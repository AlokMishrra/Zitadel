const http = require('http');
const fs = require('fs');

const ZITADEL_PORT = 8081;
const LOGIN_PORT = 3000;

const logs = [];
function log(msg) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${msg}`;
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  console.log(entry);
}

function proxy(req, res, targetPort) {
  const headers = { ...req.headers };
  headers.host = 'zeroschool-zitadel.onrender.com';
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'https';
  if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = req.socket.remoteAddress;
  const opts = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers,
    timeout: 30000,
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    log(`Proxy error to port ${targetPort}: ${e.message}`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'upstream_unavailable', port: targetPort, message: e.message }));
  });
  proxyReq.on('timeout', () => {
    log(`Proxy timeout to port ${targetPort}`);
    proxyReq.destroy();
    res.writeHead(504);
    res.end(JSON.stringify({ error: 'upstream_timeout', port: targetPort }));
  });
  req.pipe(proxyReq);
}

function routeRequest(req) {
  const url = req.url || '';
  if (url.startsWith('/ui/v2/login') || url.startsWith('/ui/v2/login/')) {
    return LOGIN_PORT;
  }
  return ZITADEL_PORT;
}

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});

const server = http.createServer((req, res) => {
  if (req.url === '/debug/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (req.url === '/debug/proxy-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: logs.slice(-50), uptime: process.uptime() }));
    return;
  }

  if (req.url === '/debug/zitadel-logs') {
    try {
      const out = fs.readFileSync('/tmp/zitadel-stdout.log', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out.slice(-5000));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No ZITADEL logs yet: ' + e.message);
    }
    return;
  }

  if (req.url === '/debug/startup') {
    try {
      const out = fs.readFileSync('/tmp/startup-debug.log', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out.slice(-5000));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No startup debug logs: ' + e.message);
    }
    return;
  }

  if (req.url === '/debug/pat-status') {
    try {
      const out = fs.readFileSync('/tmp/pat-creation-status.txt', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out.slice(-5000));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No PAT creation logs: ' + e.message);
    }
    return;
  }

  if (req.url === '/debug/login-ui') {
    try {
      const out = fs.readFileSync('/tmp/login-ui-debug.log', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out.slice(-5000));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No Login UI logs: ' + e.message);
    }
    return;
  }

  const targetPort = routeRequest(req);
  log(`${targetPort === LOGIN_PORT ? 'LOGIN' : 'ZITADEL'} -> port ${targetPort}: ${req.method} ${req.url}`);
  proxy(req, res, targetPort);
});

server.listen(8080, '0.0.0.0', () => {
  log('Proxy listening on port 8080');
  log(`all traffic -> port ${ZITADEL_PORT}`);
});

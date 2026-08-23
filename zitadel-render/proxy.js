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

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});

const server = http.createServer((req, res) => {
  // Health check - always return 200 so Render doesn't kill us during startup
  if (req.url === '/debug/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Debug endpoint with logs
  if (req.url === '/debug/proxy-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: logs.slice(-50), uptime: process.uptime() }));
    return;
  }

  // ZITADEL logs
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

  // Login UI logs
  if (req.url === '/debug/login-logs') {
    try {
      const out = fs.readFileSync('/tmp/login-stdout.log', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out.slice(-5000));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No Login UI logs yet: ' + e.message);
    }
    return;
  }

  const isLoginPath = req.url.startsWith('/ui/v2/login');

  if (isLoginPath) {
    log(`LOGIN -> port ${LOGIN_PORT}: ${req.method} ${req.url}`);
    proxy(req, res, LOGIN_PORT);
  } else {
    log(`ZITADEL -> port ${ZITADEL_PORT}: ${req.method} ${req.url}`);
    proxy(req, res, ZITADEL_PORT);
  }
});

server.listen(8080, '0.0.0.0', () => {
  log('Proxy listening on port 8080');
  log(`/ui/v2/login* -> port ${LOGIN_PORT}`);
  log(`everything else -> port ${ZITADEL_PORT}`);
});

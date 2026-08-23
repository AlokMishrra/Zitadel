const http = require('http');

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
  const opts = {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    log(`Proxy error to port ${targetPort}: ${e.message}`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'upstream_unavailable', port: targetPort }));
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  // Debug endpoint
  if (req.url === '/debug/proxy-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: logs.slice(-50), uptime: process.uptime() }));
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

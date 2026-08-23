const http = require('http');
const fs = require('fs');
const { exec } = require('child_process');

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

const DB_HOST = process.env.ZITADEL_DB_HOST || 'dpg-da47aj2jobas73aeuag0-a';
const DB_PORT = process.env.ZITADEL_DB_PORT || '5432';
const DB_NAME = process.env.ZITADEL_DB || 'zitadel_db';
const DB_USER = process.env.ZITADEL_DB_USER || 'zitadel_db_user';
const DB_PASS = process.env.ZITADEL_DB_PASSWORD || 'XaZKXwTcIiCchiEi317FvD30faT7m4vd';
const DB_DEBUG_SECRET = process.env.DB_DEBUG_SECRET || 'debug-secret-2024';

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

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => resolve(body));
  });
}

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});

const server = http.createServer(async (req, res) => {
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
      res.end(out.slice(-8000));
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
      res.end(out.slice(-8000));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('No Login UI logs: ' + e.message);
    }
    return;
  }

  if (req.url.startsWith('/debug/db')) {
    const authHeader = req.headers['x-debug-secret'];
    if (authHeader !== DB_DEBUG_SECRET) {
      log('DB debug access denied: bad secret');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: invalid x-debug-secret header' }));
      return;
    }
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const query = parsedUrl.searchParams.get('q');
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing ?q=<sql query> parameter' }));
        return;
      }
      const safeQuery = query.replace(/'/g, "'\\''");
      const psqlCmd = `PGPASSWORD='${DB_PASS}' psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -t -A -c '${safeQuery}'`;
      log('DB debug query: ' + query.slice(0, 200));
      exec(psqlCmd, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          log('DB debug error: ' + (stderr || err.message));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, stderr }));
          return;
        }
        log('DB debug result length: ' + stdout.length);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(stdout);
      });
    } catch (e) {
      log('DB debug exception: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/save-pat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const pat = (data.pat || '').trim();
      if (!pat || pat.length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid PAT value' }));
        return;
      }
      fs.writeFileSync('/tmp/login-client.pat', pat);
      log('PAT saved via API (length=' + pat.length + ')');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'PAT saved. Login UI will restart shortly.' }));
    } catch (e) {
      log('Error saving PAT: ' + e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/get-pat-status' && req.method === 'GET') {
    try {
      let hasPat = false;
      let patLen = 0;
      if (fs.existsSync('/tmp/login-client.pat')) {
        const val = fs.readFileSync('/tmp/login-client.pat', 'utf8').trim();
        hasPat = val && val !== 'no-pat' && val.length > 10;
        patLen = val.length;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasValidPat: hasPat, patLength: patLen }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/setup') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZeroSchool - Login V2 Setup</title>
<style>
body{font-family:system-ui,sans-serif;max-width:700px;margin:40px auto;padding:20px;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{margin-top:0;color:#1a1a2e}
.step{background:#f0f4ff;border-radius:8px;padding:15px;margin:15px 0;border-left:4px solid #4361ee}
.step h3{margin:0 0 8px 0;color:#4361ee}
code{background:#e8e8e8;padding:2px 6px;border-radius:4px;font-size:13px}
textarea{width:100%;height:80px;border:2px solid #ddd;border-radius:8px;padding:10px;font-family:monospace;font-size:14px;resize:vertical}
button{background:#4361ee;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:10px}
button:hover{background:#3a56d4}
button:disabled{background:#ccc;cursor:not-allowed}
.msg{padding:10px;border-radius:8px;margin-top:10px;display:none}
.msg.ok{background:#d4edda;color:#155724;display:block}
.msg.err{background:#f8d7da;color:#721c24;display:block}
.status{padding:10px;border-radius:8px;margin-top:15px;background:#e8f5e9}
.status.nopat{background:#fff3cd}
</style></head><body>
<div class="card">
<h1>ZeroSchool - Login V2 Setup</h1>
<p>Follow these steps to enable Login V2:</p>

<div class="step"><h3>Step 1</h3>
<p>Open the <a href="/ui/console" target="_blank">ZITADEL Console</a> and log in with:</p>
<p><code>school@zeroschool.localhost</code> / <code>Zeroschool@123</code></p></div>

<div class="step"><h3>Step 2</h3>
<p>In the Console, go to <strong>Users</strong> &rarr; click on <strong>school@zeroschool.localhost</strong> &rarr; <strong>Personal Access Tokens</strong> &rarr; <strong>New</strong></p>
<p>Set name to <code>login-pat</code>, expiration to a far future date, then click <strong>Create</strong>.</p></div>

<div class="step"><h3>Step 3</h3>
<p>Copy the PAT token value (the long string shown after creation) and paste it below:</p>
<textarea id="pat-input" placeholder="Paste your PAT token here..."></textarea>
<br><button id="save-btn" onclick="savePat()">Save PAT & Activate Login</button></div>

<div id="msg" class="msg"></div>
<div id="status" class="status">Checking PAT status...</div>
</div>

<script>
async function checkStatus(){
  try{
    const r=await fetch('/api/get-pat-status');
    const d=await r.json();
    const el=document.getElementById('status');
    if(d.hasValidPat){el.className='status';el.innerHTML='PAT is active (length='+d.patLength+'). Login V2 is ready!';}
    else{el.className='status nopat';el.innerHTML='No valid PAT found. Follow the steps above.';}
  }catch(e){document.getElementById('status').innerHTML='Could not check status.';}
}
async function savePat(){
  const pat=document.getElementById('pat-input').value.trim();
  const msg=document.getElementById('msg');
  const btn=document.getElementById('save-btn');
  if(!pat){msg.className='msg err';msg.textContent='Please paste a PAT token.';return;}
  btn.disabled=true;btn.textContent='Saving...';
  try{
    const r=await fetch('/api/save-pat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pat})});
    const d=await r.json();
    if(d.ok){msg.className='msg ok';msg.textContent='PAT saved! Login V2 will restart in ~10 seconds. Refresh this page after a moment.';}
    else{msg.className='msg err';msg.textContent='Error: '+d.error;}
  }catch(e){msg.className='msg err';msg.textContent='Error: '+e.message;}
  btn.disabled=false;btn.textContent='Save PAT & Activate Login';
  setTimeout(checkStatus,3000);
}
checkStatus();setInterval(checkStatus,10000);
</script></body></html>`);
    return;
  }

  const targetPort = routeRequest(req);
  log(`${targetPort === LOGIN_PORT ? 'LOGIN' : 'ZITADEL'} -> port ${targetPort}: ${req.method} ${req.url}`);
  proxy(req, res, targetPort);
});

server.listen(8080, '0.0.0.0', () => {
  log('Proxy listening on port 8080');
  log(`ZITADEL -> port ${ZITADEL_PORT}, Login V2 -> port ${LOGIN_PORT}`);
});

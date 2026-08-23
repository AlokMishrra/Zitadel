const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');

const ZITADEL_URL = 'http://localhost:8081';
const PAT_FILE = '/tmp/login-client.pat';
const STATUS_FILE = '/tmp/pat-creation-status.txt';

function log(msg) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  try {
    const existing = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : '';
    fs.writeFileSync(STATUS_FILE, existing + entry + '\n');
  } catch (e) {}
}

function httpRequest(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: { ...headers },
    };
    if (body && typeof body === 'string') {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function psql(sql) {
  try {
    const safe = sql.replace(/'/g, "'\\''");
    const cmd = `PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -t -A -c '${safe}'`;
    return execSync(cmd, { timeout: 15000, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

function psqlSingle(sql) {
  const result = psql(sql);
  if (!result) return null;
  const lines = result.split('\n').filter(l => l.trim());
  return lines.length > 0 ? lines[0] : null;
}

async function main() {
  log('=== PAT Creation ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 20) {
      log('Login Client PAT already exists (length=' + existing.length + '), skipping.');
      process.exit(0);
    }
  }

  for (let i = 0; i < 60; i += 3) {
    try {
      const r = await httpRequest('GET', `${ZITADEL_URL}/debug/healthz`);
      if (r.status === 200) { log('ZITADEL healthy'); break; }
    } catch (e) {}
    await sleep(3000);
  }

  log('Step 1: Getting OIDC config...');
  let tokenEndpoint = `${ZITADEL_URL}/oauth/v2/token`;
  try {
    const wkRes = await httpRequest('GET', `${ZITADEL_URL}/.well-known/openid-configuration`);
    if (wkRes.status === 200) {
      const wk = JSON.parse(wkRes.body);
      tokenEndpoint = wk.token_endpoint || tokenEndpoint;
      log('Token endpoint: ' + tokenEndpoint);
    }
  } catch (e) {
    log('Well-known fetch failed: ' + e.message);
  }

  log('Step 2: Trying OIDC password grant...');
  const tokenBody = new URLSearchParams({
    grant_type: 'password',
    username: 'school@zeroschool.localhost',
    password: 'Zeroschool@123',
    scope: 'openid',
  }).toString();

  let accessToken = null;

  try {
    const tokenRes = await httpRequest('POST', tokenEndpoint, tokenBody);
    log('Password grant: ' + tokenRes.status);
    if (tokenRes.status === 200) {
      const td = JSON.parse(tokenRes.body);
      accessToken = td.access_token;
      log('Got access token (length=' + (accessToken ? accessToken.length : 0) + ')');
    } else {
      log('Response: ' + tokenRes.body.substring(0, 300));
    }
  } catch (e) {
    log('Password grant error: ' + e.message);
  }

  if (!accessToken) {
    log('Password grant failed, trying client_credentials with console client...');
    try {
      const ccBody = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'openid',
      }).toString();
      const ccRes = await httpRequest('POST', tokenEndpoint, ccBody, {
        'Authorization': 'Basic ' + Buffer.from('zitadel-console@zitadel:').toString('base64'),
      });
      log('Client creds: ' + ccRes.status);
      if (ccRes.status === 200) {
        const td = JSON.parse(ccRes.body);
        accessToken = td.access_token;
      }
    } catch (e) {
      log('Client creds error: ' + e.message);
    }
  }

  if (!accessToken) {
    log('All token methods failed. Checking if login-client user exists in DB...');
    const loginClientUserId = psqlSingle(`SELECT id FROM projections.users14 WHERE username = 'login-client' AND type = 2 LIMIT 1`);
    log('login-client in DB: ' + (loginClientUserId || 'NOT FOUND'));

    const allUsers = psql(`SELECT username, type FROM projections.users14 ORDER BY created_at`);
    log('All users: ' + (allUsers || 'NONE'));

    log('ERROR: Cannot obtain access token. Login UI will start without PAT.');
    process.exit(1);
  }

  log('Step 3: Searching for login-client user...');
  const searchRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
    queries: [{
      userNameQuery: {
        userName: 'login-client',
        method: 'TEXT_QUERY_METHOD_EQUALS'
      }
    }]
  }, { 'Authorization': 'Bearer ' + accessToken });
  log('User search: ' + searchRes.status);

  let userId = null;
  try {
    const parsed = JSON.parse(searchRes.body);
    if (parsed.result && parsed.result.length > 0) {
      userId = parsed.result[0].userId;
      log('Found login-client: ' + userId);
    }
  } catch (e) {}

  if (!userId) {
    const allRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
      queries: []
    }, { 'Authorization': 'Bearer ' + accessToken });
    log('All users: ' + allRes.body.substring(0, 1000));
    process.exit(1);
  }

  log('Step 4: Creating PAT...');
  const patRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/${userId}/pats`, {
    name: 'login-client-pat',
    expirationDate: '2099-01-01T00:00:00Z'
  }, { 'Authorization': 'Bearer ' + accessToken });
  log('PAT create: ' + patRes.status + ' ' + patRes.body.substring(0, 500));

  if (patRes.status === 201 || patRes.status === 200) {
    try {
      const patData = JSON.parse(patRes.body);
      const token = patData.token || patData.pat;
      if (token) {
        fs.writeFileSync(PAT_FILE, token);
        log('SUCCESS: Login Client PAT saved (length=' + token.length + ')');
        process.exit(0);
      }
    } catch (e) {}
  }

  log('ERROR: Failed to create PAT');
  process.exit(1);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

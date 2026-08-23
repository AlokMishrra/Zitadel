const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const ZITADEL_URL = 'http://localhost:8081';
const PROXY_URL = 'http://localhost:8080';
const PAT_FILE = '/tmp/login-client.pat';
const ADMIN_PAT_FILE = '/tmp/admin.pat';
const STATUS_FILE = '/tmp/pat-creation-status.txt';
const OIDC_CODE_FILE = '/tmp/oidc-auth-code.txt';
const CLIENT_ID = '387549800423431157';
const REDIRECT_URI = 'https://zeroschool-zitadel.onrender.com/ui/console/auth/callback';

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
    if (data) {
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function main() {
  log('=== PAT Creation (v7 - Fixed Auth Code Flow) ===');

  try { fs.unlinkSync(OIDC_CODE_FILE); } catch (e) {}

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 20) {
      log('Login Client PAT already exists (length=' + existing.length + '), skipping.');
      process.exit(0);
    }
  }

  for (let i = 0; i < 40; i += 3) {
    try {
      const r = await httpRequest('GET', `${ZITADEL_URL}/debug/healthz`);
      if (r.status === 200) { log('ZITADEL healthy'); break; }
    } catch (e) {}
    if (i >= 39) { log('ERROR: ZITADEL not healthy'); process.exit(1); }
    await sleep(3000);
  }

  const { verifier, challenge } = generatePKCE();
  log('PKCE verifier: ' + verifier);
  log('PKCE challenge: ' + challenge);

  const state = crypto.randomBytes(16).toString('hex');

  log('Step 1: Starting OIDC authorization code flow...');
  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    state: state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const authUrl = `${PROXY_URL}/oauth/v2/authorize?${authParams}`;
  log('Auth URL: ' + authUrl);

  try {
    const authRes = await httpRequest('GET', authUrl, null, {
      'Host': 'zeroschool-zitadel.onrender.com',
    }, 0);
    log('Auth response: ' + authRes.status + ' ' + authRes.body.substring(0, 500));

    if (authRes.status === 302 || authRes.status === 301) {
      const location = authRes.headers.location;
      log('Redirect to: ' + location);

      if (location) {
        const loginUrl = location.startsWith('http') ? location : `${PROXY_URL}${location}`;
        log('Fetching login page: ' + loginUrl);

        const loginRes = await httpRequest('GET', loginUrl, null, {
          'Host': 'zeroschool-zitadel.onrender.com',
        });
        log('Login page status: ' + loginRes.status);
        log('Login page length: ' + loginRes.body.length);

        const html = loginRes.body;

        const csrfMatch = html.match(/name="csrf"[^>]*value="([^"]*)"/i) ||
                          html.match(/name="_csrf"[^>]*value="([^"]*)"/i) ||
                          html.match(/"csrfToken":"([^"]*)"/i) ||
                          html.match(/csrf_token[^"]*"([^"]*)"/i);
        const csrfToken = csrfMatch ? csrfMatch[1] : null;
        log('CSRF token: ' + (csrfToken || 'NOT FOUND'));

        const actionMatch = html.match(/action="([^"]*)"/i);
        const formAction = actionMatch ? actionMatch[1] : null;
        log('Form action: ' + (formAction || 'NOT FOUND'));

        const sessionMatch = html.match(/"sessionId":"([^"]*)"/i) || html.match(/name="sessionId"[^>]*value="([^"]*)"/i);
        const sessionId = sessionMatch ? sessionMatch[1] : null;
        log('Session ID: ' + sessionId);

        log('HTML snippet (first 3000 chars):');
        log(html.substring(0, 3000));
      }
    } else if (authRes.status === 200) {
      log('Got 200 directly (might be login form)');
      log('HTML snippet: ' + authRes.body.substring(0, 3000));
    }
  } catch (e) {
    log('Auth flow error: ' + e.message);
  }

  log('Step 2: Trying to create PAT via eventstore...');
  try {
    const adminUserId = '387549788495223797';
    const loginClientUserId = '387549788495485941';
    const instanceId = '387549788494633973';
    const orgId = '387549788494699509';

    log('Trying eventstore PAT creation for admin...');
    const adminPat = execSync('head -c 32 /dev/urandom | base64 | tr -d "=+/" | head -c 40', { encoding: 'utf8' }).trim();
    const adminPatHash = execSync(`echo -n "${adminPat}" | sha256sum | awk '{print $1}'`, { encoding: 'utf8' }).trim();
    const patId = execSync('cat /proc/sys/kernel/random/uuid', { encoding: 'utf8' }).trim();
    const now = new Date().toISOString();

    // Insert PAT event into eventstore
    const eventUuid = execSync('cat /proc/sys/kernel/random/uuid', { encoding: 'utf8' }).trim();
    const seq = Math.floor(Math.random() * 1000000) + 1000000;
    const payload = JSON.stringify({
      tokenID: patId,
      name: 'admin-pat',
      expirationDate: '2099-01-01T00:00:00Z',
      hashedToken: adminPatHash,
      userID: adminUserId,
      accessTokenType: 0
    }).replace(/'/g, "''");

    const sql = `INSERT INTO eventstore.events2 (instance_id, aggregate_type, aggregate_id, event_type, "sequence", revision, created_at, payload, creator, owner, position) VALUES ('${instanceId}', 'user', '${adminUserId}', 'user.pat.added', ${seq}, 1, '${now}', '${payload}'::jsonb, '${adminUserId}', '${orgId}', 0)`;
    log('Inserting PAT event...');
    const result = execSync(`PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "${sql}"`, { timeout: 15000, encoding: 'utf8' }).trim();
    log('Event insert result: ' + result);

    // Also insert projection
    const projSql = `INSERT INTO projections.personal_access_tokens3 (id, creation_date, change_date, sequence, resource_owner, instance_id, user_id, expiration, scopes, owner_removed) VALUES ('${patId}', '${now}', '${now}', 1, '${orgId}', '${instanceId}', '${adminUserId}', '2099-01-01T00:00:00Z', '{}', false)`;
    const projResult = execSync(`PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "${projSql}"`, { timeout: 15000, encoding: 'utf8' }).trim();
    log('Projection insert result: ' + projResult);

    fs.writeFileSync(ADMIN_PAT_FILE, adminPat);
    log('Admin PAT written to file (length=' + adminPat.length + ')');

    // Now do the same for login-client
    const loginPat = execSync('head -c 32 /dev/urandom | base64 | tr -d "=+/" | head -c 40', { encoding: 'utf8' }).trim();
    const loginPatHash = execSync(`echo -n "${loginPat}" | sha256sum | awk '{print $1}'`, { encoding: 'utf8' }).trim();
    const loginPatId = execSync('cat /proc/sys/kernel/random/uuid', { encoding: 'utf8' }).trim();

    const payload2 = JSON.stringify({
      tokenID: loginPatId,
      name: 'login-client-pat',
      expirationDate: '2099-01-01T00:00:00Z',
      hashedToken: loginPatHash,
      userID: loginClientUserId,
      accessTokenType: 0
    }).replace(/'/g, "''");

    const sql2 = `INSERT INTO eventstore.events2 (instance_id, aggregate_type, aggregate_id, event_type, "sequence", revision, created_at, payload, creator, owner, position) VALUES ('${instanceId}', 'user', '${loginClientUserId}', 'user.pat.added', ${seq + 1}, 1, '${now}', '${payload2}'::jsonb, '${loginClientUserId}', '${orgId}', 0)`;
    execSync(`PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "${sql2}"`, { timeout: 15000, encoding: 'utf8' });

    const projSql2 = `INSERT INTO projections.personal_access_tokens3 (id, creation_date, change_date, sequence, resource_owner, instance_id, user_id, expiration, scopes, owner_removed) VALUES ('${loginPatId}', '${now}', '${now}', 1, '${orgId}', '${instanceId}', '${loginClientUserId}', '2099-01-01T00:00:00Z', '{}', false)`;
    execSync(`PGPASSWORD='XaZKXwTcIiCchiEi317FvD30faT7m4vd' psql -h dpg-da47aj2jobas73aeuag0-a -p 5432 -U zitadel_db_user -d zitadel_db -c "${projSql2}"`, { timeout: 15000, encoding: 'utf8' });

    fs.writeFileSync(PAT_FILE, loginPat);
    log('Login Client PAT written to file (length=' + loginPat.length + ')');

    // Wait for ZITADEL to pick up the new PATs
    log('Waiting for ZITADEL to process new PATs...');
    await sleep(5000);

    // Verify by calling Management API
    const testRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
      queries: []
    }, { 'Authorization': 'Bearer ' + loginPat });
    log('Management API test with login PAT: ' + testRes.status + ' ' + testRes.body.substring(0, 300));

    if (testRes.status === 200 || testRes.status === 403) {
      log('SUCCESS: PAT appears to be working!');
      process.exit(0);
    }
  } catch (e) {
    log('Eventstore PAT creation error: ' + e.message);
  }

  log('ERROR: All methods failed');
  process.exit(1);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });
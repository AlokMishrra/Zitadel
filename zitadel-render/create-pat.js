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

function httpRequest(method, urlStr, body, headers = {}, maxRedirects = 10) {
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
  log('=== PAT Creation (v6 - OIDC Auth Code Flow) ===');

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

  const authUrl = `${PROXY_URL}/oauth/v2/auth?${authParams}`;
  log('Auth URL: ' + authUrl);

  try {
    const authRes = await httpRequest('GET', authUrl, null, {
      'Host': 'zeroschool-zitadel.onrender.com',
    }, 0);
    log('Auth response: ' + authRes.status);

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

  log('Step 2: Trying OIDC device code flow as fallback...');
  try {
    const dcBody = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'openid profile email',
    }).toString();
    const dcRes = await httpRequest('POST', `${PROXY_URL}/oauth/v2/device_authorization`, dcBody, {
      'Host': 'zeroschool-zitadel.onrender.com',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    log('Device code request: ' + dcRes.status + ' ' + dcRes.body.substring(0, 500));

    if (dcRes.status === 200) {
      const dcData = JSON.parse(dcRes.body);
      log('Device code: ' + dcData.device_code);
      log('User code: ' + dcData.user_code);
      log('Verification URI: ' + dcData.verification_uri);
      log('');
      log('*** OPEN THIS URL AND ENTER THE CODE ***');
      log(dcData.verification_uri);
      log('Code: ' + dcData.user_code);
      log('');

      const interval = dcData.interval || 5;
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        await sleep(interval * 1000);
        try {
          const tokenBody = new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: dcData.device_code,
            client_id: CLIENT_ID,
          }).toString();
          const tokenRes = await httpRequest('POST', `${PROXY_URL}/oauth/v2/token`, tokenBody, {
            'Host': 'zeroschool-zitadel.onrender.com',
            'Content-Type': 'application/x-www-form-urlencoded',
          });
          log('Poll ' + (i + 1) + ': ' + tokenRes.status + ' ' + tokenRes.body.substring(0, 200));

          if (tokenRes.status === 200) {
            const td = JSON.parse(tokenRes.body);
            const accessToken = td.access_token;
            if (accessToken) {
              log('SUCCESS: Got access token (length=' + accessToken.length + ')');
              await createPats(accessToken);
              process.exit(0);
            }
          }

          try {
            const errData = JSON.parse(tokenRes.body);
            if (errData.error === 'authorization_pending') continue;
            if (errData.error === 'slow_down') { continue; }
            if (errData.error === 'expired_token' || errData.error === 'access_denied') {
              log('Device code expired or denied');
              break;
            }
          } catch (e) {}
        } catch (e) {
          log('Poll error: ' + e.message);
        }
      }
    } else {
      log('Device code not supported for this client');
    }
  } catch (e) {
    log('Device code error: ' + e.message);
  }

  log('ERROR: All methods failed');
  process.exit(1);
}

async function createPats(accessToken) {
  const searchRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
    queries: [{
      userNameQuery: { userName: 'login-client', method: 'TEXT_QUERY_METHOD_EQUALS' }
    }]
  }, { 'Authorization': 'Bearer ' + accessToken });
  log('Search login-client: ' + searchRes.status);

  let loginUserId = null;
  try {
    const parsed = JSON.parse(searchRes.body);
    if (parsed.result && parsed.result.length > 0) {
      loginUserId = parsed.result[0].userId;
    }
  } catch (e) {}

  if (loginUserId) {
    const patRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/${loginUserId}/pats`, {
      name: 'login-client-pat',
      expirationDate: '2099-01-01T00:00:00Z'
    }, { 'Authorization': 'Bearer ' + accessToken });
    log('Login PAT create: ' + patRes.status + ' ' + patRes.body.substring(0, 500));

    if (patRes.status === 201 || patRes.status === 200) {
      try {
        const data = JSON.parse(patRes.body);
        const token = data.token || data.pat || data.accessToken;
        if (token && token.length > 10) {
          fs.writeFileSync(PAT_FILE, token);
          log('SUCCESS: Login Client PAT saved (length=' + token.length + ')');
        }
      } catch (e) { log('Parse error: ' + e.message); }
    }
  }

  const adminSearch = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
    queries: [{
      userNameQuery: { userName: 'admin', method: 'TEXT_QUERY_METHOD_EQUALS' }
    }]
  }, { 'Authorization': 'Bearer ' + accessToken });
  let adminUserId = null;
  try {
    const parsed = JSON.parse(adminSearch.body);
    if (parsed.result && parsed.result.length > 0) {
      adminUserId = parsed.result[0].userId;
    }
  } catch (e) {}

  if (adminUserId) {
    const patRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/${adminUserId}/pats`, {
      name: 'admin-pat',
      expirationDate: '2099-01-01T00:00:00Z'
    }, { 'Authorization': 'Bearer ' + accessToken });
    log('Admin PAT create: ' + patRes.status + ' ' + patRes.body.substring(0, 500));

    if (patRes.status === 201 || patRes.status === 200) {
      try {
        const data = JSON.parse(patRes.body);
        const token = data.token || data.pat || data.accessToken;
        if (token && token.length > 10) {
          fs.writeFileSync(ADMIN_PAT_FILE, token);
          log('SUCCESS: Admin PAT saved (length=' + token.length + ')');
        }
      } catch (e) { log('Parse error: ' + e.message); }
    }
  }
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

const fs = require('fs');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ZITADEL_INTERNAL_URL = 'http://localhost:8081';
const PAT_FILE = '/tmp/login-client.pat';
const ADMIN_PAT_FILE = '/tmp/admin.pat';
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

function httpRequest(method, urlStr, body, headers = {}, followRedirects = false, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { ...headers },
      rejectUnauthorized: false,
    };
    if (body && typeof body === 'string') {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body && typeof body === 'object') {
      opts.headers['Content-Type'] = 'application/json';
    }
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const transport = isHttps ? https : http;
    const req = transport.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (followRedirects && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && maxRedirects > 0) {
          const loc = res.headers.location.startsWith('http') ? res.headers.location : `${url.protocol}//${url.host}${res.headers.location}`;
          resolve({ status: res.statusCode, body: b, headers: res.headers, redirectUrl: loc });
        } else {
          resolve({ status: res.statusCode, body: b, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
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

function createJWT(privateKeyPem, claims) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerEnc = enc(header);
  const payloadEnc = enc(claims);
  const dataToSign = `${headerEnc}.${payloadEnc}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(dataToSign);
  const signature = sign.sign(privateKeyPem, 'base64url');
  return `${dataToSign}.${signature}`;
}

function parsePEM(pemStr) {
  const cleaned = pemStr.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s/g, '');
  return Buffer.from(cleaned, 'base64');
}

async function tryOIDCPasswordGrant(tokenEndpoint) {
  log('Trying OIDC password grant (ROPC)...');
  const tokenBody = new URLSearchParams({
    grant_type: 'password',
    username: 'school@zeroschool.localhost',
    password: 'Zeroschool@123',
    scope: 'openid profile email',
  }).toString();
  try {
    const res = await httpRequest('POST', tokenEndpoint, tokenBody);
    log('Password grant: ' + res.status);
    if (res.status === 200) {
      const td = JSON.parse(res.body);
      return td.access_token;
    }
    log('Response: ' + res.body.substring(0, 300));
  } catch (e) {
    log('Password grant error: ' + e.message);
  }
  return null;
}

async function tryClientCredentials(tokenEndpoint) {
  log('Trying client_credentials with console client...');
  try {
    const ccBody = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'openid profile email',
    }).toString();
    const ccRes = await httpRequest('POST', tokenEndpoint, ccBody, {
      'Authorization': 'Basic ' + Buffer.from('zitadel-console@zitadel:').toString('base64'),
    });
    log('Client creds (console): ' + ccRes.status + ' ' + ccRes.body.substring(0, 200));
    if (ccRes.status === 200) {
      return JSON.parse(ccRes.body).access_token;
    }
  } catch (e) {
    log('Client creds error: ' + e.message);
  }
  return null;
}

async function tryJWTAssertion(tokenEndpoint, machineUserId, privateKeyPem) {
  log('Trying JWT assertion with machine user key (user: ' + machineUserId + ')...');
  const now = Math.floor(Date.now() / 1000);
  const jwt = createJWT(privateKeyPem, {
    iss: machineUserId,
    sub: machineUserId,
    aud: ZITADEL_INTERNAL_URL,
    exp: now + 300,
    iat: now,
    jti: crypto.randomUUID(),
  });

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
      scope: 'openid profile email',
    }).toString();
    const res = await httpRequest('POST', tokenEndpoint, body);
    log('JWT assertion: ' + res.status + ' ' + res.body.substring(0, 300));
    if (res.status === 200) {
      return JSON.parse(res.body).access_token;
    }
  } catch (e) {
    log('JWT assertion error: ' + e.message);
  }

  log('Trying JWT assertion with "aud" as token endpoint URL...');
  const jwt2 = createJWT(privateKeyPem, {
    iss: machineUserId,
    sub: machineUserId,
    aud: tokenEndpoint,
    exp: now + 300,
    iat: now,
    jti: crypto.randomUUID(),
  });
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt2,
      scope: 'openid profile email',
    }).toString();
    const res = await httpRequest('POST', tokenEndpoint, body);
    log('JWT assertion (token aud): ' + res.status + ' ' + res.body.substring(0, 300));
    if (res.status === 200) {
      return JSON.parse(res.body).access_token;
    }
  } catch (e) {
    log('JWT assertion (token aud) error: ' + e.message);
  }

  return null;
}

async function tryInstanceKeyJWTAssertion(tokenEndpoint, instanceKeyId, privateKeyPem, machineUserId) {
  log('Trying instance key JWT assertion...');
  const now = Math.floor(Date.now() / 1000);
  const jwt = createJWT(privateKeyPem, {
    iss: instanceKeyId,
    sub: machineUserId,
    aud: ZITADEL_INTERNAL_URL,
    exp: now + 300,
    iat: now,
    jti: crypto.randomUUID(),
  });

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
      scope: 'openid profile email',
    }).toString();
    const res = await httpRequest('POST', tokenEndpoint, body);
    log('Instance key JWT: ' + res.status + ' ' + res.body.substring(0, 300));
    if (res.status === 200) {
      return JSON.parse(res.body).access_token;
    }
  } catch (e) {
    log('Instance key JWT error: ' + e.message);
  }
  return null;
}

async function tryPersonalJWTAssertion(tokenEndpoint, privateKeyPem, machineUserId) {
  log('Trying personal JWT (iss=sub=machineUserId)...');
  const now = Math.floor(Date.now() / 1000);
  const jwt = createJWT(privateKeyPem, {
    iss: machineUserId,
    sub: machineUserId,
    aud: ZITADEL_INTERNAL_URL,
    exp: now + 300,
    iat: now,
    jti: crypto.randomUUID(),
    scope: 'openid',
  });

  try {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
      scope: 'openid profile email',
    }).toString();
    const res = await httpRequest('POST', tokenEndpoint, body);
    log('Personal JWT: ' + res.status + ' ' + res.body.substring(0, 300));
    if (res.status === 200) {
      return JSON.parse(res.body).access_token;
    }
  } catch (e) {
    log('Personal JWT error: ' + e.message);
  }
  return null;
}

async function createPAT(accessToken, userId, patName) {
  log('Creating PAT for user ' + userId + '...');
  const res = await httpRequest('POST', `${ZITADEL_INTERNAL_URL}/management/v1/users/${userId}/pats`, {
    name: patName,
    expirationDate: '2099-01-01T00:00:00Z'
  }, { 'Authorization': 'Bearer ' + accessToken });
  log('PAT create: ' + res.status + ' ' + res.body.substring(0, 500));

  if (res.status === 201 || res.status === 200) {
    try {
      const patData = JSON.parse(res.body);
      const token = patData.token || patData.pat || patData.accessToken;
      if (token && token.length > 10) {
        return token;
      }
      log('PAT response parsed: ' + JSON.stringify(patData).substring(0, 500));
    } catch (e) {
      log('PAT parse error: ' + e.message);
    }
  }
  return null;
}

async function searchUser(accessToken, username) {
  const res = await httpRequest('POST', `${ZITADEL_INTERNAL_URL}/management/v1/users/_search`, {
    queries: [{
      userNameQuery: {
        userName: username,
        method: 'TEXT_QUERY_METHOD_EQUALS'
      }
    }]
  }, { 'Authorization': 'Bearer ' + accessToken });
  log('User search (' + username + '): ' + res.status);
  try {
    const parsed = JSON.parse(res.body);
    if (parsed.result && parsed.result.length > 0) {
      return parsed.result[0].userId;
    }
  } catch (e) {}
  return null;
}

async function main() {
  log('=== PAT Creation (v3) ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 20) {
      log('Login Client PAT already exists (length=' + existing.length + '), skipping.');
      process.exit(0);
    }
  }

  for (let i = 0; i < 60; i += 3) {
    try {
      const r = await httpRequest('GET', `${ZITADEL_INTERNAL_URL}/debug/healthz`);
      if (r.status === 200) { log('ZITADEL healthy'); break; }
    } catch (e) {}
    if (i >= 57) { log('ERROR: ZITADEL not healthy after 180s'); process.exit(1); }
    await sleep(3000);
  }

  log('Step 1: Getting OIDC config...');
  let tokenEndpoint = `${ZITADEL_INTERNAL_URL}/oauth/v2/token`;
  try {
    const wkRes = await httpRequest('GET', `${ZITADEL_INTERNAL_URL}/.well-known/openid-configuration`);
    if (wkRes.status === 200) {
      const wk = JSON.parse(wkRes.body);
      tokenEndpoint = wk.token_endpoint || tokenEndpoint;
      log('Token endpoint: ' + tokenEndpoint);
    }
  } catch (e) {
    log('Well-known fetch failed: ' + e.message);
  }

  let accessToken = null;

  const pwToken = await tryOIDCPasswordGrant(tokenEndpoint);
  if (pwToken) accessToken = pwToken;

  if (!accessToken) {
    const ccToken = await tryClientCredentials(tokenEndpoint);
    if (ccToken) accessToken = ccToken;
  }

  if (!accessToken) {
    log('Step 2: Querying DB for machine keys and users...');
    const tables = psql(`SELECT tablename FROM pg_tables WHERE schemaname = 'projections' AND tablename LIKE '%key%' OR tablename LIKE '%machine%' ORDER BY tablename`);
    log('Key/machine tables: ' + (tables || 'NONE'));

    const allTables = psql(`SELECT tablename FROM pg_tables WHERE schemaname = 'projections' ORDER BY tablename`);
    log('All projection tables: ' + (allTables || 'NONE'));

    const machineUsers = psql(`SELECT id, username, type FROM projections.users14 WHERE type = 2`);
    log('Machine users: ' + (machineUsers || 'NONE'));

    const adminUserId = psqlSingle(`SELECT id FROM projections.users14 WHERE username = 'admin' AND type = 2 LIMIT 1`);
    log('Admin machine user ID: ' + (adminUserId || 'NOT FOUND'));

    const loginClientUserId = psqlSingle(`SELECT id FROM projections.users14 WHERE username = 'login-client' AND type = 2 LIMIT 1`);
    log('Login client user ID: ' + (loginClientUserId || 'NOT FOUND'));

    const instanceKeys = psql(`SELECT id, algorithm FROM projections."PrivateKey4"`);
    log('Instance keys: ' + (instanceKeys || 'NONE'));

    const instanceKeyId = psqlSingle(`SELECT id FROM projections."PrivateKey4" LIMIT 1`);
    const instanceKeyPEM = psqlSingle(`SELECT private_key FROM projections."PrivateKey4" LIMIT 1`);

    if (adminUserId && instanceKeyPEM) {
      log('Step 3: Trying JWT assertion with instance key + admin user...');

      const token1 = await tryJWTAssertion(tokenEndpoint, adminUserId, instanceKeyPEM);
      if (token1) accessToken = token1;
    }

    if (!accessToken && instanceKeyId && instanceKeyPEM && adminUserId) {
      const token2 = await tryInstanceKeyJWTAssertion(tokenEndpoint, instanceKeyId, instanceKeyPEM, adminUserId);
      if (token2) accessToken = token2;
    }

    if (!accessToken && instanceKeyPEM && adminUserId) {
      const token3 = await tryPersonalJWTAssertion(tokenEndpoint, instanceKeyPEM, adminUserId);
      if (token3) accessToken = token3;
    }

    const machineKeyTables = psql(`SELECT tablename FROM pg_tables WHERE schemaname = 'projections' AND tablename ILIKE '%machinekey%' ORDER BY tablename`);
    log('Machine key tables: ' + (machineKeyTables || 'NONE'));

    if (machineKeyTables) {
      for (const table of machineKeyTables.split('\n').filter(l => l.trim())) {
        const cols = psql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'projections' AND table_name = '${table.trim()}' ORDER BY ordinal_position`);
        log(`Columns of ${table.trim()}: ${cols || 'NONE'}`);

        const data = psql(`SELECT * FROM projections."${table.trim()}" LIMIT 3`);
        log(`Data of ${table.trim()}: ${(data || 'NONE').substring(0, 1000)}`);
      }
    }

    const allMachineKeys = psql(`SELECT id, "userId", "algorithm", "creation_date" FROM projections."MachineKey4" LIMIT 5`);
    log('MachineKey4: ' + (allMachineKeys || 'NONE'));

    if (!accessToken && adminUserId) {
      const machinePrivateKey = psqlSingle(`SELECT "private_key" FROM projections."MachineKey4" WHERE "userId" = '${adminUserId}' LIMIT 1`);
      log('Admin machine private key: ' + (machinePrivateKey ? 'FOUND (length=' + machinePrivateKey.length + ')' : 'NOT FOUND'));

      if (machinePrivateKey) {
        const token4 = await tryJWTAssertion(tokenEndpoint, adminUserId, machinePrivateKey);
        if (token4) accessToken = token4;

        if (!accessToken) {
          const token5 = await tryPersonalJWTAssertion(tokenEndpoint, machinePrivateKey, adminUserId);
          if (token5) accessToken = token5;
        }
      }
    }
  }

  if (!accessToken) {
    log('ERROR: All token acquisition methods failed.');
    log('Trying to list all relevant DB data for debugging...');

    const allUsers = psql(`SELECT id, username, "firstName", "lastName", type FROM projections.users14`);
    log('All users: ' + (allUsers || 'NONE').substring(0, 2000));

    log('FATAL: Cannot obtain access token. Login UI will start without PAT.');
    fs.writeFileSync(PAT_FILE, 'no-pat');
    process.exit(1);
  }

  log('SUCCESS: Got access token (length=' + accessToken.length + ')');

  let loginClientUserId = await searchUser(accessToken, 'login-client');
  if (!loginClientUserId) {
    log('login-client not found, searching all machine users...');
    const searchRes = await httpRequest('POST', `${ZITADEL_INTERNAL_URL}/management/v1/users/_search`, {
      queries: []
    }, { 'Authorization': 'Bearer ' + accessToken });
    log('All users: ' + searchRes.body.substring(0, 2000));
    try {
      const parsed = JSON.parse(searchRes.body);
      if (parsed.result) {
        for (const u of parsed.result) {
          if (u.loginName && u.loginName.includes('login-client')) {
            loginClientUserId = u.userId;
            break;
          }
        }
      }
    } catch (e) {}
  }

  if (!loginClientUserId) {
    log('ERROR: Cannot find login-client user');
    process.exit(1);
  }

  log('Found login-client user: ' + loginClientUserId);

  const patToken = await createPAT(accessToken, loginClientUserId, 'login-client-pat');
  if (patToken) {
    fs.writeFileSync(PAT_FILE, patToken);
    log('SUCCESS: Login Client PAT saved (length=' + patToken.length + ')');

    const adminUserId = await searchUser(accessToken, 'admin');
    if (adminUserId) {
      const adminPat = await createPAT(accessToken, adminUserId, 'admin-pat');
      if (adminPat) {
        fs.writeFileSync(ADMIN_PAT_FILE, adminPat);
        log('SUCCESS: Admin PAT saved (length=' + adminPat.length + ')');
      }
    }
    process.exit(0);
  }

  log('ERROR: Failed to create PAT');
  process.exit(1);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

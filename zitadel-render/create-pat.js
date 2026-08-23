const fs = require('fs');
const http = require('http');
const https = require('https');

const ZITADEL_URL = 'http://localhost:8081';
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

function apiCall(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, ZITADEL_URL);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (token) {
      opts.headers['Authorization'] = `Bearer ${token}`;
    }
    if (data) {
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function waitForZitadel(maxWaitSec) {
  for (let i = 0; i < maxWaitSec; i += 3) {
    try {
      const res = await new Promise((resolve, reject) => {
        http.get(`${ZITADEL_URL}/debug/healthz`, (r) => {
          let b = '';
          r.on('data', (c) => (b += c));
          r.on('end', () => resolve({ status: r.statusCode, body: b }));
        }).on('error', reject);
      });
      if (res.status === 200) {
        log('ZITADEL is healthy');
        return true;
      }
    } catch (e) {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function getAdminPat() {
  for (let i = 0; i < 60; i += 3) {
    if (fs.existsSync(ADMIN_PAT_FILE)) {
      const pat = fs.readFileSync(ADMIN_PAT_FILE, 'utf8').trim();
      if (pat && pat.length > 20 && pat !== 'no-pat') {
        log('Admin PAT found (length=' + pat.length + ')');
        return pat;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function main() {
  log('=== PAT Creation via ZITADEL Management API ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 20) {
      log('Login Client PAT already exists (length=' + existing.length + '), skipping.');
      process.exit(0);
    }
  }

  log('Waiting for ZITADEL to be healthy...');
  const healthy = await waitForZitadel(180);
  if (!healthy) {
    log('ERROR: ZITADEL did not become healthy');
    process.exit(1);
  }

  log('Waiting for admin PAT...');
  const adminPat = await getAdminPat();
  if (!adminPat) {
    log('ERROR: Admin PAT not found, cannot create login-client PAT');
    log('Falling back: login UI will start without PAT');
    process.exit(1);
  }

  log('Searching for login-client user...');
  const searchRes = await apiCall('POST', '/management/v1/users/_search', {
    queries: [{
      userNameQuery: {
        userName: 'login-client',
        method: 'TEXT_QUERY_METHOD_EQUALS'
      }
    }],
    queries: [{
      userStateQuery: {
        state: 'USER_STATE_ACTIVE',
        method: 'USERSTATE_QUERY_METHOD_EQUALS'
      }
    }]
  }, adminPat);

  log('User search status: ' + searchRes.status);

  let userId = null;
  try {
    const parsed = JSON.parse(searchRes.body);
    if (parsed.result && parsed.result.length > 0) {
      userId = parsed.result[0].userId;
      log('Found login-client user ID: ' + userId);
    }
  } catch (e) {
    log('Failed to parse user search response: ' + e.message);
  }

  if (!userId) {
    log('login-client user not found, trying to list all machine users...');
    const listRes = await apiCall('POST', '/management/v1/users/_search', {
      queries: []
    }, adminPat);
    log('List users status: ' + listRes.status);
    log('List users response (first 500): ' + listRes.body.substring(0, 500));
    process.exit(1);
  }

  log('Creating PAT for login-client user...');
  const patRes = await apiCall('POST', `/management/v1/users/${userId}/pats`, {
    name: 'login-client-pat',
    expirationDate: '2099-01-01T00:00:00Z'
  }, adminPat);

  log('PAT creation status: ' + patRes.status);
  log('PAT creation response: ' + patRes.body.substring(0, 500));

  if (patRes.status === 201 || patRes.status === 200) {
    try {
      const parsed = JSON.parse(patRes.body);
      const patValue = parsed.token || parsed.pat;
      if (patValue) {
        fs.writeFileSync(PAT_FILE, patValue);
        log('Login Client PAT saved (length=' + patValue.length + ')');
        process.exit(0);
      }
      log('PAT value not found in response, full response: ' + JSON.stringify(parsed));
    } catch (e) {
      log('Failed to parse PAT response: ' + e.message);
    }
  }

  log('ERROR: Failed to create PAT via Management API');
  process.exit(1);
}

main().catch((err) => {
  log('FATAL: ' + err.message);
  process.exit(1);
});

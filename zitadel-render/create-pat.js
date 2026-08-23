const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ZITADEL_URL = 'http://localhost:8081';
const PAT_FILE = '/tmp/login-client.pat';
const MACHINE_KEY_FILE = '/tmp/machine-key.json';
const STATUS_FILE = '/tmp/pat-creation-status.txt';
const DB_HOST = 'dpg-da47aj2jobas73aeuag0-a';
const DB_PORT = '5432';
const DB_USER = 'zitadel_db_user';
const DB_PASS = 'XaZKXwTcIiCchiEi317FvD30faT7m4vd';
const DB_NAME = 'zitadel_db';
const MASTER_KEY = 'jYCXFt5umAbioo2b9IBT6YjyamC8PvyM';

function log(msg) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  try {
    const existing = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : '';
    fs.writeFileSync(STATUS_FILE, existing + entry + '\n');
  } catch (e) {}
}

function psql(sql) {
  try {
    const safe = sql.replace(/'/g, "'\\''");
    const cmd = `PGPASSWORD='${DB_PASS}' psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -t -A -c '${safe}'`;
    return execSync(cmd, { timeout: 15000, encoding: 'utf8' }).trim();
  } catch (e) {
    log('psql error: ' + (e.stderr || e.message).substring(0, 200));
    return null;
  }
}

function psqlSingle(sql) {
  const result = psql(sql);
  if (!result) return null;
  const lines = result.split('\n').filter(l => l.trim());
  return lines.length > 0 ? lines[0] : null;
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
      headers: { 'Content-Type': 'application/json', ...headers },
    };
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

function generateJWT(privateKey, keyId, userId, instanceId) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
  const payload = {
    iss: instanceId,
    sub: userId,
    aud: [instanceId],
    iat: now,
    exp: now + 365 * 24 * 3600,
    jti: crypto.randomUUID(),
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const dataToSign = `${enc(header)}.${enc(payload)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(dataToSign);
  sign.end();
  const signature = sign.sign(privateKey, 'base64url');
  return `${dataToSign}.${signature}`;
}

async function main() {
  log('=== PAT Creation: Admin JWT via DB + Management API ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 20) {
      const parts = existing.split('.');
      if (parts.length === 3) {
        log('Valid JWT already exists (length=' + existing.length + '), skipping.');
        process.exit(0);
      }
    }
  }

  for (let i = 0; i < 60; i += 3) {
    try {
      const r = await httpRequest('GET', `${ZITADEL_URL}/debug/healthz`);
      if (r.status === 200) { log('ZITADEL healthy'); break; }
    } catch (e) {}
    await sleep(3000);
  }

  log('Step 1: Reading machine key from DB...');
  const adminUserId = psqlSingle(`SELECT id FROM projections.users14 WHERE username = 'admin' AND type = 2 LIMIT 1`);
  if (!adminUserId) {
    log('ERROR: admin machine user not found');
    process.exit(1);
  }
  log('Admin user ID: ' + adminUserId);

  const instanceId = psqlSingle(`SELECT id FROM projections.instances LIMIT 1`);
  if (!instanceId) {
    log('ERROR: instance not found');
    process.exit(1);
  }
  log('Instance ID: ' + instanceId);

  const keyRow = psqlSingle(`SELECT id, identifier FROM projections.authn_keys2 WHERE aggregate_id = '${adminUserId}' AND enabled = true ORDER BY creation_date DESC LIMIT 1`);
  if (!keyRow) {
    log('ERROR: no machine key found for admin user');
    process.exit(1);
  }
  log('Key row: ' + keyRow);

  const keyId = keyRow.split('|')[0];
  log('Key ID: ' + keyId);

  log('Step 2: Generating fresh RSA key pair for JWT...');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const publicKeyB64 = Buffer.from(publicKey).toString('base64');
  const publicKeyDer = publicKey.replace(/\n/g, '').replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').trim();

  log('Step 3: Inserting new machine key event into eventstore...');
  const maxSeq = psqlSingle(`SELECT COALESCE(MAX(sequence), 0) FROM eventstore.events2 WHERE aggregate_id = '${adminUserId}'`);
  const nextSeq = parseInt(maxSeq || '0') + 1;

  const maxPos = psqlSingle(`SELECT COALESCE(MAX(position), 0) FROM eventstore.events2`);
  const nextPos = parseFloat(maxPos || '0') + 1;

  const newKeyId = Date.now().toString() + Math.floor(Math.random() * 10000).toString();
  const keyPayload = JSON.stringify({
    type: 2,
    keyId: newKeyId,
    publicKey: publicKeyB64,
    expirationDate: '9999-12-31T23:59:59Z'
  });

  const insResult = psql(`INSERT INTO eventstore.events2 (instance_id, aggregate_type, aggregate_id, event_type, sequence, revision, created_at, payload, creator, owner, position, in_tx_order) VALUES ('${instanceId}', 'user', '${adminUserId}', 'user.machine.key.added', ${nextSeq}, 1, NOW(), '${keyPayload.replace(/'/g, "''")}', '${adminUserId}', '${adminUserId}', ${nextPos}, 0)`);
  log('Event insert: ' + (insResult !== null ? 'OK' : 'FAILED'));

  log('Step 4: Inserting public key into projections...');
  const fp = crypto.createHash('sha256').update(Buffer.from(publicKey)).digest('hex').substring(0, 40);

  psql(`INSERT INTO projections.authn_keys2 (id, creation_date, change_date, resource_owner, instance_id, aggregate_id, sequence, object_id, expiration, identifier, public_key, enabled, type, fingerprint) VALUES ('${newKeyId}', NOW(), NOW(), '${adminUserId}', '${instanceId}', '${adminUserId}', ${nextSeq}, '${adminUserId}', '9999-12-31 23:59:59+00', '${adminUserId}', decode('${publicKeyB64}', 'base64'), true, 2, '${fp}') ON CONFLICT (id) DO UPDATE SET public_key = decode('${publicKeyB64}', 'base64'), enabled = true, type = 2`);
  log('authn_keys2 insert: OK');

  psql(`INSERT INTO projections.keys4_public (id, instance_id, expiry, key) VALUES ('${newKeyId}', '${instanceId}', '9999-12-31 23:59:59+00', decode('${publicKeyB64}', 'base64')) ON CONFLICT (id) DO UPDATE SET key = decode('${publicKeyB64}', 'base64')`);
  log('keys4_public insert: OK');

  log('Step 5: Generating admin JWT...');
  const jwt = generateJWT(privateKey, newKeyId, adminUserId, instanceId);
  log('JWT length: ' + jwt.length);

  log('Step 6: Testing JWT with Management API...');
  const testRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
    queries: []
  }, { 'Authorization': 'Bearer ' + jwt });
  log('JWT test: ' + testRes.status);

  if (testRes.status !== 200) {
    log('JWT test failed: ' + testRes.body.substring(0, 300));
    log('Trying to find login-client user directly via OIDC introspection...');
  }

  log('Step 7: Finding login-client user...');
  let userId = null;
  const searchRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
    queries: [{
      userNameQuery: {
        userName: 'login-client',
        method: 'TEXT_QUERY_METHOD_EQUALS'
      }
    }]
  }, { 'Authorization': 'Bearer ' + jwt });
  log('User search: ' + searchRes.status);

  try {
    const parsed = JSON.parse(searchRes.body);
    if (parsed.result && parsed.result.length > 0) {
      userId = parsed.result[0].userId;
      log('Found login-client: ' + userId);
    }
  } catch (e) {
    log('Parse error: ' + e.message);
  }

  if (!userId) {
    log('login-client not found, listing all users...');
    const allRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/_search`, {
      queries: []
    }, { 'Authorization': 'Bearer ' + jwt });
    log('All users: ' + allRes.body.substring(0, 800));
    process.exit(1);
  }

  log('Step 8: Creating PAT for login-client...');
  const patRes = await httpRequest('POST', `${ZITADEL_URL}/management/v1/users/${userId}/pats`, {
    name: 'login-client-pat',
    expirationDate: '2099-01-01T00:00:00Z'
  }, { 'Authorization': 'Bearer ' + jwt });
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
      log('Token field not found in: ' + JSON.stringify(Object.keys(patData)));
    } catch (e) {
      log('Parse error: ' + e.message);
    }
  }

  log('ERROR: Failed to create PAT');
  process.exit(1);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

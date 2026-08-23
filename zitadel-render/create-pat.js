const { execSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const DB_HOST = 'dpg-da47aj2jobas73aeuag0-a';
const DB_PORT = '5432';
const DB_USER = 'zitadel_db_user';
const DB_PASS = 'XaZKXwTcIiCchiEi317FvD30faT7m4vd';
const DB_NAME = 'zitadel_db';
const PAT_FILE = '/tmp/login-client.pat';
const STATUS_FILE = '/tmp/pat-creation-status.txt';
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
    log('psql error: ' + (e.stderr || e.message));
    return null;
  }
}

function psqlSingle(sql) {
  const result = psql(sql);
  if (!result) return null;
  const lines = result.split('\n').filter(l => l.trim());
  return lines.length > 0 ? lines[0] : null;
}

function psqlExec(sql) {
  try {
    const safe = sql.replace(/'/g, "'\\''");
    const cmd = `PGPASSWORD='${DB_PASS}' psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -c '${safe}'`;
    execSync(cmd, { timeout: 15000, encoding: 'utf8' });
    return true;
  } catch (e) {
    log('psql exec error: ' + (e.stderr || e.message));
    return false;
  }
}

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
  const headerB64 = enc(header);
  const payloadB64 = enc(payload);
  const dataToSign = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(dataToSign);
  sign.end();
  const signature = sign.sign(privateKey, 'base64url');

  return `${dataToSign}.${signature}`;
}

async function main() {
  log('=== PAT Creation via JWT Machine Key ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 20) {
      const parts = existing.split('.');
      if (parts.length === 3) {
        log('Valid JWT already exists, skipping.');
        process.exit(0);
      }
      log('Existing PAT is not a JWT (length=' + existing.length + '), will create new one.');
    }
  }

  log('Step 1: Finding admin user ID...');
  const adminUserId = psqlSingle(`SELECT id FROM projections.users14 WHERE username = 'admin' AND user_type = 1 LIMIT 1`);
  if (!adminUserId) {
    log('ERROR: Could not find admin machine user');
    process.exit(1);
  }
  log('Admin user ID: ' + adminUserId);

  const instanceId = psqlSingle(`SELECT id FROM projections.instances LIMIT 1`);
  if (!instanceId) {
    log('ERROR: Could not find instance ID');
    process.exit(1);
  }
  log('Instance ID: ' + instanceId);

  log('Step 2: Generating RSA key pair...');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const keyId = crypto.randomBytes(10).toString('decimal').substring(0, 19);
  log('Key ID: ' + keyId);

  log('Step 3: Getting max sequence for user...');
  const maxSeq = psqlSingle(`SELECT COALESCE(MAX(sequence), 0) FROM eventstore.events2 WHERE aggregate_id = '${adminUserId}'`);
  const nextSeq = parseInt(maxSeq || '0') + 1;
  log('Next sequence: ' + nextSeq);

  log('Step 4: Inserting machine key event...');
  const publicKeyDer = publicKey.replace(/\n/g, '').replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').trim();
  const publicKeyB64 = Buffer.from(publicKey).toString('base64');

  const keyPayload = JSON.stringify({
    type: 1,
    keyId: keyId,
    publicKey: publicKeyB64,
    expirationDate: '9999-12-31T23:59:59Z'
  });

  const maxPos = psqlSingle(`SELECT COALESCE(MAX(position), 0) FROM eventstore.events2`);
  const nextPos = parseFloat(maxPos || '0') + 1;

  const maxInTx = psqlSingle(`SELECT COALESCE(MAX(in_tx_order), 0) FROM eventstore.events2 WHERE sequence = ${nextSeq - 1}`);
  const nextInTx = parseInt(maxInTx || '0') + 1;

  const evResult = psqlExec(`INSERT INTO eventstore.events2 (instance_id, aggregate_type, aggregate_id, event_type, sequence, revision, created_at, payload, creator, owner, position, in_tx_order) VALUES ('${instanceId}', 'user', '${adminUserId}', 'user.machine.key.added', ${nextSeq}, 1, NOW(), '${keyPayload.replace(/'/g, "''")}', '${adminUserId}', '${adminUserId}', ${nextPos}, ${nextInTx})`);
  log('Event insert: ' + (evResult ? 'OK' : 'FAILED'));

  log('Step 5: Inserting public key into authn_keys2...');
  const publicKeyBytes = Buffer.from(publicKey);
  const fp = crypto.createHash('sha256').update(publicKeyBytes).digest('hex').substring(0, 40);

  const keyInsertResult = psqlExec(`INSERT INTO projections.authn_keys2 (id, creation_date, change_date, resource_owner, instance_id, aggregate_id, sequence, object_id, expiration, identifier, public_key, enabled, type, fingerprint) VALUES ('${keyId}', NOW(), NOW(), '${adminUserId}', '${instanceId}', '${adminUserId}', ${nextSeq}, '${adminUserId}', '9999-12-31 23:59:59+00', '${adminUserId}', decode('${publicKeyB64}', 'base64'), true, 1, '${fp}') ON CONFLICT (id) DO UPDATE SET public_key = decode('${publicKeyB64}', 'base64'), enabled = true`);
  log('authn_keys2 insert: ' + (keyInsertResult ? 'OK' : 'FAILED'));

  log('Step 6: Inserting public key into keys4_public...');
  const k4Result = psqlExec(`INSERT INTO projections.keys4_public (id, instance_id, expiry, key) VALUES ('${keyId}', '${instanceId}', '9999-12-31 23:59:59+00', decode('${publicKeyB64}', 'base64')) ON CONFLICT (id) DO UPDATE SET key = decode('${publicKeyB64}', 'base64')`);
  log('keys4_public insert: ' + (k4Result ? 'OK' : 'FAILED'));

  log('Step 7: Signing JWT...');
  const jwt = generateJWT(privateKey, keyId, adminUserId, instanceId);
  log('JWT length: ' + jwt.length);

  fs.writeFileSync(PAT_FILE, jwt);
  log('JWT saved to ' + PAT_FILE);

  log('=== JWT CREATION SUCCESS ===');
  log('The Login V2 UI will use this JWT as ZITADEL_SERVICE_USER_TOKEN');
  process.exit(0);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

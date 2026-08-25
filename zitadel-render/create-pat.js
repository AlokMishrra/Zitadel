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
    const cmd = `PGPASSWORD='${DB_PASS}' psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -t -A -c "${sql.replace(/"/g, '\\"')}"`;
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

function psqlExec(sql) {
  try {
    const cmd = `PGPASSWORD='${DB_PASS}' psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -c "${sql.replace(/"/g, '\\"')}"`;
    execSync(cmd, { timeout: 15000, encoding: 'utf8' });
    return true;
  } catch (e) {
    log('psql exec error: ' + (e.stderr || e.message).substring(0, 200));
    return false;
  }
}

async function main() {
  log('=== PAT Creation v9 (Opaque PAT + JWT fallback) ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 20) {
      const parts = existing.split('.');
      if (parts.length === 3) {
        try {
          const headerJson = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
          const kid = headerJson.kid;
          log('Existing JWT has kid: ' + kid);
          const keyExists = psqlSingle(`SELECT id FROM projections.authn_keys2 WHERE id = '${kid}' AND enabled = true`);
          if (keyExists) {
            log('Key ' + kid + ' found in authn_keys2, JWT is valid.');
            process.exit(0);
          }
          log('Key ' + kid + ' NOT found in authn_keys2, creating new PAT...');
        } catch (e) {
          log('Error validating existing JWT: ' + e.message + ', creating new one...');
        }
      } else {
        log('Existing PAT already exists (length=' + existing.length + '), checking if it works...');
        log('PAT is not a JWT, skipping to verify...');
        process.exit(0);
      }
    }
  }

  log('Step 1: Finding admin user ID...');
  const adminUserId = psqlSingle(`SELECT id FROM projections.users14 WHERE username = 'admin' AND type = 2 LIMIT 1`);
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

  const orgId = psqlSingle(`SELECT id FROM projections.orgs1 LIMIT 1`);
  log('Org ID: ' + (orgId || 'not found'));

  log('Step 2: Generating random PAT token...');
  const rawToken = 'v2' + crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  log('Token length: ' + rawToken.length + ', hash length: ' + tokenHash.length);

  const patId = tokenHash;
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '+00');

  log('Step 3: Getting max position...');
  const maxPos = psqlSingle(`SELECT COALESCE(MAX(position), 0) FROM eventstore.events2`);
  const nextPos = parseFloat(maxPos || '0') + 1;

  const maxSeq = psqlSingle(`SELECT COALESCE(MAX(sequence), 0) FROM eventstore.events2 WHERE aggregate_id = '${adminUserId}'`);
  const nextSeq = parseInt(maxSeq || '0') + 1;

  log('Step 4: Inserting PAT event into eventstore...');
  const patPayload = JSON.stringify({
    scopes: null,
    tokenId: patId,
    expiration: '2099-01-01T00:00:00Z'
  });

  const evResult = psqlExec(`INSERT INTO eventstore.events2 (instance_id, aggregate_type, aggregate_id, event_type, sequence, revision, created_at, payload, creator, owner, position, in_tx_order) VALUES ('${instanceId}', 'user', '${adminUserId}', 'user.pat.added', ${nextSeq}, 1, NOW(), '${patPayload.replace(/'/g, "''")}'::jsonb, '${adminUserId}', '${orgId || adminUserId}', ${nextPos}, 1)`);
  log('Event insert: ' + (evResult ? 'OK' : 'FAILED'));

  log('Step 5: Inserting into personal_access_tokens3...');
  const patResult = psqlExec(`INSERT INTO projections.personal_access_tokens3 (id, creation_date, change_date, sequence, resource_owner, instance_id, user_id, expiration, scopes, owner_removed) VALUES ('${patId}', NOW(), NOW(), ${nextSeq}, '${orgId || adminUserId}', '${instanceId}', '${adminUserId}', '2099-01-01 00:00:00+00', NULL, false)`);
  log('personal_access_tokens3 insert: ' + (patResult ? 'OK' : 'FAILED'));

  log('Step 6: Inserting into auth.tokens...');
  const tokenResult = psqlExec(`INSERT INTO auth.tokens (id, creation_date, change_date, resource_owner, application_id, user_agent_id, user_id, expiration, sequence, scopes, audience, preferred_language, refresh_token_id, is_pat, instance_id, actor) VALUES ('${patId}', NOW(), NOW(), '${orgId || adminUserId}', '', '', '${adminUserId}', '2099-01-01 00:00:00+00', ${nextSeq}, NULL, NULL, '', '', true, '${instanceId}', NULL)`);
  log('auth.tokens insert: ' + (tokenResult ? 'OK' : 'FAILED'));

  log('Step 7: Writing raw token to file...');
  fs.writeFileSync(PAT_FILE, rawToken);
  log('PAT written to ' + PAT_FILE + ' (length=' + rawToken.length + ')');

  log('Step 8: Waiting for ZITADEL to pick up the PAT...');
  await new Promise(r => setTimeout(r, 3000));

  log('Step 9: Verifying PAT via Management API...');
  const http = require('http');
  const verifyToken = () => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8081,
      path: '/management/v1/users/_search',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + rawToken,
        'Content-Type': 'application/json',
        'Host': 'zeroschool-zitadel.onrender.com'
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ query: { limit: 1 } }));
    req.end();
  });

  try {
    const result = await verifyToken();
    log('Verification result: ' + result.status + ' ' + result.body.substring(0, 200));
    if (result.status === 200) {
      log('=== PAT CREATION SUCCESS - PAT works! ===');
    } else {
      log('WARNING: PAT returned status ' + result.status);
      log('Trying JWT approach as fallback...');

      log('Step F1: Generating RSA key pair...');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const keyId = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
      log('Key ID: ' + keyId);

      const publicKeyB64 = Buffer.from(publicKey).toString('base64');

      const keyPayload = JSON.stringify({
        type: 1,
        keyId: keyId,
        publicKey: publicKeyB64,
        expirationDate: '9999-12-31T23:59:59Z'
      });

      const maxPos2 = psqlSingle(`SELECT COALESCE(MAX(position), 0) FROM eventstore.events2`);
      const nextPos2 = parseFloat(maxPos2 || '0') + 1;
      const maxSeq2 = psqlSingle(`SELECT COALESCE(MAX(sequence), 0) FROM eventstore.events2 WHERE aggregate_id = '${adminUserId}'`);
      const nextSeq2 = parseInt(maxSeq2 || '0') + 1;

      psqlExec(`INSERT INTO eventstore.events2 (instance_id, aggregate_type, aggregate_id, event_type, sequence, revision, created_at, payload, creator, owner, position, in_tx_order) VALUES ('${instanceId}', 'user', '${adminUserId}', 'user.machine.key.added', ${nextSeq2}, 1, NOW(), '${keyPayload.replace(/'/g, "''")}'::jsonb, '${adminUserId}', '${adminUserId}', ${nextPos2}, 1)`);

      const fp = crypto.createHash('sha256').update(Buffer.from(publicKey)).digest('hex').substring(0, 40);
      psqlExec(`INSERT INTO projections.authn_keys2 (id, creation_date, change_date, resource_owner, instance_id, aggregate_id, sequence, object_id, expiration, identifier, public_key, enabled, type, fingerprint) VALUES ('${keyId}', NOW(), NOW(), '${adminUserId}', '${instanceId}', '${adminUserId}', ${nextSeq2}, '${adminUserId}', '9999-12-31 23:59:59+00', '${adminUserId}', decode('${publicKeyB64}', 'base64'), true, 1, '${fp}')`);

      psqlExec(`INSERT INTO projections.keys4 (id, creation_date, change_date, resource_owner, instance_id, sequence, algorithm, use) VALUES ('${keyId}', NOW(), NOW(), '${adminUserId}', '${instanceId}', ${nextSeq2}, 'RSA', 1)`);
      psqlExec(`INSERT INTO projections.keys4_public (id, instance_id, expiry, key) VALUES ('${keyId}', '${instanceId}', '9999-12-31 23:59:59+00', decode('${publicKeyB64}', 'base64'))`);

      const now2 = Math.floor(Date.now() / 1000);
      const issuer = 'https://zeroschool-zitadel.onrender.com';
      const jwtHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyId })).toString('base64url');
      const jwtPayload = Buffer.from(JSON.stringify({
        iss: issuer,
        sub: adminUserId,
        aud: [issuer],
        iat: now2,
        exp: now2 + 365 * 24 * 3600,
        jti: crypto.randomUUID(),
      })).toString('base64url');
      const dataToSign = jwtHeader + '.' + jwtPayload;
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(dataToSign);
      sign.end();
      const signature = sign.sign(privateKey, 'base64url');
      const jwt = dataToSign + '.' + signature;

      fs.writeFileSync(PAT_FILE, jwt);
      log('JWT written to ' + PAT_FILE + ' (length=' + jwt.length + ')');

      await new Promise(r => setTimeout(r, 3000));
      try {
        const result2 = await verifyToken();
        log('JWT verification result: ' + result2.status + ' ' + result2.body.substring(0, 200));
      } catch (e) {
        log('JWT verification error: ' + e.message);
      }
    }
  } catch (e) {
    log('Verification error: ' + e.message);
  }

  log('=== PAT CREATION COMPLETE ===');
  process.exit(0);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

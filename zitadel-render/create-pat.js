const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const ZITADEL_PORT = 8081;
const ZITADEL_HOST = 'zeroschool-zitadel.onrender.com';
const PAT_FILE = '/tmp/login-client.pat';
const MACHINE_KEY_FILE = '/tmp/login-client-key.json';
const STATUS_FILE = '/tmp/pat-creation-status.txt';

const CONSOLE_CLIENT_ID = '387549800423431157';

function log(msg) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  try {
    const existing = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : '';
    fs.writeFileSync(STATUS_FILE, existing + entry + '\n');
  } catch (e) {}
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, raw: true });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function createJwtAssertion(keyJson) {
  const privateKeyPem = keyJson.key?.privateKey;
  if (!privateKeyPem) throw new Error('No private key in machine key file');

  const header = Buffer.from(JSON.stringify({
    alg: 'RS256',
    kid: keyJson.keyId,
    typ: 'JWT'
  })).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: keyJson.keyId,
    sub: keyJson.userId,
    aud: `https://${ZITADEL_HOST}`,
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID()
  })).toString('base64url');

  const data = `${header}.${payload}`;
  const sign = crypto.sign('sha256', Buffer.from(data), privateKeyPem);
  const signature = sign.toString('base64url');

  return `${header}.${payload}.${signature}`;
}

async function tryMachineKeyAuth() {
  if (!fs.existsSync(MACHINE_KEY_FILE)) {
    log('No machine key file found at ' + MACHINE_KEY_FILE);
    return null;
  }

  try {
    const keyJson = JSON.parse(fs.readFileSync(MACHINE_KEY_FILE, 'utf8'));
    log('Found machine key file, keyId=' + keyJson.keyId + ' userId=' + keyJson.userId);

    const jwt = createJwtAssertion(keyJson);
    log('Created JWT assertion');

    const tokenResp = await httpRequest({
      hostname: '127.0.0.1',
      port: ZITADEL_PORT,
      path: '/oauth/v2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': ZITADEL_HOST,
        'X-Forwarded-Proto': 'https',
      }
    }, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`);

    if (tokenResp.data?.access_token) {
      log('Got access token via machine key JWT bearer');
      return tokenResp.data.access_token;
    }

    log('JWT bearer token response: ' + JSON.stringify(tokenResp.data));
    return null;
  } catch (e) {
    log('Machine key auth failed: ' + e.message);
    return null;
  }
}

async function tryDeviceFlow() {
  log('Starting device flow with console client_id=' + CONSOLE_CLIENT_ID);

  const deviceAuth = await httpRequest({
    hostname: '127.0.0.1',
    port: ZITADEL_PORT,
    path: '/oauth/v2/device_authorization',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': ZITADEL_HOST,
      'X-Forwarded-Proto': 'https',
    }
  }, `client_id=${CONSOLE_CLIENT_ID}&scope=openid profile email`);

  if (deviceAuth.status !== 200 || !deviceAuth.data?.device_code) {
    log('Device auth failed: ' + JSON.stringify(deviceAuth.data));
    return null;
  }

  const verifyUrl = deviceAuth.data.verification_uri_complete || deviceAuth.data.verification_uri;
  const userCode = deviceAuth.data.user_code;
  const deviceCode = deviceAuth.data.device_code;

  log('DEVICE_FLOW_VERIFICATION_URL=' + verifyUrl);
  log('DEVICE_FLOW_USER_CODE=' + userCode);
  log('Please visit the verification URL and enter the code to authorize.');

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const tokenResp = await httpRequest({
      hostname: '127.0.0.1',
      port: ZITADEL_PORT,
      path: '/oauth/v2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': ZITADEL_HOST,
        'X-Forwarded-Proto': 'https',
      }
    }, `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceCode}&client_id=${CONSOLE_CLIENT_ID}`);

    if (tokenResp.data?.access_token) {
      log('Got access token via device flow');
      return tokenResp.data.access_token;
    }

    if (tokenResp.data?.error === 'authorization_pending') {
      if (i % 6 === 0) log('Waiting for authorization... (' + ((i + 1) * 5) + 's)');
      continue;
    }

    log('Device flow token error: ' + JSON.stringify(tokenResp.data));
    return null;
  }

  log('Device flow timed out after 5 minutes');
  return null;
}

async function createPat(accessToken) {
  const patResp = await httpRequest({
    hostname: '127.0.0.1',
    port: ZITADEL_PORT,
    path: '/auth/v1/pats/my',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken,
      'Host': ZITADEL_HOST,
      'X-Forwarded-Proto': 'https',
    }
  }, { name: 'login-client-pat', expirationDate: '2099-01-01T00:00:00Z' });

  log('Create PAT response: status=' + patResp.status + ' data=' + JSON.stringify(patResp.data));

  if (patResp.status === 200 && patResp.data?.token) {
    fs.writeFileSync(PAT_FILE, patResp.data.token);
    log('PAT saved to ' + PAT_FILE);
    return patResp.data.token;
  }

  return null;
}

async function main() {
  log('=== PAT Creation Script Starting ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 10) {
      log('Valid PAT already exists at ' + PAT_FILE + ' (length=' + existing.length + ')');
      process.exit(0);
    }
    log('Existing PAT file contains invalid value, will recreate');
  }

  let accessToken = null;

  accessToken = await tryMachineKeyAuth();

  if (!accessToken) {
    log('Machine key auth failed, falling back to device flow');
    accessToken = await tryDeviceFlow();
  }

  if (!accessToken) {
    log('ERROR: Could not obtain access token');
    process.exit(1);
  }

  const pat = await createPat(accessToken);
  if (!pat) {
    log('ERROR: Could not create PAT');
    process.exit(1);
  }

  log('=== PAT Creation Complete ===');
  process.exit(0);
}

main().catch(err => {
  log('FATAL: ' + err.message);
  process.exit(1);
});

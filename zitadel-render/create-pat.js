const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const ZITADEL_PORT = 8081;
const ZITADEL_HOST = 'zeroschool-zitadel.onrender.com';
const PAT_FILE = '/tmp/login-client.pat';
const STATUS_FILE = '/tmp/pat-creation-status.txt';
const MASTERKEY = 'jYCXFt5umAbioo2b9IBT6YjyamC8PvyM';

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

function tryParseToken(output) {
  const patterns = [
    /"token"\s*:\s*"([^"]+)"/,
    /token:\s*([A-Za-z0-9_\-\.]+)/,
    /PAT.*?([A-Za-z0-9_\-]{30,})/,
  ];
  for (const p of patterns) {
    const m = output.match(p);
    if (m && m[1] && m[1].length > 10) return m[1];
  }
  return null;
}

function tryCLICreate() {
  log('Trying zitadel user pat create...');
  try {
    const cmds = [
      `/app/zitadel user pat create --masterkey "${MASTERKEY}" --host ${ZITADEL_HOST} --insecure --name login-pat --username school@zeroschool.localhost --exp 2099-01-01T00:00:00Z`,
      `/app/zitadel user pat create --masterkey "${MASTERKEY}" --host ${ZITADEL_HOST} --insecure --config /dev/null --name login-pat --username school@zeroschool.localhost --exp 2099-01-01T00:00:00Z`,
      `/app/zitadel user pat add --masterkey "${MASTERKEY}" --host ${ZITADEL_HOST} --insecure --name login-pat --username school@zeroschool.localhost --exp 2099-01-01T00:00:00Z`,
    ];
    for (const cmd of cmds) {
      log('CLI cmd: ' + cmd);
      try {
        const out = execSync(cmd, { timeout: 30000, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
        log('CLI stdout: ' + out);
        const token = tryParseToken(out);
        if (token) return token;
      } catch (e) {
        log('CLI error: ' + (e.stderr || e.message || '').substring(0, 500));
        if (e.stdout) log('CLI stdout: ' + String(e.stdout).substring(0, 500));
      }
    }
  } catch (e) {
    log('CLI setup failed: ' + e.message);
  }
  return null;
}

async function tryDeviceFlow() {
  log('Starting device flow...');
  let deviceAuth;
  try {
    deviceAuth = await httpRequest({
      hostname: '127.0.0.1', port: ZITADEL_PORT,
      path: '/oauth/v2/device_authorization', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Host': ZITADEL_HOST, 'X-Forwarded-Proto': 'https' }
    }, `client_id=387549800423431157&scope=openid profile email`);
  } catch (e) { log('Device auth failed: ' + e.message); return null; }

  if (deviceAuth.status !== 200 || !deviceAuth.data?.device_code) {
    log('Device auth response: ' + JSON.stringify(deviceAuth.data));
    return null;
  }

  log('VISIT: ' + (deviceAuth.data.verification_uri_complete || deviceAuth.data.verification_uri));
  log('CODE: ' + deviceAuth.data.user_code);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    let tokenResp;
    try {
      tokenResp = await httpRequest({
        hostname: '127.0.0.1', port: ZITADEL_PORT,
        path: '/oauth/v2/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Host': ZITADEL_HOST, 'X-Forwarded-Proto': 'https' }
      }, `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceAuth.data.device_code}&client_id=387549800423431157`);
    } catch (e) { continue; }

    if (tokenResp.data?.access_token) return tokenResp.data.access_token;
    if (tokenResp.data?.error === 'authorization_pending') continue;
    log('Device flow error: ' + JSON.stringify(tokenResp.data));
    return null;
  }
  return null;
}

async function createPat(accessToken) {
  try {
    const patResp = await httpRequest({
      hostname: '127.0.0.1', port: ZITADEL_PORT,
      path: '/auth/v1/pats/my', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken, 'Host': ZITADEL_HOST, 'X-Forwarded-Proto': 'https' }
    }, { name: 'login-client-pat', expirationDate: '2099-01-01T00:00:00Z' });

    log('Create PAT: status=' + patResp.status);
    if (patResp.status === 200 && patResp.data?.token) {
      fs.writeFileSync(PAT_FILE, patResp.data.token);
      log('PAT saved (length=' + patResp.data.token.length + ')');
      return patResp.data.token;
    }
    log('PAT response: ' + JSON.stringify(patResp.data));
  } catch (e) {
    log('PAT create failed: ' + e.message);
  }
  return null;
}

async function main() {
  log('=== PAT Creation Script Starting ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 10) {
      log('Valid PAT already exists (length=' + existing.length + ')');
      process.exit(0);
    }
  }

  let token = tryCLICreate();
  if (token) {
    fs.writeFileSync(PAT_FILE, token);
    log('PAT saved from CLI (length=' + token.length + ')');
    process.exit(0);
  }

  log('CLI failed, trying device flow...');
  token = await tryDeviceFlow();
  if (token) {
    const pat = await createPat(token);
    if (pat) process.exit(0);
  }

  log('All methods failed. Login UI will run without PAT.');
  process.exit(1);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

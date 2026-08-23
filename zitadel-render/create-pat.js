const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const ZITADEL_PORT = 8081;
const ZITADEL_HOST = 'zeroschool-zitadel.onrender.com';
const PAT_FILE = '/tmp/login-client.pat';
const STATUS_FILE = '/tmp/pat-creation-status.txt';

const CONSOLE_CLIENT_ID = '387549800423431157';
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

async function tryZitadelCLI() {
  log('Trying ZITADEL CLI to create PAT...');
  try {
    const result = execSync(
      '/app/zitadel user pat create ' +
      '--masterkey "' + MASTERKEY + '" ' +
      '--host ' + ZITADEL_HOST + ' ' +
      '--insecure ' +
      '--name "login-pat" ' +
      '--username "school@zeroschool.localhost" ' +
      '--exp "2099-01-01T00:00:00Z"',
      { timeout: 30000, encoding: 'utf8' }
    );
    log('CLI output: ' + result);

    const patMatch = result.match(/token['":\s]+([A-Za-z0-9_\-\.]+)/i) || result.match(/([A-Za-z0-9_\-]{20,})/);
    if (patMatch) {
      const token = patMatch[1];
      fs.writeFileSync(PAT_FILE, token);
      log('PAT saved from CLI output (length=' + token.length + ')');
      return token;
    }
    log('CLI ran but could not parse PAT from output');
    return null;
  } catch (e) {
    log('CLI failed: ' + e.message);
    if (e.stdout) log('CLI stdout: ' + e.stdout);
    if (e.stderr) log('CLI stderr: ' + e.stderr);
    return null;
  }
}

async function tryDeviceFlow() {
  log('Starting device flow with console client_id=' + CONSOLE_CLIENT_ID);

  let deviceAuth;
  try {
    deviceAuth = await httpRequest({
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
  } catch (e) {
    log('Device auth request failed: ' + e.message);
    return null;
  }

  if (deviceAuth.status !== 200 || !deviceAuth.data?.device_code) {
    log('Device auth failed: ' + JSON.stringify(deviceAuth.data));
    return null;
  }

  const verifyUrl = deviceAuth.data.verification_uri_complete || deviceAuth.data.verification_uri;
  const userCode = deviceAuth.data.user_code;
  const deviceCode = deviceAuth.data.device_code;

  log('=== DEVICE FLOW ACTIVE ===');
  log('VISIT THIS URL TO AUTHORIZE: ' + verifyUrl);
  log('USER CODE: ' + userCode);
  log('Check /debug/pat-status for this info');
  log('===========================');

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));

    let tokenResp;
    try {
      tokenResp = await httpRequest({
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
    } catch (e) {
      log('Token poll failed: ' + e.message);
      continue;
    }

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
  let patResp;
  try {
    patResp = await httpRequest({
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
  } catch (e) {
    log('PAT create request failed: ' + e.message);
    return null;
  }

  log('Create PAT response: status=' + patResp.status + ' data=' + JSON.stringify(patResp.data));

  if (patResp.status === 200 && patResp.data?.token) {
    fs.writeFileSync(PAT_FILE, patResp.data.token);
    log('PAT saved to ' + PAT_FILE + ' (length=' + patResp.data.token.length + ')');
    return patResp.data.token;
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
    log('Existing PAT file contains invalid value, will recreate');
  }

  let accessToken = null;

  accessToken = await tryDeviceFlow();

  if (!accessToken) {
    log('ERROR: Could not obtain access token via any method');
    log('Manual intervention required: check /debug/pat-status for device flow URL');
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

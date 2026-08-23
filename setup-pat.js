const https = require('https');
const http = require('http');
const crypto = require('crypto');

const Z = 'zeroschool-zitadel.onrender.com';

function httpsReq(host, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const ct = headers['Content-Type'] || 'application/json';
    const opts = { hostname: host, path, method, headers: { 'Content-Type': ct, ...headers } };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function httpReq(port, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Step 1: Start device authorization
  console.log('\n1. Starting device authorization...');
  const scope = crypto.randomBytes(8).toString('hex');
  const deviceResp = await httpsReq(Z, '/oauth/v2/device_authorization', 'POST',
    'scope=openid profile email offline_access', 'application/x-www-form-urlencoded');

  console.log('Device auth status:', deviceResp.status);
  const deviceData = JSON.parse(deviceResp.body);
  console.log('Verification URI:', deviceData.verification_uri);
  console.log('User code:', deviceData.user_code);
  console.log('Device code:', deviceData.device_code);
  console.log('\n*** OPEN THIS URL IN YOUR BROWSER AND LOGIN ***');
  console.log('*** URL:', deviceData.verification_uri, '***');
  console.log('*** CODE:', deviceData.user_code, '***');

  // Step 2: Start local server to receive callback (not needed for device flow)
  // Step 3: Poll for token
  console.log('\n2. Polling for token...');
  let token = null;
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const pollResp = await httpsReq(Z, '/oauth/v2/token', 'POST',
      `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceData.device_code}&client_id=296056146375029355@zitadel`,
      'application/x-www-form-urlencoded');

    if (pollResp.status === 200) {
      token = JSON.parse(pollResp.body);
      console.log('\nGot token!');
      break;
    }
    const errData = JSON.parse(pollResp.body);
    if (errData.error === 'authorization_pending') {
      process.stdout.write('.');
      continue;
    }
    console.log('\nPoll error:', errData);
    break;
  }

  if (!token) {
    console.log('\nFailed to get token. Please create a PAT manually:');
    console.log('1. Go to https://zeroschool-zitadel.onrender.com/console');
    console.log('2. Login as school@zeroschool.localhost / Zeroschool@123');
    console.log('3. Go to GRPC & API > Personal Access Tokens');
    console.log('4. Create a PAT and copy the value');
    console.log('5. Set it as ZITADEL_PAT env var on the custom-ui service');
    return;
  }

  const accessToken = token.access_token;
  console.log('\nAccess token obtained');

  // Step 3: Create PAT via management API
  console.log('\n3. Creating PAT...');
  const patResp = await httpsReq(Z, '/auth/v1/pats', 'POST', {
    name: 'custom-ui-pat',
    expirationDate: '2028-01-01T00:00:00Z',
  }, { Authorization: `Bearer ${accessToken}` });

  console.log('PAT create status:', patResp.status);
  console.log('PAT response:', patResp.body);

  if (patResp.status === 201) {
    const patData = JSON.parse(patResp.body);
    const patValue = patData.token || patData.pat?.token;
    console.log('\n*** PAT VALUE (set this as ZITADEL_PAT):', patValue, '***');
  }
}

main().catch(console.error);

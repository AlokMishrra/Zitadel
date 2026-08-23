const https = require('https');

function apiCall(host, path, method, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      hostname: host,
      path,
      method,
      headers: { 'Content-Type': contentType },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        console.log(`=== ${method} ${path} => ${res.statusCode} ===`);
        console.log(b.substring(0, 500));
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const Z = 'zeroschool-zitadel.onrender.com';

  // Get OIDC token with username/password
  console.log('\n--- OIDC Token ---');
  const tokenBody = 'grant_type=password&username=school%40zeroschool.org&password=Zeroschool%40123&scope=openid+profile+email+offline_access';
  const tokenResp = await apiCall(Z, '/oauth/v2/token', 'POST', tokenBody, 'application/x-www-form-urlencoded');

  if (tokenResp.status === 200) {
    const tok = JSON.parse(tokenResp.body);
    const accessToken = tok.access_token;
    console.log('\nGot access token');

    // Create PAT
    console.log('\n--- Creating PAT ---');
    const patResp = await apiCall(Z, '/auth/v1/pats', 'POST', {
      name: 'custom-ui-pat',
      expirationDate: '2027-12-31T23:59:59Z',
    }, 'application/json');
    
    // Need Bearer token
    const patResp2 = await apiCall(Z, '/auth/v1/pats', 'POST', {
      name: 'custom-ui-pat',
      expirationDate: '2027-12-31T23:59:59Z',
    });
  } else {
    // Try machine user login
    console.log('\n--- Try machine user auth ---');
    const machineBody = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&scope=openid';
    // Need to get a service account token first using the admin credentials
    // Use the OIDC token endpoint with password grant
    console.log('Token failed, trying alternate approach...');
  }
}

main().catch(console.error);

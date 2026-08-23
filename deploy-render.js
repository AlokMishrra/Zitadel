const https = require('https');
const API_KEY = 'rnd_yGvScbUkZPFAY5LBRtRpV3jJNAOq';

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      hostname: 'api.render.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        console.log(`=== ${method} ${path} => ${res.statusCode} ===`);
        console.log(b.substring(0, 300));
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const ZITADEL_ID = 'srv-da5fnobtqb8s73ab0b3g';
  const CUSTOMUI_ID = 'srv-da5fnouk1f9s738h6ht0';

  // Redeploy ZITADEL with updated env vars
  console.log('\n--- Redeploy ZITADEL ---');
  await apiCall('POST', `/v1/services/${ZITADEL_ID}/deploys`);

  // Redeploy custom-ui
  console.log('\n--- Redeploy custom-ui ---');
  await apiCall('POST', `/v1/services/${CUSTOMUI_ID}/deploys`);

  // Check ZITADEL deploy status
  console.log('\n--- ZITADEL deploy status ---');
  await apiCall('GET', `/v1/services/${ZITADEL_ID}/deploys?limit=1`);

  // Check custom-ui deploy status
  console.log('\n--- custom-ui deploy status ---');
  await apiCall('GET', `/v1/services/${CUSTOMUI_ID}/deploys?limit=1`);

  console.log('\n\n=== URLs ===');
  console.log('ZITADEL: https://zeroschool-zitadel.onrender.com');
  console.log('Custom UI: https://zeroschool-custom-ui.onrender.com');
}

main().catch(console.error);

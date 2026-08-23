const https = require('https');
const API_KEY = 'rnd_yGvScbUkZPFAY5LBRtRpV3jJNAOq';

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
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
        try { console.log(JSON.stringify(JSON.parse(b), null, 2).substring(0, 600)); } catch { console.log(b.substring(0, 600)); }
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Use node:20-alpine image directly, install pg+express at runtime via a simple command
  console.log('\n--- Creating DB wipe service ---');
  const createResult = await apiCall('POST', '/v1/services', {
    name: 'db-wipe-job',
    type: 'web_service',
    ownerId: 'tea-d0abo3adbo4c73eb0r5g',
    repo: 'https://github.com/AlokMishrra/Zitadel',
    branch: 'master',
    autoDeploy: 'no',
    serviceDetails: {
      runtime: 'docker',
      env: 'docker',
      plan: 'free',
      region: 'oregon',
      buildPlan: 'starter',
      numInstances: 1,
      envVars: [
        { key: 'DB_HOST', value: 'dpg-da47aj2jobas73aeuag0-a.oregon-postgres.render.com' },
        { key: 'DB_PORT', value: '5432' },
        { key: 'DB_NAME', value: 'zitadel_db' },
        { key: 'DB_USER', value: 'zitadel_db_user' },
        { key: 'DB_PASS', value: 'XaZKXwTcIiCchiEi317FvD30faT7m4vd' },
        { key: 'PORT', value: '3000' },
      ],
      envSpecificDetails: {
        dockerfilePath: './Dockerfile.wipe',
        dockerContext: '.',
      },
    },
  });

  if (createResult.status !== 201) {
    console.log('Failed to create wipe service');
    return;
  }

  const wipeJobId = JSON.parse(createResult.body).service.id;
  console.log('Wipe service created:', wipeJobId);

  // Trigger deploy
  console.log('\n--- Triggering wipe deploy ---');
  await apiCall('POST', `/v1/services/${wipeJobId}/deploys`);

  // Wait for build+run
  console.log('\n--- Waiting 120s for wipe to complete ---');
  await sleep(120000);

  // Check status
  console.log('\n--- Check wipe deploy status ---');
  await apiCall('GET', `/v1/services/${wipeJobId}/deploys?limit=1`);

  // Delete
  console.log('\n--- Deleting wipe service ---');
  await apiCall('DELETE', `/v1/services/${wipeJobId}`);

  // Redeploy ZITADEL
  console.log('\n--- Redeploying ZITADEL ---');
  await apiCall('POST', '/v1/services/srv-da5fnobtqb8s73ab0b3g/deploys');

  // Redeploy custom-ui
  console.log('\n--- Redeploying custom-ui ---');
  await apiCall('POST', '/v1/services/srv-da5fnouk1f9s738h6ht0/deploys');

  console.log('\n\n=== ALL DONE ===');
}

main().catch(console.error);

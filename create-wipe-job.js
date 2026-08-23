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
        console.log(b.substring(0, 400));
        resolve({ status: res.statusCode, body: b });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Create a Docker job that wipes the DB and exits
  console.log('\n--- Creating DB wipe job ---');
  const result = await apiCall('POST', '/v1/services', {
    name: 'zeroschool-db-wipe',
    type: 'background_worker',
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
      ],
      envSpecificDetails: {
        dockerfilePath: './Dockerfile.wipe',
        dockerContext: '.',
        dockerCommand: 'node wipe-db.js',
      },
    },
  });

  if (result.status === 201) {
    const svc = JSON.parse(result.body).service;
    console.log('Job created:', svc.id);
  }
}

main().catch(console.error);

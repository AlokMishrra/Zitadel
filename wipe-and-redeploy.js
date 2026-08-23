const { Client } = require('pg');
const https = require('https');

async function wipeDB() {
  const c = new Client({
    connectionString: 'postgresql://zitadel_db_user:XaZKXwTcIiCchiEi317FvD30faT7m4vd@dpg-da47aj2jobas73aeuag0-a.oregon-postgres.render.com:5432/zitadel_db?sslmode=require',
    ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('DB wiped successfully');
  await c.end();
}

function redeploy(serviceId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.render.com',
      path: `/v1/services/${serviceId}/deploys`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer rnd_yGvScbUkZPFAY5LBRtRpV3jJNAOq',
        'Content-Type': 'application/json',
        'Content-Length': 2
      }
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { console.log(`Deploy ${serviceId}: ${res.statusCode}`); resolve(); });
    });
    req.write('{}');
    req.end();
  });
}

async function main() {
  await wipeDB();
  await redeploy('srv-da5fnobtqb8s73ab0b3g');
  await redeploy('srv-da5fnouk1f9s738h6ht0');
  console.log('Both services redeployed. ZITADEL will reinitialize with correct domain.');
}

main().catch(console.error);

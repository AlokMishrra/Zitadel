const https = require('https');

const data = JSON.stringify({
  name: 'zitadel-render',
  type: 'web_service',
  ownerId: 'tea-d0abo3adbo4c73eb0r5g',
  repo: 'https://github.com/school-zeroschool/zitadel-render',
  branch: 'master',
  serviceDetails: {
    runtime: 'docker',
    dockerfilePath: './Dockerfile',
    dockerContext: '.',
    envVars: [
      { key: 'ZITADEL_DATABASE_POSTGRES_HOST', value: 'dpg-da47aj2jobas73aeuag0-a' },
      { key: 'ZITADEL_DATABASE_POSTGRES_PORT', value: '5432' },
      { key: 'ZITADEL_DATABASE_POSTGRES_DATABASE', value: 'zitadel_db' },
      { key: 'ZITADEL_DATABASE_POSTGRES_USER_USERNAME', value: 'zitadel_db_user' },
      { key: 'ZITADEL_DATABASE_POSTGRES_USER_PASSWORD', value: 'XaZKXwTcIiCchiEi317FvD30faT7m4vd', generation: 'SECRET' },
      { key: 'ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME', value: 'zitadel_db_user' },
      { key: 'ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD', value: 'XaZKXwTcIiCchiEi317FvD30faT7m4vd', generation: 'SECRET' },
      { key: 'ZITADEL_EXTERNALSECURE', value: 'false' },
      { key: 'ZITADEL_DEBUG_MODE', value: 'true' },
      { key: 'PORT', value: '8080' },
    ],
    env: 'docker',
    buildPlan: 'starter',
    numInstances: 1,
    plan: 'free',
    region: 'oregon',
    ipAllowList: [{ cidrBlock: '0.0.0.0/0', description: 'everywhere' }],
  },
});

const req = https.request(
  {
    hostname: 'api.render.com',
    path: '/v1/services',
    method: 'POST',
    headers: {
      Authorization: 'Bearer rnd_cUnLrZ7PloFG8eeazsubD9ccLSBO',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  },
  (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => {
      console.log('Status:', res.statusCode);
      console.log('Body:', b);
    });
  }
);
req.write(data);
req.end();

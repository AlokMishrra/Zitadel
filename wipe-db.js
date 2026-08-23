const { Client } = require('pg');
const express = require('express');
const app = express();

async function main() {
  console.log('Connecting to DB...');
  const c = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    ssl: { rejectUnauthorized: false }
  });
  await c.connect();
  console.log('Connected. Dropping all schemas...');
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('DB wiped successfully!');
  await c.end();
  process.env.WIPE_DONE = 'true';
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

app.get('/', (req, res) => {
  res.json({ status: process.env.WIPE_DONE ? 'done' : 'in_progress' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Listening on', port));

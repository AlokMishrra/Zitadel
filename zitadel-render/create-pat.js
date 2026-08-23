const { execSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const DB_HOST = 'dpg-da47aj2jobas73aeuag0-a';
const DB_PORT = '5432';
const DB_USER = 'zitadel_db_user';
const DB_PASS = 'XaZKXwTcIiCchiEi317FvD30faT7m4vd';
const DB_NAME = 'zitadel_db';
const PAT_FILE = '/tmp/login-client.pat';
const STATUS_FILE = '/tmp/pat-creation-status.txt';
const PAT_SECRET = crypto.randomBytes(24).toString('base64url');

function log(msg) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${msg}`;
  console.log(entry);
  try {
    const existing = fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE, 'utf8') : '';
    fs.writeFileSync(STATUS_FILE, existing + entry + '\n');
  } catch (e) {}
}

function psql(sql) {
  try {
    const escaped = sql.replace(/"/g, '\\"');
    const cmd = `PGPASSWORD='${DB_PASS}' psql "sslmode=require host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME} user=${DB_USER}" -t -A -c "${escaped}"`;
    return execSync(cmd, { timeout: 15000, encoding: 'utf8' }).trim();
  } catch (e) {
    log('psql error: ' + (e.stderr || e.message));
    return null;
  }
}

function psqlSingle(sql) {
  const result = psql(sql);
  if (result === null) return null;
  const lines = result.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;
  return lines[0];
}

async function main() {
  log('=== PAT Creation via Direct DB ===');

  if (fs.existsSync(PAT_FILE)) {
    const existing = fs.readFileSync(PAT_FILE, 'utf8').trim();
    if (existing && existing !== 'no-pat' && existing.length > 10) {
      log('Valid PAT already exists (length=' + existing.length + '), skipping.');
      process.exit(0);
    }
  }

  log('Step 1: Finding admin user ID...');
  const userId = psqlSingle(`SELECT id FROM projections.users8 WHERE username = 'school@zeroschool.localhost' AND user_type = 0 LIMIT 1`);
  if (!userId) {
    const userId2 = psqlSingle(`SELECT id FROM projections.users8 WHERE username LIKE '%school%' LIMIT 1`);
    if (userId2) {
      log('Found user via fallback: ' + userId2);
      return await createPatForUser(userId2);
    }
    log('ERROR: Could not find admin user in DB');
    log('Trying to list all users...');
    const allUsers = psql(`SELECT id, username, user_type FROM projections.users8 LIMIT 20`);
    log('Users: ' + (allUsers || 'none'));
    process.exit(1);
  }
  log('Admin user ID: ' + userId);

  await createPatForUser(userId);
}

async function createPatForUser(userId) {
  log('Step 2: Examining PAT table schema...');
  const tables = psql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'projections' AND table_name LIKE '%pat%' ORDER BY table_name`);
  log('PAT tables: ' + (tables || 'none'));

  const tableColumns = psql(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'projections' AND table_name LIKE '%pat%' ORDER BY table_name, ordinal_position`);
  log('PAT columns: ' + (tableColumns || 'none'));

  log('Step 3: Checking for existing PATs...');
  const existingPat = psql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'projections' AND table_name LIKE '%personal_access%' ORDER BY table_name DESC LIMIT 1`);
  log('Latest PAT table: ' + (existingPat || 'none'));

  if (existingPat) {
    const patRows = psql(`SELECT * FROM projections."${existingPat}" LIMIT 5`);
    log('Existing PAT rows: ' + (patRows || 'none'));
  }

  const allPatTables = psql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'projections' ORDER BY table_name`);
  log('All projection tables: ' + (allPatTables || 'none'));

  log('Step 4: Looking for the token hash column and auth methods...');
  const authTables = psql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'projections' AND (table_name LIKE '%auth%' OR table_name LIKE '%token%' OR table_name LIKE '%method%') ORDER BY table_name`);
  log('Auth tables: ' + (authTables || 'none'));

  log('Step 5: Checking login client user...');
  const loginClient = psql(`SELECT id, username, user_type FROM projections.users8 WHERE username = 'login-client' LIMIT 1`);
  log('Login client: ' + (loginClient || 'none'));

  const machineUsers = psql(`SELECT id, username, user_type FROM projections.users8 WHERE user_type != 0 OR username LIKE '%machine%' OR username LIKE '%login%' OR username = 'admin' LIMIT 20`);
  log('Machine/admin users: ' + (machineUsers || 'none'));

  log('Step 6: Trying to find PAT via admin API token lookup...');
  const instanceId = psqlSingle(`SELECT id FROM projections.instances LIMIT 1`);
  log('Instance ID: ' + (instanceId || 'none'));

  log('=== DB exploration complete. Check /debug/db for manual queries. ===');
  log('Cannot auto-create PAT without knowing hash algorithm.');
  log('Visit /setup to create PAT manually via Console UI.');
  process.exit(1);
}

main().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

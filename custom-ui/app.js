const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const XLSX = require('xlsx');
const { Client } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'zeroschool-session-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const upload = multer({ dest: path.join(__dirname, 'uploads') });

let savedPAT = null;

app.post('/api/save-pat', (req, res) => {
  const { pat } = req.body;
  if (!pat) return res.status(400).json({ error: 'Missing pat' });
  savedPAT = pat;
  cachedPAT = pat;
  console.log('PAT received and cached:', pat.substring(0, 20) + '...');
  res.json({ success: true });
});

app.get('/api/get-pat', (req, res) => {
  res.json({ pat: savedPAT || cachedPAT || null });
});

app.get('/api/wipe-db', async (req, res) => {
  try {
    const c = new Client({
      host: 'dpg-da47aj2jobas73aeuag0-a',
      port: 5432,
      database: 'zitadel_db',
      user: 'zitadel_db_user',
      password: 'XaZKXwTcIiCchiEi317FvD30faT7m4vd',
      ssl: false
    });
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
    res.json({ success: true, message: 'DB wiped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

const PORT = 3000;
const ZITADEL_EXTERNAL = process.env.ZITADEL_EXTERNAL_ISSUER || 'http://localhost:8080';
const ZITADEL_INTERNAL = process.env.ZITADEL_INTERNAL || 'http://zitadel:8080';
const PAT_FILE = process.env.PAT_FILE || '/zitadel/bootstrap/admin.pat';
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || '387166122471849987';

const SCHOOLS = [
  { id: 'sch001', name: 'ZeroSchool Primary' },
  { id: 'sch002', name: 'ZeroSchool Secondary' },
  { id: 'sch003', name: 'ZeroSchool High School' },
  { id: 'sch004', name: 'ZeroSchool Academy' },
];
const CLASSES = ['1','2','3','4','5','6','7','8','9','10','11','12'];

let cachedPAT = null;

function getPAT() {
  if (cachedPAT) return cachedPAT;
  if (savedPAT) { cachedPAT = savedPAT; return cachedPAT; }
  const envPAT = (process.env.ZITADEL_PAT || '').trim();
  if (envPAT) { cachedPAT = envPAT; return cachedPAT; }
  try {
    const raw = fs.readFileSync(PAT_FILE, 'utf8').trim();
    try { cachedPAT = JSON.parse(raw).token || raw; } catch { cachedPAT = raw; }
    if (cachedPAT) return cachedPAT;
  } catch (e) { /* fall through to the explicit error below */ }
  // Previously this returned null and zitadelHeaders() sent the literal string
  // "Bearer null", which ZITADEL rejects as Errors.Token.Invalid (AUTH-7fs1e).
  // Fail loudly instead so the real cause is obvious.
  throw new Error(
    'No ZITADEL service token available. Set the ZITADEL_PAT environment variable ' +
    `(or place a token at ${PAT_FILE}, or POST one to /api/save-pat).`
  );
}

// Drop the cached token so the next call re-reads env/file. Used when ZITADEL
// rejects the token, e.g. after the instance was re-initialised and the old
// PAT no longer exists.
function invalidatePAT() {
  cachedPAT = null;
  savedPAT = null;
}

function isAuthError(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.message || '';
  return status === 401 || status === 403 || msg.includes('Errors.Token.Invalid') || msg.includes('AUTH-7fs1e');
}

function zitadelHeaders() {
  // Host must match ZITADEL's configured ExternalDomain. Derive it from the
  // target URL rather than hardcoding, so changing ZITADEL_INTERNAL can't
  // silently produce a mismatched Host header.
  let host;
  try { host = new URL(ZITADEL_INTERNAL).host; } catch (e) { host = 'zeroschool-zitadel.onrender.com'; }
  return { Authorization: `Bearer ${getPAT()}`, Host: host, 'Content-Type': 'application/json' };
}

function detectRole(host) {
  if (!host) return 'student';
  const h = host.split(':')[0];
  if (h.startsWith('student.')) return 'student';
  if (h.startsWith('teacher.')) return 'teacher';
  return 'student';
}

const c = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ZITADEL parses phone numbers to E.164 and, without a country code, falls back
// to its own default (observed: +41 Switzerland), silently corrupting the number.
// Always send an explicit country code.
const DEFAULT_PHONE_CC = process.env.DEFAULT_PHONE_COUNTRY_CODE || '+91';

function normalizePhone(phone) {
  if (!phone) return null;
  const raw = String(phone).trim();
  if (raw.startsWith('+')) return '+' + raw.slice(1).replace(/\D/g, '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  const cc = DEFAULT_PHONE_CC.replace(/\D/g, '');
  // Already prefixed with the country code but missing the leading '+'.
  if (digits.length > 10 && digits.startsWith(cc)) return '+' + digits;
  return DEFAULT_PHONE_CC + digits;
}

function generateBaseEmail(firstName, className, schoolId) {
  return `st${c(firstName)}${c(className)}${c(schoolId)}`;
}

function generateTeacherBaseEmail(firstName, lastName, schoolId) {
  return `te${c(firstName)}${c(lastName)}${c(schoolId)}`;
}

async function tryCreateStudent(firstName, lastName, className, schoolId, phone, password, loginName) {
  const school = SCHOOLS.find(s => s.id === schoolId);
  const username = loginName + '@zeroschool.localhost';
  const email = loginName + '@zeroschool.org';
  const payload = {
    username,
    profile: { givenName: firstName, familyName: lastName || '', displayName: `${firstName} ${lastName || ''}`.trim() },
    email: { email, isVerified: true },
    phone: normalizePhone(phone) ? { phone: normalizePhone(phone), isVerified: true } : undefined,
    password: { password, changeRequired: false },
    metadata: [
      { key: 'role', value: Buffer.from('student').toString('base64') },
      { key: 'school_id', value: Buffer.from(schoolId).toString('base64') },
      { key: 'school_name', value: Buffer.from(school ? school.name : schoolId).toString('base64') },
      { key: 'class', value: Buffer.from(className).toString('base64') },
    ],
  };
  await axios.post(`${ZITADEL_INTERNAL}/v2/users/human`, payload, { headers: zitadelHeaders() });
  return { loginName, email, username };
}

function generateEmailCandidates(firstName, className, schoolId, phone) {
  const base = generateBaseEmail(firstName, className, schoolId);
  const candidates = [base];
  const phoneLast4 = phone ? String(phone).replace(/\D/g, '').slice(-4) : null;
  if (phoneLast4 && phoneLast4.length === 4) candidates.push(base + phoneLast4);
  for (let i = 1; i <= 99; i++) candidates.push(base + String(i).padStart(2, '0'));
  return candidates;
}

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const specials = '@#!?';
  const all = upper + lower + digits + specials;
  let pw = upper.charAt(Math.floor(Math.random() * upper.length))
         + lower.charAt(Math.floor(Math.random() * lower.length))
         + digits.charAt(Math.floor(Math.random() * digits.length))
         + specials.charAt(Math.floor(Math.random() * specials.length));
  for (let i = 4; i < 12; i++) pw += all.charAt(Math.floor(Math.random() * all.length));
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

function authRequired(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

app.use((req, res, next) => {
  req.userRole = detectRole(req.headers.host);
  next();
});

app.get('/api/schools', (req, res) => res.json(SCHOOLS));
app.get('/api/classes', (req, res) => res.json(CLASSES));

app.get('/api/generate-email', async (req, res) => {
  try {
    const { firstName, className, schoolId, lastName, role } = req.query;
    if (!firstName || !schoolId) return res.status(400).json({ error: 'Missing fields' });
    if (role === 'teacher') {
      if (!lastName) return res.status(400).json({ error: 'Missing last name' });
      const base = generateTeacherBaseEmail(firstName, lastName, schoolId);
      return res.json({ email: base + '@zeroschool.org' });
    }
    if (!className) return res.status(400).json({ error: 'Missing class' });
    const candidates = generateEmailCandidates(firstName, className, schoolId, null);
    const base = generateBaseEmail(firstName, className, schoolId);
    res.json({ email: base + '@zeroschool.org', username: candidates[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.redirect('/register'));
app.get('/login', (req, res) => {
  const role = req.userRole || 'student';
  res.sendFile(path.join(__dirname, 'views', `${role}-login.html`));
});
app.get('/register', (req, res) => {
  const role = req.userRole || 'student';
  res.sendFile(path.join(__dirname, 'views', `${role}-register.html`));
});
app.get('/register/step2', (req, res) => {
  const role = req.userRole || 'student';
  res.sendFile(path.join(__dirname, 'views', `${role}-register-step2.html`));
});
app.get('/bulk-upload', authRequired, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'bulk-upload.html'));
});

app.post('/api/login', async (req, res) => {
  try {
    const { loginName, password } = req.body;
    if (!loginName || !password) return res.status(400).json({ error: 'Username and password required' });

    const role = detectRole(req.headers.host);
    const shortName = loginName.split('@')[0];
    const domainLoginName = shortName + '@zeroschool.localhost';

    let resp;
    try {
      resp = await axios.post(`${ZITADEL_INTERNAL}/v2/sessions`, {
        checks: { user: { loginName: domainLoginName }, password: { password } }
      }, { headers: zitadelHeaders() });
    } catch (firstErr) {
      resp = await axios.post(`${ZITADEL_INTERNAL}/v2/sessions`, {
        checks: { user: { loginName: shortName }, password: { password } }
      }, { headers: zitadelHeaders() });
    }

    const sessionToken = resp.data.sessionToken;
    const sessionId = resp.data.sessionId;
    const userResp = await axios.get(`${ZITADEL_INTERNAL}/v2/sessions/${sessionId}`, {
      headers: { ...zitadelHeaders(), Authorization: `Bearer ${sessionToken}` }
    });
    const factors = userResp.data.session?.factors || {};
    req.session.user = {
      userId: resp.data.details?.resourceOwner || '',
      sessionId, sessionToken,
      loginName: factors.user?.loginName || domainLoginName,
      role,
      displayName: factors.user?.displayName || shortName,
    };
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Login failed';
    console.error('Login error:', msg);
    if (msg.includes('invalid') || msg.includes('Invalid') || msg.includes('Password') || msg.includes('could not be found') || msg.includes('QUERY')) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/register/student', async (req, res) => {
  try {
    const { firstName, lastName, className, phone, schoolId, password } = req.body;
    if (!firstName || !className || !schoolId || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const candidates = generateEmailCandidates(firstName, className, schoolId, phone);
    let created = null;
    let retriedAuth = false;
    for (const loginName of candidates) {
      try {
        created = await tryCreateStudent(firstName, lastName, className, schoolId, phone, password, loginName);
        break;
      } catch (err) {
        // A rejected service token is not a username collision. Re-read the
        // token once in case it was rotated, then give up with a clear error.
        if (isAuthError(err) && !retriedAuth) {
          retriedAuth = true;
          invalidatePAT();
          try {
            created = await tryCreateStudent(firstName, lastName, className, schoolId, phone, password, loginName);
            break;
          } catch (err2) {
            if (isAuthError(err2)) throw err2;
            err = err2;
          }
        }
        const msg = err.response?.data?.message || '';
        if (msg.includes('already exists') || msg.includes('V3-') || msg.includes('Username') || msg.includes('UNIQUE')) continue;
        throw err;
      }
    }
    if (!created) return res.status(409).json({ error: 'Could not generate a unique username for this student' });

    const username = created.username;
    const sessionResp = await axios.post(`${ZITADEL_INTERNAL}/v2/sessions`, {
      checks: { user: { loginName: username }, password: { password } }
    }, { headers: zitadelHeaders() });

    const sessionToken = sessionResp.data.sessionToken;
    const sessionId = sessionResp.data.sessionId;
    const userResp = await axios.get(`${ZITADEL_INTERNAL}/v2/sessions/${sessionId}`, {
      headers: { ...zitadelHeaders(), Authorization: `Bearer ${sessionToken}` }
    });
    const factors = userResp.data.session?.factors || {};
    req.session.user = {
      userId: created.loginName,
      sessionId, sessionToken, loginName: username, role: 'student',
      displayName: factors.user?.displayName || firstName,
    };
    res.json({ success: true, email: created.email, redirect: '/dashboard' });
  } catch (err) {
    console.error('Student register error:', err.response?.data || err.message);
    if (isAuthError(err)) {
      return res.status(502).json({
        error: 'ZITADEL rejected the service token. The ZITADEL_PAT for this app is missing, ' +
               'expired, or belongs to a previous ZITADEL instance. Set a current admin PAT and redeploy.'
      });
    }
    res.status(500).json({ error: err.response?.data?.message || err.message || 'Registration failed' });
  }
});

app.post('/api/register/teacher', async (req, res) => {
  try {
    const { firstName, lastName, phone, schoolId, password } = req.body;
    if (!firstName || !lastName || !schoolId || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const school = SCHOOLS.find(s => s.id === schoolId);
    const base = generateTeacherBaseEmail(firstName, lastName, schoolId);
    const candidates = [base];
    const phoneLast4 = phone ? String(phone).replace(/\D/g, '').slice(-4) : null;
    if (phoneLast4 && phoneLast4.length === 4) candidates.push(base + phoneLast4);
    for (let i = 1; i <= 99; i++) candidates.push(base + String(i).padStart(2, '0'));

    let created = null;
    for (const loginName of candidates) {
      const username = loginName + '@zeroschool.localhost';
      try {
        await axios.post(`${ZITADEL_INTERNAL}/v2/users/human`, {
          username,
          profile: { givenName: firstName, familyName: lastName, displayName: `${firstName} ${lastName}` },
      email: { email: loginName + '@zeroschool.org', isVerified: true },
      phone: normalizePhone(phone) ? { phone: normalizePhone(phone), isVerified: true } : undefined,
          password: { password, changeRequired: false },
          metadata: [
            { key: 'role', value: Buffer.from('teacher').toString('base64') },
            { key: 'school_id', value: Buffer.from(schoolId).toString('base64') },
            { key: 'school_name', value: Buffer.from(school ? school.name : schoolId).toString('base64') },
          ],
        }, { headers: zitadelHeaders() });
        created = { loginName, email: loginName + '@zeroschool.org', username };
        break;
      } catch (err) {
        const msg = err.response?.data?.message || '';
        if (msg.includes('already exists') || msg.includes('V3-') || msg.includes('Username') || msg.includes('UNIQUE')) continue;
        throw err;
      }
    }
    if (!created) return res.status(500).json({ error: 'Could not generate unique username' });

    const sessionResp = await axios.post(`${ZITADEL_INTERNAL}/v2/sessions`, {
      checks: { user: { loginName: created.username }, password: { password } }
    }, { headers: zitadelHeaders() });
    const sessionToken = sessionResp.data.sessionToken;
    const sessionId = sessionResp.data.sessionId;
    const userResp = await axios.get(`${ZITADEL_INTERNAL}/v2/sessions/${sessionId}`, {
      headers: { ...zitadelHeaders(), Authorization: `Bearer ${sessionToken}` }
    });
    const factors = userResp.data.session?.factors || {};
    req.session.user = {
      userId: created.username,
      sessionId, sessionToken, loginName: created.username, role: 'teacher',
      displayName: factors.user?.displayName || firstName,
    };
    res.json({ success: true, email: created.email, redirect: '/dashboard' });
  } catch (err) {
    console.error('Teacher register error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message || 'Registration failed' });
  }
});

app.post('/api/bulk-upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (rows.length === 0) return res.status(400).json({ error: 'Empty file' });

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (const row of rows) {
      const firstName = (row.FirstName || row.firstName || row['First Name'] || '').toString().trim();
      const lastName = (row.LastName || row.lastName || row['Last Name'] || '').toString().trim();
      const className = (row.Class || row.className || row['Class'] || '').toString().trim();
      const schoolId = (row.School || row.schoolId || row['School'] || row.SchoolID || '').toString().trim();
      const phone = (row.Phone || row.phone || row['Phone'] || row.Mobile || row.mobile || '').toString().trim();

      if (!firstName || !className || !schoolId) {
        results.push({ firstName, lastName, className, schoolId, status: 'FAILED', error: 'Missing required fields (FirstName, Class, School)' });
        failCount++;
        continue;
      }

      const matchedSchool = SCHOOLS.find(s =>
        s.id === schoolId || s.name.toLowerCase().includes(schoolId.toLowerCase())
      );
      const resolvedSchoolId = matchedSchool ? matchedSchool.id : schoolId;
      const school = matchedSchool || { name: schoolId };

      const password = generatePassword();

      try {
        const candidates = generateEmailCandidates(firstName, className, resolvedSchoolId, phone);
        let created = null;
        for (const loginName of candidates) {
          try {
            created = await tryCreateStudent(firstName, lastName, className, resolvedSchoolId, phone, password, loginName);
            break;
          } catch (retryErr) {
            const rmsg = retryErr.response?.data?.message || '';
            if (rmsg.includes('already exists') || rmsg.includes('V3-') || rmsg.includes('Username') || rmsg.includes('UNIQUE')) continue;
            throw retryErr;
          }
        }
        if (!created) throw new Error('Could not generate unique username');

        results.push({
          firstName, lastName, className, schoolId: resolvedSchoolId, phone,
          email: created.email, username: created.loginName, password, status: 'SUCCESS'
        });
        successCount++;
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        results.push({ firstName, lastName, className, schoolId: resolvedSchoolId, phone, status: 'FAILED', error: errMsg });
        failCount++;
      }
    }

    fs.unlinkSync(req.file.path);

    const outWb = XLSX.utils.book_new();
    const outData = results.map(r => ({
      'First Name': r.firstName,
      'Last Name': r.lastName,
      'Class': r.className,
      'School': r.schoolId,
      'Phone': r.phone || '',
      'Email': r.email || '',
      'Username': r.username || '',
      'Password': r.password || '',
      'Status': r.status,
      'Error': r.error || ''
    }));
    const outSheet = XLSX.utils.json_to_sheet(outData);
    XLSX.utils.book_append_sheet(outWb, outSheet, 'Students');
    const outPath = path.join(__dirname, 'uploads', `bulk-result-${Date.now()}.xlsx`);
    XLSX.writeFile(outWb, outPath);

    res.json({
      success: true,
      total: rows.length,
      created: successCount,
      failed: failCount,
      downloadUrl: `/api/bulk-download/${path.basename(outPath)}`,
      results
    });
  } catch (err) {
    console.error('Bulk upload error:', err);
    res.status(500).json({ error: err.message || 'Bulk upload failed' });
  }
});

app.get('/api/bulk-download/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, 'ZeroSchool-Students-Credentials.xlsx', () => {
    setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 60000);
  });
});

app.get('/dashboard', authRequired, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => { res.redirect('/login'); });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ZeroSchool running on http://localhost:${PORT}`);
});

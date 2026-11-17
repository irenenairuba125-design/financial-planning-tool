'use strict';
/* Financial Planning Tool — API server: accounts, saved plans, and SMS / email alerts.
   Run:  npm start   (from the project folder)  →  http://localhost:3000 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

/* ---------- config (.env in the project folder) ---------- */
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();

const { computeAlerts } = require('./alerts');
const { sendEmail, sendSms, normalizePhone } = require('./notify');
const { createTables, saveState, loadState, migrateOldData } = require('./store');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_DAYS = 30;
const ALERT_CHECK_MINUTES = Number(process.env.ALERT_CHECK_MINUTES || 60);

/* ---------- database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    alert_email INTEGER NOT NULL DEFAULT 1,
    alert_sms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts_sent (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, alert_key, channel)
  );
`);
createTables(db);
migrateOldData(db);

/* ---------- passwords & sessions ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', cookie('fpt_session', token, SESSION_DAYS * 86400));
}
function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
}
function currentUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)fpt_session=([^;]+)/);
  if (!m) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(m[1]), Date.now());
  return row || null;
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || '', alertEmail: !!u.alert_email, alertSms: !!u.alert_sms });

/* simple brute-force protection: max 10 failed logins per email+IP per 15 minutes */
const failures = new Map();
function tooManyFailures(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) { failures.delete(key); return false; }
  return f.count >= 10;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

/* ---------- http helpers ---------- */
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

/* ---------- routes ---------- */
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  // Block cross-site form posts: every write must be sent as JSON (needs a CORS preflight cross-site).
  if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json'))
    return send(res, 415, { error: 'Content-Type must be application/json' });

  if (route === 'POST /api/register') {
    const b = await readJson(req);
    const name = str(b.name, 100), email = str(b.email, 200).toLowerCase(), password = String(b.password || '');
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (!name) return send(res, 400, { error: 'Please enter your name.' });
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Please enter a valid email address.' });
    if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
    if (b.phone && !phone) return send(res, 400, { error: 'Phone number should look like 0772123456 or +256772123456.' });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return send(res, 409, { error: 'An account with this email already exists. Log in instead.' });
    const r = db.prepare('INSERT INTO users (name, email, phone, password_hash, alert_sms) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, phone, hashPassword(password), phone ? 1 : 0);
    createSession(res, Number(r.lastInsertRowid));
    return send(res, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
  }

  if (route === 'POST /api/login') {
    const b = await readJson(req);
    const email = str(b.email, 200).toLowerCase();
    const key = `${email}|${req.socket.remoteAddress}`;
    if (tooManyFailures(key)) return send(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !verifyPassword(String(b.password || ''), u.password_hash)) {
      recordFailure(key);
      return send(res, 401, { error: 'Wrong email or password.' });
    }
    failures.delete(key);
    createSession(res, u.id);
    return send(res, 200, { user: publicUser(u) });
  }

  if (route === 'POST /api/logout') {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)fpt_session=([^;]+)/);
    if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(m[1]));
    res.setHeader('Set-Cookie', cookie('fpt_session', '', 0));
    return send(res, 200, { ok: true });
  }

  // everything below needs a logged-in user
  const user = currentUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });

  if (route === 'GET /api/me') return send(res, 200, { user: publicUser(user) });

  if (route === 'GET /api/data') {
    return send(res, 200, { data: loadState(db, user.id) });
  }

  if (route === 'PUT /api/data') {
    const b = await readJson(req);
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) return send(res, 400, { error: 'data must be an object' });
    saveState(db, user.id, b.data);
    return send(res, 200, { ok: true });
  }

  if (route === 'PUT /api/settings') {
    const b = await readJson(req);
    const name = str(b.name, 100) || user.name;
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (b.phone && !phone) return send(res, 400, { error: 'Phone number should look like 0772123456 or +256772123456.' });
    db.prepare('UPDATE users SET name = ?, phone = ?, alert_email = ?, alert_sms = ? WHERE id = ?')
      .run(name, phone, b.alertEmail ? 1 : 0, b.alertSms && phone ? 1 : 0, user.id);
    return send(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  }

  if (route === 'POST /api/password') {
    const b = await readJson(req);
    if (!verifyPassword(String(b.current || ''), user.password_hash)) return send(res, 400, { error: 'Current password is wrong.' });
    if (String(b.next || '').length < 8) return send(res, 400, { error: 'New password must be at least 8 characters.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.next)), user.id);
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/alerts') {
    const rows = db.prepare('SELECT channel, message, sent_at FROM alerts_sent WHERE user_id = ? ORDER BY sent_at DESC LIMIT 20').all(user.id);
    return send(res, 200, { alerts: rows });
  }

  if (route === 'POST /api/alerts/test') {
    const text = `Financial Planning Tool: test alert for ${user.name}. Your alerts are working.`;
    const result = {};
    if (user.alert_email) result.email = await sendEmail(user.email, 'Test alert', text).catch(e => ({ ok: false, error: e.message }));
    if (user.alert_sms && user.phone) result.sms = await sendSms(user.phone, text).catch(e => ({ ok: false, error: e.message }));
    if (!Object.keys(result).length) return send(res, 400, { error: 'Turn on email or SMS alerts first.' });
    return send(res, 200, { result });
  }

  if (route === 'POST /api/alerts/check') {
    return send(res, 200, { sent: await checkUserAlerts(user) });
  }

  if (route === 'DELETE /api/account') {
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.setHeader('Set-Cookie', cookie('fpt_session', '', 0));
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const file = STATIC[url.pathname];
    if (req.method === 'GET' && file) {
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(ROOT, file[0])));
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  }
});

/* ---------- alert scheduler ---------- */
async function checkUserAlerts(u) {
  const plan = loadState(db, u.id);
  if (!plan) return 0;
  const alerts = computeAlerts(plan);
  const channels = [];
  if (u.alert_email) channels.push(['email', t => sendEmail(u.email, 'Financial Planning Tool alert', t)]);
  if (u.alert_sms && u.phone) channels.push(['sms', t => sendSms(u.phone, t)]);
  const insert = db.prepare('INSERT OR IGNORE INTO alerts_sent (user_id, alert_key, channel, message) VALUES (?, ?, ?, ?)');
  const undo = db.prepare('DELETE FROM alerts_sent WHERE user_id = ? AND alert_key = ? AND channel = ?');
  let sent = 0;
  for (const [channel, deliver] of channels) {
    const fresh = alerts.filter(a => insert.run(u.id, a.key, channel, a.text).changes > 0);
    if (!fresh.length) continue;
    const text = fresh.map(a => a.text).join('\n');
    try { await deliver(text); sent += fresh.length; }
    catch (err) {
      console.error(`Alert via ${channel} to user ${u.id} failed:`, err.message);
      for (const a of fresh) undo.run(u.id, a.key, channel); // retry on the next check
    }
  }
  return sent;
}
async function checkAllAlerts() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  for (const u of db.prepare('SELECT * FROM users').all()) {
    try { await checkUserAlerts(u); } catch (err) { console.error(`Alert check for user ${u.id} failed:`, err.message); }
  }
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Financial Planning Tool running at http://localhost:${PORT}`);
    console.log(`Email alerts: ${process.env.SMTP_HOST ? 'ON' : 'dry run (set SMTP_* in .env)'} · SMS alerts: ${process.env.AT_API_KEY ? 'ON' : 'dry run (set AT_* in .env)'}`);
  });
  setTimeout(checkAllAlerts, 10_000);
  setInterval(checkAllAlerts, ALERT_CHECK_MINUTES * 60_000);
}

module.exports = { server, db, checkAllAlerts };

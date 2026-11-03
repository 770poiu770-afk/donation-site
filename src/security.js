'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');

const COOKIE = 'admin_session';
const SESSION_HOURS = 8;

const hmac = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function issueSession(res, username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_HOURS * 3600_000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${hmac(payload)}`, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/admin',
    maxAge: SESSION_HOURS * 3600_000,
  });
}

function readSession(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.');
  if (!safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now() || data.u !== config.admin.username) return null;
    return { ...data, raw };
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/admin' });
}

async function checkCredentials(username, password) {
  if (!config.admin.passwordHash) return false;
  const userOk = safeEqual(String(username || ''), config.admin.username);
  const passOk = await bcrypt.compare(String(password || ''), config.admin.passwordHash);
  return userOk && passOk;
}

/** Admin auth middleware; also provides a CSRF token bound to the session. */
function requireAdmin(req, res, next) {
  const s = readSession(req);
  if (!s) return res.redirect('/admin/login');
  req.admin = s;
  res.locals.csrfToken = hmac(`csrf:${s.raw}`);
  res.locals.adminUser = s.u;
  if (req.method === 'POST') {
    const token = req.body?._csrf || req.get('x-csrf-token');
    if (!token || !safeEqual(token, res.locals.csrfToken)) return res.status(403).send('Invalid CSRF token');
  }
  next();
}

/** Same-origin check for public JSON POST endpoints. */
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    const allowed = new Set([config.baseUrl, `${req.protocol}://${req.get('host')}`]);
    if (!allowed.has(origin)) return res.status(403).json({ error: 'forbidden_origin' });
  }
  if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
  next();
}

module.exports = { issueSession, readSession, clearSession, checkCredentials, requireAdmin, sameOrigin, safeEqual };

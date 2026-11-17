'use strict';

const crypto = require('crypto');
const config = require('./config');
const { db } = require('./db');
const { randomToken, sha256, parseCookies } = require('./security');

const USER_COOKIE = 'ket_sid';
const ADMIN_COOKIE = 'ket_admin';
const USER_TTL = 14 * 24 * 60 * 60 * 1000;
const ADMIN_TTL = 8 * 60 * 60 * 1000;

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: '/',
    maxAge,
  };
}

function issueSession(req, res, { userId = null, role, cookieName, ttl }) {
  const token = randomToken(32);
  const id = sha256(token);
  const createdAt = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, user_id, role, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, role, createdAt, createdAt + ttl, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 250));
  res.cookie(cookieName, token, cookieOptions(ttl));
  return { token, expiresAt: createdAt + ttl };
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function clearSession(req, res, cookieName) {
  const token = bearerToken(req) || parseCookies(req)[cookieName];
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
  res.clearCookie(cookieName, { path: '/' });
}

function sessionFromRequest(req, cookieName, role) {
  const token = bearerToken(req) || parseCookies(req)[cookieName];
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND role = ? AND expires_at > ?')
    .get(sha256(token), role, Date.now());
  if (!row) return null;
  if (role === 'user') {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user || user.blacklisted) return null;
    return {
      id: row.id,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        createdAt: user.created_at,
      },
    };
  }
  return { id: row.id, user: null };
}

function optionalUser(req, _res, next) {
  const session = sessionFromRequest(req, USER_COOKIE, 'user');
  if (session) req.user = session.user;
  next();
}

function requireUser(req, res, next) {
  const session = sessionFromRequest(req, USER_COOKIE, 'user');
  if (!session) return res.status(401).json({ error: 'Authentication required' });
  req.user = session.user;
  return next();
}

function requireAdmin(req, res, next) {
  const session = sessionFromRequest(req, ADMIN_COOKIE, 'admin');
  if (!session) return res.status(401).json({ error: 'Admin authentication required' });
  req.admin = { id: session.id };
  return next();
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function passwordFingerprint(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

module.exports = {
  USER_COOKIE,
  ADMIN_COOKIE,
  USER_TTL,
  ADMIN_TTL,
  issueSession,
  clearSession,
  optionalUser,
  requireUser,
  requireAdmin,
  userCount,
  passwordFingerprint,
};

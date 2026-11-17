'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const config = require('./config');

const scrypt = promisify(crypto.scrypt);
const KEY = Buffer.from(config.encKey, 'hex');

// ── Tokens & hashes ──────────────────────────────────────────────────────────

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(value, secret = config.encKey) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Passwords (scrypt, no native deps) ───────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const derived = await scrypt(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p) });
    const expected = Buffer.from(hash, 'hex');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

// ── AES-256-GCM ──────────────────────────────────────────────────────────────

function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

function decryptText(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('v1.')) {
    throw new Error('Unsupported ciphertext');
  }
  const [, ivB64, tagB64, ctB64] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

function encryptJSON(value) {
  return encryptText(JSON.stringify(value));
}

function decryptJSON(payload) {
  return JSON.parse(decryptText(payload));
}

// ── Identifiers ──────────────────────────────────────────────────────────────

const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(length, alphabet = KEY_ALPHABET) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function generateLicenseKey() {
  const groups = Array.from({ length: 4 }, () => randomChars(5));
  return `KET-${groups.join('-')}`;
}

function normalizeLicenseKey(key) {
  return String(key || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^KET/, '');
}

function licenseHash(key) {
  return hmac(`license:${normalizeLicenseKey(key)}`);
}

function keyPreview(key) {
  const clean = String(key || '').replace(/^KET-/, '');
  return `KET-•••••-•••••-•••••-${clean.slice(-5)}`;
}

function generateVerifyCode() {
  const raw = randomChars(8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeVerifyCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function verifyCodeHash(code) {
  return hmac(`verify:${normalizeVerifyCode(code)}`);
}

const ORDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateOrderNumber() {
  const d = new Date();
  const y = String(d.getUTCFullYear()).slice(2);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `KT-${y}${m}${day}-${randomChars(5, ORDER_ALPHABET)}`;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// ── Email ────────────────────────────────────────────────────────────────────

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

// ── Cookies ──────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const name = part.slice(0, idx).trim();
    if (!name) return;
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[name] = part.slice(idx + 1).trim();
    }
  });
  return out;
}

// ── Rate limiting (in-memory, single process) ───────────────────────────────

const buckets = new Map();

function rateLimit({ windowMs, max, key = 'default' }) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const bucketKey = `${key}:${ip}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

// ── CSRF / origin guard ──────────────────────────────────────────────────────

function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = Boolean(origin && config.allowedOrigins.includes(origin));
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    if (origin && !allowed) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(204).end();
  }
  return next();
}

function originGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (bot, curl) do not send cookies
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'Invalid origin' });
  }
  const allowed = new Set([req.headers.host, ...config.allowedOrigins.map((value) => new URL(value).host)]);
  if (!allowed.has(host)) return res.status(403).json({ error: 'Cross-origin request blocked' });
  return next();
}

module.exports = {
  randomToken,
  sha256,
  hmac,
  safeEqual,
  hashPassword,
  verifyPassword,
  encryptText,
  decryptText,
  encryptJSON,
  decryptJSON,
  generateLicenseKey,
  normalizeLicenseKey,
  licenseHash,
  keyPreview,
  generateVerifyCode,
  normalizeVerifyCode,
  verifyCodeHash,
  generateOrderNumber,
  newId,
  normalizeEmail,
  validEmail,
  parseCookies,
  rateLimit,
  cors,
  originGuard,
};

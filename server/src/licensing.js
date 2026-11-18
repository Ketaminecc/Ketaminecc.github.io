'use strict';

// Client licensing surface: email + key sign in with a hardware binding.
//
// A license key is tied to the buyer's email, and the first successful sign in
// pins it to a hardware ID. Every later sign in must present the same ID. The
// issued session token is stateless: base64url(payload).HMAC-SHA256(payload),
// capped at six hours and clamped to the license expiry.
//
// Everything the client needs lives here, so the storefront router can stay
// about purchases.

const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { db, audit, isBlacklisted } = require('./db');
const {
  normalizeEmail,
  validEmail,
  normalizeLicenseKey,
  licenseHash,
  rateLimit,
} = require('./security');
const { licenseStatus } = require('./orders');

const router = express.Router();

const TOKEN_TTL = 6 * 60 * 60 * 1000;
const HWID_PATTERN = /^[a-f0-9]{64}$/;

function hwidPreview(hash) {
  const value = String(hash || '');
  if (value.length < 12) return value.toUpperCase();
  return `${value.slice(0, 8).toUpperCase()}...${value.slice(-4).toUpperCase()}`;
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.encKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', config.encKey).update(body).digest('base64url');
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.lid !== 'string' || !payload.exp) return null;
  if (Number(payload.exp) < Date.now()) return null;
  return payload;
}

function licenseByKey(key) {
  return db
    .prepare(
      `SELECT l.*, p.name AS product_name, u.blacklisted AS user_blacklisted
         FROM licenses l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN users u ON u.id = l.user_id
        WHERE l.key_hash = ?`
    )
    .get(licenseHash(key));
}

function licenseById(id) {
  return db
    .prepare(
      `SELECT l.*, p.name AS product_name, u.blacklisted AS user_blacklisted
         FROM licenses l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN users u ON u.id = l.user_id
        WHERE l.id = ?`
    )
    .get(String(id));
}

function bindingForLicense(licenseId) {
  return db.prepare('SELECT * FROM license_bindings WHERE license_id = ?').get(String(licenseId)) || null;
}

function resetBinding(licenseId) {
  const result = db.prepare('DELETE FROM license_bindings WHERE license_id = ?').run(String(licenseId));
  return Number(result.changes) > 0;
}

function statusError(status) {
  switch (status) {
    case 'expired':
      return 'This license has expired.';
    case 'revoked':
      return 'This license has been revoked.';
    case 'blacklisted':
      return 'This license has been blacklisted.';
    case 'stock':
      return 'This license has not been activated yet. Contact support.';
    case 'missing':
      return 'This license is no longer attached to an order. Contact support.';
    default:
      return 'This license is not active.';
  }
}

/* Sign in. The server owns the HWID hash; the client's preview string is
   ignored so a spoofed preview cannot decorate the admin console. */
router.post(
  '/license/login',
  rateLimit({ windowMs: 60_000, max: 12, key: 'license-login' }),
  (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const key = String(req.body?.key || '');
      const hwid = String(req.body?.hwid || '').trim().toLowerCase();

      if (!validEmail(email) || normalizeLicenseKey(key).length < 16) {
        return res.status(400).json({
          ok: false,
          status: 'invalid_request',
          error: 'Enter the email and license key from your order.',
        });
      }
      if (!HWID_PATTERN.test(hwid)) {
        return res.status(400).json({
          ok: false,
          status: 'invalid_hwid',
          error: 'Hardware ID could not be read on this machine.',
        });
      }
      if (req.ip && isBlacklisted('ip', req.ip)) {
        return res.status(403).json({
          ok: false,
          status: 'blacklisted',
          error: 'Sign in is blocked from this network.',
        });
      }

      const row = licenseByKey(key);
      if (!row) {
        audit(`gate:${email}`, 'license.login_not_found', null, { ip: req.ip });
        return res.status(401).json({
          ok: false,
          status: 'not_found',
          error: 'Email and license key do not match.',
        });
      }
      if (isBlacklisted('key', row.key_hash) || isBlacklisted('email', email)) {
        return res.status(403).json({
          ok: false,
          status: 'blacklisted',
          error: statusError('blacklisted'),
        });
      }
      if (row.user_blacklisted) {
        return res.status(403).json({
          ok: false,
          status: 'revoked',
          error: statusError('revoked'),
        });
      }
      if (row.email && normalizeEmail(row.email) !== email) {
        audit(`gate:${email}`, 'license.login_email_mismatch', row.id, { ip: req.ip });
        return res.status(401).json({
          ok: false,
          status: 'not_found',
          error: 'Email and license key do not match.',
        });
      }

      const status = licenseStatus(row);
      if (status !== 'active') {
        return res.status(403).json({
          ok: false,
          status,
          error: statusError(status),
        });
      }

      const now = Date.now();
      if (!row.email) {
        db.prepare('UPDATE licenses SET email = ? WHERE id = ?').run(email, row.id);
      }
      const user = db.prepare('SELECT id, blacklisted FROM users WHERE email = ?').get(email);
      if (user?.blacklisted) {
        return res.status(403).json({
          ok: false,
          status: 'revoked',
          error: statusError('revoked'),
        });
      }
      if (user) {
        db.prepare('UPDATE licenses SET user_id = COALESCE(user_id, ?) WHERE id = ?').run(
          user.id,
          row.id
        );
      }

      const preview = hwidPreview(hwid);
      let binding = bindingForLicense(row.id);
      if (!binding) {
        db.prepare(
          `INSERT INTO license_bindings
             (license_id, hwid_hash, hwid_preview, email, first_ip, last_ip, bound_at, last_seen_at, login_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(row.id, hwid, preview, email, req.ip || null, req.ip || null, now, now);
        audit(`gate:${email}`, 'license.hwid_bind', row.id, { preview, ip: req.ip });
        binding = bindingForLicense(row.id);
      } else if (binding.hwid_hash !== hwid) {
        audit(`gate:${email}`, 'license.hwid_reject', row.id, {
          bound: binding.hwid_preview,
          presented: preview,
          ip: req.ip,
        });
        return res.status(403).json({
          ok: false,
          status: 'hwid_mismatch',
          error: `This license is already bound to another machine (${binding.hwid_preview}). Ask support for a HWID reset.`,
          hwidPreview: binding.hwid_preview,
        });
      } else {
        db.prepare(
          'UPDATE license_bindings SET last_ip = ?, last_seen_at = ?, login_count = login_count + 1 WHERE license_id = ?'
        ).run(req.ip || null, now, row.id);
      }

      const tokenExpiry = row.expires_at && row.expires_at < now + TOKEN_TTL
        ? row.expires_at
        : now + TOKEN_TTL;
      const token = signToken({ lid: row.id, em: email, hw: hwid, exp: tokenExpiry });

      audit(`gate:${email}`, 'license.login', row.id, {
        preview: binding?.hwid_preview || preview,
        ip: req.ip,
      });

      return res.json({
        ok: true,
        status: 'active',
        token,
        expiresAt: tokenExpiry,
        email,
        product: row.product_name || null,
        keyPreview: row.key_preview,
        hwidPreview: binding?.hwid_preview || preview,
        boundAt: binding?.bound_at || now,
        licenseExpiresAt: row.expires_at,
      });
    } catch (err) {
      console.error('[license] login failed:', err);
      return res.status(500).json({
        ok: false,
        status: 'server_error',
        error: 'The license server could not complete the sign in.',
      });
    }
  }
);

/* Keeps an open loader honest. Cheap: one signature check, one license read. */
router.post(
  '/license/heartbeat',
  rateLimit({ windowMs: 60_000, max: 60, key: 'license-heartbeat' }),
  (req, res) => {
    const payload = verifyToken(req.body?.token);
    if (!payload) {
      return res.status(401).json({ ok: false, status: 'unauthorized', error: 'Session expired.' });
    }
    const hwid = String(req.body?.hwid || '').trim().toLowerCase();
    if (payload.hw !== hwid) {
      return res.status(403).json({ ok: false, status: 'hwid_mismatch', error: 'Hardware changed.' });
    }
    const row = licenseById(payload.lid);
    if (!row) {
      return res.status(403).json({ ok: false, status: 'not_found', error: 'License not found.' });
    }
    const status = licenseStatus(row);
    if (row.user_blacklisted) {
      return res.status(403).json({ ok: false, status: 'revoked', error: statusError('revoked') });
    }
    if (status !== 'active') {
      return res.status(403).json({ ok: false, status, error: statusError(status) });
    }
    db.prepare('UPDATE license_bindings SET last_seen_at = ? WHERE license_id = ?').run(
      Date.now(),
      row.id
    );
    return res.json({
      ok: true,
      status: 'active',
      expiresAt: payload.exp,
      licenseExpiresAt: row.expires_at,
      product: row.product_name || null,
    });
  }
);

router.bindingForLicense = bindingForLicense;
router.resetBinding = resetBinding;
router.hwidPreview = hwidPreview;
// loader.js reads the same signed token so the snapshot route never has to
// duplicate the HMAC check.
router.verifyToken = verifyToken;

module.exports = router;

'use strict';

// Loader surface.
//
// The desktop client needs one thing from the backend after sign in: "what is
// this license, and is it mine on this machine". This router answers that in a
// single call, from either a license key or a signed session token, so the
// client never has to know how the license was minted.
//
// Everything here is read-only. Sign in, hardware binding and token minting
// stay in licensing.js; this file only reports what is already stored.
//
//   GET  /api/loader/config    discovery: brand, support, live API base
//   POST /api/loader/info      { key, hwid }        -> snapshot
//   POST /api/loader/session   { token, hwid }      -> snapshot
//
// The /loader page on the site renders the same snapshot, so the shape below is
// the contract the client and the browser both consume.

const express = require('express');
const config = require('./config');
const { db, getSetting, isBlacklisted } = require('./db');
const { normalizeLicenseKey, licenseHash, rateLimit } = require('./security');
const { licenseStatus } = require('./orders');

const router = express.Router();

const HWID_PATTERN = /^[a-f0-9]{64}$/;
const DAY = 24 * 60 * 60 * 1000;

const LICENSE_SELECT = `
  SELECT l.*,
         p.name AS product_name,
         o.number AS order_number,
         u.blacklisted AS user_blacklisted
    FROM licenses l
    LEFT JOIN products p ON p.id = l.product_id
    LEFT JOIN orders o ON o.id = l.order_id
    LEFT JOIN users u ON u.id = l.user_id
   WHERE `;

function licenseByKey(key) {
  return db.prepare(`${LICENSE_SELECT}l.key_hash = ?`).get(licenseHash(key)) || null;
}

function licenseById(id) {
  return db.prepare(`${LICENSE_SELECT}l.id = ?`).get(String(id)) || null;
}

function bindingFor(licenseId) {
  return db.prepare('SELECT * FROM license_bindings WHERE license_id = ?').get(String(licenseId)) || null;
}

function previewHash(hash) {
  const value = String(hash || '');
  if (value.length < 12) return value.toUpperCase();
  return `${value.slice(0, 8).toUpperCase()}...${value.slice(-4).toUpperCase()}`;
}

/* The client already knows the address it signed in with; the server only ever
   confirms it. Masking keeps a stolen key from turning this route into an email
   lookup for the same record. */
function maskEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.indexOf('@');
  if (at < 1) return '';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : '';
  const filler = '*'.repeat(Math.max(1, local.length - head.length - tail.length));
  return `${head}${filler}${tail}@${domain}`;
}

function snapshot(row, options = {}) {
  const hwid = options.hwid || null;
  const status = row.user_blacklisted ? 'revoked' : licenseStatus(row);
  const binding = bindingFor(row.id);
  const expiresAt = row.expires_at || null;
  const daysRemaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY)) : null;

  return {
    ok: true,
    brand: getSetting('brand', config.brand),
    source: options.source || 'key',
    status,
    active: status === 'active',
    product: row.product_name || null,
    game: row.game || 'cs2',
    email: maskEmail(row.email),
    order: row.order_number || null,
    keyPreview: row.key_preview,
    issuedAt: row.issued_at || null,
    expiresAt,
    lifetime: !expiresAt,
    daysRemaining,
    bound: binding
      ? {
          hwidPreview: binding.hwid_preview,
          boundAt: binding.bound_at,
          lastSeenAt: binding.last_seen_at,
          loginCount: Number(binding.login_count) || 0,
        }
      : null,
    // null means the caller did not present a machine, not "it matches".
    hwidMatch: hwid ? Boolean(binding && binding.hwid_hash === hwid) : null,
    serverTime: Date.now(),
  };
}

/* Discovery. The tunnel hostname rotates, so the client asks the host it can
   always reach (Pages) for the one that is live, and falls back to this route
   when it is already talking to the API directly. */
router.get('/loader/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    brand: getSetting('brand', config.brand),
    support: getSetting('support_email', config.supportEmail),
    discord: getSetting('discord_invite', ''),
    api: config.baseUrl,
    site: config.siteUrl,
    surface: 'loader',
    version: 1,
    serverTime: Date.now(),
  });
});

const lookupLimiter = rateLimit({ windowMs: 60_000, max: 40, key: 'loader-lookup' });

router.post('/loader/info', lookupLimiter, (req, res) => {
  const key = String(req.body?.key || '');
  const hwid = String(req.body?.hwid || '').trim().toLowerCase();

  if (normalizeLicenseKey(key).length < 16) {
    return res.status(400).json({
      ok: false,
      status: 'invalid_request',
      error: 'Enter the license key from your order.',
    });
  }
  if (hwid && !HWID_PATTERN.test(hwid)) {
    return res.status(400).json({
      ok: false,
      status: 'invalid_hwid',
      error: 'Hardware ID must be 64 lowercase hex characters.',
    });
  }
  if (req.ip && isBlacklisted('ip', req.ip)) {
    return res.status(403).json({ ok: false, status: 'blacklisted', error: 'This network is blocked.' });
  }

  const row = licenseByKey(key);
  if (!row) {
    return res.status(404).json({
      ok: false,
      status: 'not_found',
      error: 'That key does not exist.',
    });
  }
  if (isBlacklisted('key', row.key_hash)) {
    return res.status(403).json({ ok: false, status: 'blacklisted', error: 'That key is blocked.' });
  }
  return res.json(snapshot(row, { hwid, source: 'key' }));
});

/* Same snapshot, resolved from the session token the sign in already returned.
   The loader polls this instead of re-sending the key. */
router.post('/loader/session', lookupLimiter, (req, res) => {
  const token = String(req.body?.token || '');
  const hwid = String(req.body?.hwid || '').trim().toLowerCase();

  if (hwid && !HWID_PATTERN.test(hwid)) {
    return res.status(400).json({ ok: false, status: 'invalid_hwid', error: 'Malformed hardware ID.' });
  }

  const claims = require('./licensing').verifyToken(token);
  if (!claims) {
    return res.status(401).json({ ok: false, status: 'invalid_token', error: 'Session expired. Sign in again.' });
  }

  const row = licenseById(claims.lid);
  if (!row) {
    return res.status(404).json({ ok: false, status: 'not_found', error: 'License record is missing.' });
  }
  return res.json(snapshot(row, { hwid, source: 'session' }));
});

router.previewHash = previewHash;

module.exports = router;

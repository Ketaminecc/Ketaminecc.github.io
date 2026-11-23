'use strict';

// Build downloads are not static paths.
//
// The setup guide asks the server for a link when the button is pressed, the
// server mints a single-use ticket that lives for two minutes, and /d/<token>
// streams the file exactly once. There is no href in the markup to copy: the
// anchor is a button, and even a copied /d/... URL is dead after one use.
//
// Both the ticket and the loader module endpoints require an active license for
// the game being fetched. A signed-in account with no license gets a 403 before
// any file path is resolved, so the builds cannot be pulled anonymously.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { db } = require('./db');
const { requireUser } = require('./auth');
const { licenseStatus } = require('./orders');
const { verifyToken } = require('./licensing');

const router = express.Router();

// Kept outside the public site folder: the builds are never served by a static
// route, only through a ticket.
const buildDir = path.join(__dirname, '..', 'builds');

const BUILDS = {
  cs2: { file: 'cs2.zip', name: 'Ketamine.cc-CS2.zip', game: 'cs2' },
  roblox: { file: 'roblox-external.zip', name: 'Ketamine.cc-Roblox-External.zip', game: 'roblox' },
};

// What the loader pulls on first launch. Not a download link a browser sees.
const LOADER_DLL = 'cs2_internal.dll';

const TICKET_TTL_MS = 2 * 60 * 1000;
const tickets = new Map();

function pruneTickets() {
  const now = Date.now();
  for (const [token, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(token);
}

function buildId(file) {
  const stat = fs.statSync(file);
  return crypto
    .createHash('sha256')
    .update(`${stat.size}:${Math.floor(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
}

// ── License checks ───────────────────────────────────────────────────────────

function licenseGame(row) {
  return String(row?.game || 'cs2').trim().toLowerCase();
}

/* An active, non-blacklisted key for exactly this game. Roblox money must not
   unlock the CS2 loader, and a CS2 key must not unlock the Roblox build. */
function activeLicenseFor(userId, game) {
  const rows = db
    .prepare(
      `SELECT l.*, u.blacklisted AS user_blacklisted
         FROM licenses l
         LEFT JOIN users u ON u.id = l.user_id
        WHERE l.user_id = ?`
    )
    .all(String(userId));

  return (
    rows.find(
      (row) =>
        !row.user_blacklisted &&
        licenseGame(row) === game &&
        licenseStatus(row) === 'active'
    ) || null
  );
}

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(req.query?.token || '').trim();
}

/* The desktop client authenticates with the license session token it got from
   /api/license/login; it has no site cookie. */
function requireLoaderLicense(req, res, next) {
  const claims = verifyToken(bearerToken(req));
  if (!claims) {
    return res.status(401).json({ error: 'Sign in with an active license to download the module.' });
  }

  const row = db.prepare('SELECT * FROM licenses WHERE id = ?').get(String(claims.lid));
  if (!row || licenseGame(row) !== 'cs2' || licenseStatus(row) !== 'active') {
    return res.status(403).json({ error: 'An active CS2 license is required.' });
  }

  req.license = row;
  return next();
}

// ── Ticket issue ─────────────────────────────────────────────────────────────

router.get('/downloads/:product', requireUser, (req, res) => {
  const entry = BUILDS[String(req.params.product || '').toLowerCase()];
  if (!entry) return res.status(404).json({ error: 'Unknown build' });

  const license = activeLicenseFor(req.user.id, entry.game);
  if (!license) {
    return res.status(403).json({
      error:
        entry.game === 'roblox'
          ? 'An active Roblox license is required for this build.'
          : 'An active CS2 license is required for this build.',
    });
  }

  const file = path.join(buildDir, entry.file);
  if (!fs.existsSync(file)) return res.status(503).json({ error: 'Build is not uploaded yet' });

  pruneTickets();
  const token = crypto.randomBytes(24).toString('base64url');
  tickets.set(token, {
    file,
    name: entry.name,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.json({ url: `/d/${token}`, name: entry.name, expiresIn: TICKET_TTL_MS });
});

// ── Ticket redemption ────────────────────────────────────────────────────────

function redeem(req, res) {
  const token = String(req.params.token || '');
  const ticket = tickets.get(token);
  tickets.delete(token);

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (!ticket || ticket.expiresAt <= Date.now()) {
    return res
      .status(410)
      .type('text/plain')
      .send('This download link has expired or was already used. Start the download again from the setup guide.');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${ticket.name}"`);
  return res.sendFile(ticket.file, (err) => {
    if (err && !res.headersSent) res.status(500).type('text/plain').send('Download failed.');
  });
}

// ── Loader build (the desktop client, not a browser download) ────────────────

function loaderDllPath() {
  return path.join(buildDir, LOADER_DLL);
}

router.get('/loader/version', requireLoaderLicense, (_req, res) => {
  const file = loaderDllPath();
  if (!fs.existsSync(file)) return res.status(503).json({ error: 'No loader build uploaded' });
  const stat = fs.statSync(file);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ id: buildId(file), size: stat.size });
});

router.get('/loader/build', requireLoaderLicense, (_req, res) => {
  const file = loaderDllPath();
  if (!fs.existsSync(file)) return res.status(503).type('text/plain').send('No loader build uploaded');

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Build-Id', buildId(file));
  return res.sendFile(file);
});

module.exports = { router, redeem, LOADER_DLL };

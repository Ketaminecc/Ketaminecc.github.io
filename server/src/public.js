'use strict';

const express = require('express');
const config = require('./config');
const { db, getProduct, listProducts, getSetting, isBlacklisted, audit } = require('./db');
const {
  normalizeEmail,
  validEmail,
  hashPassword,
  verifyPassword,
  rateLimit,
  safeEqual,
  normalizeVerifyCode,
  verifyCodeHash,
  normalizeLicenseKey,
  licenseHash,
} = require('./security');
const { issueSession, clearSession, requireUser, optionalUser, USER_COOKIE } = require('./auth');
const {
  getOrderByNumber,
  createOrder,
  fulfillOrder,
  serializeOrderForUser,
  serializeLicenseForUser,
  licenseForOrder,
  licenseStatus,
} = require('./orders');
const { createCheckoutSession, publicPaymentMode, stripeConfigured } = require('./stripe');

const router = express.Router();

function mePayload(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name || user.displayName || null,
    createdAt: user.created_at || user.createdAt,
  };
}

function claimEmailLicenses(user) {
  db.prepare('UPDATE licenses SET user_id = ? WHERE user_id IS NULL AND lower(email) = lower(?)').run(
    user.id,
    user.email
  );
}

function publicProduct(p) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    priceCents: p.priceCents,
    currency: p.currency,
    durationDays: p.durationDays,
    features: p.features,
    badge: p.badge,
    note: p.note,
  };
}

// ── Site metadata ────────────────────────────────────────────────────────────

router.get('/site', (_req, res) => {
  res.json({
    brand: getSetting('brand', config.brand),
    supportEmail: getSetting('support_email', config.supportEmail),
    discordInvite: getSetting('discord_invite', ''),
    payments: publicPaymentMode(),
    stripeConfigured: stripeConfigured(),
  });
});

router.get('/health', (_req, res) => {
  const row = db.prepare('SELECT 1 AS ok').get();
  res.json({ ok: row?.ok === 1, time: Date.now() });
});

router.get('/products', (_req, res) => {
  res.json({ products: listProducts().map(publicProduct) });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, key: 'auth' });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, max: 8, key: 'register' });

router.post('/auth/register', registerLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.displayName || '').trim().slice(0, 60);

  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (isBlacklisted('email', email) || (req.ip && isBlacklisted('ip', req.ip))) {
    return res.status(403).json({ error: 'This account is not eligible for registration.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });

  const id = `usr_${require('crypto').randomBytes(12).toString('hex')}`;
  const now = Date.now();
  const passwordHash = await hashPassword(password);
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, email, passwordHash, displayName || email.split('@')[0], 'customer', now, now);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  claimEmailLicenses(user);
  issueSession(req, res, { userId: id, role: 'user', cookieName: USER_COOKIE, ttl: 14 * 24 * 60 * 60 * 1000 });
  audit(`user:${email}`, 'account.register', id, { ip: req.ip });
  return res.status(201).json({ user: mePayload(user) });
});

router.post('/auth/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });
  if (user.blacklisted) return res.status(403).json({ error: 'This account has been suspended.' });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
  claimEmailLicenses(user);
  issueSession(req, res, { userId: user.id, role: 'user', cookieName: USER_COOKIE, ttl: 14 * 24 * 60 * 60 * 1000 });
  return res.json({ user: mePayload(user) });
});

router.post('/auth/logout', (req, res) => {
  clearSession(req, res, USER_COOKIE);
  res.json({ ok: true });
});

router.get('/me', optionalUser, (req, res) => {
  res.json({
    user: req.user ? mePayload(req.user) : null,
    payments: publicPaymentMode(),
  });
});

router.post('/auth/password', requireUser, async (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(current, user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const hash = await hashPassword(next);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND role = 'user'").run(user.id);
  issueSession(req, res, {
    userId: user.id,
    role: 'user',
    cookieName: USER_COOKIE,
    ttl: 14 * 24 * 60 * 60 * 1000,
  });
  audit(`user:${user.email}`, 'account.password_change', user.id, { ip: req.ip });
  res.json({ ok: true });
});

// ── Checkout & orders ────────────────────────────────────────────────────────

router.post('/checkout', requireUser, rateLimit({ windowMs: 10 * 60_000, max: 15, key: 'checkout' }), async (req, res) => {
  const product = getProduct(req.body?.productId || req.body?.slug || '');
  if (!product || !product.active) return res.status(404).json({ error: 'Product not available.' });
  if (isBlacklisted('email', req.user.email) || (req.ip && isBlacklisted('ip', req.ip))) {
    return res.status(403).json({ error: 'Checkout is restricted for this account.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const order = createOrder(user, product);
  const mode = publicPaymentMode();

  if (mode === 'disabled') {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
    return res.status(503).json({ error: 'Payments are not configured yet. Contact support.' });
  }

  if (mode === 'demo') {
    const result = await fulfillOrder(order, { ip: req.ip, source: 'demo' });
    return res.json({
      mode: 'demo',
      url: `/checkout-success.html?order=${encodeURIComponent(order.number)}`,
      order: serializeOrderForUser(result.order),
    });
  }

  try {
    const session = await createCheckoutSession({ order, product, user });
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, order.id);
    return res.json({ mode: 'stripe', url: session.url });
  } catch (err) {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
    console.error('[stripe] checkout failed:', err.message);
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

router.get('/orders', requireUser, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.id);
  res.json({ orders: rows.map(serializeOrderForUser) });
});

router.get('/licenses', requireUser, (req, res) => {
  const rows = db
    .prepare(
      `SELECT l.*, p.name AS product_name, o.number AS order_number
       FROM licenses l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN orders o ON o.id = l.order_id
       WHERE l.user_id = ? OR (l.email IS NOT NULL AND lower(l.email) = lower(?))
       ORDER BY l.issued_at DESC LIMIT 300`
    )
    .all(req.user.id, req.user.email);
  res.json({ licenses: rows.map(serializeLicenseForUser) });
});

router.get('/orders/:number', requireUser, (req, res) => {
  const order = getOrderByNumber(req.params.number);
  if (!order || order.user_id !== req.user.id) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: serializeOrderForUser(order) });
});

// ── Public license validation (for your software client) ─────────────────────

router.get('/license/validate', rateLimit({ windowMs: 60_000, max: 90, key: 'validate' }), (req, res) => {
  const key = String(req.query.key || '');
  if (!normalizeLicenseKey(key)) return res.status(400).json({ valid: false, error: 'Missing license key.' });
  const row = db
    .prepare(
      `SELECT l.*, p.name AS product_name, o.number AS order_number, u.email, u.blacklisted AS user_blacklisted
       FROM licenses l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN orders o ON o.id = l.order_id
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.key_hash = ?`
    )
    .get(licenseHash(key));

  if (!row) return res.json({ valid: false, status: 'not_found' });
  if (isBlacklisted('key', row.key_hash)) {
    return res.json({ valid: false, status: 'blacklisted', product: row.product_name });
  }
  const status = row.user_blacklisted ? 'revoked' : licenseStatus(row);
  return res.json({
    valid: status === 'active',
    status,
    product: row.product_name,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    order: row.order_number,
    preview: row.key_preview,
  });
});

// ── Discord bot: one-time reveal of encrypted purchase records ───────────────

router.post('/internal/reveal', rateLimit({ windowMs: 60_000, max: 30, key: 'bot' }), (req, res) => {
  if (!safeEqual(req.headers['x-bot-secret'] || '', config.botSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const code = normalizeVerifyCode(req.body?.code || '');
  if (code.length !== 8) return res.status(400).json({ error: 'Verification code must be 8 characters.' });

  const row = db
    .prepare('SELECT * FROM verify_codes WHERE code_hash = ?')
    .get(verifyCodeHash(code));
  if (!row) return res.status(404).json({ error: 'Verification code not found.' });
  if (row.used_at) return res.status(409).json({ error: 'This code has already been used.', usedAt: row.used_at });
  if (row.expires_at < Date.now()) return res.status(410).json({ error: 'This verification code has expired.' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id);
  if (!order) return res.status(404).json({ error: 'Order record missing.' });
  const license = licenseForOrder(order.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  let licenseKey = null;
  if (license) {
    try {
      licenseKey = require('./security').decryptText(license.key_enc);
    } catch {
      licenseKey = null;
    }
  }

  db.prepare('UPDATE verify_codes SET used_at = ?, used_by = ? WHERE id = ?').run(
    Date.now(),
    String(req.body?.actor || 'discord:owner').slice(0, 100),
    row.id
  );
  audit('discord-owner', 'purchase.reveal', order.number, { codeId: row.id });

  return res.json({
    purchaseId: order.number,
    status: order.status,
    product: order.product_name,
    amountCents: order.amount_cents,
    currency: order.currency,
    customerEmail: order.customer_email,
    customerName: user?.display_name || null,
    customerId: order.user_id,
    licenseKey,
    licenseStatus: license ? licenseStatus(license) : null,
    issuedAt: license?.issued_at || null,
    expiresAt: license?.expires_at || null,
    stripeSessionId: order.stripe_session_id,
    paymentIntent: order.stripe_payment_intent,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    revealedAt: Date.now(),
  });
});

module.exports = router;

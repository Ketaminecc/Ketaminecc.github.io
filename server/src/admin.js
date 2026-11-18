'use strict';

const express = require('express');
const config = require('./config');
const { db, listProducts, getProduct, getSetting, setSetting, audit, isBlacklisted } = require('./db');
const {
  safeEqual,
  rateLimit,
  encryptText,
  decryptText,
  normalizeEmail,
  validEmail,
  normalizeLicenseKey,
  licenseHash,
  normalizeVerifyCode,
  verifyCodeHash,
} = require('./security');
const { issueSession, clearSession, requireAdmin, ADMIN_COOKIE, ADMIN_TTL } = require('./auth');
const {
  getOrderByNumber,
  licenseForOrder,
  serializeLicenseAdmin,
  revokeLicensesForOrder,
  issueStockKey,
  licenseStatus,
  fulfillOrder,
} = require('./orders');
const { refundPaymentIntent, stripeConfigured, stripeSource, webhookSecret, resetStripeClient, verifyStripeKey } = require('./stripe');
const { sendTestLog, getWebhookUrl, isValidWebhook } = require('./discord');
const { publicPaymentMode } = require('./payments');
const licensing = require('./licensing');

const router = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 6, key: 'admin-login' });

// ── Session ──────────────────────────────────────────────────────────────────

router.post('/login', loginLimiter, (req, res) => {
  const secret = String(req.body?.secret || '');
  if (!safeEqual(secret, config.adminSecret)) {
    audit('unknown', 'admin.login_failed', null, { ip: req.ip });
    return res.status(401).json({ error: 'Invalid admin key.' });
  }
  const session = issueSession(req, res, { role: 'admin', cookieName: ADMIN_COOKIE, ttl: ADMIN_TTL });
  audit('admin', 'admin.login', null, { ip: req.ip });
  return res.json({ ok: true, token: session.token });
});

router.post('/logout', (req, res) => {
  clearSession(req, res, ADMIN_COOKIE);
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (_req, res) => {
  res.json({ admin: true, stripeConfigured: stripeConfigured() });
});

router.use(requireAdmin);

// ── Overview ─────────────────────────────────────────────────────────────────

router.get('/overview', (_req, res) => {
  const now = Date.now();
  const thirtyDays = now - 30 * 86_400_000;
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    orders30d: db.prepare('SELECT COUNT(*) AS c FROM orders WHERE created_at >= ? AND status = ?').get(thirtyDays, 'paid').c,
    revenue30d: db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM orders WHERE created_at >= ? AND status = 'paid'")
      .get(thirtyDays).s,
    activeLicenses: db
      .prepare("SELECT COUNT(*) AS c FROM licenses WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)")
      .get(now).c,
    expiringSoon: db
      .prepare(
        "SELECT COUNT(*) AS c FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > ? AND expires_at < ?"
      )
      .get(now, now + 7 * 86_400_000).c,
    pendingOrders: db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'").get().c,
    refunds30d: db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'refunded' AND refunded_at >= ?").get(thirtyDays).c,
  };

  const recent = db
    .prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8')
    .all()
    .map(orderSummary);
  res.json({ stats, recent, payments: stripeConfigured() ? 'stripe' : config.demoMode ? 'demo' : 'disabled' });
});

// ── Orders ───────────────────────────────────────────────────────────────────

function orderSummary(row) {
  const license = licenseForOrder(row.id);
  return {
    number: row.number,
    status: row.status,
    email: row.customer_email,
    userId: row.user_id,
    product: row.product_name,
    amountCents: row.amount_cents,
    currency: row.currency,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    expiresAt: license?.expires_at ?? row.expires_at,
    licenseStatus: license ? licenseStatus(license) : null,
    licensePreview: license?.key_preview ?? null,
    discordStatus: row.discord_status,
    paymentMethod: row.payment_method || null,
    paymentRef: row.payment_ref || null,
    paymentClaimedAt: row.payment_claimed_at || null,
  };
}

router.get('/orders', (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT * FROM orders
       WHERE (number LIKE ? OR customer_email LIKE ? OR product_name LIKE ?)
         AND (? = '' OR status = ?)
       ORDER BY created_at DESC LIMIT 300`
    )
    .all(like, like, like, status, status);
  res.json({ orders: rows.map(orderSummary) });
});

router.get('/orders/:number', (req, res) => {
  const order = getOrderByNumber(req.params.number);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const licenses = db
    .prepare(
      `SELECT l.*, p.name AS product_name, COALESCE(l.email, u.email) AS email, o.number AS order_number
       FROM licenses l LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN users u ON u.id = l.user_id LEFT JOIN orders o ON o.id = l.order_id
       WHERE l.order_id = ?`
    )
    .all(order.id)
    .map(serializeLicenseAdmin);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  res.json({
    order: {
      ...orderSummary(order),
      customerName: user?.display_name || null,
      blacklisted: Boolean(user?.blacklisted),
      stripeSessionId: order.stripe_session_id,
      paymentIntent: order.stripe_payment_intent,
      discordStatus: order.discord_status,
    },
    licenses,
  });
});

router.post('/orders/:number/refund', async (req, res) => {
  const order = getOrderByNumber(req.params.number);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'refunded') return res.status(409).json({ error: 'Order is already refunded.' });

  let stripeRefund = null;
  if (stripeConfigured() && order.stripe_payment_intent) {
    try {
      stripeRefund = await refundPaymentIntent(order.stripe_payment_intent);
    } catch (err) {
      return res.status(502).json({ error: `Stripe refund failed: ${err.message}` });
    }
  }

  db.prepare("UPDATE orders SET status = 'refunded', refunded_at = ? WHERE id = ?").run(Date.now(), order.id);
  const revoked = revokeLicensesForOrder(order.id, 'refund');
  audit('admin', 'order.refund', order.number, { revoked, stripeRefund: stripeRefund?.id || null });
  return res.json({ ok: true, revoked, refundId: stripeRefund?.id || null });
});

router.post('/orders/:number/confirm', async (req, res) => {
  const order = getOrderByNumber(req.params.number);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status === 'paid') return res.status(409).json({ error: 'Order is already paid.' });
  if (order.status !== 'awaiting_payment') {
    return res.status(409).json({ error: 'Only manual orders awaiting payment can be confirmed.' });
  }
  try {
    const result = await fulfillOrder(order, { source: 'manual' });
    audit('admin', 'order.confirm_payment', order.number, {
      method: order.payment_method,
      reference: order.payment_ref || null,
      licenseId: result.license?.id || null,
    });
    return res.json({
      ok: true,
      order: orderSummary(result.order),
      keyPreview: result.license?.key_preview || null,
      discord: result.discord,
    });
  } catch (err) {
    console.error('[manual] confirm failed:', err);
    return res.status(500).json({ error: 'Could not confirm the payment.' });
  }
});

router.post('/orders/:number/cancel', (req, res) => {
  const order = getOrderByNumber(req.params.number);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!['awaiting_payment', 'pending'].includes(order.status)) {
    return res.status(409).json({ error: 'This order can no longer be cancelled.' });
  }
  db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
  audit('admin', 'order.cancel', order.number, { previousStatus: order.status });
  res.json({ ok: true });
});

router.post('/orders/:number/revoke', (req, res) => {
  const order = getOrderByNumber(req.params.number);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const revoked = revokeLicensesForOrder(order.id, 'admin');
  audit('admin', 'order.revoke_licenses', order.number, { revoked });
  res.json({ ok: true, revoked });
});

// ── Licenses ─────────────────────────────────────────────────────────────────

router.get('/licenses', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const hashed = q.length >= 8 ? licenseHash(q) : '___none___';
  const rows = db
    .prepare(
      `SELECT l.*, p.name AS product_name, COALESCE(l.email, u.email) AS email, o.number AS order_number
       FROM licenses l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN orders o ON o.id = l.order_id
       WHERE (l.key_preview LIKE ? OR COALESCE(l.email, u.email) LIKE ? OR o.number LIKE ? OR l.key_hash = ?)
       ORDER BY l.issued_at DESC LIMIT 300`
    )
    .all(like, like, like, hashed);
  const stock = db
    .prepare(
      `SELECT l.product_id AS productId, COALESCE(p.name, 'Unknown') AS productName, COUNT(*) AS count
       FROM licenses l
       LEFT JOIN products p ON p.id = l.product_id
       WHERE l.status = 'stock'
       GROUP BY l.product_id
       ORDER BY count DESC`
    )
    .all();
  res.json({ licenses: rows.map(serializeLicenseAdmin), stock });
});

router.post('/licenses/generate', (req, res) => {
  const product = getProduct(req.body?.productId || '');
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const quantity = Math.min(500, Math.max(1, Number(req.body?.quantity) || 1));

  let durationDays;
  if (req.body?.durationDays === undefined || req.body?.durationDays === '' || req.body?.durationDays === null) {
    durationDays = product.durationDays;
  } else if (String(req.body.durationDays).toLowerCase() === 'lifetime') {
    durationDays = null;
  } else {
    durationDays = Math.max(1, Math.min(3650, Number(req.body.durationDays) || 0));
  }

  const note = String(req.body?.note || '').slice(0, 300) || null;
  const created = [];
  for (let i = 0; i < quantity; i += 1) {
    const { license, key } = issueStockKey({ product, durationDays, note });
    created.push({
      id: license.id,
      key,
      preview: license.key_preview,
      durationDays: license.duration_days,
    });
  }

  const stockCount = db
    .prepare("SELECT COUNT(*) AS c FROM licenses WHERE product_id = ? AND status = 'stock'")
    .get(product.id).c;

  audit('admin', 'license.restock', product.slug, { quantity, durationDays, stockCount });
  res.status(201).json({ keys: created, product: product.name, durationDays, stockCount });
});

router.post('/licenses/:id/revoke', (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
  if (!license) return res.status(404).json({ error: 'License not found.' });
  db.prepare("UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE id = ?").run(Date.now(), license.id);
  audit('admin', 'license.revoke', license.key_preview, { licenseId: license.id });
  res.json({ ok: true });
});

router.post('/licenses/:id/blacklist', (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
  if (!license) return res.status(404).json({ error: 'License not found.' });
  db.prepare("UPDATE licenses SET status = 'blacklisted', revoked_at = ? WHERE id = ?").run(Date.now(), license.id);
  try {
    db.prepare('INSERT INTO blacklist (id, kind, value, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
      `bl_${require('crypto').randomBytes(10).toString('hex')}`,
      'key',
      license.key_hash,
      String(req.body?.reason || 'Revoked from admin dashboard').slice(0, 300),
      Date.now(),
      'admin'
    );
  } catch {
    /* already blacklisted */
  }
  audit('admin', 'license.blacklist', license.key_preview, { licenseId: license.id });
  res.json({ ok: true });
});

// ── Hardware bindings ────────────────────────────────────────────────────────

router.get('/licenses/:id/hwid', (req, res) => {
  const license = db.prepare('SELECT id, email, key_preview FROM licenses WHERE id = ?').get(req.params.id);
  if (!license) return res.status(404).json({ error: 'License not found.' });
  const binding = licensing.bindingForLicense(license.id);
  res.json({
    license: { id: license.id, email: license.email, preview: license.key_preview },
    binding: binding
      ? {
          hwidPreview: binding.hwid_preview,
          email: binding.email,
          firstIp: binding.first_ip,
          lastIp: binding.last_ip,
          boundAt: binding.bound_at,
          lastSeenAt: binding.last_seen_at,
          loginCount: binding.login_count,
        }
      : null,
  });
});

router.post('/licenses/:id/hwid/reset', (req, res) => {
  const license = db.prepare('SELECT id, key_preview FROM licenses WHERE id = ?').get(req.params.id);
  if (!license) return res.status(404).json({ error: 'License not found.' });
  const removed = licensing.resetBinding(license.id);
  audit('admin', 'license.hwid_reset', license.key_preview, { licenseId: license.id, removed });
  res.json({ ok: true, removed });
});

// ── Customers ────────────────────────────────────────────────────────────────

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT u.*,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_orders,
        (SELECT COALESCE(SUM(o.amount_cents), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS revenue_cents,
        (SELECT COUNT(*) FROM licenses l WHERE l.user_id = u.id AND l.status = 'active') AS active_licenses
       FROM users u WHERE u.email LIKE ? OR u.display_name LIKE ? ORDER BY u.created_at DESC LIMIT 200`
    )
    .all(like, like);
  res.json({
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      blacklisted: Boolean(u.blacklisted),
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      paidOrders: u.paid_orders,
      revenueCents: u.revenue_cents,
      activeLicenses: u.active_licenses,
    })),
  });
});

router.post('/users/:id/blacklist', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  db.prepare('UPDATE users SET blacklisted = 1 WHERE id = ?').run(user.id);
  db.prepare("UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'").run(
    Date.now(),
    user.id
  );
  try {
    db.prepare('INSERT INTO blacklist (id, kind, value, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
      `bl_${require('crypto').randomBytes(10).toString('hex')}`,
      'email',
      user.email,
      String(req.body?.reason || 'Account suspended from admin dashboard').slice(0, 300),
      Date.now(),
      'admin'
    );
  } catch {
    /* already listed */
  }
  audit('admin', 'user.blacklist', user.email, { userId: user.id });
  res.json({ ok: true });
});

router.post('/users/:id/unblacklist', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  db.prepare('UPDATE users SET blacklisted = 0 WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM blacklist WHERE kind = ? AND value = ?').run('email', user.email);
  audit('admin', 'user.unblacklist', user.email, { userId: user.id });
  res.json({ ok: true });
});

// ── Products ─────────────────────────────────────────────────────────────────

router.get('/products', (_req, res) => {
  res.json({ products: listProducts({ includeInactive: true }) });
});

function productInput(body, existing) {
  const name = String(body?.name ?? existing?.name ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Name is required.' };
  const priceCents = Math.round(Number(body?.priceCents ?? existing?.priceCents ?? 0));
  if (!Number.isFinite(priceCents) || priceCents < 50 || priceCents > 100_000) {
    return { error: 'Price must be between $0.50 and $1,000.00.' };
  }
  let durationDays = body?.durationDays === undefined ? existing?.durationDays ?? null : body.durationDays;
  if (durationDays === '' || durationDays === null || durationDays === 'lifetime') durationDays = null;
  else {
    durationDays = Math.round(Number(durationDays));
    if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) {
      return { error: 'Duration must be 1–3650 days, or empty for lifetime.' };
    }
  }
  const features = Array.isArray(body?.features)
    ? body.features
    : String(body?.features || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
  return {
    value: {
      name,
      tagline: String(body?.tagline ?? existing?.tagline ?? '').slice(0, 120),
      description: String(body?.description ?? existing?.description ?? '').slice(0, 1000),
      priceCents,
      currency: String(body?.currency ?? existing?.currency ?? 'usd').toLowerCase().slice(0, 3),
      durationDays,
      features: features.slice(0, 12),
      badge: String(body?.badge ?? existing?.badge ?? '').slice(0, 30) || null,
      note: String(body?.note ?? existing?.note ?? '').slice(0, 120) || null,
      sort: Math.max(0, Math.round(Number(body?.sort ?? existing?.sort ?? 0))),
      active: body?.active === undefined ? (existing ? existing.active : true) : Boolean(body.active),
    },
  };
}

router.post('/products', (req, res) => {
  const parsed = productInput(req.body, null);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  const baseSlug =
    String(req.body?.slug || v.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'plan';
  let slug = baseSlug;
  let n = 2;
  while (db.prepare('SELECT 1 AS hit FROM products WHERE slug = ?').get(slug)) slug = `${baseSlug}-${n++}`;
  const id = `prd_${require('crypto').randomBytes(6).toString('hex')}`;
  db.prepare(
    `INSERT INTO products (id, slug, name, tagline, description, price_cents, currency, duration_days, features, badge, note, sort, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    slug,
    v.name,
    v.tagline,
    v.description,
    v.priceCents,
    v.currency,
    v.durationDays,
    JSON.stringify(v.features),
    v.badge,
    v.note,
    v.sort,
    v.active ? 1 : 0,
    Date.now()
  );
  audit('admin', 'product.create', slug, { name: v.name, priceCents: v.priceCents });
  res.status(201).json({ product: getProduct(id) });
});

router.put('/products/:id', (req, res) => {
  const existing = getProduct(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found.' });
  const parsed = productInput(req.body, existing);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  db.prepare(
    `UPDATE products SET name = ?, tagline = ?, description = ?, price_cents = ?, currency = ?, duration_days = ?,
     features = ?, badge = ?, note = ?, sort = ?, active = ?, updated_at = ? WHERE id = ?`
  ).run(
    v.name,
    v.tagline,
    v.description,
    v.priceCents,
    v.currency,
    v.durationDays,
    JSON.stringify(v.features),
    v.badge,
    v.note,
    v.sort,
    v.active ? 1 : 0,
    Date.now(),
    existing.id
  );
  audit('admin', 'product.update', existing.slug, { name: v.name, priceCents: v.priceCents, active: v.active });
  res.json({ product: getProduct(existing.id) });
});

// ── Blacklist ────────────────────────────────────────────────────────────────

router.get('/blacklist', (_req, res) => {
  const rows = db.prepare('SELECT * FROM blacklist ORDER BY created_at DESC LIMIT 500').all();
  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.kind === 'key' ? 'encrypted key hash' : r.value,
      reason: r.reason,
      createdAt: r.created_at,
      createdBy: r.created_by,
    })),
  });
});

router.post('/blacklist', (req, res) => {
  const kind = String(req.body?.kind || '').toLowerCase();
  if (!['email', 'ip', 'discord', 'key'].includes(kind)) {
    return res.status(400).json({ error: 'Kind must be email, ip, discord, or key.' });
  }
  let value = String(req.body?.value || '').trim();
  if (!value) return res.status(400).json({ error: 'Value is required.' });
  if (kind === 'email') {
    value = normalizeEmail(value);
    if (!validEmail(value)) return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (kind === 'key') {
    if (!normalizeLicenseKey(value)) return res.status(400).json({ error: 'Invalid license key.' });
    value = licenseHash(value);
  }
  if (isBlacklisted(kind, value)) return res.status(409).json({ error: 'Entry already exists.' });
  const id = `bl_${require('crypto').randomBytes(10).toString('hex')}`;
  db.prepare('INSERT INTO blacklist (id, kind, value, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    kind,
    value,
    String(req.body?.reason || '').slice(0, 300) || null,
    Date.now(),
    'admin'
  );
  audit('admin', 'blacklist.add', kind, { reason: req.body?.reason || null, value: kind === 'key' ? 'hash' : value });
  res.status(201).json({ ok: true, id });
});

router.delete('/blacklist/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM blacklist WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Entry not found.' });
  db.prepare('DELETE FROM blacklist WHERE id = ?').run(row.id);
  audit('admin', 'blacklist.remove', row.kind, { value: row.kind === 'key' ? 'hash' : row.value });
  res.json({ ok: true });
});

// ── Audit log ────────────────────────────────────────────────────────────────

router.get('/audit', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = db.prepare('SELECT * FROM audit ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({
    entries: rows.map((r) => {
      let detail = null;
      try {
        detail = r.detail ? JSON.parse(r.detail) : null;
      } catch {
        detail = r.detail;
      }
      return { id: r.id, actor: r.actor, action: r.action, target: r.target, detail, createdAt: r.created_at };
    }),
  });
});

// ── Settings / integrations ──────────────────────────────────────────────────

router.get('/settings', async (_req, res) => {
  const webhook = await getWebhookUrl();
  res.json({
    brand: getSetting('brand', config.brand),
    supportEmail: getSetting('support_email', config.supportEmail),
    discordInvite: getSetting('discord_invite', ''),
    discordTicketUrl: getSetting('discord_ticket_url', ''),
    webhookConfigured: Boolean(webhook),
    webhookMasked: webhook ? `${webhook.slice(0, 42)}…${webhook.slice(-6)}` : null,
    stripeConfigured: stripeConfigured(),
    stripeSource: stripeSource(),
    stripeWebhookConfigured: Boolean(webhookSecret()),
    stripeWebhookUrl: `${config.baseUrl}/api/webhook/stripe`,
    manualPayments: getSetting('manual_payments', '0') === '1',
    manualCashapp: getSetting('manual_cashapp', ''),
    manualPaypal: getSetting('manual_paypal', ''),
    manualBtc: getSetting('manual_btc', ''),
    manualEth: getSetting('manual_eth', ''),
    manualUsdt: getSetting('manual_usdt', ''),
    manualCrypto: getSetting('manual_crypto', ''),
    manualInstructions: getSetting('manual_instructions', ''),
    paymentMode: publicPaymentMode(),
    demoMode: config.demoMode,
    botSecretConfigured: Boolean(config.botSecret),
  });
});

router.put('/settings', (req, res) => {
  const {
    brand,
    supportEmail,
    discordInvite,
    discordTicketUrl,
    webhookUrl,
    stripeSecretKey,
    stripeWebhookSecret,
    clearStripe,
    manualPayments,
    manualCashapp,
    manualPaypal,
    manualBtc,
    manualEth,
    manualUsdt,
    manualCrypto,
    manualInstructions,
  } = req.body || {};

  let nextStripeKey;
  if (stripeSecretKey !== undefined) {
    nextStripeKey = String(stripeSecretKey).trim();
    if (nextStripeKey && !/^(sk|rk)_(live|test)_[A-Za-z0-9_]+$/.test(nextStripeKey)) {
      return res.status(400).json({ error: 'Enter a valid Stripe secret key (sk_live_… or sk_test_…).' });
    }
  }
  let nextWebhookSecret;
  if (stripeWebhookSecret !== undefined) {
    nextWebhookSecret = String(stripeWebhookSecret).trim();
    if (nextWebhookSecret && !/^whsec_[A-Za-z0-9_]+$/.test(nextWebhookSecret)) {
      return res.status(400).json({ error: 'Enter a valid Stripe webhook signing secret (whsec_…).' });
    }
  }

  let nextCashapp;
  if (manualCashapp !== undefined) {
    let raw = String(manualCashapp).trim();
    if (raw) {
      raw = raw
        .replace(/^https?:\/\/(?:www\.)?cash\.app\//i, '')
        .replace(/^\$/, '')
        .split(/[/?#]/)[0];
      if (!/^[A-Za-z][A-Za-z0-9]{0,19}$/.test(raw)) {
        return res.status(400).json({ error: 'Enter a Cash App cashtag like $yourname.' });
      }
      nextCashapp = `$${raw}`;
    } else {
      nextCashapp = '';
    }
  }

  let nextPaypal;
  if (manualPaypal !== undefined) {
    let raw = String(manualPaypal).trim();
    if (raw) {
      if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        return res.status(400).json({ error: 'Enter a valid paypal.me link.' });
      }
      if (!['paypal.me', 'www.paypal.me'].includes(parsed.hostname.toLowerCase())) {
        return res.status(400).json({ error: 'Enter a paypal.me link, e.g. https://paypal.me/yourname.' });
      }
      nextPaypal = parsed.toString();
    } else {
      nextPaypal = '';
    }
  }

  let nextBtc;
  if (manualBtc !== undefined) {
    let raw = String(manualBtc).trim();
    if (raw) {
      if (/^bc1/i.test(raw)) raw = raw.toLowerCase();
      const bech32 = /^bc1[a-z0-9]{25,62}$/.test(raw);
      const legacy = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(raw);
      if (!bech32 && !legacy) {
        return res.status(400).json({ error: 'Enter a valid Bitcoin address (bc1…, 1…, or 3…).' });
      }
      nextBtc = raw;
    } else {
      nextBtc = '';
    }
  }

  let nextEth;
  if (manualEth !== undefined) {
    const raw = String(manualEth).trim();
    if (raw && !/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      return res.status(400).json({ error: 'Enter a valid Ethereum address (0x…, 40 hex characters).' });
    }
    nextEth = raw;
  }

  let nextUsdt;
  if (manualUsdt !== undefined) {
    const raw = String(manualUsdt).trim();
    if (raw && !/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      return res.status(400).json({ error: 'Enter a valid USDT ERC-20 address (0x…, 40 hex characters).' });
    }
    nextUsdt = raw;
  }

  let nextCrypto;
  if (manualCrypto !== undefined) nextCrypto = String(manualCrypto).trim().slice(0, 800);
  let nextInstructions;
  if (manualInstructions !== undefined) nextInstructions = String(manualInstructions).trim().slice(0, 600);

  let nextTicketUrl;
  if (discordTicketUrl !== undefined) {
    const raw = String(discordTicketUrl).trim();
    if (raw) {
      if (!/^https?:\/\/[^\s]+$/i.test(raw)) {
        return res.status(400).json({ error: 'Enter a valid Discord ticket URL.' });
      }
      nextTicketUrl = raw.slice(0, 300);
    } else {
      nextTicketUrl = '';
    }
  }

  const effectiveEnabled =
    manualPayments !== undefined ? Boolean(manualPayments) : getSetting('manual_payments', '0') === '1';
  const effectiveCashapp = nextCashapp !== undefined ? nextCashapp : getSetting('manual_cashapp', '');
  const effectivePaypal = nextPaypal !== undefined ? nextPaypal : getSetting('manual_paypal', '');
  const effectiveBtc = nextBtc !== undefined ? nextBtc : getSetting('manual_btc', '');
  const effectiveEth = nextEth !== undefined ? nextEth : getSetting('manual_eth', '');
  const effectiveUsdt = nextUsdt !== undefined ? nextUsdt : getSetting('manual_usdt', '');
  const effectiveCrypto = nextCrypto !== undefined ? nextCrypto : getSetting('manual_crypto', '');
  if (
    effectiveEnabled &&
    !effectiveCashapp &&
    !effectivePaypal &&
    !effectiveBtc &&
    !effectiveEth &&
    !effectiveUsdt &&
    !effectiveCrypto
  ) {
    return res.status(400).json({ error: 'Add at least one payment method before enabling manual payments.' });
  }

  if (brand !== undefined) setSetting('brand', String(brand).slice(0, 60));
  if (supportEmail !== undefined) {
    const email = normalizeEmail(supportEmail);
    if (email && !validEmail(email)) return res.status(400).json({ error: 'Invalid support email.' });
    setSetting('support_email', email);
  }
  if (discordInvite !== undefined) setSetting('discord_invite', String(discordInvite).trim().slice(0, 200));
  if (nextTicketUrl !== undefined) setSetting('discord_ticket_url', nextTicketUrl);
  if (webhookUrl !== undefined) {
    const url = String(webhookUrl).trim();
    if (url && !isValidWebhook(url)) return res.status(400).json({ error: 'Enter a valid Discord webhook URL.' });
    setSetting('discord_webhook_url', url ? `enc:${encryptText(url)}` : '');
  }
  if (nextStripeKey !== undefined) {
    setSetting('stripe_secret_key', nextStripeKey ? `enc:${encryptText(nextStripeKey)}` : '');
    resetStripeClient();
  }
  if (nextWebhookSecret !== undefined) {
    setSetting('stripe_webhook_secret', nextWebhookSecret ? `enc:${encryptText(nextWebhookSecret)}` : '');
  }
  if (clearStripe === true) {
    setSetting('stripe_secret_key', '');
    setSetting('stripe_webhook_secret', '');
    resetStripeClient();
  }
  if (nextCashapp !== undefined) setSetting('manual_cashapp', nextCashapp);
  if (nextPaypal !== undefined) setSetting('manual_paypal', nextPaypal);
  if (nextBtc !== undefined) setSetting('manual_btc', nextBtc);
  if (nextEth !== undefined) setSetting('manual_eth', nextEth);
  if (nextUsdt !== undefined) setSetting('manual_usdt', nextUsdt);
  if (nextCrypto !== undefined) setSetting('manual_crypto', nextCrypto);
  if (nextInstructions !== undefined) setSetting('manual_instructions', nextInstructions);
  if (manualPayments !== undefined) setSetting('manual_payments', manualPayments ? '1' : '0');

  audit('admin', 'settings.update', null, {
    webhookChanged: webhookUrl !== undefined,
    brand: brand !== undefined ? String(brand) : undefined,
    stripeKeyChanged: nextStripeKey !== undefined || clearStripe === true,
    stripeWebhookChanged: nextWebhookSecret !== undefined || clearStripe === true,
    manualChanged:
      manualPayments !== undefined ||
      nextCashapp !== undefined ||
      nextPaypal !== undefined ||
      nextBtc !== undefined ||
      nextEth !== undefined ||
      nextUsdt !== undefined ||
      nextCrypto !== undefined ||
      nextInstructions !== undefined ||
      nextTicketUrl !== undefined,
  });
  res.json({ ok: true, paymentMode: publicPaymentMode() });
});

router.post('/settings/test-stripe', async (_req, res) => {
  const result = await verifyStripeKey();
  if (!result.ok) {
    return res.status(502).json({
      error: result.reason === 'not_configured' ? 'Add a Stripe secret key first.' : 'Stripe rejected the key.',
      detail: result,
    });
  }
  res.json(result);
});

router.post('/settings/test-webhook', async (_req, res) => {
  const result = await sendTestLog();
  if (!result.sent) return res.status(502).json({ error: 'Webhook test failed.', detail: result });
  res.json({ ok: true });
});

router.get('/integrations/stripe', async (_req, res) => {
  res.json(await verifyStripeKey());
});

// ── Reveal (admin-side, same one-time codes) ─────────────────────────────────

router.post('/reveal', (req, res) => {
  const code = normalizeVerifyCode(req.body?.code || '');
  if (code.length !== 8) return res.status(400).json({ error: 'Verification code must be 8 characters.' });
  const row = db.prepare('SELECT * FROM verify_codes WHERE code_hash = ?').get(verifyCodeHash(code));
  if (!row) return res.status(404).json({ error: 'Code not found.' });
  if (row.used_at) return res.status(409).json({ error: 'Code already used.', usedAt: row.used_at });
  if (row.expires_at < Date.now()) return res.status(410).json({ error: 'Code expired.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id);
  if (!order) return res.status(404).json({ error: 'Order missing.' });
  const license = licenseForOrder(order.id);
  db.prepare('UPDATE verify_codes SET used_at = ?, used_by = ? WHERE id = ?').run(Date.now(), 'admin', row.id);
  audit('admin', 'purchase.reveal', order.number, { codeId: row.id });
  res.json({
    purchaseId: order.number,
    product: order.product_name,
    amountCents: order.amount_cents,
    currency: order.currency,
    customerEmail: order.customer_email,
    licenseKey: license ? decryptText(license.key_enc) : null,
    licenseStatus: license ? licenseStatus(license) : null,
    expiresAt: license?.expires_at || null,
    createdAt: order.created_at,
    paidAt: order.paid_at,
  });
});

module.exports = router;

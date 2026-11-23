'use strict';

const { db, getProduct } = require('./db');
const {
  generateLicenseKey,
  licenseHash,
  keyPreview,
  generateOrderNumber,
  newId,
  encryptText,
  decryptText,
} = require('./security');
const { sendPurchaseLog } = require('./discord');

const DAY = 86_400_000;

function getOrderByNumber(number) {
  return db.prepare('SELECT * FROM orders WHERE number = ?').get(String(number));
}

function getOrderById(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(String(id));
}

function getOrderBySession(sessionId) {
  return db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(String(sessionId));
}

function licenseForOrder(orderId) {
  return db.prepare('SELECT * FROM licenses WHERE order_id = ? ORDER BY issued_at DESC LIMIT 1').get(String(orderId));
}

function userForOrder(order) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
}

function licenseStatus(license) {
  if (!license) return 'missing';
  if (license.status === 'revoked' || license.status === 'blacklisted') return license.status;
  if (license.status === 'stock') return 'stock';
  if (!license.order_id && !license.user_id && !license.email) return 'stock';
  if (license.expires_at && license.expires_at < Date.now()) return 'expired';
  return 'active';
}

function createOrder(user, product, { status = 'pending', paymentMethod = null, game = 'cs2' } = {}) {
  const number = generateOrderNumber();
  const id = newId('ord');
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO orders (id, number, user_id, product_id, product_name, amount_cents, currency, status, customer_email, payment_method, game, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    number,
    user.id,
    product.id,
    product.name,
    product.priceCents,
    product.currency,
    status,
    user.email,
    paymentMethod,
    game,
    createdAt
  );
  return getOrderById(id);
}

function createLicenseRecord({
  order,
  product,
  key,
  issuedAt,
  expiresAt,
  durationDays = null,
  note = null,
  userId = null,
  email = null,
  status = 'active',
  game = null,
}) {
  const id = newId('lic');
  const hash = licenseHash(key);
  const ownerEmail = email || (order ? order.customer_email : null);
  const ownerGame = game || (order ? order.game : null) || 'cs2';
  db.prepare(
    `INSERT INTO licenses (id, order_id, user_id, product_id, email, key_enc, key_hash, key_preview, status, issued_at, expires_at, duration_days, game, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    order ? order.id : null,
    userId || (order ? order.user_id : null),
    product ? product.id : null,
    ownerEmail,
    encryptText(key),
    hash,
    keyPreview(key),
    status,
    issuedAt,
    expiresAt,
    durationDays,
    ownerGame,
    note
  );
  return db.prepare('SELECT * FROM licenses WHERE id = ?').get(id);
}

function generateUniqueKey() {
  let key = generateLicenseKey();
  let attempts = 0;
  while (db.prepare('SELECT 1 AS hit FROM licenses WHERE key_hash = ?').get(licenseHash(key)) && attempts < 6) {
    key = generateLicenseKey();
    attempts += 1;
  }
  return key;
}

function issueKey({ product, order = null, userId = null, durationDays, note = null, email = null, game = null }) {
  const key = generateUniqueKey();
  const issuedAt = Date.now();
  const days = durationDays === undefined ? product.durationDays : durationDays;
  const expiresAt = days === null || days === undefined ? null : issuedAt + Number(days) * DAY;
  const license = createLicenseRecord({
    order,
    product,
    key,
    issuedAt,
    expiresAt,
    durationDays: days ?? null,
    note,
    userId,
    email,
    game,
  });
  return { license, key };
}

function issueStockKey({ product, durationDays, note = null }) {
  const key = generateUniqueKey();
  const days = durationDays === undefined ? product.durationDays : durationDays;
  const license = createLicenseRecord({
    product,
    key,
    issuedAt: Date.now(),
    expiresAt: null,
    durationDays: days ?? null,
    note,
    status: 'stock',
  });
  return { license, key };
}

function claimStockKey(order, product) {
  const row = db
    .prepare("SELECT * FROM licenses WHERE product_id = ? AND status = 'stock' ORDER BY issued_at ASC LIMIT 1")
    .get(product.id);
  if (!row) return null;
  const issuedAt = Date.now();
  const days = row.duration_days === undefined ? product.durationDays : row.duration_days;
  const expiresAt = days === null || days === undefined ? null : issuedAt + Number(days) * DAY;
  const result = db
    .prepare(
      `UPDATE licenses
          SET status = 'active', order_id = ?, user_id = ?, email = ?, issued_at = ?, expires_at = ?,
              game = COALESCE(game, ?)
        WHERE id = ? AND status = 'stock'`
    )
    .run(order.id, order.user_id, order.customer_email, issuedAt, expiresAt,
      order.game || 'cs2', row.id);
  if (!result.changes) return null;
  const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(row.id);
  return { license, key: decryptText(license.key_enc) };
}

async function fulfillOrder(order, { paymentIntent = null, sessionId = null, ip = null, source = 'stripe' } = {}) {
  const fresh = getOrderById(order.id);
  if (!fresh) throw new Error('Order not found');
  if (fresh.status === 'paid') {
    const existing = licenseForOrder(fresh.id);
    return {
      order: fresh,
      license: existing,
      key: existing ? decryptText(existing.key_enc) : null,
      alreadyFulfilled: true,
    };
  }

  const product = getProduct(fresh.product_id) || {
    id: fresh.product_id,
    durationDays: 30,
    name: fresh.product_name,
  };
  const { license, key } =
    claimStockKey(fresh, product) ||
    issueKey({
      product,
      order: fresh,
      durationDays: product.durationDays,
      email: fresh.customer_email,
      game: fresh.game,
    });
  const paidAt = Date.now();

  db.prepare(
    `UPDATE orders SET status = 'paid', paid_at = ?, expires_at = ?, stripe_payment_intent = COALESCE(?, stripe_payment_intent),
     stripe_session_id = COALESCE(?, stripe_session_id) WHERE id = ?`
  ).run(paidAt, license.expires_at, paymentIntent, sessionId, fresh.id);

  const updated = getOrderById(fresh.id);
  const user = userForOrder(updated);
  let discord = { sent: false, reason: 'not_configured' };
  try {
    discord = await sendPurchaseLog({ order: updated, license, key, user, ip, source });
  } catch (err) {
    discord = { sent: false, reason: 'error', detail: String(err.message || err) };
  }
  db.prepare('UPDATE orders SET discord_status = ? WHERE id = ?').run(
    discord.sent ? 'sent' : `failed:${discord.reason || 'unknown'}`,
    updated.id
  );

  return { order: getOrderById(fresh.id), license, key, discord };
}

function serializeOrderForUser(order) {
  const license = licenseForOrder(order.id);
  let key = null;
  if (license) {
    try {
      key = decryptText(license.key_enc);
    } catch {
      key = null;
    }
  }
  return {
    number: order.number,
    status: order.status,
    productName: order.product_name,
    game: order.game || 'cs2',
    amountCents: order.amount_cents,
    currency: order.currency,
    paymentMethod: order.payment_method || null,
    paymentRef: order.payment_ref || null,
    paymentClaimedAt: order.payment_claimed_at || null,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    expiresAt: license ? license.expires_at : order.expires_at,
    license: license
      ? {
          id: license.id,
          key,
          preview: license.key_preview,
          status: licenseStatus(license),
          issuedAt: license.issued_at,
          expiresAt: license.expires_at,
        }
      : null,
  };
}

function serializeLicenseAdmin(row) {
  let key = null;
  try {
    key = decryptText(row.key_enc);
  } catch {
    key = null;
  }
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name || null,
    userId: row.user_id,
    email: row.email || null,
    orderNumber: row.order_number || null,
    key,
    preview: row.key_preview,
    status: licenseStatus(row),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    durationDays: row.duration_days ?? null,
    revokedAt: row.revoked_at,
    note: row.note,
  };
}

function serializeLicenseForUser(row) {
  let key = null;
  try {
    key = decryptText(row.key_enc);
  } catch {
    key = null;
  }
  return {
    id: row.id,
    productName: row.product_name || null,
    game: row.game || 'cs2',
    email: row.email || null,
    orderNumber: row.order_number || null,
    key,
    preview: row.key_preview,
    status: licenseStatus(row),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

function revokeLicensesForOrder(orderId, reason = 'revoked') {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM licenses WHERE order_id = ?').all(orderId);
  db.prepare("UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE order_id = ? AND status != 'blacklisted'").run(
    now,
    orderId
  );
  db.prepare('UPDATE orders SET meta = ? WHERE id = ?').run(JSON.stringify({ revokeReason: reason, revokedAt: now }), orderId);
  return rows.length;
}

function findOrCreateStandaloneUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

module.exports = {
  DAY,
  getOrderByNumber,
  getOrderById,
  getOrderBySession,
  licenseForOrder,
  licenseStatus,
  createOrder,
  createLicenseRecord,
  issueKey,
  issueStockKey,
  fulfillOrder,
  serializeOrderForUser,
  serializeLicenseAdmin,
  serializeLicenseForUser,
  revokeLicensesForOrder,
  findOrCreateStandaloneUser,
};

'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(path.join(config.dataDir, 'store.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'customer',
    blacklisted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tagline TEXT,
    description TEXT,
    price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    duration_days INTEGER,
    features TEXT NOT NULL DEFAULT '[]',
    badge TEXT,
    note TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    product_id TEXT,
    product_name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    customer_email TEXT,
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent TEXT,
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    refunded_at INTEGER,
    expires_at INTEGER,
    discord_status TEXT,
    payment_method TEXT,
    payment_ref TEXT,
    payment_claimed_at INTEGER,
    meta TEXT
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    user_id TEXT,
    product_id TEXT,
    email TEXT,
    key_enc TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_preview TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    issued_at INTEGER NOT NULL,
    expires_at INTEGER,
    duration_days INTEGER,
    revoked_at INTEGER,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS license_bindings (
    license_id TEXT PRIMARY KEY,
    hwid_hash TEXT NOT NULL,
    hwid_preview TEXT,
    email TEXT,
    first_ip TEXT,
    last_ip TEXT,
    bound_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    login_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS verify_codes (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value TEXT NOT NULL UNIQUE,
    reason TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT
  );

  CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
  CREATE INDEX IF NOT EXISTS idx_licenses_order ON licenses(order_id);
  CREATE INDEX IF NOT EXISTS idx_bindings_hwid ON license_bindings(hwid_hash);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
`);

// Migrate databases created before license emails were stored.
try {
  db.exec('ALTER TABLE licenses ADD COLUMN email TEXT');
} catch {
  /* column already exists */
}
try {
  db.exec('ALTER TABLE licenses ADD COLUMN duration_days INTEGER');
} catch {
  /* column already exists */
}
for (const sql of [
  'ALTER TABLE orders ADD COLUMN payment_method TEXT',
  'ALTER TABLE orders ADD COLUMN payment_ref TEXT',
  'ALTER TABLE orders ADD COLUMN payment_claimed_at INTEGER',
]) {
  try {
    db.exec(sql);
  } catch {
    /* column already exists */
  }
}
try {
  db.exec(`
    UPDATE licenses
       SET email = (SELECT customer_email FROM orders WHERE orders.id = licenses.order_id)
     WHERE email IS NULL AND order_id IS NOT NULL;
    UPDATE licenses
       SET email = (SELECT email FROM users WHERE users.id = licenses.user_id)
     WHERE email IS NULL AND user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
  `);
} catch (err) {
  console.error('License email migration failed:', err.message);
}

// ── Settings ─────────────────────────────────────────────────────────────────

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value === null || value === undefined ? null : String(value));
}

const defaults = {
  brand: config.brand,
  support_email: config.supportEmail,
  discord_invite: '',
  discord_webhook_url: '',
  discord_ticket_url: '',
  manual_payments: '0',
  manual_cashapp: '',
  manual_paypal: '',
  manual_btc: '',
  manual_eth: '',
  manual_usdt: '',
  manual_crypto: '',
  manual_instructions:
    'Pay the exact amount, include your order number in the note, then submit the transaction ID or open a Discord ticket.',
};
for (const [key, value] of Object.entries(defaults)) {
  if (getSetting(key) === null) setSetting(key, value);
}

// ── Products ─────────────────────────────────────────────────────────────────

const now = Date.now();
const seedProducts = [
  {
    id: 'prd_weekly',
    slug: 'weekly',
    name: 'Weekly License',
    tagline: 'Short cycle access, delivered instantly.',
    price_cents: 599,
    duration_days: 7,
    badge: 'STARTER',
    note: '≈ €5.44 EUR / £4.54 GBP',
    features: [
      'Full access to core features',
      'Instant encrypted key delivery',
      'Standard support channel',
    ],
    sort: 1,
  },
  {
    id: 'prd_monthly',
    slug: 'monthly',
    name: 'Monthly License',
    tagline: 'The working plan for daily use.',
    price_cents: 1599,
    duration_days: 30,
    badge: 'MOST POPULAR',
    note: '≈ €14.52 EUR / £12.11 GBP',
    features: [
      'Full access to core features',
      'Instant encrypted key delivery',
      'Priority support channel',
      'Free minor updates',
    ],
    sort: 2,
  },
  {
    id: 'prd_lifetime',
    slug: 'lifetime',
    name: 'Lifetime License',
    tagline: 'One payment. Permanent access.',
    price_cents: 3000,
    duration_days: null,
    badge: 'BEST VALUE',
    note: '≈ €27.24 EUR / £22.72 GBP',
    features: [
      'Full access to core features',
      'All future updates included',
      '1-on-1 private developer line',
      'Direct help & priority fixes',
    ],
    sort: 3,
  },
];

if (db.prepare('SELECT COUNT(*) AS c FROM products').get().c === 0) {
  const insert = db.prepare(`
    INSERT INTO products (id, slug, name, tagline, description, price_cents, currency, duration_days, features, badge, note, sort, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  for (const p of seedProducts) {
    insert.run(
      p.id,
      p.slug,
      p.name,
      p.tagline,
      p.tagline,
      p.price_cents,
      'usd',
      p.duration_days,
      JSON.stringify(p.features),
      p.badge,
      p.note,
      p.sort,
      now
    );
  }
}

// Rename the original "Pass" products in place (idempotent).
db.prepare("UPDATE products SET name = 'Weekly License' WHERE slug = 'weekly' AND name = 'Weekly Pass'").run();
db.prepare("UPDATE products SET name = 'Monthly License' WHERE slug = 'monthly' AND name = 'Monthly Pass'").run();
// Keep historical order snapshots consistent with the renamed catalog.
db.prepare("UPDATE orders SET product_name = 'Weekly License' WHERE product_name = 'Weekly Pass'").run();
db.prepare("UPDATE orders SET product_name = 'Monthly License' WHERE product_name = 'Monthly Pass'").run();

function mapProduct(row) {
  if (!row) return null;
  let features = [];
  try {
    features = JSON.parse(row.features || '[]');
  } catch {
    features = [];
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    durationDays: row.duration_days,
    features,
    badge: row.badge,
    note: row.note,
    sort: row.sort,
    active: Boolean(row.active),
    updatedAt: row.updated_at,
  };
}

function listProducts({ includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM products ORDER BY sort ASC, price_cents ASC'
    : 'SELECT * FROM products WHERE active = 1 ORDER BY sort ASC, price_cents ASC';
  return db.prepare(sql).all().map(mapProduct);
}

function stockCounts() {
  const rows = db
    .prepare("SELECT product_id, COUNT(*) AS c FROM licenses WHERE status = 'stock' AND product_id IS NOT NULL GROUP BY product_id")
    .all();
  const counts = Object.create(null);
  for (const row of rows) counts[row.product_id] = Number(row.c) || 0;
  return counts;
}

function getProduct(idOrSlug) {
  const row = db
    .prepare('SELECT * FROM products WHERE id = ? OR slug = ?')
    .get(String(idOrSlug), String(idOrSlug));
  return mapProduct(row);
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

function audit(actor, action, target, detail) {
  db.prepare('INSERT INTO audit (id, actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    `aud_${require('crypto').randomBytes(10).toString('hex')}`,
    actor,
    action,
    target || null,
    detail ? JSON.stringify(detail) : null,
    Date.now()
  );
}

function isBlacklisted(kind, value) {
  return Boolean(
    db.prepare('SELECT 1 AS hit FROM blacklist WHERE kind = ? AND value = ?').get(kind, String(value))
  );
}

setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 30 * 60_000).unref();

module.exports = {
  db,
  getSetting,
  setSetting,
  listProducts,
  getProduct,
  stockCounts,
  audit,
  isBlacklisted,
};

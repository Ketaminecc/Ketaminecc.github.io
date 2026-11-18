'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const { db } = require('./db');
const { getOrderBySession, getOrderById, fulfillOrder } = require('./orders');
const { originGuard, cors } = require('./security');
const { stripe, stripeConfigured, webhookSecret, retrieveCheckoutSession } = require('./stripe');
const { getWebhookUrl, isValidWebhook } = require('./discord');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

// ── Security headers ─────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(self)');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self' https://checkout.stripe.com",
    ].join('; ')
  );
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ── Stripe webhook (raw body — must be registered before JSON parsing) ───────

app.post('/api/webhook/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const signingSecret = webhookSecret();
  if (!stripeConfigured() || !signingSecret) {
    return res.status(503).send('Stripe webhook is not configured');
  }
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], signingSecret);
  } catch (err) {
    console.error('[stripe] webhook signature failed:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid' || event.type === 'checkout.session.async_payment_succeeded') {
        const order = getOrderBySession(session.id) || getOrderById(session.metadata?.orderId || '');
        if (order) {
          await fulfillOrder(order, {
            paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
            sessionId: session.id,
            source: 'stripe',
          });
        }
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const order = getOrderBySession(session.id);
      if (order && order.status === 'pending') {
        db.prepare("UPDATE orders SET status = 'expired' WHERE id = ?").run(order.id);
      }
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (paymentIntent) {
        const order = db.prepare('SELECT * FROM orders WHERE stripe_payment_intent = ?').get(paymentIntent);
        if (order && order.status !== 'refunded') {
          db.prepare("UPDATE orders SET status = 'refunded', refunded_at = ? WHERE id = ?").run(Date.now(), order.id);
          db.prepare("UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE order_id = ? AND status = 'active'").run(
            Date.now(),
            order.id
          );
        }
      }
    }
  } catch (err) {
    console.error('[stripe] webhook processing failed:', err);
    return res.status(500).send('Webhook processing failed');
  }

  return res.json({ received: true });
});

// ── Body parsing, origin guard, routes ───────────────────────────────────────

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use('/api', cors);
app.use(originGuard);

app.use('/api/admin', require('./admin'));
app.use('/api', require('./licensing'));
app.use('/api', require('./loader'));
app.use('/api', require('./public'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Static site (explicit whitelist — never serve /server) ───────────────────

const siteDir = config.siteDir;
app.use(
  '/assets',
  express.static(path.join(siteDir, 'assets'), {
    maxAge: config.isProd ? '7d' : 0,
    fallthrough: true,
    index: false,
    dotfiles: 'deny',
  })
);

const pages = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/login': 'login.html',
  '/login.html': 'login.html',
  '/checkout': 'checkout.html',
  '/checkout.html': 'checkout.html',
  '/checkout-success': 'checkout-success.html',
  '/checkout-success.html': 'checkout-success.html',
  '/dashboard': 'dashboard.html',
  '/dashboard.html': 'dashboard.html',
  '/account': 'account.html',
  '/account.html': 'account.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
  '/loader': 'loader.html',
  '/loader.html': 'loader.html',
};

for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(siteDir, file), (err) => {
      if (err) res.status(err.statusCode === 404 ? 404 : 500).send('Page not found');
    });
  });
}

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\n');
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  return res.status(404).type('text/plain').send('Not found');
});

// ── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  // body-parser marks its own failures with a 4xx status. A client that sends
  // broken JSON gets 400, not a 500 that reads like the server is down.
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) console.error('[server] unhandled error:', err);
  if (res.headersSent) return;
  if (status >= 500) return res.status(500).json({ error: 'Internal server error' });
  return res.status(status).json({
    error: status === 400 ? 'Malformed request body.' : 'Request rejected.',
  });
});

// ── Stripe reconciliation (webhook backup) ───────────────────────────────────

async function reconcilePendingOrders() {
  if (!stripeConfigured()) return;
  const rows = db
    .prepare(
      `SELECT * FROM orders
        WHERE status = 'pending' AND stripe_session_id IS NOT NULL AND created_at > ?
        ORDER BY created_at ASC LIMIT 20`
    )
    .all(Date.now() - 24 * 60 * 60_000);

  for (const order of rows) {
    try {
      const session = await retrieveCheckoutSession(order.stripe_session_id);
      const paymentIntent =
        typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (session.payment_status === 'paid') {
        await fulfillOrder(order, { paymentIntent, sessionId: session.id, source: 'stripe-reconcile' });
        console.log(`[stripe] reconciled paid order ${order.number}`);
      } else if (session.status === 'expired') {
        db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(order.id);
      }
    } catch (err) {
      console.error(`[stripe] reconcile ${order.number} failed:`, err.message);
    }
  }
}

setInterval(() => {
  reconcilePendingOrders().catch((err) => console.error('[stripe] reconcile loop:', err.message));
}, 5 * 60_000).unref();

setTimeout(() => {
  reconcilePendingOrders().catch((err) => console.error('[stripe] reconcile boot:', err.message));
}, 15_000).unref();

// ── Boot ─────────────────────────────────────────────────────────────────────

// assets/api-base.json is owned by scripts/tunnel-watchdog.ps1, which writes it
// at the same moment it rewrites the tunnel hostname. The server does not touch
// it: two writers means the stale one wins whenever the order flips.

const server = app.listen(config.port, config.host, async () => {
  console.log(`\n  ${config.brand} licensing server`);
  console.log(`  ──────────────────────────────────────────`);
  console.log(`  Local:    http://localhost:${config.port}`);
  console.log(`  API:      ${config.baseUrl}`);
  console.log(`  Site:     ${config.siteUrl}`);
  console.log(`  Payments: ${stripeConfigured() ? 'Stripe' : config.demoMode ? 'DEMO MODE (no charges)' : 'DISABLED'}`);
  console.log(`  Admin:    ${config.siteUrl}/admin.html`);
  const webhook = await getWebhookUrl().catch(() => null);
  console.log(`  Discord:  ${webhook && isValidWebhook(webhook) ? 'purchase log connected' : 'not configured'}`);
  console.log('');
});

function shutdown() {
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

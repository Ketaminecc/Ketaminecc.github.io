'use strict';

const config = require('./config');
const { getSetting } = require('./db');
const { decryptText } = require('./security');

let stripeClient = null;
let cachedSecret = null;

/* Keys can come from server/.env (preferred for a single-owner install) or from
   the admin console, where they are stored encrypted with ENC_KEY. */
function settingSecret(key) {
  const raw = getSetting(key, '');
  if (!raw) return '';
  const value = String(raw);
  if (!value.startsWith('enc:')) return value.trim();
  try {
    return String(decryptText(value.slice(4)) || '').trim();
  } catch (err) {
    console.error(`[stripe] could not decrypt ${key}:`, err.message);
    return '';
  }
}

function secretKey() {
  return String(config.stripeSecretKey || settingSecret('stripe_secret_key') || '').trim();
}

function webhookSecret() {
  return String(config.stripeWebhookSecret || settingSecret('stripe_webhook_secret') || '').trim();
}

function stripeSource() {
  if (config.stripeSecretKey) return 'env';
  if (settingSecret('stripe_secret_key')) return 'database';
  return 'none';
}

function resetStripeClient() {
  stripeClient = null;
  cachedSecret = null;
}

function stripe() {
  const key = secretKey();
  if (!key) return null;
  if (!stripeClient || cachedSecret !== key) {
    // eslint-disable-next-line global-require
    stripeClient = require('stripe')(key, {
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
    cachedSecret = key;
  }
  return stripeClient;
}

function stripeConfigured() {
  return Boolean(secretKey());
}

async function createCheckoutSession({ order, product, user }) {
  const client = stripe();
  if (!client) throw new Error('Stripe is not configured');
  const base = config.siteUrl;
  return client.checkout.sessions.create({
    mode: 'payment',
    customer_email: user.email,
    client_reference_id: user.id,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    metadata: {
      orderId: order.id,
      orderNumber: order.number,
      productId: product.id,
      userId: user.id,
    },
    payment_intent_data: {
      metadata: {
        orderId: order.id,
        orderNumber: order.number,
        productId: product.id,
        userId: user.id,
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: product.currency || 'usd',
          unit_amount: product.priceCents,
          product_data: {
            name: product.name,
            description: (product.tagline || '').slice(0, 300) || undefined,
          },
        },
      },
    ],
    success_url: `${base}/checkout-success.html?order=${encodeURIComponent(order.number)}`,
    cancel_url: `${base}/checkout.html?product=${encodeURIComponent(product.slug)}&canceled=1`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });
}

async function retrieveCheckoutSession(sessionId) {
  const client = stripe();
  if (!client) throw new Error('Stripe is not configured');
  return client.checkout.sessions.retrieve(String(sessionId));
}

async function refundPaymentIntent(paymentIntentId, amountCents) {
  const client = stripe();
  if (!client) throw new Error('Stripe is not configured');
  return client.refunds.create({
    payment_intent: paymentIntentId,
    ...(amountCents ? { amount: amountCents } : {}),
    metadata: { source: 'ketamine-cc-admin' },
  });
}

async function verifyStripeKey() {
  const client = stripe();
  if (!client) return { ok: false, reason: 'not_configured' };
  try {
    const account = await client.accounts.retrieve();
    return { ok: true, account: account.id, country: account.country, chargesEnabled: account.charges_enabled };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

function publicPaymentMode() {
  if (stripeConfigured()) return 'stripe';
  if (config.demoMode) return 'demo';
  return 'disabled';
}

module.exports = {
  stripe,
  stripeConfigured,
  stripeSource,
  webhookSecret,
  resetStripeClient,
  createCheckoutSession,
  retrieveCheckoutSession,
  refundPaymentIntent,
  verifyStripeKey,
  publicPaymentMode,
};

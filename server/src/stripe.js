'use strict';

const config = require('./config');

let stripeClient = null;

function stripe() {
  if (!config.stripeSecretKey) return null;
  if (!stripeClient) {
    // eslint-disable-next-line global-require
    stripeClient = require('stripe')(config.stripeSecretKey, {
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }
  return stripeClient;
}

function stripeConfigured() {
  return Boolean(config.stripeSecretKey);
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
  createCheckoutSession,
  refundPaymentIntent,
  verifyStripeKey,
  publicPaymentMode,
};

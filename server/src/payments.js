'use strict';

const config = require('./config');
const { getSetting } = require('./db');
const { stripeConfigured } = require('./stripe');

function value(key) {
  return String(getSetting(key, '') || '').trim();
}

function manualConfig() {
  const cashapp = value('manual_cashapp');
  const paypal = value('manual_paypal');
  const crypto = value('manual_crypto');
  const methods = [];
  if (cashapp) methods.push('cashapp');
  if (paypal) methods.push('paypal');
  if (crypto) methods.push('crypto');
  return {
    enabled: value('manual_payments') === '1',
    cashapp,
    paypal,
    crypto,
    instructions: value('manual_instructions'),
    ticketUrl: value('discord_ticket_url') || value('discord_invite'),
    methods,
  };
}

function manualActive() {
  const manual = manualConfig();
  return manual.enabled && manual.methods.length > 0;
}

function publicManualConfig() {
  const manual = manualConfig();
  if (!manual.enabled) return null;
  return {
    enabled: manual.enabled,
    cashapp: manual.cashapp,
    paypal: manual.paypal,
    crypto: manual.crypto,
    instructions: manual.instructions,
    ticketUrl: manual.ticketUrl,
    methods: manual.methods,
  };
}

/* Manual payments win on purpose: Stripe needs business activation that this
   install may not have, while a configured Cash App/PayPal/crypto method works
   immediately. Stripe stays available if manual payments are turned off. */
function publicPaymentMode() {
  if (manualActive()) return 'manual';
  if (stripeConfigured()) return 'stripe';
  if (config.demoMode) return 'demo';
  return 'disabled';
}

module.exports = {
  manualConfig,
  manualActive,
  publicManualConfig,
  publicPaymentMode,
};

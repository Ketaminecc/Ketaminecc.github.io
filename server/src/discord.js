'use strict';

const config = require('./config');
const { db, getSetting } = require('./db');
const {
  encryptJSON,
  decryptText,
  generateVerifyCode,
  verifyCodeHash,
  newId,
} = require('./security');

const VERIFY_TTL = 30 * 24 * 60 * 60 * 1000;

function isValidWebhook(url) {
  return /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(String(url || ''));
}

async function getWebhookUrl() {
  if (config.discordWebhookUrl) return config.discordWebhookUrl;
  const stored = getSetting('discord_webhook_url');
  if (!stored) return null;
  if (stored.startsWith('enc:')) {
    try {
      return decryptText(stored.slice(4));
    } catch {
      return null;
    }
  }
  return stored;
}

function chunk(value, size) {
  const out = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

function buildPurchasePayload({ order, license, key, user, ip, source }) {
  return {
    event: 'purchase',
    purchaseId: order.number,
    customer: {
      id: order.user_id,
      email: order.customer_email,
      name: user?.display_name || null,
      ip: ip || null,
    },
    product: {
      id: order.product_id,
      name: order.product_name,
      amountCents: order.amount_cents,
      currency: order.currency,
      durationDays: license?.expires_at
        ? Math.round((license.expires_at - license.issued_at) / 86_400_000)
        : null,
    },
    license: {
      key,
      preview: license?.key_preview,
      status: license?.status,
      issuedAt: license?.issued_at,
      expiresAt: license?.expires_at,
    },
    stripe: {
      sessionId: order.stripe_session_id || null,
      paymentIntent: order.stripe_payment_intent || null,
    },
    source,
    recordedAt: new Date().toISOString(),
  };
}

async function sendPurchaseLog(args) {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) return { sent: false, reason: 'not_configured' };

  const payload = buildPurchasePayload(args);
  const ciphertext = encryptJSON(payload);
  const code = generateVerifyCode();
  const createdAt = Date.now();

  db.prepare(
    'INSERT INTO verify_codes (id, order_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(newId('vc'), args.order.id, verifyCodeHash(code), createdAt, createdAt + VERIFY_TTL);

  const chunks = chunk(ciphertext, 950);
  const fields = [
    { name: 'Purchase ID', value: `\`${args.order.number}\``, inline: true },
    { name: 'Verification code', value: `\`${code}\``, inline: true },
  ];
  chunks.forEach((part, index) => {
    fields.push({
      name: chunks.length > 1 ? `Encrypted record ${index + 1}/${chunks.length}` : 'Encrypted record',
      value: `\`\`\`\n${part}\n\`\`\``,
    });
  });

  const body = {
    username: `${config.brand} · Purchases`,
    avatar_url: `${config.siteUrl}/assets/favicon.svg`,
    embeds: [
      {
        title: `New purchase · ${args.order.number}`,
        description:
          `Owner verification: run \`/verify ${code}\` in Discord.\n` +
          'All customer and license data below is AES-256-GCM encrypted.',
        color: 0xe5484d,
        fields,
        footer: { text: 'Encrypted at rest and in transit · one-time reveal' },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: false, reason: `discord_${res.status}`, detail: text.slice(0, 300) };
    }
    return { sent: true, code };
  } catch (err) {
    return { sent: false, reason: 'network', detail: String(err.message || err).slice(0, 300) };
  }
}

async function sendTestLog() {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: `${config.brand} · Purchases`,
        embeds: [
          {
            title: 'Webhook connected',
            description:
              'Purchase records from ketaminecc.website will be delivered here.\n' +
              'Records are encrypted with AES-256-GCM; use `/verify <code>` to reveal them.',
            color: 0x3dd68c,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: 'network', detail: String(err.message || err) };
  }
}

module.exports = { sendPurchaseLog, sendTestLog, getWebhookUrl, isValidWebhook };

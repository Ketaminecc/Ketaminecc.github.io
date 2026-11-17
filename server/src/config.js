'use strict';

const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const asInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && value !== '' && value !== undefined ? n : fallback;
};

const asBool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const siteUrl = (process.env.PUBLIC_SITE_URL || baseUrl).replace(/\/+$/, '');
const isProd = process.env.NODE_ENV === 'production';
const encKey = String(process.env.ENC_KEY || '').trim();
const cookieSameSite = String(process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(cookieSameSite)) {
  throw new Error('COOKIE_SAME_SITE must be lax, strict, or none.');
}

const allowedOrigins = [
  siteUrl,
  baseUrl,
  ...String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
];
if (!isProd) {
  allowedOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000');
}

const config = {
  port: asInt(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  isProd,
  baseUrl,
  siteUrl,
  allowedOrigins: [...new Set(allowedOrigins)],
  trustProxy: process.env.TRUST_PROXY === undefined ? 1 : asInt(process.env.TRUST_PROXY, 0),
  cookieSecure: siteUrl.startsWith('https://') || baseUrl.startsWith('https://') || isProd,
  cookieSameSite,
  sessionSecret: String(process.env.SESSION_SECRET || '').trim(),
  encKey,
  botSecret: String(process.env.BOT_SHARED_SECRET || '').trim(),
  adminSecret: String(process.env.ADMIN_SECRET || '').trim(),
  demoMode: asBool(process.env.DEMO_MODE, false),
  stripeSecretKey: String(process.env.STRIPE_SECRET_KEY || '').trim(),
  stripeWebhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
  discordWebhookUrl: String(process.env.DISCORD_PURCHASE_WEBHOOK_URL || '').trim(),
  supportEmail: process.env.SUPPORT_EMAIL || 'support@ketaminecc.site',
  dataDir: path.join(__dirname, '..', 'data'),
  siteDir: path.join(__dirname, '..', '..'),
  brand: 'Ketamine.cc',
};

if (!config.sessionSecret || config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET is missing or too short (32+ chars). Check server/.env');
}
if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
  throw new Error('ENC_KEY must be exactly 64 hex characters (32 bytes). Check server/.env');
}
if (!config.botSecret || config.botSecret.length < 24) {
  throw new Error('BOT_SHARED_SECRET is missing or too short (24+ chars). Check server/.env');
}
if (!config.adminSecret || config.adminSecret.length < 8) {
  throw new Error('ADMIN_SECRET is missing or too short. Check server/.env');
}

if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

module.exports = config;

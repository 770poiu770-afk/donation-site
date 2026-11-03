'use strict';
/**
 * Central configuration. All secrets come from environment variables
 * (or a local .env file in development) — never from the source code.
 */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '..', '.env'), quiet: true });

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

const PAYPAL_API = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

const mode = (env.PAYPAL_MODE || 'sandbox').toLowerCase();

const config = {
  isProduction,
  port: parseInt(env.PORT || '3000', 10),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY ? (isNaN(Number(env.TRUST_PROXY)) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)) : (isProduction ? 1 : false),
  timezone: env.TIMEZONE || 'Asia/Jerusalem',
  currency: (env.CURRENCY || 'USD').toUpperCase(),
  databasePath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'donations.db'),

  paypal: {
    mode, // sandbox | live | mock
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    apiBase: env.PAYPAL_API_BASE || PAYPAL_API[mode] || PAYPAL_API.sandbox,
    sdkBase: env.PAYPAL_SDK_URL || 'https://www.paypal.com/sdk/js',
    brandName: env.PAYPAL_BRAND_NAME || '',
    enableSubscriptions: env.ENABLE_MONTHLY !== 'false',
  },

  admin: {
    username: env.ADMIN_USERNAME || 'admin',
    passwordHash: env.ADMIN_PASSWORD_HASH || '',
  },

  sessionSecret: env.SESSION_SECRET || '',

  donation: {
    minCents: 100, // $1.00
    maxCents: 100000000, // $1,000,000.00
    presets: [5, 18, 36, 72, 100, 180, 360, 500, 1000, 5000, 10000, 50000, 100000],
  },
};

// In mock mode the "PayPal" API and SDK are served by this same app (for local demo / tests).
if (mode === 'mock') {
  config.paypal.apiBase = env.PAYPAL_API_BASE || `http://127.0.0.1:${config.port}/__mock-paypal`;
  config.paypal.sdkBase = '/__mock-paypal/sdk.js';
  config.paypal.clientId = config.paypal.clientId || 'mock-client-id';
  config.paypal.clientSecret = config.paypal.clientSecret || 'mock-secret';
  config.paypal.webhookId = config.paypal.webhookId || 'mock-webhook-id';
}

// Site content (organization name, texts, FAQ...) lives in config/site.json
const sitePath = env.SITE_CONFIG_PATH || path.join(__dirname, '..', 'config', 'site.json');
config.site = JSON.parse(fs.readFileSync(sitePath, 'utf8'));

config.paypalConfigured = () =>
  Boolean(config.paypal.clientId && config.paypal.clientSecret);

/** Validate configuration; throws in production when something critical is missing. */
config.validate = () => {
  const problems = [];
  const warnings = [];
  if (!['sandbox', 'live', 'mock'].includes(mode)) problems.push('PAYPAL_MODE must be sandbox, live or mock');
  if (mode === 'mock' && isProduction) problems.push('PAYPAL_MODE=mock is not allowed in production');
  if (!config.paypalConfigured()) (isProduction ? problems : warnings).push('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');
  if (!config.paypal.webhookId) (isProduction ? problems : warnings).push('PAYPAL_WEBHOOK_ID is not set — webhooks cannot be verified and will be rejected');
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    if (isProduction) problems.push('SESSION_SECRET must be at least 32 characters');
    else {
      warnings.push('SESSION_SECRET not set — using a random one (admin sessions reset on restart)');
      config.sessionSecret = require('crypto').randomBytes(32).toString('hex');
    }
  }
  if (!config.admin.passwordHash) (isProduction ? problems : warnings).push('ADMIN_PASSWORD_HASH is not set — admin login is disabled (run: npm run admin:password)');
  if (isProduction && !config.baseUrl.startsWith('https://')) problems.push('BASE_URL must start with https:// in production');
  return { problems, warnings };
};

module.exports = config;

#!/usr/bin/env node
'use strict';
// Registers the webhook with PayPal for BASE_URL/webhooks/paypal and prints the PAYPAL_WEBHOOK_ID.
const config = require('../src/config');
const paypal = require('../src/paypal');
const { WEBHOOK_EVENTS } = require('../src/donations');

(async () => {
  if (!config.paypalConfigured()) { console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.'); process.exit(1); }
  const url = `${config.baseUrl}/webhooks/paypal`;
  if (!url.startsWith('https://')) { console.error(`PayPal requires an https URL. BASE_URL is ${config.baseUrl}`); process.exit(1); }
  console.log(`PayPal mode: ${config.paypal.mode}\nWebhook URL: ${url}`);
  const list = await paypal.listWebhooks();
  const existing = (list.webhooks || []).find((w) => w.url === url);
  if (existing) {
    console.log(`\nA webhook for this URL already exists.\nPAYPAL_WEBHOOK_ID=${existing.id}`);
    return;
  }
  const wh = await paypal.createWebhook(url, WEBHOOK_EVENTS);
  console.log(`\nWebhook created ✓\nAdd this line to your .env:\nPAYPAL_WEBHOOK_ID=${wh.id}`);
})().catch((e) => { console.error('Failed:', e.message, e.body ? JSON.stringify(e.body) : ''); process.exit(1); });

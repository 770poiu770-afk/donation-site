#!/usr/bin/env node
'use strict';
// Checks configuration and (optionally) that PayPal credentials work.
const config = require('../src/config');
const paypal = require('../src/paypal');
(async () => {
  const { problems, warnings } = config.validate();
  console.log(`Mode: ${config.paypal.mode} | Production: ${config.isProduction} | Base URL: ${config.baseUrl}`);
  problems.forEach((p) => console.log('❌', p));
  warnings.forEach((w) => console.log('⚠️ ', w));
  if (config.paypalConfigured() && config.paypal.mode !== 'mock') {
    try { await paypal.getAccessToken(); console.log('✅ PayPal credentials work'); }
    catch (e) { console.log('❌ PayPal credentials rejected:', e.message); process.exitCode = 1; }
  }
  if (!problems.length) console.log('✅ Configuration OK');
  else process.exitCode = 1;
})();

'use strict';
const config = require('./src/config');

const { problems, warnings } = config.validate();
warnings.forEach((w) => console.warn('⚠️ ', w));
if (problems.length) {
  problems.forEach((p) => console.error('❌', p));
  console.error('Fix the configuration in your environment variables (.env) and start again.');
  process.exit(1);
}

const { createApp } = require('./src/app');
const db = require('./src/db');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`✅ Donation site running on ${config.baseUrl} (port ${config.port}) — PayPal mode: ${config.paypal.mode.toUpperCase()}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

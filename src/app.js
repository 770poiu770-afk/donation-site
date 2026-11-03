'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const i18n = require('./i18n');

function createApp({ mock } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  if (config.isProduction) app.set('view cache', true);

  db.get(); // open/migrate database

  const paypalSrc = ['https://www.paypal.com', 'https://*.paypal.com', 'https://*.paypalobjects.com', 'https://www.sandbox.paypal.com'];
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'", ...paypalSrc],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          'img-src': ["'self'", 'data:', ...paypalSrc],
          'frame-src': [...paypalSrc],
          'connect-src': ["'self'", ...paypalSrc],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      // PayPal popups need to keep a reference to the opener
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      crossOriginEmbedderPolicy: false,
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );
  app.use(compression());
  app.use(cookieParser());

  // Static assets (long cache for versioned files)
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProduction ? '7d' : 0, index: false }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/favicon.svg'));

  // Mock PayPal (local demo/tests only)
  if (config.paypal.mode === 'mock') {
    if (config.isProduction) throw new Error('Mock PayPal cannot run in production');
    const m = mock || require('./mock-paypal').createMockPayPal();
    app.locals.mockPayPal = m;
    app.use('/__mock-paypal', m.router);
  }

  app.use('/webhooks', require('./routes/webhooks'));
  app.use('/api', require('./routes/api'));

  app.use(i18n.middleware);
  app.locals.assetVersion = Date.now().toString(36);
  app.locals.paypalMode = config.paypal.mode;

  app.use('/admin', require('./routes/admin'));
  app.use('/', require('./routes/public'));

  // 404
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
    res.status(404).render('404', { pageTitle: res.locals.t ? res.locals.t('notFound.title') : 'Not found', path: req.path });
  });

  // errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (res.headersSent) return;
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) return res.status(500).json({ error: 'server_error' });
    res.status(500).send('Something went wrong. Please try again later.');
  });

  return app;
}

module.exports = { createApp };

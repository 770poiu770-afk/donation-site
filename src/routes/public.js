'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');
const { formatMoney } = require('../amounts');

const router = express.Router();

function publicStats() {
  const d = db.get();
  const r = d
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents - refunded_cents),0) AS total
              FROM donations WHERE status IN ('completed','partially_refunded')`)
    .get();
  const subs = d.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`).get().n;
  const min = config.site.statsMinDonations ?? 10;
  return { show: r.n >= min, count: r.n, totalCents: r.total, monthly: subs };
}

function donateConfig(lang) {
  return {
    clientId: config.paypal.clientId,
    currency: config.currency,
    sdkBase: config.paypal.sdkBase,
    presets: config.donation.presets,
    monthlyEnabled: config.paypal.enableSubscriptions,
    available: config.paypalConfigured(),
    locale: lang === 'he' ? 'he_IL' : 'en_US',
    lang,
  };
}

router.use((req, res, next) => {
  res.locals.donateConfig = { ...donateConfig(req.lang), nonce: res.locals.cspNonce };
  res.locals.formatMoney = (cents) => formatMoney(cents, config.currency, req.lang === 'he' ? 'he-IL' : 'en-US');
  res.locals.path = req.path;
  res.locals.baseUrl = config.baseUrl;
  next();
});

router.get('/', (req, res) => {
  res.render('home', { stats: publicStats(), pageTitle: null });
});

router.get('/donate', (req, res) => {
  res.render('donate', { pageTitle: res.locals.t('donate.title') });
});

router.get('/thank-you', (req, res) => {
  let item = null;
  let kind = null;
  if (typeof req.query.d === 'string') {
    item = db.getDonationByPublicId(req.query.d);
    kind = 'donation';
  } else if (typeof req.query.s === 'string') {
    item = db.getSubscriptionByPublicId(req.query.s);
    kind = 'subscription';
  }
  // Only show a confirmation for payments PayPal actually confirmed (or is processing).
  const visible = item && (kind === 'donation'
    ? ['completed', 'pending', 'partially_refunded'].includes(item.status)
    : ['active', 'approved', 'created'].includes(item.status) && item.paypal_subscription_id);
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.render('thank-you', { item: visible ? item : null, kind, pageTitle: res.locals.t('thanks.title') });
});

router.get('/faq', (req, res) => res.render('faq', { pageTitle: res.locals.t('faq.title') }));
router.get('/contact', (req, res) => res.render('contact', { pageTitle: res.locals.t('contact.title'), sent: req.query.sent === '1', error: false, form: {} }));
router.get('/privacy', (req, res) => res.render('legal', { pageTitle: res.locals.t('footer.privacy'), doc: 'privacy' }));
router.get('/terms', (req, res) => res.render('legal', { pageTitle: res.locals.t('footer.terms'), doc: 'terms' }));

const contactLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

router.post('/contact', contactLimiter, express.urlencoded({ extended: false, limit: '20kb' }), (req, res) => {
  const b = req.body || {};
  if (b.website) return res.redirect(303, '/contact?sent=1'); // honeypot: silently drop bots
  const name = String(b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().slice(0, 254);
  const subject = String(b.subject || '').trim().slice(0, 200);
  const message = String(b.message || '').trim().slice(0, 5000);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !message) {
    return res.status(400).render('contact', { pageTitle: res.locals.t('contact.title'), sent: false, error: true, form: { name, email, subject, message } });
  }
  db.createContactMessage({ name, email, subject, message });
  res.redirect(303, '/contact?sent=1');
});

router.get('/healthz', (req, res) => {
  try {
    db.get().prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /api\nDisallow: /thank-you\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const urls = ['/', '/donate', '/faq', '/contact', '/privacy', '/terms'];
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      urls.map((u) => `<url><loc>${config.baseUrl}${u}</loc></url>`).join('') +
      `</urlset>`
  );
});

module.exports = router;
module.exports.publicStats = publicStats;

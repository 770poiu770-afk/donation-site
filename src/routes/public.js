'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');
const { formatMoney } = require('../amounts');
const donations = require('../donations');

const router = express.Router();

function publicStats() {
  const d = db.get();
  const rows = d
    .prepare(`SELECT currency, COUNT(*) AS n, COALESCE(SUM(amount_cents - refunded_cents),0) AS total
              FROM donations WHERE status IN ('completed','partially_refunded') GROUP BY currency`)
    .all();
  const count = rows.reduce((a, r) => a + r.n, 0);
  const totals = rows.filter((r) => r.total > 0).map((r) => ({ currency: r.currency, cents: r.total }));
  const subs = d.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`).get().n;
  const min = config.site.statsMinDonations ?? 10;
  return { show: count >= min, count, totals, monthly: subs };
}

const SYMBOL = { USD: '$', ILS: '₪', EUR: '€', GBP: '£' };

function defaultCurrency(lang) {
  if (lang === 'he' && config.currencies.includes('ILS')) return 'ILS';
  return config.currencies.includes(config.currency) ? config.currency : config.currencies[0];
}

function donateConfig(lang) {
  return {
    clientId: config.paypal.clientId,
    currency: defaultCurrency(lang),
    currencies: config.currencies,
    sdkBase: config.paypal.sdkBase,
    presets: config.donation.presets,
    presetsByCurrency: config.donation.presetsByCurrency,
    defaultPreset: config.donation.defaultPreset,
    monthlyEnabled: config.paypal.enableSubscriptions,
    available: config.paypalConfigured(),
    locale: lang === 'he' ? 'he_IL' : 'en_US',
    lang,
  };
}

router.use((req, res, next) => {
  res.locals.donateConfig = { ...donateConfig(req.lang), nonce: res.locals.cspNonce };
  res.locals.formatMoney = (cents, currency = config.currency) => formatMoney(cents, currency, req.lang === 'he' ? 'he-IL' : 'en-US');
  res.locals.currencySymbol = SYMBOL;
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

// Return from the full-page PayPal checkout
router.get('/paypal/return', async (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[A-Z0-9-]{6,64}$/i.test(token)) return res.redirect(303, '/#donate');
  try {
    const r = await donations.captureOneTime(token);
    if (r.ok) return res.redirect(303, `/thank-you?d=${encodeURIComponent(r.publicId)}`);
    return res.redirect(303, `/?payment=${r.restart ? 'declined' : 'failed'}#donate`);
  } catch (err) {
    console.error('[paypal/return]', err.message);
    return res.redirect(303, '/?payment=failed#donate');
  }
});
router.get('/paypal/cancel', (req, res) => {
  const token = String(req.query.token || '');
  if (/^[A-Z0-9-]{6,64}$/i.test(token)) donations.cancelOneTime(token);
  res.redirect(303, '/?payment=cancelled#donate');
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

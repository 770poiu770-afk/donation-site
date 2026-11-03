'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');
const reports = require('../reports');
const { formatMoney } = require('../amounts');
const sec = require('../security');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '20kb' }));
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.locals.money = (c) => formatMoney(c || 0, config.currency, 'en-US');
  res.locals.fmtDate = (iso) => (iso ? new Intl.DateTimeFormat('he-IL', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '—');
  res.locals.statusLabel = STATUS_LABELS;
  res.locals.path = req.path;
  res.locals.mode = config.paypal.mode;
  next();
});

const STATUS_LABELS = {
  completed: 'הושלם', pending: 'ממתין', created: 'לא הושלם', cancelled: 'בוטל ע״י התורם', failed: 'נכשל',
  refunded: 'הוחזר', partially_refunded: 'הוחזר חלקית', reversed: 'בוטל (חיוב חוזר)', review: 'לבדיקה',
  active: 'פעיל', approved: 'אושר', suspended: 'מושהה', expired: 'פג תוקף',
};

/* ---------------- auth ---------------- */
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true });

router.get('/login', (req, res) => {
  if (sec.readSession(req)) return res.redirect('/admin');
  res.render('admin/login', { error: null, disabled: !config.admin.passwordHash });
});

router.post('/login', loginLimiter, async (req, res) => {
  const ok = await sec.checkCredentials(req.body.username, req.body.password);
  if (!ok) return res.status(401).render('admin/login', { error: 'שם משתמש או סיסמה שגויים', disabled: !config.admin.passwordHash });
  sec.issueSession(res, config.admin.username);
  res.redirect(303, '/admin');
});

router.use(sec.requireAdmin);

router.post('/logout', (req, res) => {
  sec.clearSession(res);
  res.redirect(303, '/admin/login');
});

/* ---------------- dashboard ---------------- */
router.get('/', (req, res) => {
  const s = reports.summary();
  const recent = db.get().prepare(`SELECT * FROM donations WHERE status NOT IN ('created','cancelled') ORDER BY created_at DESC LIMIT 8`).all();
  res.render('admin/dashboard', { s, recent, warnings: config.validate().warnings });
});

/* ---------------- donations ---------------- */
router.get('/donations', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = reports.searchDonations(req.query, { page });
  const qs = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => k !== 'page' && v)).toString();
  res.render('admin/donations', { result, q: req.query, page, qs, statuses: reports.STATUSES });
});

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // prevent spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/donations.csv', (req, res) => {
  const { rows } = reports.searchDonations(req.query, { all: true });
  const tzFmt = (iso) => (iso ? new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '');
  const header = ['Reference', 'Type', 'Status', 'Amount', 'Currency', 'Refunded', 'PayPal fee', 'Net', 'Created', 'Paid at',
    'PayPal order ID', 'PayPal transaction ID', 'Payer name (PayPal)', 'Payer email (PayPal)', 'Payer country',
    'Donor name (optional)', 'Donor email (optional)', 'Message', 'Notes'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.public_id, r.type === 'monthly' ? 'monthly' : 'one-time', r.status, (r.amount_cents / 100).toFixed(2), r.currency,
      (r.refunded_cents / 100).toFixed(2), r.fee_cents != null ? (r.fee_cents / 100).toFixed(2) : '', r.net_cents != null ? (r.net_cents / 100).toFixed(2) : '',
      tzFmt(r.created_at), tzFmt(r.completed_at), r.paypal_order_id, r.paypal_capture_id, r.payer_name, r.payer_email, r.payer_country,
      r.donor_name, r.donor_email, r.message, r.failure_reason,
    ].map(csvCell).join(','));
  }
  const stamp = reports.localDate(Date.now());
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="donations-${stamp}.csv"`);
  res.send('﻿' + lines.join('\r\n')); // BOM so Excel shows Hebrew correctly
});

router.get('/donations/:id', (req, res, next) => {
  const d = db.getDonation(parseInt(req.params.id, 10));
  if (!d) return next();
  const log = db.get().prepare('SELECT * FROM audit_log WHERE donation_id = ? ORDER BY id').all(d.id);
  const refunds = db.get().prepare('SELECT * FROM refunds WHERE donation_id = ? ORDER BY created_at').all(d.id);
  const sub = d.subscription_id ? db.getSubscription(d.subscription_id) : null;
  const paypalHost = config.paypal.mode === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com';
  res.render('admin/donation', { d, log, refunds, sub, paypalHost });
});

/* ---------------- subscriptions ---------------- */
router.get('/subscriptions', (req, res) => {
  const status = ['active', 'cancelled', 'suspended', 'expired', 'approved', 'created', 'failed'].includes(req.query.status) ? req.query.status : null;
  const rows = db.get()
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM donations d WHERE d.subscription_id = s.id AND d.status IN ('completed','partially_refunded')) AS payments,
                     (SELECT COALESCE(SUM(amount_cents - refunded_cents),0) FROM donations d WHERE d.subscription_id = s.id AND d.status IN ('completed','partially_refunded')) AS collected
              FROM subscriptions s ${status ? 'WHERE s.status = ?' : `WHERE s.status NOT IN ('created','failed')`} ORDER BY s.created_at DESC LIMIT 500`)
    .all(...(status ? [status] : []));
  res.render('admin/subscriptions', { rows, status });
});

/* ---------------- messages ---------------- */
router.get('/messages', (req, res) => {
  const rows = db.get().prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 500').all();
  res.render('admin/messages', { rows });
});

router.post('/messages/:id/read', (req, res) => {
  db.get().prepare('UPDATE contact_messages SET is_read = 1 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect(303, '/admin/messages');
});

/* ---------------- system ---------------- */
router.get('/system', (req, res) => {
  const v = config.validate();
  const lastWebhook = db.get().prepare('SELECT event_type, received_at, processed, error FROM webhook_events ORDER BY received_at DESC LIMIT 15').all();
  const failedWebhooks = db.get().prepare('SELECT COUNT(*) n FROM webhook_events WHERE processed = 0').get().n;
  res.render('admin/system', {
    v, lastWebhook, failedWebhooks,
    info: {
      mode: config.paypal.mode,
      clientId: config.paypal.clientId ? `${config.paypal.clientId.slice(0, 6)}…${config.paypal.clientId.slice(-4)}` : null,
      secret: Boolean(config.paypal.clientSecret),
      webhookId: config.paypal.webhookId || null,
      webhookUrl: `${config.baseUrl}/webhooks/paypal`,
      baseUrl: config.baseUrl,
      currency: config.currency,
      monthly: config.paypal.enableSubscriptions,
      production: config.isProduction,
      timezone: config.timezone,
    },
  });
});

module.exports = router;

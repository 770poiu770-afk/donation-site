'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { parseAmount } = require('../amounts');
const donations = require('../donations');
const { sameOrigin } = require('../security');

const router = express.Router();

router.use(rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false }));
router.use(express.json({ limit: '10kb' }));
router.use((req, res, next) => (req.method === 'POST' ? sameOrigin(req, res, next) : next()));
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!config.paypalConfigured()) return res.status(503).json({ error: 'unavailable' });
  next();
});

const PAYPAL_ID = /^[A-Z0-9-]{6,64}$/i;
const lang = (l) => (l === 'he' ? 'he' : 'en');

function fail(res, err) {
  console.error('[api]', err.message, err.debugId ? `debug_id=${err.debugId}` : '', err.body ? JSON.stringify(err.body).slice(0, 500) : '');
  const status = err.status === 400 ? 400 : 502;
  res.status(status).json({ error: 'paypal_error' });
}

router.post('/orders', async (req, res) => {
  const amount = parseAmount(req.body?.amount);
  if (!amount.ok) return res.status(400).json({ error: amount.error });
  try {
    const r = await donations.startOneTime({ amountCents: amount.cents, details: req.body?.details, lang: lang(req.body?.lang) });
    res.status(201).json({ id: r.orderId });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/orders/:id/capture', async (req, res) => {
  if (!PAYPAL_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const r = await donations.captureOneTime(req.params.id);
    if (r.code === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (r.restart) return res.status(422).json({ error: 'declined', restart: true });
    if (!r.ok) return res.status(409).json({ error: r.code || r.status });
    res.json({ status: r.status, redirect: `/thank-you?d=${encodeURIComponent(r.publicId)}` });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/orders/:id/cancel', (req, res) => {
  if (!PAYPAL_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  donations.cancelOneTime(req.params.id);
  res.json({ ok: true });
});

router.post('/subscriptions', async (req, res) => {
  if (!config.paypal.enableSubscriptions) return res.status(400).json({ error: 'monthly_disabled' });
  const amount = parseAmount(req.body?.amount);
  if (!amount.ok) return res.status(400).json({ error: amount.error });
  try {
    const r = await donations.startMonthly({ amountCents: amount.cents, details: req.body?.details, lang: lang(req.body?.lang) });
    res.status(201).json({ id: r.subscriptionId });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/subscriptions/:id/confirm', async (req, res) => {
  if (!PAYPAL_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const r = await donations.confirmMonthly(req.params.id);
    if (r.code === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (!r.ok) return res.status(409).json({ error: r.status });
    res.json({ status: r.status, redirect: `/thank-you?s=${encodeURIComponent(r.publicId)}` });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;

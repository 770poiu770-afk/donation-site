'use strict';
const express = require('express');
const db = require('../db');
const paypal = require('../paypal');
const donations = require('../donations');

const router = express.Router();

// Raw body is required: PayPal signature verification needs the exact bytes.
router.post('/paypal', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return res.status(400).send('bad json');
  }
  if (!evt?.id || !evt?.event_type) return res.status(400).send('bad event');

  let verified = false;
  try {
    verified = await paypal.verifyWebhookSignature(req.headers, raw);
  } catch (err) {
    console.error('[webhook] verification call failed', err.message);
    return res.status(503).send('verification unavailable'); // PayPal will retry
  }
  if (!verified) {
    console.warn('[webhook] rejected unverified event', evt.id, evt.event_type);
    return res.status(401).send('invalid signature');
  }

  const isNew = db.storeWebhookEvent(evt, true);
  if (!isNew) {
    const prev = db.getWebhookEvent(evt.id);
    if (prev?.processed) return res.status(200).send('duplicate');
  }

  try {
    const result = await donations.handleWebhookEvent(evt);
    db.markWebhookProcessed(evt.id);
    res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('[webhook] processing failed', evt.id, err.message);
    db.markWebhookProcessed(evt.id, String(err.message).slice(0, 500));
    res.status(500).send('processing failed'); // non-2xx -> PayPal retries
  }
});

module.exports = router;

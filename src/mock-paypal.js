'use strict';
/**
 * A small in-memory imitation of the PayPal REST API + JS SDK, used ONLY for
 * local demos (PAYPAL_MODE=mock) and automated tests. It is never mounted in
 * production (config.validate() refuses mock mode when NODE_ENV=production).
 */
const express = require('express');
const crypto = require('crypto');

const MOCK_SIGNATURE = 'mock-valid-signature';

function createMockPayPal() {
  const router = express.Router();
  const state = { orders: new Map(), subs: new Map(), plans: new Map(), products: new Map(), idem: new Map(), declineNext: false, calls: [] };
  const id = (p) => `${p}${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  router.use(express.json({ limit: '1mb', type: (req) => !/x-www-form-urlencoded/.test(req.headers['content-type'] || '') }));
  router.use(express.urlencoded({ extended: false }));
  router.use((req, res, next) => { state.calls.push(`${req.method} ${req.path}`); next(); });

  const authed = (req, res, next) => (/^Bearer mock-token/.test(req.get('authorization') || '') ? next() : res.status(401).json({ name: 'AUTHENTICATION_FAILURE', message: 'bad token' }));
  const idempotent = (req, res, next) => {
    const key = req.get('paypal-request-id');
    if (key && state.idem.has(`${req.path}|${key}`)) return res.status(200).json(state.idem.get(`${req.path}|${key}`)());
    res.locals.idemKey = key;
    next();
  };
  const remember = (req, res, fn) => { if (res.locals.idemKey) state.idem.set(`${req.path}|${res.locals.idemKey}`, fn); };

  router.post('/v1/oauth2/token', (req, res) => {
    if (!/^Basic /.test(req.get('authorization') || '')) return res.status(401).json({ error: 'invalid_client' });
    res.json({ access_token: `mock-token-${Date.now()}`, token_type: 'Bearer', expires_in: 32400 });
  });

  /* ---- orders ---- */
  router.post('/v2/checkout/orders', authed, idempotent, (req, res) => {
    const pu = req.body.purchase_units?.[0];
    if (!pu?.amount?.value) return res.status(400).json({ name: 'INVALID_REQUEST', details: [{ issue: 'MISSING_REQUIRED_PARAMETER' }] });
    const o = { id: id('ORD'), status: 'CREATED', intent: 'CAPTURE', purchase_units: [{ ...pu, payments: undefined }], create_time: new Date().toISOString() };
    state.orders.set(o.id, o);
    remember(req, res, () => state.orders.get(o.id));
    res.status(201).json(o);
  });

  router.get('/v2/checkout/orders/:id', authed, (req, res) => {
    const o = state.orders.get(req.params.id);
    return o ? res.json(o) : res.status(404).json({ name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
  });

  router.post('/v2/checkout/orders/:id/capture', authed, idempotent, (req, res) => {
    const o = state.orders.get(req.params.id);
    if (!o) return res.status(404).json({ name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
    if (o.status === 'COMPLETED') return res.status(422).json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    if (o.status !== 'APPROVED') return res.status(422).json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    if (o.decline) { o.decline = false; return res.status(422).json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }); }
    const amt = o.purchase_units[0].amount;
    const value = Number(amt.value);
    const fee = (Math.round((value * 0.029 + 0.3) * 100) / 100).toFixed(2);
    o.status = 'COMPLETED';
    o.purchase_units[0].payments = {
      captures: [{
        id: id('CAP'), status: o.pending ? 'PENDING' : 'COMPLETED', amount: { currency_code: amt.currency_code, value: amt.value },
        custom_id: o.purchase_units[0].custom_id, create_time: new Date().toISOString(),
        status_details: o.pending ? { reason: 'PENDING_REVIEW' } : undefined,
        seller_receivable_breakdown: { gross_amount: amt, paypal_fee: { currency_code: amt.currency_code, value: fee }, net_amount: { currency_code: amt.currency_code, value: (value - Number(fee)).toFixed(2) } },
      }],
    };
    remember(req, res, () => state.orders.get(o.id));
    res.status(201).json(o);
  });

  /* ---- catalog / plans / subscriptions ---- */
  router.post('/v1/catalogs/products', authed, idempotent, (req, res) => {
    const p = { id: id('PROD-'), ...req.body };
    state.products.set(p.id, p);
    remember(req, res, () => p);
    res.status(201).json(p);
  });
  router.post('/v1/billing/plans', authed, idempotent, (req, res) => {
    const p = { id: id('P-'), status: 'ACTIVE', ...req.body };
    state.plans.set(p.id, p);
    remember(req, res, () => p);
    res.status(201).json(p);
  });
  router.post('/v1/billing/subscriptions', authed, idempotent, (req, res) => {
    if (!state.plans.has(req.body.plan_id)) return res.status(422).json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INVALID_PLAN' }] });
    const s = { id: id('I-'), status: 'APPROVAL_PENDING', plan_id: req.body.plan_id, custom_id: req.body.custom_id, create_time: new Date().toISOString() };
    state.subs.set(s.id, s);
    remember(req, res, () => state.subs.get(s.id));
    res.status(201).json(s);
  });
  router.get('/v1/billing/subscriptions/:id', authed, (req, res) => {
    const s = state.subs.get(req.params.id);
    return s ? res.json(s) : res.status(404).json({ name: 'RESOURCE_NOT_FOUND' });
  });

  /* ---- webhooks ---- */
  router.post('/v1/notifications/verify-webhook-signature', authed, (req, res) => {
    const ok = req.body.transmission_sig === MOCK_SIGNATURE && req.body.webhook_id && req.body.webhook_event?.id;
    res.json({ verification_status: ok ? 'SUCCESS' : 'FAILURE' });
  });
  router.get('/v1/notifications/webhooks', authed, (req, res) => res.json({ webhooks: [] }));
  router.post('/v1/notifications/webhooks', authed, (req, res) => res.status(201).json({ id: id('WH-'), ...req.body }));

  /* ---- buyer simulation (what the PayPal popup would do) ---- */
  const payer = (card) => ({
    name: { given_name: card ? 'Card' : 'Demo', surname: 'Donor' },
    email_address: card ? null : 'donor@example.com',
    payer_id: id('PAYER'),
    address: { country_code: 'US' },
  });
  router.post('/__buyer/approve-order/:id', (req, res) => {
    const o = state.orders.get(req.params.id);
    if (!o) return res.status(404).json({});
    o.status = 'APPROVED';
    o.payer = payer(req.body?.card);
    if (req.body?.decline) o.decline = true;
    if (req.body?.pending) o.pending = true;
    res.json({ ok: true });
  });
  router.post('/__buyer/approve-subscription/:id', (req, res) => {
    const s = state.subs.get(req.params.id);
    if (!s) return res.status(404).json({});
    s.status = 'ACTIVE';
    s.subscriber = { ...payer(false) };
    res.json({ ok: true });
  });

  router.get('/sdk.js', (req, res) => {
    res.type('application/javascript').send(SDK_SOURCE);
  });

  return { router, state, MOCK_SIGNATURE };
}

/* Browser-side imitation of the PayPal JS SDK Buttons component */
const SDK_SOURCE = `(() => {
  const script = document.currentScript;
  const ns = (script && script.dataset.namespace) || 'paypal';
  const base = script.src.replace(/\\/sdk\\.js.*$/, '');
  const isSub = /intent=subscription/.test(script.src);
  function modal(kind, onAction) {
    const wrap = document.createElement('div');
    wrap.className = 'mockpp-overlay';
    wrap.innerHTML = '<div class="mockpp-modal" role="dialog" aria-label="Mock PayPal checkout">' +
      '<div class="mockpp-head">PayPal <small>DEMO / TEST MODE</small></div>' +
      '<p>' + (kind === 'card' ? 'Pay with Debit or Credit Card (no account)' : 'Log in to PayPal') + '</p>' +
      '<button type="button" data-a="approve" class="mockpp-approve">Approve payment</button>' +
      '<button type="button" data-a="decline">Simulate declined card</button>' +
      '<button type="button" data-a="cancel">Cancel and return</button></div>';
    wrap.addEventListener('click', (e) => { const a = e.target.dataset && e.target.dataset.a; if (a) { wrap.remove(); onAction(a); } });
    document.body.appendChild(wrap);
  }
  const style = document.createElement('style');
  style.textContent = '.mockpp-btn{display:block;width:100%;height:48px;margin:0 0 10px;border:0;border-radius:6px;font:600 16px system-ui;cursor:pointer}' +
    '.mockpp-btn.pp{background:#ffc439;color:#003087}.mockpp-btn.card{background:#2c2e2f;color:#fff}' +
    '.mockpp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999}' +
    '.mockpp-modal{background:#fff;color:#111;border-radius:12px;padding:24px;width:min(360px,90vw);font:15px system-ui;display:grid;gap:10px}' +
    '.mockpp-head{font-weight:800;font-size:22px;color:#003087}.mockpp-head small{font-size:11px;color:#b00;margin-inline-start:6px}' +
    '.mockpp-modal button{padding:10px;border-radius:8px;border:1px solid #ccc;background:#f6f6f6;cursor:pointer}.mockpp-modal .mockpp-approve{background:#0070ba;color:#fff;border:0}';
  document.head.appendChild(style);
  window[ns] = {
    FUNDING: { PAYPAL: 'paypal', CARD: 'card' },
    Buttons(opts) {
      return {
        isEligible: () => true,
        render(target) {
          const el = typeof target === 'string' ? document.querySelector(target) : target;
          el.innerHTML = '';
          const sources = opts.fundingSource ? [opts.fundingSource] : ['paypal', 'card'];
          sources.forEach((src) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mockpp-btn ' + (src === 'card' ? 'card' : 'pp');
            b.textContent = src === 'card' ? 'Debit or Credit Card' : 'PayPal  Donate';
            b.dataset.funding = src;
            b.addEventListener('click', async () => {
              let rejected = false;
              if (opts.onClick) await opts.onClick({ fundingSource: src }, { resolve: () => {}, reject: () => { rejected = true; } });
              if (rejected) return;
              try {
                const id = isSub ? await opts.createSubscription({}, {}) : await opts.createOrder({}, {});
                modal(src, async (a) => {
                  if (a === 'cancel') return opts.onCancel && opts.onCancel({ orderID: id });
                  const path = isSub ? '/__buyer/approve-subscription/' : '/__buyer/approve-order/';
                  await fetch(base + path + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card: src === 'card', decline: a === 'decline' }) });
                  const data = isSub ? { subscriptionID: id, orderID: id } : { orderID: id };
                  await opts.onApprove(data, { restart: () => b.click() });
                });
              } catch (err) { opts.onError && opts.onError(err); }
            });
            el.appendChild(b);
          });
          return Promise.resolve();
        },
      };
    },
  };
})();`;

module.exports = { createMockPayPal, MOCK_SIGNATURE };

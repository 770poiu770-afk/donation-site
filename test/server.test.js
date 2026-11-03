'use strict';
/* End-to-end server tests against the built-in PayPal mock. Run: npm test */
const path = require('path');
const os = require('os');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const PORT = 3998;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'donate-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  PAYPAL_MODE: 'mock',
  PORT: String(PORT),
  BASE_URL: `http://127.0.0.1:${PORT}`,
  DATABASE_PATH: path.join(tmp, 'test.db'),
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync('correct-horse-battery', 4),
  SESSION_SECRET: 'x'.repeat(64),
  DOTENV_PATH: path.join(tmp, 'none.env'),
});

const { createApp } = require('../src/app');
const db = require('../src/db');
const { parseAmount } = require('../src/amounts');
const { MOCK_SIGNATURE } = require('../src/mock-paypal');

const B = `http://127.0.0.1:${PORT}`;
let server;
let mock;

test.before(async () => {
  const app = createApp();
  mock = app.locals.mockPayPal;
  await new Promise((r) => (server = app.listen(PORT, '127.0.0.1', r)));
});
test.after(() => { server.close(); db.close(); });

const json = (url, body, headers = {}) =>
  fetch(B + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const approve = (orderId, extra = {}) => json(`/__mock-paypal/__buyer/approve-order/${orderId}`, extra);
const approveSub = (id) => json(`/__mock-paypal/__buyer/approve-subscription/${id}`, {});

function webhook(evt, sig = MOCK_SIGNATURE) {
  return fetch(`${B}/webhooks/paypal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-transmission-id': 'tid-' + evt.id,
      'paypal-transmission-sig': sig,
      'paypal-transmission-time': new Date().toISOString(),
    },
    body: JSON.stringify(evt),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

async function paidDonation(amount = '50') {
  const c = await json('/api/orders', { amount });
  await approve(c.body.id);
  const cap = await json(`/api/orders/${c.body.id}/capture`, {});
  return { orderId: c.body.id, cap, d: db.getDonationByOrderId(c.body.id) };
}

/* ---------------- amount validation ---------------- */
test('amount parsing and limits', () => {
  assert.deepEqual(parseAmount('18'), { ok: true, cents: 1800 });
  assert.deepEqual(parseAmount('1,000.5'), { ok: true, cents: 100050 });
  assert.deepEqual(parseAmount(1000000), { ok: true, cents: 100000000 });
  assert.equal(parseAmount('1000000.01').error, 'amount_too_large');
  assert.equal(parseAmount('0.99').error, 'amount_too_small');
  assert.equal(parseAmount('-5').error, 'amount_invalid');
  assert.equal(parseAmount('1e5').error, 'amount_invalid');
  assert.equal(parseAmount('12.345').error, 'amount_invalid');
  assert.equal(parseAmount(null).error, 'amount_required');
});

test('API rejects invalid amounts server-side', async () => {
  for (const amount of ['0', '2000000', 'abc', '-1', '5.999']) {
    const r = await json('/api/orders', { amount });
    assert.equal(r.status, 400, `amount ${amount}`);
  }
  const big = await json('/api/subscriptions', { amount: '1000000.01' });
  assert.equal(big.status, 400);
});

test('API rejects cross-origin and non-JSON requests', async () => {
  const r = await json('/api/orders', { amount: '10' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${B}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'amount=10' });
  assert.equal(r2.status, 415);
});

/* ---------------- one-time flow ---------------- */
test('anonymous one-time donation: create → approve → capture', async () => {
  const c = await json('/api/orders', { amount: '36' });
  assert.equal(c.status, 201);
  let d = db.getDonationByOrderId(c.body.id);
  assert.equal(d.status, 'created');
  assert.equal(d.donor_name, null);
  assert.equal(d.anonymous, 1);

  await approve(c.body.id);
  const cap = await json(`/api/orders/${c.body.id}/capture`, {});
  assert.equal(cap.status, 200);
  assert.equal(cap.body.status, 'completed');
  assert.match(cap.body.redirect, /^\/thank-you\?d=don_/);

  d = db.getDonationByOrderId(c.body.id);
  assert.equal(d.status, 'completed');
  assert.equal(d.amount_cents, 3600);
  assert.ok(d.paypal_capture_id);
  assert.ok(d.completed_at);
  assert.equal(d.payer_name, 'Demo Donor'); // admin still sees PayPal-provided data
  assert.ok(d.fee_cents > 0);

  const page = await fetch(B + cap.body.redirect + '&lang=en').then((r) => r.text());
  assert.match(page, /\$36/);
  assert.match(page, new RegExp(d.paypal_capture_id));
});

test('optional donor details are stored when given', async () => {
  const c = await json('/api/orders', { amount: '18', details: { name: '  Dana  ', email: 'dana@example.com', message: 'L’ilui nishmat' } });
  const d = db.getDonationByOrderId(c.body.id);
  assert.equal(d.donor_name, 'Dana');
  assert.equal(d.donor_email, 'dana@example.com');
  assert.equal(d.message, 'L’ilui nishmat');
  const bad = await json('/api/orders', { amount: '18', details: { email: 'not-an-email' } });
  assert.equal(db.getDonationByOrderId(bad.body.id).donor_email, null);
});

test('double capture is safe (idempotent, no duplicate records)', async () => {
  const { orderId, cap } = await paidDonation('100');
  assert.equal(cap.body.status, 'completed');
  const again = await json(`/api/orders/${orderId}/capture`, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'completed');
  const rows = db.get().prepare('SELECT COUNT(*) n FROM donations WHERE paypal_order_id = ?').get(orderId).n;
  assert.equal(rows, 1);
});

test('capture of unknown / unapproved order is refused (no forged success)', async () => {
  const unknown = await json('/api/orders/ORDFAKE123456/capture', {});
  assert.equal(unknown.status, 404);
  const c = await json('/api/orders', { amount: '20' });
  const notApproved = await json(`/api/orders/${c.body.id}/capture`, {});
  assert.equal(notApproved.status, 409);
  assert.equal(db.getDonationByOrderId(c.body.id).status, 'created');
  // thank-you page does not confirm an unpaid donation
  const d = db.getDonationByOrderId(c.body.id);
  const page = await fetch(`${B}/thank-you?d=${d.public_id}`).then((r) => r.text());
  assert.doesNotMatch(page, /was received|התקבלה/);
});

test('declined card asks the buyer to restart', async () => {
  const c = await json('/api/orders', { amount: '72' });
  await approve(c.body.id, { decline: true });
  const cap = await json(`/api/orders/${c.body.id}/capture`, {});
  assert.equal(cap.status, 422);
  assert.equal(cap.body.restart, true);
  assert.notEqual(db.getDonationByOrderId(c.body.id).status, 'completed');
});

test('pending capture is recorded as pending, then completed by webhook', async () => {
  const c = await json('/api/orders', { amount: '500' });
  await approve(c.body.id, { pending: true });
  const cap = await json(`/api/orders/${c.body.id}/capture`, {});
  assert.equal(cap.body.status, 'pending');
  const d = db.getDonationByOrderId(c.body.id);
  const r = await webhook({
    id: 'WH-PENDING-1', event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: d.paypal_capture_id, status: 'COMPLETED', amount: { currency_code: 'USD', value: '500.00' }, custom_id: d.public_id },
  });
  assert.equal(r.status, 200);
  assert.equal(db.getDonation(d.id).status, 'completed');
});

test('cancel marks an abandoned order as cancelled', async () => {
  const c = await json('/api/orders', { amount: '5' });
  await json(`/api/orders/${c.body.id}/cancel`, {});
  assert.equal(db.getDonationByOrderId(c.body.id).status, 'cancelled');
});

/* ---------------- webhooks ---------------- */
test('webhook with invalid signature is rejected and changes nothing', async () => {
  const { d } = await paidDonation('40');
  const r = await webhook({ id: 'WH-FORGED', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'R1', amount: { value: '40.00', currency_code: 'USD' }, custom_id: d.public_id } }, 'forged');
  assert.equal(r.status, 401);
  assert.equal(db.getDonation(d.id).status, 'completed');
  assert.equal(db.getWebhookEvent('WH-FORGED'), undefined);
});

test('webhook without signature headers is rejected', async () => {
  const r = await fetch(`${B}/webhooks/paypal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'X', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }) });
  assert.equal(r.status, 401);
});

test('partial then full refund via webhooks; duplicate delivery ignored', async () => {
  const { d } = await paidDonation('100');
  const up = [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/${d.paypal_capture_id}` }];
  const evt1 = { id: 'WH-REF-1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF-A', amount: { value: '30.00', currency_code: 'USD' }, links: up } };
  assert.equal((await webhook(evt1)).status, 200);
  assert.equal(db.getDonation(d.id).status, 'partially_refunded');
  assert.equal(db.getDonation(d.id).refunded_cents, 3000);
  // same event delivered twice
  assert.equal((await webhook(evt1)).status, 200);
  assert.equal(db.getDonation(d.id).refunded_cents, 3000);
  // same refund under a new event id is still not double counted
  await webhook({ ...evt1, id: 'WH-REF-1b' });
  assert.equal(db.getDonation(d.id).refunded_cents, 3000);
  await webhook({ id: 'WH-REF-2', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF-B', amount: { value: '70.00', currency_code: 'USD' }, links: up } });
  assert.equal(db.getDonation(d.id).status, 'refunded');
  assert.equal(db.getDonation(d.id).refunded_cents, 10000);
});

test('reversal (chargeback) webhook', async () => {
  const { d } = await paidDonation('60');
  await webhook({ id: 'WH-REV-1', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: d.paypal_capture_id, status: 'REVERSED', amount: { value: '60.00', currency_code: 'USD' } } });
  assert.equal(db.getDonation(d.id).status, 'reversed');
});

test('amount mismatch from PayPal is flagged for review', async () => {
  const { d } = await paidDonation('25');
  // forge-proof: even a verified event with a different amount does not silently mark it ok
  await webhook({ id: 'WH-MIS-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: d.paypal_capture_id, status: 'COMPLETED', amount: { value: '1.00', currency_code: 'USD' } } });
  assert.equal(db.getDonation(d.id).status, 'review');
});

test('CHECKOUT.ORDER.APPROVED webhook captures when the browser closed early', async () => {
  const c = await json('/api/orders', { amount: '45' });
  await approve(c.body.id);
  await webhook({ id: 'WH-APPROVED-1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: c.body.id, status: 'APPROVED' } });
  assert.equal(db.getDonationByOrderId(c.body.id).status, 'completed');
});

/* ---------------- monthly ---------------- */
test('monthly donation: subscription + recurring payments via webhooks', async () => {
  const c = await json('/api/subscriptions', { amount: '18' });
  assert.equal(c.status, 201);
  await approveSub(c.body.id);
  const conf = await json(`/api/subscriptions/${c.body.id}/confirm`, {});
  assert.equal(conf.status, 200);
  assert.match(conf.body.redirect, /thank-you\?s=sub_/);
  const sub = db.getSubscriptionByPaypalId(c.body.id);
  assert.equal(sub.status, 'active');

  // same amount reuses the same PayPal plan
  const c2 = await json('/api/subscriptions', { amount: '18' });
  assert.equal(db.getSubscriptionByPaypalId(c2.body.id).paypal_plan_id, sub.paypal_plan_id);

  const sale = { id: 'WH-SALE-1', event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE-1', billing_agreement_id: c.body.id, amount: { total: '18.00', currency: 'USD' }, transaction_fee: { value: '0.82' } } };
  await webhook(sale);
  await webhook({ ...sale, id: 'WH-SALE-1-dup' }); // duplicate sale must not create a second row
  const rows = db.get().prepare('SELECT * FROM donations WHERE subscription_id = ?').all(sub.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'monthly');
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].fee_cents, 82);

  await webhook({ id: 'WH-SUB-CANCEL', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: c.body.id, status: 'CANCELLED', custom_id: sub.public_id } });
  assert.equal(db.getSubscription(sub.id).status, 'cancelled');
});

/* ---------------- admin ---------------- */
async function login() {
  const r = await fetch(`${B}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=correct-horse-battery' });
  assert.equal(r.status, 303);
  return r.headers.get('set-cookie').split(';')[0];
}

test('admin requires login; wrong password rejected', async () => {
  for (const p of ['/admin', '/admin/donations', '/admin/donations.csv', '/admin/system']) {
    const r = await fetch(B + p, { redirect: 'manual' });
    assert.equal(r.status, 302, p);
  }
  const bad = await fetch(`${B}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=nope' });
  assert.equal(bad.status, 401);
  const forged = await fetch(`${B}/admin`, { redirect: 'manual', headers: { Cookie: 'admin_session=eyJ1IjoiYWRtaW4ifQ.fake' } });
  assert.equal(forged.status, 302);
});

test('admin pages, search, filters and CSV export', async () => {
  const cookie = await login();
  const get = (p) => fetch(B + p, { headers: { Cookie: cookie } });
  for (const p of ['/admin', '/admin/donations', '/admin/subscriptions', '/admin/messages', '/admin/system', '/admin/donations?status=paid&type=one_time']) {
    assert.equal((await get(p)).status, 200, p);
  }
  const { d } = await paidDonation('77');
  const search = await get(`/admin/donations?q=${d.paypal_capture_id}`).then((r) => r.text());
  assert.match(search, new RegExp(d.paypal_capture_id));
  const detail = await get(`/admin/donations/${d.id}`);
  assert.equal(detail.status, 200);

  // formula injection is neutralised in CSV
  db.get().prepare("UPDATE donations SET message = '=HYPERLINK(\"x\")' WHERE id = ?").run(d.id);
  const buf = Buffer.from(await get('/admin/donations.csv?status=paid').then((r) => r.arrayBuffer()));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
  const csv = buf.toString('utf8');
  assert.match(csv, /Reference,Type,Status/);
  assert.match(csv, new RegExp(d.paypal_capture_id));
  assert.match(csv, /'=HYPERLINK/);
});

test('admin POST without CSRF token is refused', async () => {
  const cookie = await login();
  const r = await fetch(`${B}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(r.status, 403);
});

/* ---------------- public pages ---------------- */
test('all public pages respond in both languages with security headers', async () => {
  for (const lang of ['en', 'he']) {
    for (const p of ['/', '/donate', '/faq', '/contact', '/privacy', '/terms', '/thank-you']) {
      const r = await fetch(`${B}${p}?lang=${lang}`);
      assert.equal(r.status, 200, `${p} ${lang}`);
      assert.match(r.headers.get('content-security-policy') || '', /paypal/);
      const html = await r.text();
      // every internal link resolves
      for (const href of [...html.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1])) {
        if (href.startsWith('/static/') || href === '/') continue;
        const s = (await fetch(B + href, { redirect: 'manual' })).status;
        assert.ok([200, 301, 302].includes(s), `broken link ${href} on ${p}`);
      }
    }
  }
  assert.equal((await fetch(`${B}/nope`)).status, 404);
});

test('contact form stores message; honeypot drops bots', async () => {
  const post = (body) => fetch(`${B}/contact`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const before = db.get().prepare('SELECT COUNT(*) n FROM contact_messages').get().n;
  assert.equal((await post({ name: 'Avi', email: 'avi@example.com', message: 'Hello' })).status, 303);
  assert.equal((await post({ name: 'Bot', email: 'b@example.com', message: 'spam', website: 'x' })).status, 303);
  assert.equal((await post({ name: '', email: 'bad', message: '' })).status, 400);
  assert.equal(db.get().prepare('SELECT COUNT(*) n FROM contact_messages').get().n, before + 1);
});

test('no secrets in served assets', async () => {
  const html = await fetch(`${B}/`).then((r) => r.text());
  assert.doesNotMatch(html, /mock-secret|CLIENT_SECRET|clientSecret/);
});

/* ---------------- currencies (₪ / $) ---------------- */
test('donation in shekels (ILS) end to end', async () => {
  const c = await json('/api/orders', { amount: '180', currency: 'ILS' });
  assert.equal(c.status, 201);
  await approve(c.body.id);
  const cap = await json(`/api/orders/${c.body.id}/capture`, {});
  assert.equal(cap.body.status, 'completed');
  const d = db.getDonationByOrderId(c.body.id);
  assert.equal(d.currency, 'ILS');
  assert.equal(d.amount_cents, 18000);
  const page = await fetch(`${B}${cap.body.redirect}&lang=he`).then((r) => r.text());
  assert.match(page, /₪/);
});

test('unsupported currency is rejected', async () => {
  assert.equal((await json('/api/orders', { amount: '10', currency: 'EUR' })).status, 400);
  assert.equal((await json('/api/subscriptions', { amount: '10', currency: 'XYZ' })).status, 400);
});

test('monthly in shekels uses its own PayPal plan', async () => {
  const usd = await json('/api/subscriptions', { amount: '50', currency: 'USD' });
  const ils = await json('/api/subscriptions', { amount: '50', currency: 'ILS' });
  const a = db.getSubscriptionByPaypalId(usd.body.id);
  const b = db.getSubscriptionByPaypalId(ils.body.id);
  assert.equal(b.currency, 'ILS');
  assert.notEqual(a.paypal_plan_id, b.paypal_plan_id);
});

test('admin reports never mix currencies', async () => {
  const cookie = await login();
  const html = await fetch(`${B}/admin?cur=ILS`, { headers: { Cookie: cookie } }).then((r) => r.text());
  assert.match(html, /₪/);
  const list = await fetch(`${B}/admin/donations?currency=ILS`, { headers: { Cookie: cookie } }).then((r) => r.text());
  assert.doesNotMatch(list.split('result-line')[1].split('</p>')[0], /\$/);
});

test('Hebrew page defaults to shekels, English to dollars', async () => {
  const he = await fetch(`${B}/?lang=he`).then((r) => r.text());
  const en = await fetch(`${B}/?lang=en`).then((r) => r.text());
  assert.match(he, /value="ILS" checked/);
  assert.match(en, /value="USD" checked/);
});

/* ---------------- full-page card checkout (redirect) ---------------- */
test('full-page PayPal card checkout: redirect → return → captured', async () => {
  const r = await json('/api/orders/redirect', { amount: '50', currency: 'ILS', lang: 'he' });
  assert.equal(r.status, 201);
  assert.match(r.body.url, /__buyer\/checkout\//);
  // buyer pays on PayPal's page, PayPal sends them back to /paypal/return
  const pay = await fetch(`${B}/__mock-paypal/__buyer/approve-redirect/${r.body.id}`, { redirect: 'manual' });
  const back = pay.headers.get('location');
  assert.match(back, /\/paypal\/return\?token=/);
  const ret = await fetch(back, { redirect: 'manual' });
  assert.equal(ret.status, 303);
  assert.match(ret.headers.get('location'), /^\/thank-you\?d=don_/);
  const d = db.getDonationByOrderId(r.body.id);
  assert.equal(d.status, 'completed');
  assert.equal(d.currency, 'ILS');
  assert.equal(d.amount_cents, 5000);
});

test('full-page checkout: cancel and declined return safely', async () => {
  const a = await json('/api/orders/redirect', { amount: '20' });
  const c = await fetch(`${B}/paypal/cancel?token=${a.body.id}`, { redirect: 'manual' });
  assert.match(c.headers.get('location'), /payment=cancelled/);
  assert.equal(db.getDonationByOrderId(a.body.id).status, 'cancelled');
  const b = await json('/api/orders/redirect', { amount: '20' });
  const pay = await fetch(`${B}/__mock-paypal/__buyer/approve-redirect/${b.body.id}?decline=1`, { redirect: 'manual' });
  const ret = await fetch(pay.headers.get('location'), { redirect: 'manual' });
  assert.match(ret.headers.get('location'), /payment=declined/);
  assert.notEqual(db.getDonationByOrderId(b.body.id).status, 'completed');
  // forged return for an unknown order does nothing
  const f = await fetch(`${B}/paypal/return?token=ORDNOTREAL123`, { redirect: 'manual' });
  assert.match(f.headers.get('location'), /payment=failed/);
});

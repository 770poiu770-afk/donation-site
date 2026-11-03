'use strict';
/**
 * Donation business logic. The browser never decides whether a payment
 * succeeded: every status comes from PayPal's API response or from a
 * signature-verified webhook.
 */
const config = require('./config');
const db = require('./db');
const paypal = require('./paypal');
const { centsToValue, valueToCents } = require('./amounts');

const log = (...a) => { if (process.env.NODE_ENV !== 'test') console.log('[donations]', ...a); };

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function cleanOptional(details = {}) {
  const str = (v, max) => {
    if (typeof v !== 'string') return null;
    const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    return t ? t.slice(0, max) : null;
  };
  let email = str(details.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) email = null;
  return {
    donorName: str(details.name, 120),
    donorEmail: email,
    message: str(details.message, 1000),
    anonymous: true, // names are never published on the site
  };
}

function description(type) {
  const org = config.site.org.name?.en || 'Donation';
  return type === 'monthly' ? `Monthly donation – ${org}` : `Donation – ${org}`;
}

function payerFields(payer = {}, paymentSource = {}) {
  const name = payer.name ? [payer.name.given_name, payer.name.surname].filter(Boolean).join(' ') : paymentSource.card?.name || null;
  return {
    payer_name: name || null,
    payer_email: payer.email_address || null,
    payer_id: payer.payer_id || null,
    payer_country: payer.address?.country_code || paymentSource.card?.billing_address?.country_code || null,
  };
}

/** Map a PayPal capture object to our donation status */
function captureStatus(capture) {
  switch (capture?.status) {
    case 'COMPLETED': return 'completed';
    case 'PENDING': return 'pending';
    case 'DECLINED':
    case 'FAILED': return 'failed';
    case 'REFUNDED': return 'refunded';
    case 'PARTIALLY_REFUNDED': return 'partially_refunded';
    default: return 'pending';
  }
}

/**
 * Apply a capture (from the capture API response or a webhook) to a donation.
 * Verifies amount and currency against what we stored when the order was created.
 */
function applyCapture(donation, capture, extra = {}) {
  const capturedCents = valueToCents(capture.amount?.value);
  const currency = capture.amount?.currency_code;
  let status = captureStatus(capture);
  let failure = null;

  if (capturedCents !== donation.amount_cents || currency !== donation.currency) {
    status = 'review';
    failure = `Amount mismatch: expected ${centsToValue(donation.amount_cents)} ${donation.currency}, PayPal reports ${capture.amount?.value} ${currency}`;
  } else if (status === 'pending') {
    failure = capture.status_details?.reason ? `Pending: ${capture.status_details.reason}` : null;
  } else if (status === 'failed') {
    failure = capture.status_details?.reason || 'Declined by PayPal';
  }

  // never downgrade a completed/refunded donation because of an out-of-order event
  const terminal = ['refunded', 'partially_refunded', 'reversed'];
  if (terminal.includes(donation.status) && status === 'completed') status = donation.status;

  const brk = capture.seller_receivable_breakdown || {};
  const fields = {
    status,
    paypal_capture_id: capture.id || donation.paypal_capture_id,
    failure_reason: failure,
    fee_cents: brk.paypal_fee?.value ? valueToCents(brk.paypal_fee.value) : donation.fee_cents,
    net_cents: brk.net_amount?.value ? valueToCents(brk.net_amount.value) : donation.net_cents,
    completed_at: status === 'completed' ? donation.completed_at || capture.create_time || db.now() : donation.completed_at,
    ...extra,
  };
  const updated = db.updateDonation(donation.id, fields);
  if (donation.status !== updated.status) {
    db.audit({ donationId: donation.id, event: `status:${donation.status}->${updated.status}`, details: { captureId: capture.id, captureStatus: capture.status, reason: failure } });
  }
  return updated;
}

/* ------------------------------------------------------------------ */
/* one-time donations (Orders API v2)                                  */
/* ------------------------------------------------------------------ */

async function startOneTime({ amountCents, details, lang }) {
  const donation = db.createDonation({ type: 'one_time', amountCents, lang, ...cleanOptional(details) });
  db.audit({ donationId: donation.id, event: 'order:create:request', details: { amountCents } });
  try {
    const order = await paypal.createOrder({
      amountValue: centsToValue(amountCents),
      currency: donation.currency,
      publicId: donation.public_id,
      description: description('one_time'),
    });
    db.updateDonation(donation.id, { paypal_order_id: order.id });
    db.audit({ donationId: donation.id, event: 'order:created', details: { orderId: order.id, status: order.status } });
    return { orderId: order.id, publicId: donation.public_id };
  } catch (err) {
    db.updateDonation(donation.id, { status: 'failed', failure_reason: `Order creation failed: ${err.message}`.slice(0, 500) });
    db.audit({ donationId: donation.id, event: 'order:create:error', details: { message: err.message, debugId: err.debugId } });
    throw err;
  }
}

/**
 * Capture an approved order. Safe to call many times: PayPal-Request-Id makes the
 * capture idempotent and an already-captured order is reconciled instead.
 */
async function captureOneTime(orderId) {
  const donation = db.getDonationByOrderId(orderId);
  if (!donation) return { ok: false, code: 'not_found' };
  if (['completed', 'refunded', 'partially_refunded'].includes(donation.status)) {
    return { ok: true, status: donation.status, publicId: donation.public_id };
  }

  let order;
  try {
    order = await paypal.captureOrder(orderId, donation.public_id);
  } catch (err) {
    db.audit({ donationId: donation.id, event: 'order:capture:error', details: { status: err.status, issue: err.issue, debugId: err.debugId } });
    if (err.issue === 'INSTRUMENT_DECLINED' || err.issue === 'PAYER_ACTION_REQUIRED') {
      // PayPal recommends restarting the buyer flow so they can choose another funding source
      return { ok: false, code: 'declined', restart: true };
    }
    if (err.issue === 'ORDER_ALREADY_CAPTURED' || err.issue === 'DUPLICATE_INVOICE_ID') {
      order = await paypal.getOrder(orderId);
    } else if (err.issue === 'ORDER_NOT_APPROVED') {
      return { ok: false, code: 'not_approved' };
    } else {
      throw err;
    }
  }

  const unit = order.purchase_units?.[0] || {};
  if (unit.custom_id && unit.custom_id !== donation.public_id) {
    db.audit({ donationId: donation.id, event: 'order:capture:mismatch', details: { customId: unit.custom_id } });
    db.updateDonation(donation.id, { status: 'review', failure_reason: 'Order reference mismatch' });
    return { ok: false, code: 'review' };
  }
  const capture = unit.payments?.captures?.[0];
  if (!capture) {
    db.audit({ donationId: donation.id, event: 'order:capture:no_capture', details: { orderStatus: order.status } });
    return { ok: false, code: 'no_capture' };
  }
  const updated = applyCapture(donation, capture, payerFields(order.payer, order.payment_source));
  db.audit({ donationId: donation.id, event: 'order:captured', details: { captureId: capture.id, status: capture.status } });
  log('captured', orderId, updated.status);
  return { ok: ['completed', 'pending'].includes(updated.status), status: updated.status, publicId: updated.public_id };
}

function cancelOneTime(orderId) {
  const donation = db.getDonationByOrderId(orderId);
  if (!donation) return false;
  if (donation.status === 'created') {
    db.updateDonation(donation.id, { status: 'cancelled' });
    db.audit({ donationId: donation.id, event: 'order:cancelled_by_donor' });
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* monthly donations (Subscriptions API)                               */
/* ------------------------------------------------------------------ */

async function ensurePlan(amountCents) {
  const { mode } = config.paypal;
  const currency = config.currency;
  const existing = db.getPlan(amountCents, currency, mode);
  if (existing) return existing;

  const productKey = `paypal_product_${mode}_${currency}`;
  let productId = db.getSetting(productKey);
  if (!productId) {
    const product = await paypal.createProduct();
    productId = product.id;
    db.setSetting(productKey, productId);
  }
  const plan = await paypal.createPlan({ productId, amountValue: centsToValue(amountCents), currency });
  db.savePlan(amountCents, currency, mode, plan.id);
  return plan.id;
}

async function startMonthly({ amountCents, details, lang }) {
  if (!config.paypal.enableSubscriptions) {
    const e = new Error('Monthly donations are disabled');
    e.status = 400;
    throw e;
  }
  const sub = db.createSubscription({ amountCents, lang, ...cleanOptional(details) });
  db.audit({ subscriptionId: sub.id, event: 'subscription:create:request', details: { amountCents } });
  try {
    const planId = await ensurePlan(amountCents);
    const ppSub = await paypal.createSubscription({
      planId,
      publicId: sub.public_id,
      returnUrl: `${config.baseUrl}/thank-you?s=${sub.public_id}`,
      cancelUrl: `${config.baseUrl}/#donate`,
    });
    db.updateSubscription(sub.id, { paypal_subscription_id: ppSub.id, paypal_plan_id: planId });
    db.audit({ subscriptionId: sub.id, event: 'subscription:created', details: { subscriptionId: ppSub.id, planId } });
    return { subscriptionId: ppSub.id, publicId: sub.public_id };
  } catch (err) {
    db.updateSubscription(sub.id, { status: 'failed' });
    db.audit({ subscriptionId: sub.id, event: 'subscription:create:error', details: { message: err.message, debugId: err.debugId } });
    throw err;
  }
}

function subStatus(ppStatus) {
  return ({ APPROVAL_PENDING: 'created', APPROVED: 'approved', ACTIVE: 'active', SUSPENDED: 'suspended', CANCELLED: 'cancelled', EXPIRED: 'expired' })[ppStatus] || 'created';
}

function applySubscription(sub, ppSub) {
  const status = subStatus(ppSub.status);
  if (ppSub.custom_id && ppSub.custom_id !== sub.public_id) {
    db.audit({ subscriptionId: sub.id, event: 'subscription:mismatch', details: { customId: ppSub.custom_id } });
    return sub;
  }
  const subscriber = ppSub.subscriber || {};
  const fields = {
    status,
    payer_name: subscriber.name ? [subscriber.name.given_name, subscriber.name.surname].filter(Boolean).join(' ') : sub.payer_name,
    payer_email: subscriber.email_address || sub.payer_email,
    payer_id: subscriber.payer_id || sub.payer_id,
    activated_at: status === 'active' && !sub.activated_at ? db.now() : sub.activated_at,
    cancelled_at: ['cancelled', 'expired'].includes(status) && !sub.cancelled_at ? db.now() : sub.cancelled_at,
  };
  const updated = db.updateSubscription(sub.id, fields);
  if (sub.status !== updated.status) db.audit({ subscriptionId: sub.id, event: `status:${sub.status}->${updated.status}` });
  return updated;
}

async function confirmMonthly(subscriptionId) {
  const sub = db.getSubscriptionByPaypalId(subscriptionId);
  if (!sub) return { ok: false, code: 'not_found' };
  const ppSub = await paypal.getSubscription(subscriptionId);
  const updated = applySubscription(sub, ppSub);
  const ok = ['active', 'approved'].includes(updated.status);
  return { ok, status: updated.status, publicId: updated.public_id };
}

/* ------------------------------------------------------------------ */
/* webhooks                                                            */
/* ------------------------------------------------------------------ */

function findDonationForCapture(capture) {
  return (
    (capture.id && db.getDonationByCaptureId(capture.id)) ||
    (capture.supplementary_data?.related_ids?.order_id && db.getDonationByOrderId(capture.supplementary_data.related_ids.order_id)) ||
    (capture.custom_id && db.getDonationByPublicId(capture.custom_id)) ||
    null
  );
}

function captureIdFromRefund(refund) {
  const up = (refund.links || []).find((l) => l.rel === 'up' && /\/captures\//.test(l.href));
  return up ? up.href.split('/captures/')[1].split(/[/?]/)[0] : null;
}

function applyRefund(donation, refundId, refundCents) {
  if (refundId && !db.recordRefund(refundId, donation.id, refundCents)) return donation; // already counted
  const total = db.totalRefunded(donation.id);
  const status = total >= donation.amount_cents ? 'refunded' : 'partially_refunded';
  const updated = db.updateDonation(donation.id, { refunded_cents: total, status });
  db.audit({ donationId: donation.id, event: `refund:${status}`, details: { refundId, refundCents, totalRefunded: total } });
  return updated;
}

async function handleWebhookEvent(evt) {
  const r = evt.resource || {};
  switch (evt.event_type) {
    case 'CHECKOUT.ORDER.APPROVED': {
      // Donor approved but the browser may have closed before capture — capture server-side.
      const d = db.getDonationByOrderId(r.id);
      if (d && d.status === 'created') await captureOneTime(r.id);
      return 'order_approved';
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.PENDING':
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED': {
      const d = findDonationForCapture(r);
      if (!d) return 'capture_unknown';
      applyCapture(d, r);
      return 'capture_applied';
    }
    case 'PAYMENT.CAPTURE.REFUNDED': {
      const captureId = captureIdFromRefund(r);
      const d = (captureId && db.getDonationByCaptureId(captureId)) || (r.custom_id && db.getDonationByPublicId(r.custom_id));
      if (!d) return 'refund_unknown';
      applyRefund(d, r.id, valueToCents(r.amount?.value));
      return 'refund_applied';
    }
    case 'PAYMENT.CAPTURE.REVERSED': {
      const d = findDonationForCapture(r) || (captureIdFromRefund(r) && db.getDonationByCaptureId(captureIdFromRefund(r)));
      if (!d) return 'reversal_unknown';
      db.updateDonation(d.id, { status: 'reversed', failure_reason: 'Payment reversed (chargeback or dispute)' });
      db.audit({ donationId: d.id, event: 'reversed', details: { id: r.id } });
      return 'reversal_applied';
    }
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.UPDATED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED': {
      const s = db.getSubscriptionByPaypalId(r.id);
      if (!s) return 'subscription_unknown';
      applySubscription(s, r);
      return 'subscription_applied';
    }
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
      const s = db.getSubscriptionByPaypalId(r.id);
      if (s) db.audit({ subscriptionId: s.id, event: 'subscription:payment_failed', details: { lastFailed: r.billing_info?.last_failed_payment } });
      return 'subscription_payment_failed';
    }
    case 'PAYMENT.SALE.COMPLETED': {
      // A monthly charge succeeded — record it as its own donation row.
      const s = r.billing_agreement_id && db.getSubscriptionByPaypalId(r.billing_agreement_id);
      if (!s) return 'sale_unknown';
      if (db.getDonationByCaptureId(r.id)) return 'sale_duplicate';
      const cents = valueToCents(r.amount?.total);
      const donation = db.tx(() => {
        const dn = db.createDonation({
          type: 'monthly', amountCents: cents, currency: r.amount?.currency || s.currency, status: 'completed',
          donorName: s.donor_name, donorEmail: s.donor_email, message: s.message, lang: s.lang,
          paypalCaptureId: r.id, subscriptionId: s.id, payerName: s.payer_name, payerEmail: s.payer_email, payerId: s.payer_id,
          completedAt: r.create_time || db.now(),
        });
        const fee = r.transaction_fee?.value ? valueToCents(r.transaction_fee.value) : null;
        if (fee !== null) db.updateDonation(dn.id, { fee_cents: fee, net_cents: cents - fee });
        if (cents !== s.amount_cents) db.updateDonation(dn.id, { failure_reason: `Charged ${r.amount?.total}, plan amount ${centsToValue(s.amount_cents)}` });
        return dn;
      });
      db.audit({ donationId: donation.id, subscriptionId: s.id, event: 'subscription:payment_completed', details: { saleId: r.id } });
      if (s.status !== 'active') db.updateSubscription(s.id, { status: 'active', activated_at: s.activated_at || db.now() });
      return 'sale_recorded';
    }
    case 'PAYMENT.SALE.REFUNDED':
    case 'PAYMENT.SALE.REVERSED': {
      const d = r.sale_id && db.getDonationByCaptureId(r.sale_id);
      if (!d) return 'sale_refund_unknown';
      if (evt.event_type === 'PAYMENT.SALE.REVERSED') {
        db.updateDonation(d.id, { status: 'reversed' });
        db.audit({ donationId: d.id, event: 'reversed', details: { id: r.id } });
      } else {
        applyRefund(d, r.id, valueToCents(r.amount?.total));
      }
      return 'sale_refund_applied';
    }
    default:
      return 'ignored';
  }
}

const WEBHOOK_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED',
];

module.exports = {
  startOneTime, captureOneTime, cancelOneTime,
  startMonthly, confirmMonthly, ensurePlan,
  handleWebhookEvent, WEBHOOK_EVENTS, cleanOptional,
};

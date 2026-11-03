'use strict';
/**
 * Thin PayPal REST client: OAuth token cache, Orders v2, Subscriptions v1,
 * Catalog products, Billing plans and webhook signature verification.
 * Credentials come only from config (environment variables).
 */
const config = require('./config');

class PayPalError extends Error {
  constructor(message, { status, body, debugId } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.body = body;
    this.debugId = debugId;
    this.issue = body?.details?.[0]?.issue;
  }
}

let tokenCache = { token: null, expiresAt: 0 };

function resetTokenCache() {
  tokenCache = { token: null, expiresAt: 0 };
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  if (!config.paypalConfigured()) throw new PayPalError('PayPal credentials are not configured', { status: 503 });
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${config.paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(`PayPal auth failed (${res.status})`, { status: res.status, body });
  tokenCache = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 300) * 1000 };
  return tokenCache.token;
}

async function request(method, path, { body, requestId, rawBody, prefer = 'return=representation' } = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: prefer };
  if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency key
  const res = await fetch(`${config.paypal.apiBase}${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    if (res.status === 401) resetTokenCache();
    throw new PayPalError(json.message || `PayPal ${method} ${path} failed (${res.status})`, {
      status: res.status, body: json, debugId: json.debug_id || res.headers.get('paypal-debug-id'),
    });
  }
  return json;
}

/* ---------------- Orders v2 ---------------- */
function brandName() {
  return config.paypal.brandName || config.site.org.name?.en || 'Donation';
}

function createOrder({ amountValue, currency, publicId, description }) {
  return request('POST', '/v2/checkout/orders', {
    requestId: `${publicId}-create`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: publicId,
        custom_id: publicId,
        invoice_id: publicId,
        description: description.slice(0, 127),
        amount: {
          currency_code: currency,
          value: amountValue,
          breakdown: { item_total: { currency_code: currency, value: amountValue } },
        },
        items: [{
          name: description.slice(0, 127),
          quantity: '1',
          category: 'DONATION',
          unit_amount: { currency_code: currency, value: amountValue },
        }],
      }],
      application_context: {
        brand_name: brandName().slice(0, 127),
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
      },
    },
  });
}

const getOrder = (orderId) => request('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);

const captureOrder = (orderId, publicId) =>
  request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId: `${publicId}-capture`, body: {} });

/* ---------------- Catalog / Plans / Subscriptions ---------------- */
const createProduct = () =>
  request('POST', '/v1/catalogs/products', {
    requestId: `product-${config.paypal.mode}-${config.currency}`,
    body: {
      name: `${brandName()} – Monthly donation`.slice(0, 127),
      description: 'Recurring monthly donation',
      type: 'SERVICE',
      category: 'CHARITY',
    },
  });

const createPlan = ({ productId, amountValue, currency }) =>
  request('POST', '/v1/billing/plans', {
    requestId: `plan-${config.paypal.mode}-${currency}-${amountValue}`,
    body: {
      product_id: productId,
      name: `Monthly donation ${amountValue} ${currency}`,
      description: `Monthly donation of ${amountValue} ${currency}`,
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0, // until cancelled
        pricing_scheme: { fixed_price: { value: amountValue, currency_code: currency } },
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    },
  });

const createSubscription = ({ planId, publicId, returnUrl, cancelUrl }) =>
  request('POST', '/v1/billing/subscriptions', {
    requestId: `${publicId}-create`,
    body: {
      plan_id: planId,
      custom_id: publicId,
      application_context: {
        brand_name: brandName().slice(0, 127),
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
  });

const getSubscription = (id) => request('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`);

/* ---------------- Webhooks ---------------- */
/**
 * Ask PayPal to verify a webhook signature. rawBody must be the exact
 * bytes received, so it is spliced into the JSON instead of re-serialized.
 */
async function verifyWebhookSignature(headers, rawBody) {
  if (!config.paypal.webhookId) return false;
  const h = (n) => headers[n] || headers[n.toLowerCase()];
  const required = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (required.some((n) => !h(n))) return false;
  const payload =
    `{"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},` +
    `"cert_url":${JSON.stringify(h('paypal-cert-url'))},` +
    `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},` +
    `"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},` +
    `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},` +
    `"webhook_id":${JSON.stringify(config.paypal.webhookId)},` +
    `"webhook_event":${rawBody}}`;
  const res = await request('POST', '/v1/notifications/verify-webhook-signature', { rawBody: payload });
  return res.verification_status === 'SUCCESS';
}

const listWebhooks = () => request('GET', '/v1/notifications/webhooks');
const createWebhook = (url, eventTypes) =>
  request('POST', '/v1/notifications/webhooks', { body: { url, event_types: eventTypes.map((name) => ({ name })) } });

module.exports = {
  PayPalError, getAccessToken, resetTokenCache, request,
  createOrder, getOrder, captureOrder,
  createProduct, createPlan, createSubscription, getSubscription,
  verifyWebhookSignature, listWebhooks, createWebhook,
};

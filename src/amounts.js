'use strict';
const config = require('./config');

/**
 * Parse and validate a donation amount coming from the client.
 * Returns { ok: true, cents } or { ok: false, error }.
 * Accepts numbers or strings like "18", "18.5", "1,000.00".
 */
function parseAmount(input) {
  if (input === null || input === undefined) return { ok: false, error: 'amount_required' };
  let s = String(input).trim().replace(/[,\s$]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'amount_invalid' };
  const [whole, frac = ''] = s.split('.');
  const cents = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  if (!Number.isSafeInteger(cents)) return { ok: false, error: 'amount_invalid' };
  if (cents < config.donation.minCents) return { ok: false, error: 'amount_too_small' };
  if (cents > config.donation.maxCents) return { ok: false, error: 'amount_too_large' };
  return { ok: true, cents };
}

/** Cents -> "1234.50" (PayPal value format) */
function centsToValue(cents) {
  return (cents / 100).toFixed(2);
}

/** PayPal value string -> cents (exact, no float math) */
function valueToCents(value) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!m) return NaN;
  return parseInt(m[1], 10) * 100 + parseInt(((m[2] || '') + '00').slice(0, 2), 10);
}

function formatMoney(cents, currency = config.currency, locale = 'en-US') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

module.exports = { parseAmount, centsToValue, valueToCents, formatMoney };

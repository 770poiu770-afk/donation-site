'use strict';
/** Server-side validation. Never trust anything coming from the browser. */

const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/i;

/** Parse "1,234.50" / "18" / 18 → integer cents, or null when invalid. */
function parseAmountToCents(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[\s,$]/g, '');
  if (!AMOUNT_RE.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

function validateAmount(input, { minCents, maxCents }) {
  const cents = parseAmountToCents(input);
  if (cents === null) return { ok: false, error: 'invalid_amount' };
  if (cents < minCents) return { ok: false, error: 'amount_too_small' };
  if (cents > maxCents) return { ok: false, error: 'amount_too_large' };
  return { ok: true, cents };
}

function centsToString(cents) {
  return (cents / 100).toFixed(2);
}

function cleanText(v, max) {
  if (v === null || v === undefined) return '';
  // strip control chars, collapse whitespace at edges
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

/** Optional donor details. Everything is optional; returns { ok, value | error }. */
function validateDonor(body = {}) {
  const name = cleanText(body.name, 120);
  const email = cleanText(body.email, 200);
  const message = cleanText(body.message, 1000);
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };
  // Anonymous unless the donor explicitly gave a name AND did not tick "anonymous"
  const wantsAnonymous = body.anonymous === undefined ? true : ['1', 'true', 'on', true].includes(body.anonymous);
  return {
    ok: true,
    value: { donorName: name || null, donorEmail: email || null, message: message || null, anonymous: wantsAnonymous || !name },
  };
}

function validateFrequency(v) {
  return v === 'monthly' ? 'monthly' : 'one_time';
}

function validateMethod(v) {
  return v === 'card' ? 'card' : 'paypal';
}

function validateLang(v) {
  return v === 'he' ? 'he' : 'en';
}

module.exports = {
  parseAmountToCents, validateAmount, centsToString, cleanText, validateDonor,
  validateFrequency, validateMethod, validateLang, EMAIL_RE,
};

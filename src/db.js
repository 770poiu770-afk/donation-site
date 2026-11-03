'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS donations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id           TEXT NOT NULL UNIQUE,
  type                TEXT NOT NULL CHECK (type IN ('one_time','monthly')),
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL,
  -- optional details the donor chose to give on our site
  donor_name          TEXT,
  donor_email         TEXT,
  message             TEXT,
  anonymous           INTEGER NOT NULL DEFAULT 1,
  lang                TEXT,
  -- data returned by PayPal
  payer_name          TEXT,
  payer_email         TEXT,
  payer_id            TEXT,
  payer_country       TEXT,
  paypal_order_id     TEXT UNIQUE,
  paypal_capture_id   TEXT UNIQUE,
  subscription_id     INTEGER REFERENCES subscriptions(id),
  fee_cents           INTEGER,
  net_cents           INTEGER,
  refunded_cents      INTEGER NOT NULL DEFAULT 0,
  failure_reason      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_completed ON donations(completed_at);
CREATE INDEX IF NOT EXISTS idx_donations_created ON donations(created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id               TEXT NOT NULL UNIQUE,
  paypal_subscription_id  TEXT UNIQUE,
  paypal_plan_id          TEXT,
  amount_cents            INTEGER NOT NULL,
  currency                TEXT NOT NULL,
  status                  TEXT NOT NULL,
  donor_name              TEXT,
  donor_email             TEXT,
  message                 TEXT,
  anonymous               INTEGER NOT NULL DEFAULT 1,
  lang                    TEXT,
  payer_name              TEXT,
  payer_email             TEXT,
  payer_id                TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  activated_at            TEXT,
  cancelled_at            TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  mode          TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (amount_cents, currency, mode)
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  resource_id   TEXT,
  verified      INTEGER NOT NULL,
  processed     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  payload       TEXT NOT NULL,
  received_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id     INTEGER,
  subscription_id INTEGER,
  event           TEXT NOT NULL,
  details         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_donation ON audit_log(donation_id);
CREATE INDEX IF NOT EXISTS idx_audit_sub ON audit_log(subscription_id);

CREATE TABLE IF NOT EXISTS refunds (
  refund_id     TEXT PRIMARY KEY,
  donation_id   INTEGER NOT NULL REFERENCES donations(id),
  amount_cents  INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  subject     TEXT,
  message     TEXT NOT NULL,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
`;

function now() {
  return new Date().toISOString();
}

function newPublicId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

function init(dbPath = config.databasePath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

function get() {
  if (!db) init();
  return db;
}

function close() {
  if (db) db.close();
  db = undefined;
}

/* ---------------- audit ---------------- */
function audit({ donationId = null, subscriptionId = null, event, details = null }) {
  get()
    .prepare('INSERT INTO audit_log (donation_id, subscription_id, event, details, created_at) VALUES (?,?,?,?,?)')
    .run(donationId, subscriptionId, event, details ? JSON.stringify(details) : null, now());
}

/* ---------------- donations ---------------- */
function createDonation(d) {
  const ts = now();
  const publicId = newPublicId('don');
  const info = get()
    .prepare(
      `INSERT INTO donations (public_id, type, amount_cents, currency, status, donor_name, donor_email, message, anonymous, lang,
        paypal_order_id, paypal_capture_id, subscription_id, payer_name, payer_email, payer_id, completed_at, created_at, updated_at)
       VALUES (@public_id,@type,@amount_cents,@currency,@status,@donor_name,@donor_email,@message,@anonymous,@lang,
        @paypal_order_id,@paypal_capture_id,@subscription_id,@payer_name,@payer_email,@payer_id,@completed_at,@ts,@ts)`
    )
    .run({
      public_id: publicId,
      type: d.type,
      amount_cents: d.amountCents,
      currency: d.currency || config.currency,
      status: d.status || 'created',
      donor_name: d.donorName || null,
      donor_email: d.donorEmail || null,
      message: d.message || null,
      anonymous: d.anonymous === false ? 0 : 1,
      lang: d.lang || null,
      paypal_order_id: d.paypalOrderId || null,
      paypal_capture_id: d.paypalCaptureId || null,
      subscription_id: d.subscriptionId || null,
      payer_name: d.payerName || null,
      payer_email: d.payerEmail || null,
      payer_id: d.payerId || null,
      completed_at: d.completedAt || null,
      ts,
    });
  return getDonation(info.lastInsertRowid);
}

const DONATION_COLUMNS = new Set([
  'status', 'paypal_order_id', 'paypal_capture_id', 'payer_name', 'payer_email', 'payer_id', 'payer_country',
  'fee_cents', 'net_cents', 'refunded_cents', 'failure_reason', 'completed_at', 'amount_cents',
]);

function updateDonation(id, fields) {
  const keys = Object.keys(fields).filter((k) => DONATION_COLUMNS.has(k));
  if (!keys.length) return getDonation(id);
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  get().prepare(`UPDATE donations SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({ ...pick(fields, keys), updated_at: now(), id });
  return getDonation(id);
}

function pick(obj, keys) {
  const o = {};
  keys.forEach((k) => (o[k] = obj[k] === undefined ? null : obj[k]));
  return o;
}

const getDonation = (id) => get().prepare('SELECT * FROM donations WHERE id = ?').get(id);
const getDonationByPublicId = (pid) => get().prepare('SELECT * FROM donations WHERE public_id = ?').get(pid);
const getDonationByOrderId = (oid) => get().prepare('SELECT * FROM donations WHERE paypal_order_id = ?').get(oid);
const getDonationByCaptureId = (cid) => get().prepare('SELECT * FROM donations WHERE paypal_capture_id = ?').get(cid);

/* ---------------- subscriptions ---------------- */
function createSubscription(s) {
  const ts = now();
  const info = get()
    .prepare(
      `INSERT INTO subscriptions (public_id, paypal_subscription_id, paypal_plan_id, amount_cents, currency, status,
         donor_name, donor_email, message, anonymous, lang, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      newPublicId('sub'), s.paypalSubscriptionId || null, s.planId || null, s.amountCents, s.currency || config.currency,
      s.status || 'created', s.donorName || null, s.donorEmail || null, s.message || null, s.anonymous === false ? 0 : 1,
      s.lang || null, ts, ts
    );
  return getSubscription(info.lastInsertRowid);
}

const SUB_COLUMNS = new Set(['status', 'paypal_subscription_id', 'paypal_plan_id', 'payer_name', 'payer_email', 'payer_id', 'activated_at', 'cancelled_at']);
function updateSubscription(id, fields) {
  const keys = Object.keys(fields).filter((k) => SUB_COLUMNS.has(k));
  if (!keys.length) return getSubscription(id);
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  get().prepare(`UPDATE subscriptions SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({ ...pick(fields, keys), updated_at: now(), id });
  return getSubscription(id);
}
const getSubscription = (id) => get().prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
const getSubscriptionByPublicId = (pid) => get().prepare('SELECT * FROM subscriptions WHERE public_id = ?').get(pid);
const getSubscriptionByPaypalId = (sid) => get().prepare('SELECT * FROM subscriptions WHERE paypal_subscription_id = ?').get(sid);

/* ---------------- settings / plans ---------------- */
const getSetting = (k) => get().prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) => get().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const getPlan = (cents, currency, mode) => get().prepare('SELECT plan_id FROM plans WHERE amount_cents = ? AND currency = ? AND mode = ?').get(cents, currency, mode)?.plan_id;
const savePlan = (cents, currency, mode, planId) =>
  get().prepare('INSERT OR REPLACE INTO plans (amount_cents, currency, mode, plan_id, created_at) VALUES (?,?,?,?,?)').run(cents, currency, mode, planId, now());

/* ---------------- webhooks ---------------- */
/** Returns false if this event id was already stored (duplicate delivery). */
function storeWebhookEvent(evt, verified) {
  try {
    get()
      .prepare('INSERT INTO webhook_events (id, event_type, resource_id, verified, payload, received_at) VALUES (?,?,?,?,?,?)')
      .run(evt.id, evt.event_type, evt.resource?.id || null, verified ? 1 : 0, JSON.stringify(evt), now());
    return true;
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return false;
    throw e;
  }
}
const markWebhookProcessed = (id, error = null) =>
  get().prepare('UPDATE webhook_events SET processed = ?, error = ? WHERE id = ?').run(error ? 0 : 1, error, id);
const getWebhookEvent = (id) => get().prepare('SELECT * FROM webhook_events WHERE id = ?').get(id);

/* ---------------- refunds ---------------- */
/** Returns true when the refund is new (not already recorded). */
function recordRefund(refundId, donationId, amountCents) {
  const r = get()
    .prepare('INSERT OR IGNORE INTO refunds (refund_id, donation_id, amount_cents, created_at) VALUES (?,?,?,?)')
    .run(refundId, donationId, amountCents, now());
  return r.changes === 1;
}
const totalRefunded = (donationId) =>
  get().prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM refunds WHERE donation_id = ?').get(donationId).t;

/* ---------------- contact ---------------- */
function createContactMessage({ name, email, subject, message }) {
  return get()
    .prepare('INSERT INTO contact_messages (name, email, subject, message, created_at) VALUES (?,?,?,?,?)')
    .run(name, email, subject || null, message, now());
}

function tx(fn) {
  return get().transaction(fn)();
}

module.exports = {
  init, get, close, now, tx, audit,
  createDonation, updateDonation, getDonation, getDonationByPublicId, getDonationByOrderId, getDonationByCaptureId,
  createSubscription, updateSubscription, getSubscription, getSubscriptionByPublicId, getSubscriptionByPaypalId,
  getSetting, setSetting, getPlan, savePlan,
  storeWebhookEvent, markWebhookProcessed, getWebhookEvent,
  createContactMessage, recordRefund, totalRefunded,
};

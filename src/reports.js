'use strict';
/** Reporting helpers for the admin dashboard (timezone-aware grouping). */
const config = require('./config');
const db = require('./db');

const COUNTED = `status IN ('completed','partially_refunded')`;

function partsIn(ts, tz = config.timezone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return o;
}

function tzOffsetMs(ts, tz = config.timezone) {
  const p = partsIn(ts, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** "YYYY-MM-DD" local date -> UTC ms at local midnight */
function localDayStartUtc(dateStr, tz = config.timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz); // second pass handles DST edges
  return ts;
}

const localDate = (ts) => {
  const p = partsIn(ts);
  return `${p.year}-${p.month}-${p.day}`;
};

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Week starts on Sunday (Israeli convention) */
function weekStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(dateStr, -dow);
}

function countedSince(fromDateStr) {
  const fromIso = new Date(localDayStartUtc(fromDateStr)).toISOString();
  return db.get()
    .prepare(`SELECT amount_cents - refunded_cents AS net, completed_at, type FROM donations WHERE ${COUNTED} AND completed_at >= ?`)
    .all(fromIso);
}

function summary() {
  const d = db.get();
  const today = localDate(Date.now());
  const wk = weekStart(today);
  const mo = today.slice(0, 8) + '01';

  const all = d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents - refunded_cents),0) t FROM donations WHERE ${COUNTED}`).get();
  const sumSince = (from) => {
    const rows = countedSince(from);
    return { n: rows.length, t: rows.reduce((a, r) => a + r.net, 0) };
  };

  // series: last 30 days, 12 weeks, 12 months
  const start = addDays(today, -400);
  const rows = countedSince(start).map((r) => ({ ...r, day: localDate(Date.parse(r.completed_at)) }));

  const daily = [];
  for (let i = 29; i >= 0; i--) daily.push({ key: addDays(today, -i), n: 0, t: 0 });
  const weekly = [];
  for (let i = 11; i >= 0; i--) weekly.push({ key: addDays(wk, -7 * i), n: 0, t: 0 });
  const monthly = [];
  {
    const [y, m] = today.split('-').map(Number);
    for (let i = 11; i >= 0; i--) {
      const dt = new Date(Date.UTC(y, m - 1 - i, 1));
      monthly.push({ key: dt.toISOString().slice(0, 7), n: 0, t: 0 });
    }
  }
  const idx = (arr) => Object.fromEntries(arr.map((x) => [x.key, x]));
  const di = idx(daily), wi = idx(weekly), mi = idx(monthly);
  for (const r of rows) {
    const a = di[r.day]; if (a) { a.n++; a.t += r.net; }
    const b = wi[weekStart(r.day)]; if (b) { b.n++; b.t += r.net; }
    const c = mi[r.day.slice(0, 7)]; if (c) { c.n++; c.t += r.net; }
  }

  const counts = Object.fromEntries(d.prepare('SELECT status, COUNT(*) n FROM donations GROUP BY status').all().map((r) => [r.status, r.n]));
  const subs = d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) t FROM subscriptions WHERE status='active'`).get();
  const unread = d.prepare('SELECT COUNT(*) n FROM contact_messages WHERE is_read = 0').get().n;

  return {
    total: all,
    today: sumSince(today),
    week: sumSince(wk),
    month: sumSince(mo),
    average: all.n ? Math.round(all.t / all.n) : 0,
    daily, weekly, monthly,
    counts,
    activeSubs: subs,
    unread,
  };
}

/* ---------------- donation search ---------------- */
const STATUSES = ['completed', 'pending', 'created', 'cancelled', 'failed', 'refunded', 'partially_refunded', 'reversed', 'review'];

function buildFilter(q = {}) {
  const where = [];
  const params = {};
  if (q.q) {
    where.push(`(donor_name LIKE @q OR donor_email LIKE @q OR payer_name LIKE @q OR payer_email LIKE @q OR paypal_order_id LIKE @q
      OR paypal_capture_id LIKE @q OR public_id LIKE @q OR message LIKE @q)`);
    params.q = `%${String(q.q).slice(0, 100)}%`;
  }
  if (q.status && STATUSES.includes(q.status)) { where.push('status = @status'); params.status = q.status; }
  else if (q.status === 'paid') where.push(COUNTED);
  else if (!q.status) where.push(`status NOT IN ('created','cancelled')`); // default: hide abandoned checkouts
  if (q.type === 'one_time' || q.type === 'monthly') { where.push('type = @type'); params.type = q.type; }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRe.test(q.from || '')) { where.push('created_at >= @from'); params.from = new Date(localDayStartUtc(q.from)).toISOString(); }
  if (dateRe.test(q.to || '')) { where.push('created_at < @to'); params.to = new Date(localDayStartUtc(addDays(q.to, 1))).toISOString(); }
  if (/^\d+$/.test(q.min || '')) { where.push('amount_cents >= @min'); params.min = Number(q.min) * 100; }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function searchDonations(q = {}, { page = 1, pageSize = 50, all = false } = {}) {
  const { sql, params } = buildFilter(q);
  const d = db.get();
  const agg = d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${COUNTED} THEN amount_cents - refunded_cents ELSE 0 END),0) t FROM donations ${sql}`).get(params);
  const limit = all ? '' : `LIMIT ${pageSize} OFFSET ${(Math.max(1, page) - 1) * pageSize}`;
  const rows = d.prepare(`SELECT * FROM donations ${sql} ORDER BY created_at DESC, id DESC ${limit}`).all(params);
  return { rows, count: agg.n, sum: agg.t, pages: Math.max(1, Math.ceil(agg.n / pageSize)) };
}

module.exports = { summary, searchDonations, STATUSES, localDate, localDayStartUtc, addDays, weekStart };

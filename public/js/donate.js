/* Donation widget: amount selection + PayPal Smart Buttons (PayPal & guest card).
   The server creates and captures every order; this file never decides success. */
(function () {
  'use strict';
  const form = document.querySelector('[data-donate]');
  if (!form || form.dataset.ready) return;
  form.dataset.ready = '1';

  const cfg = JSON.parse(form.dataset.config);
  const T = JSON.parse(form.dataset.i18n);
  const ERR = JSON.parse(form.dataset.errors);
  const $ = (s) => form.querySelector(s);
  const $$ = (s) => Array.from(form.querySelectorAll(s));

  const customInput = $('input[name="custom"]');
  const customWrap = customInput.closest('.custom-amount');
  const summary = $('[data-summary]');
  const per = $('[data-per]');
  const suffix = $('[data-suffix]');
  const monthlyNote = $('[data-monthly-note]');
  const msg = $('[data-msg]');
  const processing = $('[data-processing]');
  const payArea = $('.pay-area');
  const loading = $('[data-pp-loading]');
  const freqBox = $('.freq');

  const MIN = 100, MAX = 100000000;
  let freq = 'one_time';

  /* ---------------- amount ---------------- */
  function parseCents(str) {
    const s = String(str || '').replace(/[,\s$]/g, '');
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
    const [w, f = ''] = s.split('.');
    return parseInt(w, 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
  }
  function currentCents() {
    if (customInput.value.trim()) return parseCents(customInput.value);
    const p = form.querySelector('input[name="preset"]:checked');
    return p ? parseInt(p.value, 10) * 100 : null;
  }
  function valid(c) { return c !== null && c >= MIN && c <= MAX; }
  function fmt(c) {
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function refresh(bump) {
    const c = currentCents();
    const ok = valid(c);
    summary.textContent = ok ? fmt(c) : '—';
    customWrap.classList.toggle('active', !!customInput.value.trim());
    customWrap.classList.toggle('invalid', !!customInput.value.trim() && !ok);
    if (bump && ok) { summary.classList.remove('bump'); void summary.offsetWidth; summary.classList.add('bump'); }
    if (ok) hideMsg();
  }

  $$('input[name="preset"]').forEach((r) => r.addEventListener('change', () => { customInput.value = ''; refresh(true); }));
  customInput.addEventListener('input', () => {
    customInput.value = customInput.value.replace(/[^\d.,]/g, '');
    if (customInput.value.trim()) $$('input[name="preset"]').forEach((r) => (r.checked = false));
    refresh(true);
  });
  customInput.addEventListener('blur', () => {
    if (!customInput.value.trim() && !form.querySelector('input[name="preset"]:checked')) {
      const def = form.querySelector('input[name="preset"][value="36"]');
      if (def) def.checked = true;
      refresh(false);
    }
  });

  // "What your gift can do" shortcuts elsewhere on the page
  document.querySelectorAll('[data-pick-amount]').forEach((btn) =>
    btn.addEventListener('click', () => setAmount(parseInt(btn.dataset.pickAmount, 10)))
  );
  function setAmount(dollars) {
    const r = form.querySelector(`input[name="preset"][value="${dollars}"]`);
    if (r) { r.checked = true; customInput.value = ''; } else { customInput.value = String(dollars); }
    refresh(true);
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------------- frequency ---------------- */
  $$('input[name="freq"]').forEach((r) =>
    r.addEventListener('change', () => {
      freq = r.value;
      const monthly = freq === 'monthly';
      freqBox && freqBox.classList.toggle('is-monthly', monthly);
      per.hidden = !monthly;
      suffix.hidden = !monthly;
      monthlyNote.hidden = !monthly;
      $$('[data-pp]').forEach((el) => (el.hidden = el.dataset.pp !== freq));
      hideMsg();
      renderButtons(freq);
    })
  );

  /* ---------------- messages ---------------- */
  function showMsg(text, info) { msg.textContent = text; msg.classList.toggle('info', !!info); msg.hidden = false; }
  function hideMsg() { msg.hidden = true; }
  function busy(on) { form.classList.toggle('busy', on); processing.hidden = !on; }

  function details() {
    const v = (n) => (form.elements[n] && form.elements[n].value.trim()) || undefined;
    return { name: v('name'), email: v('email'), message: v('message') };
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }

  /* ---------------- PayPal SDK ---------------- */
  const sdkPromises = {};
  function loadSdk(kind) {
    if (sdkPromises[kind]) return sdkPromises[kind];
    const params = new URLSearchParams({
      'client-id': cfg.clientId,
      currency: cfg.currency,
      components: 'buttons',
      locale: cfg.locale,
    });
    if (kind === 'monthly') { params.set('vault', 'true'); params.set('intent', 'subscription'); }
    else { params.set('intent', 'capture'); params.set('enable-funding', 'card'); params.set('disable-funding', 'paylater,credit'); }
    const ns = kind === 'monthly' ? 'paypal_monthly' : 'paypal_once';
    sdkPromises[kind] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = cfg.sdkBase + '?' + params.toString();
      s.dataset.namespace = ns;
      s.dataset.pageType = 'checkout';
      if (cfg.nonce) { s.nonce = cfg.nonce; s.setAttribute('data-csp-nonce', cfg.nonce); }
      s.async = true;
      s.onload = () => (window[ns] ? resolve(window[ns]) : reject(new Error('sdk')));
      s.onerror = () => { delete sdkPromises[kind]; reject(new Error('sdk')); };
      document.head.appendChild(s);
    });
    return sdkPromises[kind];
  }

  const rendered = {};
  async function renderButtons(kind) {
    if (rendered[kind]) return;
    if (!cfg.available) { loading.hidden = true; showMsg(T.errUnavailable, true); return; }
    payArea.classList.remove('ready');
    let pp;
    try { pp = await loadSdk(kind); } catch (e) { loading.hidden = true; showMsg(T.errUnavailable); return; }
    const container = form.querySelector(`[data-pp="${kind}"]`);

    const common = {
      style: { layout: 'vertical', color: 'gold', shape: 'pill', label: kind === 'monthly' ? 'subscribe' : 'donate', height: 50, tagline: false },
      onClick: (data, actions) => {
        const c = currentCents();
        if (!valid(c)) { showMsg(T.errAmount); customInput.focus(); return actions.reject(); }
        hideMsg();
        return actions.resolve();
      },
      onCancel: async (data) => {
        busy(false);
        showMsg(T.cancelled, true);
        if (data && data.orderID && kind === 'one_time') post(`/api/orders/${encodeURIComponent(data.orderID)}/cancel`).catch(() => {});
      },
      onError: () => { busy(false); showMsg(T.errGeneric); },
    };

    const opts = kind === 'monthly'
      ? {
          ...common,
          createSubscription: async () => {
            const r = await post('/api/subscriptions', { amount: (currentCents() / 100).toFixed(2), details: details(), lang: cfg.lang });
            if (!r.ok) throw new Error(r.data.error || 'create');
            return r.data.id;
          },
          onApprove: async (data) => {
            busy(true);
            const r = await post(`/api/subscriptions/${encodeURIComponent(data.subscriptionID)}/confirm`);
            if (r.ok && r.data.redirect) return (window.location.href = r.data.redirect);
            busy(false);
            showMsg(T.errGeneric);
          },
        }
      : {
          ...common,
          createOrder: async () => {
            const r = await post('/api/orders', { amount: (currentCents() / 100).toFixed(2), details: details(), lang: cfg.lang });
            if (!r.ok) {
              if (ERR[r.data.error]) showMsg(ERR[r.data.error]);
              throw new Error(r.data.error || 'create');
            }
            return r.data.id;
          },
          onApprove: async (data, actions) => {
            busy(true);
            const r = await post(`/api/orders/${encodeURIComponent(data.orderID)}/capture`);
            if (r.ok && r.data.redirect) return (window.location.href = r.data.redirect);
            busy(false);
            if (r.data && r.data.restart) { showMsg(T.errDeclined); return actions.restart(); }
            showMsg(T.errGeneric);
          },
        };

    try {
      const buttons = pp.Buttons(opts);
      await buttons.render(container);
      rendered[kind] = true;
      payArea.classList.add('ready');
    } catch (e) {
      loading.hidden = true;
      showMsg(T.errUnavailable);
    }
  }

  refresh(false);
  // Load PayPal as soon as the widget is near the viewport (it is above the fold on the home page)
  renderButtons('one_time');
})();

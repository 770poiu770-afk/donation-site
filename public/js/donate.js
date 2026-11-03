/* Donation widget: currency (₪ / $), amount selection + PayPal Smart Buttons (PayPal & guest card).
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

  const SYMBOL = { USD: '$', ILS: '₪', EUR: '€', GBP: '£' };
  const customInput = $('input[name="custom"]');
  const customWrap = customInput.closest('.custom-amount');
  const summary = $('[data-summary]');
  const per = $('[data-per]');
  const suffix = $('[data-suffix]');
  const symbolEl = $('[data-symbol]');
  const grid = $('[data-amount-grid]');
  const monthlyNote = $('[data-monthly-note]');
  const msg = $('[data-msg]');
  const processing = $('[data-processing]');
  const payArea = $('.pay-area');
  const holder = $('[data-pp-holder]');
  const loading = $('[data-pp-loading]');
  const freqBox = $('.freq-type');
  const curBox = $('.cur-toggle');

  const MIN = 100, MAX = 100000000;
  let freq = 'one_time';
  let currency = cfg.currency;

  /* ---------------- amount ---------------- */
  function parseCents(str) {
    const s = String(str || '').replace(/[,\s$₪]/g, '');
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
  function sym() { return SYMBOL[currency] || ''; }
  function fmt(c) {
    return sym() + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
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

  function bindPresets() {
    $$('input[name="preset"]').forEach((r) => r.addEventListener('change', () => { customInput.value = ''; refresh(true); }));
  }
  function defaultPreset() {
    return (cfg.defaultPreset && cfg.defaultPreset[currency]) || 36;
  }
  /** Rebuild the preset buttons for the selected currency */
  function renderPresets() {
    const list = (cfg.presetsByCurrency && cfg.presetsByCurrency[currency]) || cfg.presets;
    const def = defaultPreset();
    grid.innerHTML = '';
    list.forEach((p) => {
      const label = document.createElement('label');
      label.className = 'amount-opt';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'preset';
      input.value = String(p);
      input.checked = !customInput.value.trim() && p === def;
      const span = document.createElement('span');
      span.dir = 'ltr';
      span.textContent = sym() + p.toLocaleString('en-US');
      label.append(input, span);
      grid.appendChild(label);
    });
    symbolEl.textContent = sym();
    bindPresets();
  }

  bindPresets();
  customInput.addEventListener('input', () => {
    customInput.value = customInput.value.replace(/[^\d.,]/g, '');
    if (customInput.value.trim()) $$('input[name="preset"]').forEach((r) => (r.checked = false));
    refresh(true);
  });
  customInput.addEventListener('blur', () => {
    if (!customInput.value.trim() && !form.querySelector('input[name="preset"]:checked')) {
      const def = form.querySelector(`input[name="preset"][value="${defaultPreset()}"]`);
      if (def) def.checked = true;
      refresh(false);
    }
  });

  // "What your gift can do" shortcuts elsewhere on the page
  document.querySelectorAll('[data-pick-amount]').forEach((btn) =>
    btn.addEventListener('click', () => setAmount(parseInt(btn.dataset.pickAmount, 10)))
  );
  function setAmount(n) {
    const r = form.querySelector(`input[name="preset"][value="${n}"]`);
    if (r) { r.checked = true; customInput.value = ''; } else { customInput.value = String(n); $$('input[name="preset"]').forEach((x) => (x.checked = false)); }
    refresh(true);
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------------- frequency & currency ---------------- */
  function moveGlider(box) {
    if (!box) return;
    const opts = Array.from(box.querySelectorAll('input'));
    const i = Math.max(0, opts.findIndex((o) => o.checked));
    box.style.setProperty('--n', opts.length);
    box.style.setProperty('--i', i);
  }
  $$('input[name="freq"]').forEach((r) =>
    r.addEventListener('change', () => {
      freq = r.value;
      const monthly = freq === 'monthly';
      moveGlider(freqBox);
      per.hidden = !monthly;
      suffix.hidden = !monthly;
      monthlyNote.hidden = !monthly;
      hideMsg();
      showButtons();
    })
  );
  $$('input[name="currency"]').forEach((r) =>
    r.addEventListener('change', () => {
      currency = r.value;
      moveGlider(curBox);
      renderPresets();
      refresh(true);
      hideMsg();
      showButtons();
    })
  );
  moveGlider(freqBox);
  moveGlider(curBox);

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

  /* ---------------- PayPal SDK ----------------
     The SDK's currency is fixed per script load, so each (type, currency)
     pair gets its own namespaced SDK instance and button container. */
  const sdkPromises = {};
  function loadSdk(kind, cur) {
    const key = `${kind}_${cur}`;
    if (sdkPromises[key]) return sdkPromises[key];
    const params = new URLSearchParams({
      'client-id': cfg.clientId,
      currency: cur,
      components: 'buttons',
      locale: cfg.locale,
    });
    if (kind === 'monthly') { params.set('vault', 'true'); params.set('intent', 'subscription'); }
    else { params.set('intent', 'capture'); params.set('enable-funding', 'card'); params.set('disable-funding', 'paylater,credit'); }
    const ns = `paypal_${kind}_${cur}`;
    sdkPromises[key] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = cfg.sdkBase + '?' + params.toString();
      s.dataset.namespace = ns;
      s.dataset.pageType = 'checkout';
      if (cfg.nonce) { s.nonce = cfg.nonce; s.setAttribute('data-csp-nonce', cfg.nonce); }
      s.async = true;
      s.onload = () => (window[ns] ? resolve(window[ns]) : reject(new Error('sdk')));
      s.onerror = () => { delete sdkPromises[key]; reject(new Error('sdk')); };
      document.head.appendChild(s);
    });
    return sdkPromises[key];
  }

  const rendered = {};
  function containerFor(key) {
    let el = holder.querySelector(`[data-pp="${key}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pp-buttons';
      el.dataset.pp = key;
      holder.appendChild(el);
    }
    return el;
  }

  function showButtons() {
    const key = `${freq}_${currency}`;
    holder.querySelectorAll('[data-pp]').forEach((el) => (el.hidden = el.dataset.pp !== key));
    containerFor(key).hidden = false;
    if (rendered[key]) { payArea.classList.add('ready'); return; }
    renderButtons(freq, currency);
  }

  async function renderButtons(kind, cur) {
    const key = `${kind}_${cur}`;
    if (!cfg.available) { loading.hidden = true; showMsg(T.errUnavailable, true); return; }
    payArea.classList.remove('ready');
    loading.hidden = false;
    let pp;
    try { pp = await loadSdk(kind, cur); } catch (e) { loading.hidden = true; showMsg(T.errUnavailable); return; }
    const container = containerFor(key);
    const amountBody = () => ({ amount: (currentCents() / 100).toFixed(2), currency: cur, details: details(), lang: cfg.lang });

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
            const r = await post('/api/subscriptions', amountBody());
            if (!r.ok) { if (ERR[r.data.error]) showMsg(ERR[r.data.error]); throw new Error(r.data.error || 'create'); }
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
            const r = await post('/api/orders', amountBody());
            if (!r.ok) { if (ERR[r.data.error]) showMsg(ERR[r.data.error]); throw new Error(r.data.error || 'create'); }
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
      await pp.Buttons(opts).render(container);
      rendered[key] = true;
      if (`${freq}_${currency}` === key) payArea.classList.add('ready');
    } catch (e) {
      loading.hidden = true;
      showMsg(T.errUnavailable);
    }
  }

  /* ---------------- full-page PayPal card checkout (fallback) ---------------- */
  const altBtn = $('[data-redirect-card]');
  function syncAlt() { if (altBtn) altBtn.hidden = freq !== 'one_time'; }
  $$('input[name="freq"]').forEach((r) => r.addEventListener('change', syncAlt));
  if (altBtn) {
    altBtn.addEventListener('click', async () => {
      const c = currentCents();
      if (!valid(c)) { showMsg(T.errAmount); customInput.focus(); return; }
      hideMsg();
      busy(true);
      const r = await post('/api/orders/redirect', { amount: (c / 100).toFixed(2), currency, details: details(), lang: cfg.lang });
      if (r.ok && r.data.url) { window.location.href = r.data.url; return; }
      busy(false);
      showMsg(ERR[r.data.error] || T.errGeneric);
    });
  }
  syncAlt();

  // Messages after returning from the full-page checkout
  const back = new URLSearchParams(window.location.search).get('payment');
  if (back === 'cancelled') showMsg(T.cancelled, true);
  else if (back === 'declined') showMsg(T.errDeclined);
  else if (back === 'failed') showMsg(T.errGeneric);

  refresh(false);
  showButtons();
})();

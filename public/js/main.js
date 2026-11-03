(function () {
  'use strict';
  document.documentElement.classList.add('js');

  // header shadow on scroll
  const header = document.querySelector('[data-header]');
  const onScroll = () => header && header.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // mobile nav
  const toggle = document.querySelector('[data-nav-toggle]');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.querySelectorAll('[data-nav] a').forEach((a) =>
      a.addEventListener('click', () => { document.body.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false'); })
    );
  }

  // reveal on scroll
  const items = document.querySelectorAll('.reveal, .fund-bar');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    items.forEach((el, i) => { el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`; io.observe(el); });
  } else {
    items.forEach((el) => el.classList.add('in'));
  }

  // count-up numbers
  const counters = document.querySelectorAll('[data-count]');
  if (counters.length && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const co = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        co.unobserve(e.target);
        const el = e.target, end = parseInt(el.dataset.count, 10) || 0, prefix = el.dataset.prefix || '';
        const t0 = performance.now(), dur = 1400;
        const step = (now) => {
          const p = Math.min(1, (now - t0) / dur), v = Math.round(end * (1 - Math.pow(1 - p, 3)));
          el.textContent = prefix + v.toLocaleString('en-US');
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.5 });
    counters.forEach((c) => co.observe(c));
  }

  // copy link
  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = b.dataset.copied; setTimeout(() => (b.textContent = t), 1600); } catch (e) { /* ignore */ }
    })
  );
})();

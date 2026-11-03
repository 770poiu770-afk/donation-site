(function () {
  'use strict';
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
      document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    })
  );
  document.querySelectorAll('tr[data-href]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      window.location.href = tr.dataset.href;
    })
  );
})();

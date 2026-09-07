'use strict';
// ---------------------------------------------------------------------------
// footwear.js (browser) — Footwear panel (Phase 23).
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'footwear-panel',
    mount: 'manager',
    label: 'footwear_tab',

    render(el, ctx) {
      const { api, t, esc } = ctx;
      el.innerHTML = `
        <h3>${esc(t('sizes'))}</h3>
        <p class="hint">${esc(t('sizes_hint'))}</p>
        <div id="fw-size"></div>
        <h3>${esc(t('broken'))}</h3>
        <p class="hint">${esc(t('broken_hint'))}</p>
        <div id="fw-broken"></div>
      `;
      for (const [id, host] of [['shoe_size_sell_through', '#fw-size'], ['broken_sizes', '#fw-broken']]) {
        api(`/api/reports/modules/${id}`)
          .then((r) => { el.querySelector(host).innerHTML = OP.reportTable(r.rows, r.columns); })
          .catch((e) => { el.querySelector(host).innerHTML = `<p class="err">${esc(e.message)}</p>`; });
      }
    }
  });
})();

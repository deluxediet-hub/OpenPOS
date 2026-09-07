'use strict';
// ---------------------------------------------------------------------------
// cosmetics.js (browser) — Cosmetics panel (Phase 23).
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'cosmetics-panel',
    mount: 'manager',
    label: 'cosmetics_tab',

    render(el, ctx) {
      const { api, t, esc } = ctx;
      el.innerHTML = `
        <h3>${esc(t('shades'))}</h3>
        <p class="hint">${esc(t('shades_hint'))}</p>
        <div id="cs-shade"></div>
        <h3>${esc(t('expiry'))}</h3>
        <div id="cs-exp"></div>
      `;
      for (const [id, host] of [['shade_sell_through', '#cs-shade'], ['cosmetics_expiry', '#cs-exp']]) {
        api(`/api/reports/modules/${id}`)
          .then((r) => { el.querySelector(host).innerHTML = OP.reportTable(r.rows, r.columns); })
          .catch((e) => { el.querySelector(host).innerHTML = `<p class="err">${esc(e.message)}</p>`; });
      }
    }
  });
})();

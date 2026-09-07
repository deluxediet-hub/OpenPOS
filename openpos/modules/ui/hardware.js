'use strict';
// ---------------------------------------------------------------------------
// hardware.js (browser) — Hardware store panel (Phase 23).
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'hardware-panel',
    mount: 'manager',
    label: 'hardware_tab',

    render(el, ctx) {
      const { api, t, esc } = ctx;
      el.innerHTML = `
        <h3>${esc(t('remnants'))}</h3>
        <p class="hint">${esc(t('remnants_hint'))}</p>
        <div id="hw-rem"></div>
        <h3>${esc(t('measure'))}</h3>
        <div id="hw-ms"></div>
      `;
      for (const [id, host] of [['remnants', '#hw-rem'], ['measure_sales', '#hw-ms']]) {
        api(`/api/reports/modules/${id}`)
          .then((r) => { el.querySelector(host).innerHTML = OP.reportTable(r.rows, r.columns); })
          .catch((e) => { el.querySelector(host).innerHTML = `<p class="err">${esc(e.message)}</p>`; });
      }
    }
  });
})();

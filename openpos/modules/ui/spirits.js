'use strict';
// ---------------------------------------------------------------------------
// spirits.js (browser) — the Wines & Spirits manager panel.
// Declared by modules/spirits.js as a `ui` part; the shell loads it by name and
// mounts it as a tab. No file in public/ knows this panel exists.
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'spirits-panel',
    mount: 'manager',
    label: 'spirits_tab',

    render(el, ctx) {
      const { api, boot, t, esc } = ctx;
      el.innerHTML = `
        <h3>${esc(t('premium_lines'))}</h3>
        <p class="hint">${esc(t('premium_hint'))}</p>
        <div id="sp-premium" class="rows">${esc(t('loading') || 'Loading…')}</div>
        <h3>${esc(t('bottle_economics'))}</h3>
        <p class="hint">${esc(t('bottle_hint'))}</p>
        <div id="sp-litre" class="rows"></div>
        <p><button id="sp-report" class="btn">${esc(t('run_report'))}</button></p>
      `;

      const premium = (boot.products || []).filter((p) => {
        const meta = (p && typeof p.meta === 'object' && p.meta) || {};
        return meta.premium === true || meta.premium === '1' || meta.premium === 1;
      });
      el.querySelector('#sp-premium').innerHTML = premium.length
        ? premium.map((p) => `<div class="row"><span>${esc(p.name)}</span><span class="pill r">${esc(t('premium_lines'))}</span></div>`).join('')
        : `<p class="hint">${esc(t('no_premium'))}</p>`;

      const loadLitre = async () => {
        try {
          const r = await api('/api/reports/modules/price_per_litre');
          const rows = (r.rows || []).slice(0, 20);
          el.querySelector('#sp-litre').innerHTML = rows.length
            ? `<table class="tbl"><thead><tr><th>${esc(t('name'))}</th><th>ml</th><th>${esc(t('price'))}</th><th>${esc(t('per_litre'))}</th></tr></thead><tbody>${
              rows.map((row) => `<tr><td>${esc(row.product_name)}${row.variant_name ? ` — ${esc(row.variant_name)}` : ''}</td><td>${esc(row.bottle_ml)}</td><td>${esc(row.price)}</td><td><b>${esc(row.price_per_litre)}</b></td></tr>`).join('')
            }</tbody></table>`
            : `<p class="hint">${esc(t('none'))}</p>`;
        } catch (e) {
          el.querySelector('#sp-litre').innerHTML = `<p class="err">${esc(e.message)}</p>`;
        }
      };
      el.querySelector('#sp-report').onclick = loadLitre;
      loadLitre();
    }
  });
})();

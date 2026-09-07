'use strict';
// ---------------------------------------------------------------------------
// pharmacy.js (browser) — the Chemist manager panel: expiry watch + controlled
// register. Declared by modules/pharmacy.js; the shell mounts it by name.
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'pharmacy-panel',
    mount: 'manager',
    label: 'pharmacy_tab',

    render(el, ctx) {
      const { api, t, esc } = ctx;
      el.innerHTML = `
        <h3>${esc(t('expiry_watch'))}</h3>
        <p class="hint">${esc(t('expiry_hint'))}</p>
        <div id="ph-expiry" class="rows">…</div>
        <h3>${esc(t('controlled'))}</h3>
        <p class="hint">${esc(t('controlled_hint'))}</p>
        <div id="ph-ctl" class="rows"></div>
      `;

      api('/api/reports/modules/expiry_watch?days=90')
        .then((r) => {
          const rows = r.rows || [];
          el.querySelector('#ph-expiry').innerHTML = rows.length
            ? `<table class="tbl"><thead><tr><th>${esc(t('name'))}</th><th>${esc(t('batch_no'))}</th><th>${esc(t('expiry'))}</th><th>${esc(t('quantity'))}</th></tr></thead><tbody>${
              rows.map((row) => `<tr><td>${esc(row.product_name)}</td><td>${esc(row.batch_no || '')}</td><td>${esc(row.expiry_date)}${row.expired ? ` <span class="pill r">${esc(t('expired'))}</span>` : ` <span class="pill">${esc(row.days_left)} ${esc(t('days'))}</span>`}</td><td>${esc(row.qty)}</td></tr>`).join('')
            }</tbody></table>`
            : `<p class="hint">${esc(t('none'))}</p>`;
        })
        .catch((e) => { el.querySelector('#ph-expiry').innerHTML = `<p class="err">${esc(e.message)}</p>`; });

      // The register is guarded by the module's own permission — a cashier sees
      // the refusal, not an empty page.
      api('/api/reports/modules/controlled_register', { noRedirect: true })
        .then((r) => {
          const rows = r.rows || [];
          el.querySelector('#ph-ctl').innerHTML = rows.length
            ? `<table class="tbl"><thead><tr><th>${esc(t('when'))}</th><th>${esc(t('name'))}</th><th>${esc(t('quantity'))}</th><th>${esc(t('by'))}</th></tr></thead><tbody>${
              rows.map((row) => `<tr><td>${esc(String(row.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(row.product_name)}</td><td>${esc(row.qty)}</td><td>${esc(row.user_name || '')}</td></tr>`).join('')
            }</tbody></table>`
            : `<p class="hint">${esc(t('none'))}</p>`;
        })
        .catch((e) => { el.querySelector('#ph-ctl').innerHTML = `<p class="hint">${esc(e.message)}</p>`; });
    }
  });
})();

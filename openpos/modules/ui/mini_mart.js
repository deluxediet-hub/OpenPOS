'use strict';
// ---------------------------------------------------------------------------
// mini_mart.js (browser) — Mini-mart / general retail panel (Phase 22).
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'minimart-panel',
    mount: 'manager',
    label: 'minimart_tab',

    render(el, ctx) {
      const { api, boot, t, esc } = ctx;
      const cmd = (boot.modules.commands || []).find((c) => c.id === 'repack' && c.module === 'mini_mart');
      el.innerHTML = `
        <h3>${esc(t('plu_sheet'))}</h3>
        <p class="hint">${esc(t('plu_hint'))}</p>
        <div id="mm-plu"></div>
        <h3>${esc(t('reorder'))}</h3>
        <p class="hint">${esc(t('reorder_hint'))}</p>
        <div id="mm-re"></div>
        ${cmd ? `<h3>${esc(cmd.title)}</h3><div id="mm-form">${OP.commandForm(cmd, async (params) => {
          const r = await api('/api/modules/mini_mart/commands/repack', { method: 'POST', body: { params } });
          return `${r.units} units packed from ${r.used}`;
        })}</div>` : ''}
      `;

      const load = async () => {
        for (const [id, host] of [['plu_sheet', '#mm-plu'], ['reorder_now', '#mm-re']]) {
          try {
            const r = await api(`/api/reports/modules/${id}`);
            el.querySelector(host).innerHTML = OP.reportTable(r.rows, r.columns);
          } catch (e) {
            el.querySelector(host).innerHTML = `<p class="err">${esc(e.message)}</p>`;
          }
        }
      };
      OP.bindForms(el);
      load();
    }
  });
})();

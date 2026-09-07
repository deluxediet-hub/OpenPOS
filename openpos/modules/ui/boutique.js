'use strict';
// ---------------------------------------------------------------------------
// boutique.js (browser) — Boutique / Fashion manager panel (Phase 20).
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'boutique-panel',
    mount: 'manager',
    label: 'boutique_tab',

    render(el, ctx) {
      const { api, boot, t, esc } = ctx;
      const cmd = (boot.modules.commands || []).find((c) => c.id === 'markdown' && c.module === 'boutique');
      el.innerHTML = `
        <h3>${esc(t('sell_through'))}</h3>
        <p class="hint">${esc(t('sell_through_hint'))}</p>
        <div id="bt-st"></div>
        <h3>${esc(t('dead_fashion'))}</h3>
        <p class="hint">${esc(t('dead_hint'))}</p>
        <div id="bt-dead"></div>
        <h3>${esc(t('markdowns'))}</h3>
        <div id="bt-md"></div>
        ${cmd ? `<div id="bt-form">${OP.commandForm(cmd, async (params) => {
          const r = await api(`/api/modules/boutique/commands/markdown`, { method: 'POST', body: { params } });
          load(); return `${r.applied} marked down${r.skipped ? `, ${r.skipped} below margin` : ''}`;
        })}</div>` : ''}
      `;

      const load = async () => {
        for (const [id, host] of [['size_sell_through', '#bt-st'], ['dead_fashion_stock', '#bt-dead'], ['markdowns', '#bt-md']]) {
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

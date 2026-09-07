'use strict';
// ---------------------------------------------------------------------------
// electronics.js (browser) — Electronics panel (Phase 23).
// ---------------------------------------------------------------------------
(function () {
  const OP = window.OP;

  OP.registerPanel({
    id: 'electronics-panel',
    mount: 'manager',
    label: 'electronics_tab',

    render(el, ctx) {
      const { api, boot, t, esc } = ctx;
      const cmds = (boot.modules.commands || []).filter((c) => c.module === 'electronics');
      const forms = cmds.map((c) => `<h3>${esc(c.title)}</h3>${OP.commandForm(c, async (params) => {
        const r = await api(`/api/modules/electronics/commands/${c.id}`, { method: 'POST', body: { params } });
        if (c.id === 'warranty_check') return r.in_warranty ? `in warranty until ${r.warranty_expires}` : 'not in warranty';
        return r.ref ? `job ${r.ref}` : 'done';
      })}`).join('');
      el.innerHTML = `
        <h3>${esc(t('repairs'))}</h3>
        <p class="hint">${esc(t('repairs_hint'))}</p>
        <div id="el-rep"></div>
        <h3>${esc(t('warranty'))}</h3>
        <div id="el-war"></div>
        ${forms}
      `;
      const load = () => {
        for (const [id, host] of [['repair_jobs', '#el-rep'], ['warranty_expiring', '#el-war']]) {
          api(`/api/reports/modules/${id}`)
            .then((r) => { el.querySelector(host).innerHTML = OP.reportTable(r.rows, r.columns); })
            .catch((e) => { el.querySelector(host).innerHTML = `<p class="err">${esc(e.message)}</p>`; });
        }
      };
      OP.bindForms(el);
      load();
    }
  });
})();

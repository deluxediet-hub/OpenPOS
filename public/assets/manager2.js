/* manager2.js — Phase 2-4 manager console tabs */
'use strict';

const Manager2 = (() => {
  const DAYNAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* --------------------------- DAYPARTS --------------------------- */
  async function dayparts(body) {
    const r = await api('/api/dayparts');
    const now = new Date();
    const minsNow = now.getHours() * 60 + now.getMinutes();
    body.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="stat" style="flex:1;min-width:150px"><div class="l">Rules</div><div class="v">${r.dayparts.length}</div></div>
        <div class="stat" style="flex:1;min-width:150px"><div class="l">Active right now</div>
          <div class="v" style="color:var(--green)">${r.active_now.length}</div>
          <div class="d">${new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}</div></div>
        <span class="grow"></span>
        <button class="btn primary" id="addDp">+ New pricing rule</button>
      </div>
      <div class="card"><div class="scroll-x"><table class="tbl">
        <thead><tr><th>Name</th><th>Days</th><th>Window</th><th>Discount</th><th>Applies to</th><th>State</th><th></th></tr></thead>
        <tbody>${r.dayparts.map((d) => {
          const live = r.active_now.some((a) => a.id === d.id);
          const days = String(d.days).split(',').map(Number).map((n) => DAYNAMES[n]).join(' ');
          const cat = d.category_id ? esc((State.categories.find((c) => c.id === d.category_id) || {}).name || '?') : 'All items';
          return `<tr>
            <td><b>${esc(d.name)}</b></td>
            <td class="small muted">${String(d.days) === '0,1,2,3,4,5,6' ? 'Every day' : esc(days)}</td>
            <td class="mono">${d.start_time}–${d.end_time}</td>
            <td><span class="tag warn">${d.discount_pct}% off</span></td>
            <td class="small">${cat}${d.station ? ` <span class="tag ${d.station}">${d.station}</span>` : ''}</td>
            <td>${!d.active ? '<span class="tag bad">Disabled</span>'
              : live ? '<span class="tag ok">● Live now</span>' : '<span class="tag info">Scheduled</span>'}</td>
            <td class="right nowrap">
              <button class="btn xs ${d.active ? 'red' : 'green'}" data-tog="${d.id}">${d.active ? 'Disable' : 'Enable'}</button>
              <button class="btn xs ghost" data-e="${d.id}">Edit</button>
              <button class="btn xs red" data-d="${d.id}">×</button></td>
          </tr>`;
        }).join('') || '<tr><td colspan="7" class="empty">No pricing rules yet.</td></tr>'}</tbody></table></div></div>
      <p class="tiny muted" style="margin-top:12px">Rules are evaluated when an item is added to an order and the resulting
        price is frozen onto the line, so editing a rule later never rewrites past bills. Windows may cross midnight
        (e.g. 22:00–02:00).</p>`;

    body.querySelector('#addDp').onclick = () => form(null);
    body.querySelectorAll('[data-tog]').forEach((b) => b.onclick = async () => {
      const d = r.dayparts.find((x) => x.id === Number(b.dataset.tog));
      await api('/api/dayparts/' + d.id, { method: 'PUT', body: { active: d.active ? 0 : 1 } });
      await Manager.reload(); dayparts(body); toast(d.active ? 'Rule disabled' : 'Rule enabled', 'ok');
    });
    body.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => form(r.dayparts.find((x) => x.id === Number(b.dataset.e))));
    body.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => {
      const d = r.dayparts.find((x) => x.id === Number(b.dataset.d));
      confirmBox('Delete ' + d.name, 'This pricing rule will stop applying immediately.', {
        danger: true, okLabel: 'Delete', onOk: async () => {
          await api('/api/dayparts/' + d.id, { method: 'DELETE' });
          await Manager.reload(); dayparts(body); toast('Deleted', 'ok');
        } });
    });

    function form(d) {
      const isNew = !d;
      d = d || { name: '', days: '0,1,2,3,4,5,6', start_time: '17:00', end_time: '19:00', discount_pct: 20, category_id: null, station: null, active: 1 };
      const days = String(d.days).split(',').map(Number);
      modal({
        title: isNew ? 'New pricing rule' : 'Edit — ' + d.name,
        body: `<label class="fld">Name</label><input class="inp" id="dn" value="${esc(d.name)}" placeholder="e.g. Happy Hour">
          <div class="grid3" style="margin-top:12px">
            <div><label class="fld">Starts</label><input class="inp" id="ds" type="time" value="${d.start_time}"></div>
            <div><label class="fld">Ends</label><input class="inp" id="de" type="time" value="${d.end_time}"></div>
            <div><label class="fld">Discount %</label><input class="inp" id="dd" type="number" min="0" max="100" value="${d.discount_pct}"></div>
          </div>
          <div style="margin-top:12px"><label class="fld">Days</label>
            <div class="row">${DAYNAMES.map((n, i) => `<label class="row" style="gap:5px;cursor:pointer">
              <input type="checkbox" class="dow" value="${i}" ${days.includes(i) ? 'checked' : ''}> ${n}</label>`).join('')}</div></div>
          <div class="grid2" style="margin-top:12px">
            <div><label class="fld">Category (optional)</label>
              <select class="inp" id="dc"><option value="">All categories</option>
                ${State.categories.map((c) => `<option value="${c.id}" ${c.id === d.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
            <div><label class="fld">Station</label>
              <select class="inp" id="dst"><option value="">Any</option>
                <option value="kitchen" ${d.station === 'kitchen' ? 'selected' : ''}>Kitchen only</option>
                <option value="bar" ${d.station === 'bar' ? 'selected' : ''}>Bar only</option></select></div>
          </div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>`
      });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        const sel = [...ov.querySelectorAll('.dow:checked')].map((c) => c.value).join(',');
        const payload = {
          name: ov.querySelector('#dn').value.trim(), start_time: ov.querySelector('#ds').value,
          end_time: ov.querySelector('#de').value, discount_pct: Number(ov.querySelector('#dd').value),
          days: sel || '0,1,2,3,4,5,6', category_id: Number(ov.querySelector('#dc').value) || null,
          station: ov.querySelector('#dst').value || null, active: d.active
        };
        if (!payload.name) return toast('Name required', 'err');
        try {
          if (isNew) await api('/api/dayparts', { body: payload });
          else await api('/api/dayparts/' + d.id, { method: 'PUT', body: payload });
          closeModal(); await Manager.reload(); dayparts(body); toast('Saved', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    }
  }

  /* ---------------------------- RECIPES ---------------------------- */
  async function recipes(body) {
    const all = await api('/api/recipes');
    const stock = await api('/api/stock');
    const byItem = {};
    for (const r of all) (byItem[r.item_name] = byItem[r.item_name] || []).push(r);
    body.innerHTML = `
      <p class="muted small" style="margin-top:0">A recipe links a menu item to the ingredients it consumes. Stock is
        deducted automatically when a bill is settled — never before, so voids don't cost you stock.</p>
      <div class="row" style="margin-bottom:14px">
        <div class="stat" style="flex:1;min-width:140px"><div class="l">Recipe lines</div><div class="v">${all.length}</div></div>
        <div class="stat" style="flex:1;min-width:140px"><div class="l">Menu items with recipes</div><div class="v">${Object.keys(byItem).length}</div></div>
        <div class="stat" style="flex:1;min-width:140px"><div class="l">Items with no recipe</div>
          <div class="v" style="color:${State.menu.length - Object.keys(byItem).length ? 'var(--red)' : 'var(--green)'}">${State.menu.length - Object.keys(byItem).length}</div>
          <div class="d">won't deplete stock</div></div>
        <span class="grow"></span>
        <button class="btn primary" id="addR">+ Add ingredient</button>
      </div>
      <div class="card"><div class="card-b" style="max-height:60vh;overflow:auto">
        ${Object.keys(byItem).length ? Object.entries(byItem).map(([name, lines]) => `
          <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #1d2732">
            <b>${esc(name)}</b>
            <div class="row" style="margin-top:6px">
              ${lines.map((l) => `<span class="tag kitchen">${esc(l.stock_name)} × ${l.qty} ${esc(l.unit)}
                <button class="btn xs red" data-d="${l.id}" style="margin-left:6px">×</button></span>`).join('')}
            </div>
          </div>`).join('') : '<div class="empty">No recipes yet — add one to start tracking ingredient usage.</div>'}
      </div></div>`;

    body.querySelector('#addR').onclick = () => modal({
      title: 'Add ingredient to a recipe',
      body: `<label class="fld">Menu item</label>
          <select class="inp" id="rm">${State.menu.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
        <div class="grid2" style="margin-top:12px">
          <div><label class="fld">Ingredient</label>
            <select class="inp" id="rs">${stock.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.unit)})</option>`).join('')}</select></div>
          <div><label class="fld">Quantity used per item sold</label>
            <input class="inp" id="rq" type="number" step="0.01" min="0" placeholder="e.g. 0.55"></div>
        </div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>`
    }) || (() => {
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        try {
          await api('/api/recipes', { body: {
            menu_item_id: Number(ov.querySelector('#rm').value),
            stock_item_id: Number(ov.querySelector('#rs').value),
            qty: Number(ov.querySelector('#rq').value) } });
          closeModal(); recipes(body); toast('Recipe saved', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    })();

    body.querySelectorAll('[data-d]').forEach((b) => b.onclick = async () => {
      await api('/api/recipes/' + b.dataset.d, { method: 'DELETE' });
      recipes(body); toast('Removed', 'ok');
    });
  }

  /* ---------------------------- MODIFIERS --------------------------- */
  async function modifiers(body) {
    const r = await api('/api/modifiers');
    body.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <span class="grow"></span>
        <button class="btn primary" id="addG">+ New option group</button>
      </div>
      ${r.groups.map((g) => {
        const opts = r.options.filter((o) => o.group_id === g.id);
        const items = r.item_groups.filter((ig) => ig.group_id === g.id)
          .map((ig) => (State.menu.find((m) => m.id === ig.menu_item_id) || {}).name).filter(Boolean);
        return `<div class="card" style="margin-bottom:12px">
          <div class="card-h"><h3>${esc(g.name)}</h3>
            ${g.required ? '<span class="tag warn">Required</span>' : '<span class="tag info">Optional</span>'}
            <span class="tiny muted">${g.max_pick > 1 ? 'up to ' + g.max_pick + ' picks' : 'single pick'}</span>
            <span class="grow"></span>
            <button class="btn xs ghost" data-o="${g.id}">+ Option</button>
            <button class="btn xs ghost" data-l="${g.id}">Link items</button>
            <button class="btn xs red" data-dg="${g.id}">×</button></div>
          <div class="card-b">
            <div class="row">${opts.map((o) => `<span class="tag kitchen">${esc(o.name)}${o.price ? ' +' + fmt(o.price) : ''}
              <button class="btn xs red" data-do="${o.id}" style="margin-left:6px">×</button></span>`).join('')
              || '<span class="tiny muted">No options yet</span>'}</div>
            <div class="tiny muted" style="margin-top:8px">Used by: ${items.length ? items.map(esc).join(', ') : '<i>nothing yet</i>'}</div>
          </div></div>`;
      }).join('') || '<div class="empty">No modifier groups. Create one to offer sizes, doneness, sauces or flavours.</div>'}`;

    body.querySelector('#addG').onclick = () => modal({
      title: 'New option group',
      body: `<label class="fld">Name</label><input class="inp" id="gn" placeholder="e.g. Steak doneness">
        <div class="grid3" style="margin-top:12px">
          <div><label class="fld">Required</label><select class="inp" id="gr"><option value="1">Yes</option><option value="0">No</option></select></div>
          <div><label class="fld">Min picks</label><input class="inp" id="gmn" type="number" min="0" value="0"></div>
          <div><label class="fld">Max picks</label><input class="inp" id="gmx" type="number" min="1" value="1"></div>
        </div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Create</button>`
    });
    let ov = document.querySelector('#modalRoot .ov');
    if (ov) {
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        try {
          await api('/api/modifier-groups', { body: {
            name: ov.querySelector('#gn').value, required: Number(ov.querySelector('#gr').value),
            min_pick: Number(ov.querySelector('#gmn').value), max_pick: Number(ov.querySelector('#gmx').value) } });
          closeModal(); await Manager.reload(); modifiers(body); toast('Created', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    }

    body.querySelectorAll('[data-o]').forEach((b) => b.onclick = () => {
      modal({
        title: 'Add option',
        body: `<label class="fld">Name</label><input class="inp" id="on" placeholder="e.g. Medium rare">
          <div style="margin-top:12px"><label class="fld">Extra charge (${sym()})</label>
            <input class="inp" id="op" type="number" step="0.01" value="0"></div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Add</button>`
      });
      const o2 = document.querySelector('#modalRoot .ov');
      o2.querySelector('[data-no]').onclick = closeModal;
      o2.querySelector('[data-yes]').onclick = async () => {
        try {
          await api('/api/modifier-options', { body: { group_id: Number(b.dataset.o),
            name: o2.querySelector('#on').value, price: Number(o2.querySelector('#op').value) } });
          closeModal(); modifiers(body); toast('Added', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    });

    body.querySelectorAll('[data-do]').forEach((b) => b.onclick = async () => {
      await api('/api/modifier-options/' + b.dataset.do, { method: 'DELETE' }); modifiers(body);
    });
    body.querySelectorAll('[data-dg]').forEach((b) => b.onclick = () =>
      confirmBox('Delete group', 'The group and all its options will be removed.', {
        danger: true, okLabel: 'Delete', onOk: async () => {
          await api('/api/modifier-groups/' + b.dataset.dg, { method: 'DELETE' });
          await Manager.reload(); modifiers(body); toast('Deleted', 'ok');
        } }));

    body.querySelectorAll('[data-l]').forEach((b) => b.onclick = () => {
      const gid = Number(b.dataset.l);
      const linked = new Set(r.item_groups.filter((ig) => ig.group_id === gid).map((ig) => ig.menu_item_id));
      modal({
        title: 'Link group to menu items',
        wide: true,
        body: `<p class="muted small" style="margin-top:0">Tick every item that should offer this group.</p>
          <div style="max-height:50vh;overflow:auto">
          ${State.menu.map((m) => `<label class="row" style="gap:8px;padding:3px 0;cursor:pointer">
            <input type="checkbox" class="li" value="${m.id}" ${linked.has(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('')}
          </div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save links</button>`
      });
      const o3 = document.querySelector('#modalRoot .ov');
      o3.querySelector('[data-no]').onclick = closeModal;
      o3.querySelector('[data-yes]').onclick = async () => {
        const ids = [...o3.querySelectorAll('.li:checked')].map((c) => Number(c.value));
        for (const id of ids) await api(`/api/menu-items/${id}/modifiers`, { body: { groups: [...new Set(
          [...r.item_groups.filter((ig) => ig.menu_item_id === id).map((ig) => ig.group_id), gid]) ] } });
        /* unlink the ones unticked */
        for (const ig of r.item_groups.filter((x) => x.group_id === gid && !ids.includes(x.menu_item_id))) {
          const keep = r.item_groups.filter((x) => x.menu_item_id === ig.menu_item_id && x.group_id !== gid).map((x) => x.group_id);
          await api(`/api/menu-items/${ig.menu_item_id}/modifiers`, { body: { groups: keep } });
        }
        closeModal(); await Manager.reload(); modifiers(body); toast('Links saved', 'ok');
      };
    });
  }

  /* ----------------------------- DRAWER ----------------------------- */
  async function drawer(body) {
    const cur = await api('/api/shifts/current');
    const [list, counts] = await Promise.all([api('/api/shifts'), State.settings.business_type === 'wines_spirits' ? api('/api/stock-counts') : Promise.resolve([])]);
    const openCount = counts.find((c) => c.status === 'open');
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>${cur.shift ? (cur.shift.status === 'reconciling' ? 'End-of-day reconciliation' : 'Till open') : 'Till closed'}</h3><span class="grow"></span>
          ${cur.shift ? `<span class="tiny muted">opened ${cur.shift.opened_at}</span>` : ''}</div>
        <div class="card-b">
          ${cur.shift ? (() => {
            const d = cur.drawer;
            return `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
              <div class="stat"><div class="l">Opening float</div><div class="v">${fmt(cur.shift.opening_float)}</div></div>
              <div class="stat"><div class="l">Cash sales</div><div class="v" style="color:var(--green)">${fmt(d.cash_sales)}</div></div>
              <div class="stat"><div class="l">M-Pesa sales</div><div class="v" style="color:var(--green)">${fmt(d.mpesa_sales || 0)}</div></div>
              <div class="stat"><div class="l">Card sales</div><div class="v" style="color:var(--green)">${fmt(d.card_sales || 0)}</div></div>
              <div class="stat"><div class="l">Cash expenses</div><div class="v" style="color:var(--red)">−${fmt(d.cash_expenses || 0)}</div></div>
              <div class="stat"><div class="l">M-Pesa expenses</div><div class="v" style="color:var(--red)">−${fmt(d.mpesa_expenses || 0)}</div></div>
              <div class="stat"><div class="l">Expected cash</div><div class="v">${fmt(d.expected)}</div></div>
              <div class="stat"><div class="l">Expected M-Pesa</div><div class="v">${fmt(d.expected_mpesa || 0)}</div></div>
              <div class="stat"><div class="l">Expected Card/EDC</div><div class="v">${fmt(d.expected_card || 0)}</div></div>
            </div>
            ${cur.stocktake ? `<div class="card" style="margin-top:12px;background:#101820"><div class="card-b">
              <div class="row"><b>Stock count variance · ${esc(cur.stock_coverage||'partial')}</b><span class="grow"></span><span class="tag ${cur.stocktake.cost_variance < 0 ? 'bad' : cur.stocktake.cost_variance > 0 ? 'warn' : 'ok'}">${esc(cur.stocktake.reference)}</span></div>
              <div class="grid2" style="margin-top:9px"><div class="tline"><span>At inventory cost</span><b>${fmt(cur.stocktake.cost_variance)}</b></div>
                <div class="tline"><span>At potential retail</span><b>${fmt(cur.stocktake.retail_variance)}</b></div></div>
              <div class="tiny muted" style="margin-top:7px">Recorded separately from expected cash. Changing expected cash would hide whether the difference came from an unrecorded sale, breakage, theft or a counting error.</div>
            </div></div>` : ''}
            <div class="row" style="margin-top:14px">
              <button class="btn ghost" id="payout">+ Record expense</button>
              <span class="grow"></span>
              ${openCount ? `<button class="btn primary" id="continueStocktake">Continue stocktake</button>` : `<button class="btn primary" id="closeShift">Close till &amp; reconcile</button>`}
            </div>`;
          })() : `<p class="muted">Open the till each morning. Enter the physical cash float and current M-Pesa business balance before selling.</p>
            <div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));max-width:920px">
              <div><label class="fld">Opening cash (${sym()})</label><input class="inp" id="fl" type="number" step="0.01" value="5000"></div>
              <div><label class="fld">Opening M-Pesa balance (${sym()})</label><input class="inp" id="fmp" type="number" step="0.01" value="0"></div>
              <div><label class="fld">Opening Card/EDC batch (${sym()})</label><input class="inp" id="fcard" type="number" step="0.01" value="0"></div>
              <div style="align-self:end"><button class="btn primary" id="openShift">Open till for sales</button></div>
            </div>`}
        </div>
      </div>
      <div class="card"><div class="card-h"><h3>Shift history</h3></div>
        <div class="scroll-x"><table class="tbl">
          <thead><tr><th>Opened</th><th>Closed</th><th>By</th><th class="right">Cash float</th>
            <th class="right">Cash expected</th><th class="right">Cash counted</th><th class="right">Cash variance</th>
            <th class="right">M-Pesa expected</th><th class="right">M-Pesa actual</th><th class="right">M-Pesa variance</th>
            <th class="right">Card expected</th><th class="right">Card actual</th><th class="right">Card variance</th>
            <th class="right">Stock retail variance</th><th class="right">Overall</th><th>Status</th></tr></thead>
          <tbody>${list.map((s) => `<tr>
            <td class="small mono">${s.opened_at}</td>
            <td class="small mono">${s.closed_at || '<i>open</i>'}</td>
            <td class="small">${esc(s.closed_by_name || s.opened_by_name || '—')}</td>
            <td class="right mono">${fmt(s.opening_float)}</td>
            <td class="right mono">${s.expected_cash == null ? '—' : fmt(s.expected_cash)}</td>
            <td class="right mono">${s.counted_cash == null ? '—' : fmt(s.counted_cash)}</td>
            <td class="right">${s.variance == null ? '—' : `<span class="tag ${s.variance === 0 ? 'ok' : Math.abs(s.variance) > 5000 ? 'bad' : 'warn'}">
              ${s.variance > 0 ? '+' : ''}${fmt(s.variance)}</span>`}</td>
            <td class="right mono">${s.expected_mpesa == null ? '—' : fmt(s.expected_mpesa)}</td>
            <td class="right mono">${s.counted_mpesa == null ? '—' : fmt(s.counted_mpesa)}</td>
            <td class="right">${s.mpesa_variance == null ? '—' : `<span class="tag ${s.mpesa_variance === 0 ? 'ok' : 'warn'}">${s.mpesa_variance > 0 ? '+' : ''}${fmt(s.mpesa_variance)}</span>`}</td>
            <td class="right mono">${s.expected_card == null ? '—' : fmt(s.expected_card)}</td><td class="right mono">${s.counted_card == null ? '—' : fmt(s.counted_card)}</td>
            <td class="right mono">${s.card_variance == null ? '—' : fmt(s.card_variance)}</td><td class="right mono">${s.stock_retail_variance == null ? '—' : fmt(s.stock_retail_variance)}</td>
            <td class="right mono"><b>${s.overall_variance == null ? '—' : fmt(s.overall_variance)}</b></td>
            <td><span class="tag ${s.reconciliation_status === 'FULLY BALANCED' || (s.reconciliation_status||'').startsWith('TENDERS BALANCED') ? 'ok' : (s.reconciliation_status||'').includes('RECONCILED') ? 'warn' : 'bad'}">${esc(s.reconciliation_status || (s.status === 'open' ? 'OPEN' : '—'))}</span></td>
          </tr>`).join('') || '<tr><td colspan="16" class="empty">No shifts recorded.</td></tr>'}</tbody></table></div>
      </div>`;

    if (cur.shift) {
      body.querySelector('#payout').onclick = () => {
        modal({ title: 'Record business expense', body: `<p class="muted" style="margin-top:0">The amount is deducted from the expected Cash or M-Pesa balance for this till.</p>
          <div class="grid2"><div><label class="fld">Paid from</label><select class="inp" id="exMethod"><option value="cash">Cash drawer</option><option value="mpesa">M-Pesa business account</option></select></div>
          <div><label class="fld">Amount (${sym()})</label><input class="inp" id="exAmount" type="number" min="0.01" step="0.01"></div></div>
          <div style="margin-top:12px"><label class="fld">Reason / receipt reference</label><input class="inp" id="exReason" placeholder="Supplier, transport, airtime, bank deposit…"></div>`,
          footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Record expense</button>' });
        const ov = document.querySelector('#modalRoot .ov');
        ov.querySelector('[data-no]').onclick = closeModal;
        ov.querySelector('[data-yes]').onclick = async () => {
          try {
            await api(`/api/shifts/${cur.shift.id}/payout`, { body: { amount: Number(ov.querySelector('#exAmount').value),
              method: ov.querySelector('#exMethod').value, reason: ov.querySelector('#exReason').value.trim() } });
            closeModal(); drawer(body); toast('Expense recorded', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      };
      const continueStocktake = body.querySelector('#continueStocktake');
      if (continueStocktake) continueStocktake.onclick = () => Retail.stocktakes(body);
      const closeShift = body.querySelector('#closeShift');
      if (closeShift) closeShift.onclick = () => {
        const d=cur.drawer,stockRetail=cur.stocktake?cur.stocktake.retail_variance:null;
        const stockCoverage=cur.stock_coverage||'none';
        const tolerance = Math.max(0, Number(State.settings.reconciliation_tolerance || 20) * 100);
        modal({
          title: 'Close shift / till — reconcile operations', wide: true,
          body: `<div class="grid3">
              <div><label class="fld">Expected cash</label><input class="inp mono" value="${(d.expected / 100).toFixed(2)}" disabled>
                <label class="fld" style="margin-top:8px">Cash physically counted</label><input class="inp mono" id="cnt" type="number" step="0.01" value="${(d.expected / 100).toFixed(2)}"></div>
              <div><label class="fld">Expected M-Pesa balance</label><input class="inp mono" value="${((d.expected_mpesa || 0) / 100).toFixed(2)}" disabled>
                <label class="fld" style="margin-top:8px">Actual M-Pesa balance</label><input class="inp mono" id="cntMpesa" type="number" step="0.01" value="${((d.expected_mpesa || 0) / 100).toFixed(2)}"></div>
              <div><label class="fld">Expected Card/EDC batch</label><input class="inp mono" value="${((d.expected_card || 0) / 100).toFixed(2)}" disabled>
                <label class="fld" style="margin-top:8px">Actual Card/EDC batch</label><input class="inp mono" id="cntCard" type="number" step="0.01" value="${((d.expected_card || 0) / 100).toFixed(2)}"></div>
            </div>
            <div class="card" style="background:#101820;margin-top:12px"><div class="card-b">
              <div class="grid3"><div class="tline"><span>Cash variance</span><b id="vr">—</b></div>
                <div class="tline"><span>M-Pesa variance</span><b id="vrMpesa">—</b></div>
                <div class="tline"><span>Card variance</span><b id="vrCard">—</b></div></div>
              <div class="tline" style="margin-top:8px"><span>Total tender variance</span><b id="vrTender">—</b></div>
              <div class="tline"><span>Stock variance at retail (${esc(stockCoverage)})</span><b id="vrStock">${stockRetail==null?'NOT COUNTED':fmt(stockRetail)}</b></div>
              <div class="tline total"><span>${stockCoverage==='full'?'Overall operational variance':'Scoped overall variance'}</span><b id="vrOverall">—</b></div>
              <div class="center" style="margin-top:10px"><span class="tag" id="vrStatus">—</span></div>
              <p class="tiny muted" style="margin:9px 0 0">Overall = Cash + M-Pesa + Card variance + stock variance at retail. Offsetting differences can reveal sales that were made but not entered.</p>
            </div></div>
            <div style="margin-top:12px"><label class="fld">Reconciliation note <span id="noteRequired" style="color:var(--red)"></span></label>
              <input class="inp" id="sn" placeholder="Required when anything differs — e.g. likely missed sales during rush"></div>`,
          footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Close till</button>`
        });
        const ov = document.querySelector('#modalRoot .ov');
        const cnt = ov.querySelector('#cnt'), cntMpesa = ov.querySelector('#cntMpesa'), cntCard = ov.querySelector('#cntCard');
        let current = null;
        const paintVariance=(el,value)=>{
          if(value==null){el.textContent='NOT AVAILABLE';el.style.color='var(--dim)';return;}
          el.textContent=(value>0?'+':value<0?'−':'')+fmt(Math.abs(value));
          el.style.color=Math.abs(value)<=tolerance?'var(--green)':'var(--red)';
        };
        let previewSequence=0;
        const upd=async()=>{
          const sequence=++previewSequence;
          try{const result=await api(`/api/shifts/${cur.shift.id}/reconciliation-preview`,{body:{
            counted_cash:Number(cnt.value)||0,counted_mpesa:Number(cntMpesa.value)||0,counted_card:Number(cntCard.value)||0}});
            if(sequence!==previewSequence)return;current=result;
            paintVariance(ov.querySelector('#vr'),current.cash_variance);paintVariance(ov.querySelector('#vrMpesa'),current.mpesa_variance);
            paintVariance(ov.querySelector('#vrCard'),current.card_variance);paintVariance(ov.querySelector('#vrTender'),current.tender_variance);
            paintVariance(ov.querySelector('#vrStock'),current.stock_retail_variance);paintVariance(ov.querySelector('#vrOverall'),current.overall_variance);
            const status=ov.querySelector('#vrStatus');status.textContent=current.status;
            status.className='tag '+(current.status==='FULLY BALANCED'||current.status.startsWith('TENDERS BALANCED')?'ok':current.status.includes('RECONCILED')?'warn':'bad');
            ov.querySelector('#noteRequired').textContent=current.requires_note?'* required':'(optional)';
          }catch(e){toast(e.message,'err');}
        };
        cnt.oninput=upd;cntMpesa.oninput=upd;cntCard.oninput=upd;upd();
        ov.querySelector('[data-no]').onclick = closeModal;
        ov.querySelector('[data-yes]').onclick = async () => {
          const note = ov.querySelector('#sn').value.trim();
          if(!current)await upd();
          if(!current)return toast('Could not calculate reconciliation','err');
          if (current.requires_note && !note) return toast('Add a reconciliation note for the variance', 'err');
          try {
            const res = await api(`/api/shifts/${cur.shift.id}/close`, { body: {
              counted_cash: Number(cnt.value), counted_mpesa: Number(cntMpesa.value), counted_card: Number(cntCard.value),
              reconciliation_note: note, notes: note } });
            closeModal(); await loadBootstrap(); drawer(body);
            toast(`Till closed · ${res.reconciliation.status} · ${res.reconciliation.overall_variance==null?'stock overall not available':'overall '+fmt(res.reconciliation.overall_variance)}`,
              res.reconciliation.requires_note ? 'err' : 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      };
    } else {
      body.querySelector('#openShift').onclick = async () => {
        try {
          await api('/api/shifts', { body: { opening_float: Number(body.querySelector('#fl').value),
            opening_mpesa: Number(body.querySelector('#fmp').value), opening_card: Number(body.querySelector('#fcard').value) } });
          await loadBootstrap(); toast('Till opened — ready for sales', 'ok');
          if (State.user.role === 'seller') navigate('tables'); else drawer(body);
        } catch (e) { toast(e.message, 'err'); }
      };
    }
  }

  /* -------------------------- RESERVATIONS -------------------------- */
  async function reservations(body) {
    const day = today();
    const load = async (d) => {
      const list = await api('/api/reservations?date=' + d);
      body.innerHTML = `
        <div class="row" style="margin-bottom:14px">
          <label class="fld" style="margin:0">Date</label>
          <input class="inp" type="date" id="rd" value="${d}" style="width:auto">
          <span class="grow"></span>
          <button class="btn primary" id="addRv">+ New reservation</button>
        </div>
        <div class="card"><div class="scroll-x"><table class="tbl">
          <thead><tr><th>Time</th><th>Name</th><th>Phone</th><th class="right">Guests</th><th>Table</th><th>Status</th><th>Notes</th><th></th></tr></thead>
          <tbody>${list.map((r) => `<tr>
            <td class="mono"><b>${r.res_time}</b></td><td><b>${esc(r.name)}</b></td>
            <td class="small muted">${esc(r.phone || '')}</td><td class="right mono">${r.people}</td>
            <td class="small">${esc(r.table_name || '—')}</td>
            <td><span class="tag ${r.status === 'seated' ? 'ok' : r.status === 'cancelled' ? 'bad' : r.status === 'no_show' ? 'warn' : 'info'}">${r.status}</span></td>
            <td class="small muted">${esc(r.notes || '')}</td>
            <td class="right nowrap">
              ${r.status === 'booked' ? `<button class="btn xs green" data-s="${r.id}">Seat</button>` : ''}
              <button class="btn xs red" data-c="${r.id}">Cancel</button></td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty">No reservations for this date.</td></tr>'}</tbody></table></div></div>`;

      body.querySelector('#rd').onchange = (e) => load(e.target.value);
      body.querySelector('#addRv').onclick = () => {
        modal({
          title: 'New reservation',
          body: `<div class="grid2">
              <div><label class="fld">Name</label><input class="inp" id="rn"></div>
              <div><label class="fld">Phone</label><input class="inp" id="rp"></div>
              <div><label class="fld">Date</label><input class="inp" type="date" id="rdate" value="${d}"></div>
              <div><label class="fld">Time</label><input class="inp" type="time" id="rt" value="19:00"></div>
              <div><label class="fld">Guests</label><input class="inp" type="number" id="rg" min="1" value="2"></div>
              <div><label class="fld">Table</label><select class="inp" id="rtb"><option value="">Unassigned</option>
                ${State.tables.map((t) => `<option value="${t.id}">${esc(t.name)} · ${esc(t.area)}</option>`).join('')}</select></div>
            </div>
            <div style="margin-top:12px"><label class="fld">Notes</label><input class="inp" id="rno" placeholder="e.g. birthday, window seat"></div>`,
          footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Book</button>`
        });
        const ov = document.querySelector('#modalRoot .ov');
        ov.querySelector('[data-no]').onclick = closeModal;
        ov.querySelector('[data-yes]').onclick = async () => {
          try {
            await api('/api/reservations', { body: {
              name: ov.querySelector('#rn').value, phone: ov.querySelector('#rp').value,
              res_date: ov.querySelector('#rdate').value, res_time: ov.querySelector('#rt').value,
              people: Number(ov.querySelector('#rg').value), table_id: Number(ov.querySelector('#rtb').value) || null,
              notes: ov.querySelector('#rno').value } });
            closeModal(); load(d); toast('Reservation booked', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      };
      body.querySelectorAll('[data-s]').forEach((b) => b.onclick = async () => {
        await api('/api/reservations/' + b.dataset.s, { method: 'PUT', body: { status: 'seated' } }); load(d);
      });
      body.querySelectorAll('[data-c]').forEach((b) => b.onclick = async () => {
        await api('/api/reservations/' + b.dataset.c, { method: 'DELETE' }); load(d); toast('Cancelled', 'ok');
      });
    };
    load(day);
  }

  /* --------------------- LOYALTY & GIFT CARDS ---------------------- */
  let sub = 'customers';
  async function loyalty(body) {
    body.innerHTML = `
      <div class="tabs" style="margin-bottom:14px">
        <button class="tab ${sub === 'customers' ? 'active' : ''}" data-s="customers">Customers</button>
        <button class="tab ${sub === 'cards' ? 'active' : ''}" data-s="cards">Gift cards</button>
      </div><div id="loyBody"></div>`;
    body.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => { sub = b.dataset.s; loyalty(body); });
    const host = body.querySelector('#loyBody');
    if (sub === 'customers') return customers(host);
    return cards(host);
  }

  async function customers(host) {
    const list = await api('/api/customers');
    host.innerHTML = `
      <div class="row" style="margin-bottom:12px"><input class="inp" id="cs" placeholder="Search name or phone…" style="max-width:260px">
        <span class="grow"></span><button class="btn primary" id="addC">+ New customer</button></div>
      <div class="card"><div class="scroll-x"><table class="tbl">
        <thead><tr><th>Name</th><th>Phone</th><th class="right">Points</th><th class="right">Value</th>
          <th class="right">Visits</th><th class="right">Total spend</th></tr></thead>
        <tbody id="crows">${rows(list)}</tbody></table></div></div>`;
    function rows(l) {
      const per = Number(State.settings.loyalty_redeem_per) || 1;
      return l.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="small muted">${esc(c.phone || '')}</td>
        <td class="right mono"><b>${c.points}</b></td><td class="right mono muted">${fmt(c.points * per * 100)}</td>
        <td class="right mono">${c.visits}</td><td class="right mono">${fmt(c.total_spend)}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">No customers yet.</td></tr>';
    }
    host.querySelector('#cs').oninput = async (e) => {
      const r = await api('/api/customers?q=' + encodeURIComponent(e.target.value));
      host.querySelector('#crows').innerHTML = rows(r);
    };
    host.querySelector('#addC').onclick = () => {
      modal({ title: 'New customer',
        body: `<label class="fld">Name</label><input class="inp" id="cn">
          <div class="grid2" style="margin-top:12px">
            <div><label class="fld">Phone</label><input class="inp" id="cph"></div>
            <div><label class="fld">Email</label><input class="inp" id="ce"></div></div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>` });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        try {
          await api('/api/customers', { body: { name: ov.querySelector('#cn').value,
            phone: ov.querySelector('#cph').value, email: ov.querySelector('#ce').value } });
          closeModal(); customers(host); toast('Customer added', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    };
  }

  async function cards(host) {
    const list = await api('/api/gift-cards');
    host.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div class="stat" style="flex:1;min-width:140px"><div class="l">Outstanding liability</div>
          <div class="v">${fmt(list.reduce((a, c) => a + (c.status === 'active' ? c.balance : 0), 0))}</div>
          <div class="d">unredeemed gift card value</div></div>
        <span class="grow"></span>
        <button class="btn primary" id="addGc">+ Issue gift card</button></div>
      <div class="card"><div class="scroll-x"><table class="tbl">
        <thead><tr><th>Code</th><th>Holder</th><th class="right">Value</th><th class="right">Balance</th><th>Issued</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr>
          <td class="mono"><b>${esc(c.code)}</b></td><td class="small">${esc(c.customer_name || '—')}</td>
          <td class="right mono">${fmt(c.value)}</td><td class="right mono"><b>${fmt(c.balance)}</b></td>
          <td class="small muted">${c.created_at.slice(0, 10)}</td>
          <td><span class="tag ${c.status === 'active' ? 'ok' : c.status === 'void' ? 'bad' : 'info'}">${c.status}</span></td>
          <td class="right">${c.status === 'active' ? `<button class="btn xs red" data-v="${c.id}">Void</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">No gift cards issued.</td></tr>'}</tbody></table></div></div>`;

    host.querySelector('#addGc').onclick = () => {
      modal({ title: 'Issue gift card',
        body: `<label class="fld">Value (${sym()})</label><input class="inp" id="gv" type="number" step="0.01" placeholder="e.g. 2000">
          <div class="grid2" style="margin-top:12px"><div><label class="fld">Funding payment</label><select class="inp" id="gm"><option value="cash">Cash</option><option value="card">Card</option><option value="mpesa">M-Pesa</option></select></div>
            <div><label class="fld">Card/M-Pesa reference</label><input class="inp mono" id="gr" placeholder="Required for non-cash"></div></div>
          <div style="margin-top:12px"><label class="fld">Code (leave blank to auto-generate)</label>
            <input class="inp mono" id="gc" placeholder="${State.settings.giftcard_prefix || 'SRN'}-XXXX-XXXX-XXXX"></div>
          <p class="tiny muted">The card activates only after this funding payment is recorded against the open till.</p>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Issue</button>` });
      const ov = document.querySelector('#modalRoot .ov');
      const fundingKey = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `gift-${Date.now()}-${Math.random()}`;
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        try {
          const res = await api('/api/gift-cards', { body: { value: Number(ov.querySelector('#gv').value),
            code: ov.querySelector('#gc').value, payment_method: ov.querySelector('#gm').value,
            reference: ov.querySelector('#gr').value.trim(), idempotency_key: fundingKey } });
          closeModal(); cards(host);
          modal({ title: 'Gift card issued', body: `<div class="center" style="padding:16px">
            <div class="mono" style="font-size:22px;font-weight:700;letter-spacing:2px">${esc(res.code)}</div>
            <div class="muted" style="margin-top:8px">${fmt(res.value)}</div>
            <p class="tiny muted" style="margin-top:16px">Write this down — it is the only time the full code is shown.</p></div>`,
            footer: `<button class="btn primary" data-no>Done</button>` });
          const o2 = document.querySelector('#modalRoot .ov');
          o2.querySelector('[data-no]').onclick = closeModal;
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    host.querySelectorAll('[data-v]').forEach((b) => b.onclick = () =>
      confirmBox('Void gift card', 'The card will no longer be accepted at the till.', {
        danger: true, okLabel: 'Void card', onOk: async () => {
          await api(`/api/gift-cards/${b.dataset.v}/void`, {}); cards(host); toast('Voided', 'ok');
        } }));
  }

  /* ------------------------ LABOUR & USAGE ------------------------- */
  async function labour(body) {
    const t = today();
    const [lab, usage] = await Promise.all([
      api(`/api/reports/labour?from=${t}&to=${t}`),
      api(`/api/reports/stock-usage?from=${t}&to=${t}`)
    ]);
    body.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h3 style="margin:0;font-size:14px">Labour &amp; usage</h3>
        <span class="grow"></span><button class="btn" id="labpdf">🖨 PDF</button></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:14px">
        <div class="stat"><div class="l">Hours worked today</div><div class="v">${lab.hours}</div></div>
        <div class="stat"><div class="l">Labour cost</div><div class="v">${fmt(lab.cost)}</div></div>
        <div class="stat"><div class="l">Labour % of sales</div>
          <div class="v" style="color:${lab.pct > lab.target_pct ? 'var(--red)' : 'var(--green)'}">${lab.pct}%</div>
          <div class="d">target ${lab.target_pct}%</div></div>
        <div class="stat"><div class="l">Net sales</div><div class="v">${fmt(lab.sales)}</div></div>
      </div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card"><div class="card-h"><h3>Staff on the clock</h3></div>
          <table class="tbl"><thead><tr><th>Name</th><th class="right">Hours</th><th class="right">Cost</th></tr></thead>
          <tbody>${lab.by_user.map((u) => `<tr><td><b>${esc(u.name)}</b></td>
            <td class="right mono">${u.hours}</td><td class="right mono">${fmt(u.cost)}</td></tr>`).join('')
            || '<tr><td colspan="3" class="empty">No completed punches today.</td></tr>'}</tbody></table>
        </div>
        <div class="card"><div class="card-h"><h3>Theoretical stock usage</h3>
          <span class="grow"></span><span class="tiny muted">from recipes × items sold</span></div>
          <div style="max-height:320px;overflow:auto"><table class="tbl">
            <thead><tr><th>Ingredient</th><th class="right">Used</th><th class="right">On hand</th></tr></thead>
            <tbody>${usage.filter((u) => u.theoretical > 0).map((u) => `<tr>
              <td><b>${esc(u.name)}</b></td><td class="right mono">${Math.round(u.theoretical * 100) / 100} ${esc(u.unit)}</td>
              <td class="right mono">${esc(stockQtyLabel(u.on_hand, u.unit, u.capacity_ml))}</td></tr>`).join('')
              || '<tr><td colspan="3" class="empty">Nothing sold against a recipe today.</td></tr>'}</tbody></table></div>
        </div>
      </div>`;
    body.querySelector('#labpdf').onclick = () => printReport({
      title: 'Labour & Stock-Usage Report', subtitle: `Date ${t}`,
      tables: [
        { title: 'Labour', head: ['Metric', 'Value'], right: [1], rows: [
          ['Hours worked', String(lab.hours)], ['Labour cost', fmt(lab.cost)],
          ['Labour % of sales', lab.pct + '% (target ' + lab.target_pct + '%)'], ['Net sales', fmt(lab.sales)] ] },
        { title: 'Staff on the clock', head: ['Name', 'Hours', 'Cost'], right: [1, 2],
          rows: lab.by_user.map((u) => [u.name, String(u.hours), fmt(u.cost)]),
          footer: ['TOTAL', String(lab.hours), fmt(lab.cost)] },
        { title: 'Theoretical stock usage', head: ['Ingredient', 'Used', 'On hand'], right: [1, 2],
          rows: usage.filter((u) => u.theoretical > 0).map((u) => [u.name, (Math.round(u.theoretical * 100) / 100) + ' ' + u.unit, stockQtyLabel(u.on_hand, u.unit, u.capacity_ml)]) }
      ]
    });
  }

  /* ------------------------ INTEGRATIONS UI ------------------------ */
  async function integrations(body) {
    const r = await api('/api/integrations');
    const badge = (c) => c.enabled
      ? (c.configured ? '<span class="tag warn">Enabled · awaiting client</span>' : '<span class="tag bad">Enabled but incomplete</span>')
      : '<span class="tag info">Disabled</span>';
    body.innerHTML = `
      <div class="card" style="border-left:3px solid var(--amber);margin-bottom:16px"><div class="card-b">
        <b>Configuration only.</b>
        <p class="muted small" style="margin:8px 0 0">Credentials you save here are stored per business and used by the
          integration layer in <code>lib/integrations.js</code>. Neither KRA eTIMS transmission nor live M-Pesa STK push is
          wired up yet — until it is, keep collecting the M-Pesa confirmation code by hand and issue tax invoices through
          the KRA portal or mobile app. The <b>Dry run</b> buttons shape a real payload without sending it, so you can
          verify credentials and endpoint URLs in advance.</p>
      </div></div>

      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card"><div class="card-h"><h3>KRA eTIMS</h3><span class="grow"></span>${badge(r.etims)}</div>
          <div class="card-b">
            <label class="row" style="gap:8px;cursor:pointer;margin-bottom:12px">
              <input type="checkbox" id="et_en" ${r.etims.enabled ? 'checked' : ''}> Enabled</label>
            <label class="fld">API endpoint</label><input class="inp" id="et_ep" value="${esc(r.etims.endpoint)}">
            <div class="grid2" style="margin-top:10px">
              <div><label class="fld">Username</label><input class="inp" id="et_un" value="${esc(r.etims.username)}"></div>
              <div><label class="fld">Password</label><input class="inp" id="et_pw" type="password" placeholder="(saved — retype to change)"></div>
              <div><label class="fld">Branch code</label><input class="inp" id="et_br" value="${esc(r.etims.branch_code)}"></div>
              <div><label class="fld">Device serial</label><input class="inp" id="et_ds" value="${esc(r.etims.device_serial)}"></div>
              <div><label class="fld">Receipt prefix</label><input class="inp" id="et_rp" value="${esc(r.etims.receipt_prefix)}"></div>
              <div><label class="fld">Offline queue (hrs)</label><input class="inp" id="et_oh" type="number" value="${esc(String(r.etims.offline_queue_hours))}"></div>
            </div>
            ${r.etims.missing.length ? `<p class="tiny" style="color:var(--red);margin-top:10px">Still needed: ${r.etims.missing.join(', ')}</p>` : ''}
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="etSave">Save eTIMS</button>
              <button class="btn ghost" id="etDry">Dry run invoice</button></div>
          </div>
        </div>

        <div class="card"><div class="card-h"><h3>Safaricom Daraja (M-Pesa)</h3><span class="grow"></span>${badge(r.mpesa)}</div>
          <div class="card-b">
            <label class="row" style="gap:8px;cursor:pointer;margin-bottom:12px">
              <input type="checkbox" id="mp_en" ${r.mpesa.enabled ? 'checked' : ''}> Enabled</label>
            <div class="grid2">
              <div><label class="fld">Environment</label><select class="inp" id="mp_env">
                <option value="sandbox" ${r.mpesa.env === 'sandbox' ? 'selected' : ''}>Sandbox</option>
                <option value="production" ${r.mpesa.env === 'production' ? 'selected' : ''}>Production</option></select></div>
              <div><label class="fld">Shortcode / Paybill</label><input class="inp" id="mp_sc" value="${esc(r.mpesa.shortcode)}"></div>
              <div><label class="fld">Consumer key</label><input class="inp" id="mp_ck" type="password" placeholder="(saved)"></div>
              <div><label class="fld">Consumer secret</label><input class="inp" id="mp_cs" type="password" placeholder="(saved)"></div>
            </div>
            <div style="margin-top:10px"><label class="fld">Passkey</label><input class="inp" id="mp_pk" type="password" placeholder="(saved)"></div>
            <div style="margin-top:10px"><label class="fld">Callback URL (must be public HTTPS)</label>
              <input class="inp" id="mp_cb" value="${esc(r.mpesa.callback_url)}" placeholder="https://yourdomain.com/api/mpesa/callback"></div>
            <div style="margin-top:10px"><label class="fld">Account reference</label>
              <input class="inp" id="mp_ac" value="${esc(r.mpesa.paybill_account)}"></div>
            ${r.mpesa.missing.length ? `<p class="tiny" style="color:var(--red);margin-top:10px">Still needed: ${r.mpesa.missing.join(', ')}</p>` : ''}
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="mpSave">Save M-Pesa</button>
              <button class="btn ghost" id="mpDry">Dry run STK</button></div>
          </div>
        </div>
      </div>
      <div id="intOut"></div>`;

    const out = body.querySelector('#intOut');
    const show = (o) => { out.innerHTML = `<div class="card" style="margin-top:14px">
      <div class="card-h"><h3>Dry-run output</h3><span class="grow"></span><button class="btn xs ghost" id="clr">Clear</button></div>
      <div class="card-b"><pre style="margin:0;font-size:11.5px;overflow:auto;max-height:340px">${esc(JSON.stringify(o, null, 2))}</pre></div></div>`;
      out.querySelector('#clr').onclick = () => { out.innerHTML = ''; }; };

    body.querySelector('#etSave').onclick = async () => {
      const p = { etims_enabled: body.querySelector('#et_en').checked ? '1' : '0',
        etims_endpoint: body.querySelector('#et_ep').value, etims_username: body.querySelector('#et_un').value,
        etims_branch_code: body.querySelector('#et_br').value, etims_device_serial: body.querySelector('#et_ds').value,
        etims_receipt_prefix: body.querySelector('#et_rp').value, etims_offline_queue_hours: body.querySelector('#et_oh').value };
      const pw = body.querySelector('#et_pw').value;
      if (pw) p.etims_password = pw;
      await api('/api/settings', { method: 'PUT', body: p });
      toast('eTIMS settings saved', 'ok'); integrations(body);
    };
    body.querySelector('#mpSave').onclick = async () => {
      const p = { mpesa_enabled: body.querySelector('#mp_en').checked ? '1' : '0',
        mpesa_env: body.querySelector('#mp_env').value, mpesa_shortcode: body.querySelector('#mp_sc').value,
        mpesa_callback_url: body.querySelector('#mp_cb').value, mpesa_paybill_account: body.querySelector('#mp_ac').value };
      const ck = body.querySelector('#mp_ck').value, cs = body.querySelector('#mp_cs').value, pk = body.querySelector('#mp_pk').value;
      if (ck) p.mpesa_consumer_key = ck;
      if (cs) p.mpesa_consumer_secret = cs;
      if (pk) p.mpesa_passkey = pk;
      await api('/api/settings', { method: 'PUT', body: p });
      toast('M-Pesa settings saved', 'ok'); integrations(body);
    };
    body.querySelector('#etDry').onclick = async () => {
      try { show(await api('/api/integrations/dry-run', { body: { target: 'etims' } })); }
      catch (e) { toast(e.message, 'err'); }
    };
    body.querySelector('#mpDry').onclick = () => {
      modal({ title: 'Dry-run STK push',
        body: `<div class="grid2"><div><label class="fld">Phone</label><input class="inp" id="dp" value="0712345678"></div>
          <div><label class="fld">Amount (${sym()})</label><input class="inp" id="da" type="number" value="100"></div></div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Run</button>` });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        const res = await api('/api/integrations/dry-run', { body: { target: 'mpesa',
          phone: ov.querySelector('#dp').value, amount: Number(ov.querySelector('#da').value) } });
        closeModal(); show(res);
      };
    };
  }

  /* --------------------------- PRINTER UI --------------------------- */
  function printer(body) {
    const s = State.settings, retail = s.business_type === 'wines_spirits';
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-h"><h3>Thermal printer</h3>
        <span class="grow"></span>${s.printer_enabled === '1' ? '<span class="tag ok">Enabled</span>' : '<span class="tag info">Disabled</span>'}</div>
        <div class="card-b">
          <p class="muted small" style="margin-top:0">Network (ESC/POS) printers listen on port 9100. Find the printer's IP
            from its self-test page. Every job is also spooled to <code>spool/</code> as a reprint archive. With printing
            disabled the app falls back to the browser's print dialog.</p>
          <label class="row" style="gap:8px;cursor:pointer;margin-bottom:12px">
            <input type="checkbox" id="pr_en" ${s.printer_enabled === '1' ? 'checked' : ''}> Send jobs to a network printer</label>
          <div class="grid2">
            <div><label class="fld">Receipt printer host</label><input class="inp mono" id="pr_h" value="${esc(s.printer_host)}" placeholder="192.168.1.50"></div>
            <div><label class="fld">Port</label><input class="inp mono" id="pr_p" value="${esc(s.printer_port)}"></div>
            ${retail ? '' : `<div><label class="fld">Kitchen printer host (optional)</label><input class="inp mono" id="pr_kh" value="${esc(s.kitchen_printer_host)}" placeholder="defaults to receipt printer"></div>
            <div><label class="fld">Kitchen port</label><input class="inp mono" id="pr_kp" value="${esc(s.kitchen_printer_port)}"></div>`}
            <div><label class="fld">Characters per line</label><input class="inp" id="pr_c" type="number" value="${esc(s.printer_chars)}">
              <div class="tiny muted" style="margin-top:4px">42 for 80mm paper, 32 for 58mm</div></div>
            <div><label class="fld">Cash drawer</label><select class="inp" id="pr_d">
              <option value="1" ${s.drawer_kick_enabled === '1' ? 'selected' : ''}>Kick open on cash sale</option>
              <option value="0" ${s.drawer_kick_enabled !== '1' ? 'selected' : ''}>No drawer attached</option></select></div>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" id="prSave">Save</button>
            <button class="btn ghost" id="prTest">Print test receipt</button></div>
          <div id="prOut" class="tiny muted" style="margin-top:10px"></div>
        </div>
      </div>`;

    body.querySelector('#prSave').onclick = async () => {
      State.settings = await api('/api/settings', { method: 'PUT', body: {
        printer_enabled: body.querySelector('#pr_en').checked ? '1' : '0',
        printer_host: body.querySelector('#pr_h').value.trim(),
        printer_port: body.querySelector('#pr_p').value,
        kitchen_printer_host: body.querySelector('#pr_kh')?.value.trim() || '',
        kitchen_printer_port: body.querySelector('#pr_kp')?.value || '9100',
        printer_chars: body.querySelector('#pr_c').value,
        drawer_kick_enabled: body.querySelector('#pr_d').value } });
      toast('Printer settings saved', 'ok'); printer(body);
    };
    body.querySelector('#prTest').onclick = async () => {
      const o = State.orders[0] || (await api('/api/orders?status=closed'))[0];
      const out = body.querySelector('#prOut');
      if (!o) { out.innerHTML = '<span style="color:var(--red)">No order exists yet to print.</span>'; return; }
      try {
        const r = await api('/api/print/receipt/' + o.id, { method: 'POST' });
        out.innerHTML = r.sent
          ? `<span style="color:var(--green)">Sent ${r.bytes} bytes to ${esc(r.printer)}</span>`
          : `<span style="color:var(--amber)">${esc(r.reason || 'Not sent')} — ${r.bytes} bytes spooled</span>`;
      } catch (e) { out.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
    };
  }

  return { dayparts, recipes, modifiers, drawer, reservations, loyalty, labour, integrations, printer };
})();

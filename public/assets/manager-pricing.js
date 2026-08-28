/* manager-pricing.js — pricing rules, recipes and product options */
'use strict';

const ManagerPricing = (() => {
  const DAYNAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  async function dayparts(body) {
    const r = await api('/api/dayparts');
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

  return { dayparts, recipes, modifiers };
})();

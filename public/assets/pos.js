/* pos.js — floor map, order taking, item entry */
'use strict';

const Pos = (() => {
  /* ---------------------------- FLOOR MAP ---------------------------- */
  function renderFloor(host) {
    if (State.settings.business_type === 'wines_spirits') return renderRetail(host);
    const areas = ['All', ...new Set(State.tables.map((t) => t.area))];
    const list = State.tables.filter((t) => State.area === 'All' || t.area === State.area);
    const counts = { free: 0, occupied: 0, billed: 0 };
    State.tables.forEach((t) => { const o = tableStatus(t.id); counts[o ? o.status : 'free']++; });
    const float = State.orders.filter((o) => !o.table_id);

    host.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Open orders</div><div class="v">${State.orders.filter(o=>o.status==='open').length}</div></div>
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Awaiting payment</div><div class="v" style="color:var(--blue)">${counts.billed}</div></div>
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Tables free</div><div class="v" style="color:var(--green)">${counts.free}</div></div>
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Covers seated</div><div class="v">${State.orders.reduce((a,o)=>a+(o.people||0),0)}</div></div>
        <span class="grow"></span>
        <button class="btn primary" id="newTakeaway">+ Takeaway order</button>
      </div>
      <div class="legend">
        <span><i style="background:#2f5c3a"></i>Free</span>
        <span><i style="background:var(--amber)"></i>Occupied</span>
        <span><i style="background:var(--blue)"></i>Bill requested</span>
      </div>
      <div class="area-tabs">${areas.map((a) =>
        `<button class="area-tab${State.area === a ? ' active' : ''}" data-area="${esc(a)}">${esc(a)}</button>`).join('')}</div>
      <div class="table-grid">
        ${list.map((t) => {
          const o = tableStatus(t.id);
          const st = o ? o.status : 'free';
          return `<button class="tbl-card ${st}" data-tid="${t.id}">
            <span class="bar"></span>
            <span class="nm">${esc(t.name)}</span>
            <span class="st">${o ? (st === 'billed' ? 'Bill due' : 'Occupied') : 'Free'} · ${t.seats} seats</span>
            ${o ? `<span class="amt">${fmt(o.totals.grand_total)}</span>
                   <span class="meta">${o.items.length} items · ${ago(o.opened_at)} · ${esc(waiterName(o.waiter_id))}</span>`
                 : `<span class="amt" style="color:var(--dim2)">—</span><span class="meta">Tap to seat</span>`}
          </button>`;
        }).join('')}
      </div>
      ${float.length ? `<h3 style="margin:22px 0 10px;font-size:13px;color:var(--dim)">TAKEAWAY / UNGROUPED</h3>
        <div class="ord-list">${float.map((o) => `
          <div class="ord" data-oid="${o.id}">
            <div class="t"><span>Takeaway #${o.number}</span><span>${fmt(o.totals.grand_total)}</span></div>
            <div class="m"><span>${o.items.length} items</span><span>opened ${ago(o.opened_at)} ago</span>
              <span>${esc(waiterName(o.waiter_id))}</span></div>
          </div>`).join('')}</div>` : ''}`;

    host.querySelectorAll('[data-area]').forEach((b) => b.onclick = () => { State.area = b.dataset.area; renderFloor(host); });
    host.querySelectorAll('[data-tid]').forEach((b) => b.onclick = () => tapTable(host, Number(b.dataset.tid)));
    host.querySelectorAll('[data-oid]').forEach((b) => b.onclick = () => openEditor(host, Number(b.dataset.oid)));
    host.querySelector('#newTakeaway').onclick = () => newOrder(host, null);
  }

  /* Retail till: no restaurant floor, seating or kitchen workflow. */
  function renderRetail(host) {
    const open = State.orders.filter((o) => ['open', 'billed'].includes(o.status) && !o.table_id);
    host.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="stat" style="flex:1;min-width:150px"><div class="l">Open sales</div><div class="v">${open.length}</div><div class="d">parked at this till</div></div>
        <div class="stat" style="flex:1;min-width:150px"><div class="l">Products</div><div class="v">${State.menu.filter((m) => m.available).length}</div><div class="d">available for sale</div></div>
        <div class="stat" style="flex:1;min-width:150px"><div class="l">Low stock</div><div class="v" style="color:var(--amber)">${State.stock.filter((x) => x.qty <= x.min_qty).length}</div><div class="d">check Stock tab</div></div>
        <span class="grow"></span><button class="btn primary" id="newRetailSale">+ New sale</button>
      </div>
      <div class="card"><div class="card-h"><h3>Open / parked sales</h3><span class="grow"></span>
        <span class="muted tiny">Start a sale, add bottles or packs, then take Cash, Card or M-Pesa.</span></div>
        <div class="ord-list" style="padding:12px">${open.map((o) => `
          <div class="ord" data-oid="${o.id}"><div class="t"><span>Sale #${o.number}</span><span>${fmt(o.totals.grand_total)}</span></div>
          <div class="m"><span>${o.items.reduce((n, i) => n + i.qty, 0)} unit(s)</span><span>opened ${ago(o.opened_at)} ago</span>
          <span>${esc(waiterName(o.waiter_id))}</span></div></div>`).join('') || '<div class="empty">No open sales. Tap “New sale” to begin.</div>'}</div>
      </div>`;
    host.querySelector('#newRetailSale').onclick = () => newOrder(host, null);
    host.querySelectorAll('[data-oid]').forEach((b) => b.onclick = () => openEditor(host, Number(b.dataset.oid)));
  }

  function tapTable(host, tid) {
    const o = tableStatus(tid);
    if (o) return openEditor(host, o.id);
    const t = State.tables.find((x) => x.id === tid);
    modal({
      title: `Seat guests — Table ${t.name}`,
      body: `<div class="grid2">
        <div><label class="fld">Number of guests</label>
          <input class="inp" id="people" type="number" min="1" value="${t.seats}"></div>
        <div><label class="fld">Table</label>
          <input class="inp" value="${esc(t.name)} · ${esc(t.area)} · ${t.seats} seats" disabled></div>
      </div>
      <div style="margin-top:12px"><label class="fld">Note (optional)</label>
        <input class="inp" id="note" placeholder="e.g. birthday, window seat"></div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Open table</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    setTimeout(() => ov.querySelector('#people').select(), 30);
    const go = async () => {
      try {
        const created = await api('/api/orders', { body: {
          table_id: tid, people: Number(ov.querySelector('#people').value) || 1, notes: ov.querySelector('#note').value } });
        closeModal(); openEditor(host, created.id);
      } catch (e) { toast(e.message, 'err'); }
    };
    ov.querySelector('[data-yes]').onclick = go;
    ov.querySelector('#people').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  async function newOrder(host, tableId) {
    try {
      const o = await api('/api/orders', { body: { table_id: tableId, people: 1 } });
      openEditor(host, o.id);
    } catch (e) { toast(e.message, 'err'); }
  }

  /* -------------------------- ORDER EDITOR --------------------------- */
  let search = '', searchTimer = null, measureMode = false;
  async function openEditor(host, orderId) {
    State.openOrderId = orderId;
    /* A freshly created order is not in State.orders yet — pull it before rendering,
       otherwise activeOrder() misses and the floor silently repaints instead. */
    if (!State.orders.some((o) => o.id === orderId)) {
      try { await refresh(); }
      catch (e) { State.openOrderId = null; return toast(e.message, 'err'); }
    }
    if (!State.category) {
      const firstCat = State.categories.find((c) => State.menu.some((m) => m.category_id === c.id));
      State.category = firstCat ? firstCat.id : null;
    }
    renderEditor(host);
  }

  function closeEditor(host) {
    State.openOrderId = null;
    renderFloor(host);
  }

  function renderEditor(host) {
    const o = activeOrder();
    if (!o) return renderFloor(host);
    const t = orderTable(o);
    const retail = State.settings.business_type === 'wines_spirits';
    const cat = State.categories.find((c) => c.id === State.category);
    const items = cat
      ? State.menu.filter((m) => m.category_id === cat.id)
      : State.menu;
    const filtered = search
      ? State.menu.filter((m) => [m.name, m.sku, m.barcode].some((v) => String(v || '').toLowerCase().includes(search.toLowerCase())))
      : items;

    host.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <button class="btn ghost" id="back">← ${retail ? 'Sales' : 'Floor'}</button>
        <h3 style="margin:0;font-size:16px">${t ? esc(t.name) + ' <span class="muted small">' + esc(t.area) + '</span>' : (retail ? 'Sale #' : 'Takeaway #') + o.number}</h3>
        <span class="tag ${o.status === 'billed' ? 'info' : 'warn'}">${o.status}</span>
        <span class="muted small">#${o.number}${retail ? '' : ' · ' + o.people + ' guests'} · ${esc(waiterName(o.waiter_id))} · open ${ago(o.opened_at)}</span>
        <span class="grow"></span>
        ${retail ? '' : `<button class="btn sm" id="transfer">Move table</button>
        <button class="btn sm" id="peopleBtn">Guests: ${o.people}</button>`}
        ${retail && ['manager', 'admin'].includes(State.user.role) ? '<button class="btn sm ghost" id="complimentaryBtn">🎁 Complimentary</button>' : ''}
        ${retail && !['manager', 'admin'].includes(State.user.role) ? '' : `<button class="btn sm" id="discBtn">Discount</button>
        <button class="btn sm red" id="voidBtn">Void order</button>`}
      </div>
      <div class="pos">
        <div class="menu-panel">
          <div class="search"><div class="row"><input class="inp" id="search" placeholder="Search products…  ( / )" value="${esc(search)}">
            ${retail ? `<label class="btn ${measureMode ? 'primary' : 'ghost'}" style="cursor:pointer"><input type="checkbox" id="measureMode" ${measureMode ? 'checked' : ''}> Sell measured amount</label>` : ''}
          </div>${retail && measureMode ? '<div class="tiny" style="color:var(--amber);margin-top:6px">Tap a bottle to choose Full, Half, Quarter, Shot or custom ml.</div>' : ''}</div>
          <div class="cats">
            ${State.categories.map((c) => `
              <button class="cat${c.id === State.category && !search ? ' active' : ''}" data-cat="${c.id}">
                ${esc(c.name)}${!retail && c.station === 'bar' ? ' 🍸' : ''}</button>`).join('')}
          </div>
          <div class="items">
            ${filtered.length ? filtered.map((m) => {
              const live = priceOf(m), rule = ruleFor(m), off = live !== m.price;
              return `<button class="item${m.available ? '' : ' out'}" data-mid="${m.id}" ${m.available ? '' : `title="${retail ? 'Out of stock / unavailable' : '86 — unavailable'}"`}>
                <span class="n">${esc(m.name)}${groupsFor(m.id).length ? ' <span class="tiny" style="color:var(--teal)">▸</span>' : ''}</span>
                ${retail && (m.sku || m.barcode) ? `<span class="tiny muted mono">${esc(m.sku || m.barcode)}</span>` : ''}
                ${retail && m.stock_qty != null ? `<span class="tiny" style="color:${m.stock_qty <= 0 ? 'var(--red)' : m.stock_qty <= m.stock_min_qty ? 'var(--amber)' : 'var(--dim)'}">${m.stock_mode === 'pour' && m.stock_deduction ? `Available ${Math.floor(m.stock_qty / m.stock_deduction)} serving(s)` : `Stock ${m.stock_qty}`}</span>` : ''}
                ${off ? `<span class="tiny" style="color:var(--dim2);text-decoration:line-through">${fmt(m.price)}</span>` : ''}
                <span class="p" style="${off ? 'color:var(--green)' : ''}">${m.available ? fmt(live) : (retail ? 'Unavailable' : '86')}</span>
                ${rule ? `<span class="tiny" style="color:var(--green)">${esc(rule)}</span>` : ''}
              </button>`;
            }).join('') : '<div class="empty">No items match.</div>'}
          </div>
        </div>
        <div class="bill-panel">
          <div class="bill-head">
            <div class="row" style="justify-content:space-between">
              <div><b>${retail ? 'Current sale' : 'Current order'}</b><div class="tiny muted">${retail ? `${o.items.reduce((n, i) => n + i.qty, 0)} unit(s)` : `${o.items.length} line(s) · ${o.items.filter(i=>i.status==='pending').length} unsent`}</div></div>
              <button class="btn sm" id="printBill">🖨 ${retail ? 'Sale slip' : 'Pre-bill'}</button>
            </div>
          </div>
          <div class="bill-lines">
            ${o.items.length ? o.items.map((i) => `
              <div class="line">
                <span class="nm">${esc(i.name)}</span>
                <span class="amt">${fmt(i.price * i.qty)}</span>
                ${i.modifiers && i.modifiers.length ? `<span class="note">↳ ${i.modifiers.map((x) => esc(x.name)).join(', ')}</span>` : ''}
                ${i.note ? `<span class="note">↳ ${esc(i.note)}</span>` : ''}
                <span class="sub">
                  ${retail ? '' : `<span class="tag ${i.station}">${i.station}</span>
                  <span class="tag ${i.status === 'sent' ? 'info' : i.status === 'ready' ? 'ok' : 'warn'}">${i.status}</span>`}
                  <span class="grow" style="flex:1"></span>
                  <span class="qty">
                    <button data-dec="${i.id}">−</button><span>${i.qty}</span><button data-inc="${i.id}">+</button>
                  </span>
                  <button class="btn xs ghost" data-note="${i.id}">note</button>
                  <button class="btn xs red" data-rm="${i.id}">×</button>
                </span>
              </div>`).join('')
              : '<div class="empty">No items yet.<br><span class="tiny">Tap items on the left to add them.</span></div>'}
          </div>
          <div class="bill-foot">
            ${totalRows(o)}
            <div class="row" style="margin-top:11px">
              ${retail ? '' : `<button class="btn green" id="send" style="flex:1;justify-content:center" ${o.items.some(i=>i.status==='pending') ? '' : 'disabled'}>
                🔥 Send to kitchen / bar${o.items.some(i=>i.status==='pending') ? ' (' + o.items.filter(i=>i.status==='pending').length + ')' : ''}
              </button>`}
              <button class="btn primary" id="toBill" style="flex:1;justify-content:center">💳 Take payment</button>
            </div>
          </div>
        </div>
      </div>`;

    /* wire up */
    host.querySelector('#back').onclick = () => closeEditor(host);
    const searchInput = host.querySelector('#search');
    searchInput.oninput = (e) => {
      search = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderEditor(host), 100);
    };
    const measureToggle = host.querySelector('#measureMode');
    if (measureToggle) measureToggle.onchange = (e) => { measureMode = e.target.checked; renderEditor(host); };
    searchInput.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      clearTimeout(searchTimer);
      const code = searchInput.value.trim().toLowerCase();
      const exact = State.menu.find((m) => [m.barcode, m.sku].some((v) => String(v || '').toLowerCase() === code));
      if (exact) { e.preventDefault(); search = ''; addItem(host, exact.id); }
      else renderEditor(host);
    };
    if (search) setTimeout(() => { const i = host.querySelector('#search'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0);
    host.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () => {
      State.category = Number(b.dataset.cat); search = ''; renderEditor(host);
    });
    host.querySelectorAll('[data-mid]').forEach((b) => b.onclick = () => addItem(host, Number(b.dataset.mid)));
    host.querySelectorAll('[data-inc]').forEach((b) => b.onclick = () => bump(host, Number(b.dataset.inc), 1));
    host.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => bump(host, Number(b.dataset.dec), -1));
    host.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => removeLine(host, Number(b.dataset.rm)));
    host.querySelectorAll('[data-note]').forEach((b) => b.onclick = () => noteLine(host, Number(b.dataset.note)));
    const sendBtn = host.querySelector('#send');
    if (sendBtn) sendBtn.onclick = async () => {
      try {
        await api(`/api/orders/${o.id}/send`, { method: 'POST' });
        await refresh();
        toast('Sent to kitchen & bar', 'ok');
        autoPrintDocket(o.id);
        renderEditor(host);
      } catch (e) { toast(e.message, 'err'); }
    };
    host.querySelector('#printBill').onclick = () => printReceipt(o.id, { paid: false });
    host.querySelector('#toBill').onclick = () => Cashier.payModal(o.id, () => {
      if (retail && State.user.role === 'seller') navigate('tables');
      else closeEditor(host);
    });
    const complimentaryBtn = host.querySelector('#complimentaryBtn');
    if (complimentaryBtn) complimentaryBtn.onclick = () => complimentaryModal(host);
    const transferBtn = host.querySelector('#transfer');
    if (transferBtn) transferBtn.onclick = () => transferModal(o, host);
    const voidBtn = host.querySelector('#voidBtn');
    if (voidBtn) voidBtn.onclick = () => requireManagerPin('Voiding a whole order needs manager authorisation.', async () => {
      confirmBox(`Void ${retail ? 'sale' : 'order'} #${o.number}`, retail ? 'All products will be removed and the sale cancelled. This cannot be undone.' : 'All items will be voided and the table freed. This cannot be undone.', {
        danger: true, okLabel: `Void ${retail ? 'sale' : 'order'}`, fields: [{ name: 'reason', label: 'Reason', placeholder: retail ? 'Duplicate / wrong sale' : 'Guest walked out / wrong order' }],
        onOk: async (v) => {
          try { await api(`/api/orders/${o.id}/void`, { body: { reason: v.reason } }); await refresh(); toast('Order voided', 'ok'); closeEditor(host); }
          catch (e) { toast(e.message, 'err'); }
        }
      });
    });
    const discountBtn = host.querySelector('#discBtn');
    if (discountBtn) discountBtn.onclick = () => requireManagerPin('Discounts need manager authorisation.', () => discountModal(o, host));
    const peopleBtn = host.querySelector('#peopleBtn');
    if (peopleBtn) peopleBtn.onclick = async () => {
      const n = prompt('Number of guests at this table', o.people);
      if (!n || !(Number(n) > 0)) return;
      try {
        await api(`/api/orders/${o.id}/people`, { method: 'PATCH', body: { people: Number(n) } });
        await refresh(); renderEditor(host);
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function totalRows(o) {
    const t = o.totals;
    return `
      <div class="tline"><span>Subtotal</span><b>${fmt(t.subtotal)}</b></div>
      ${t.discount ? `<div class="tline"><span>Discount</span><b style="color:var(--red)">−${fmt(t.discount)}</b></div>` : ''}
      ${t.service ? `<div class="tline"><span>Service charge ${State.settings.service_charge_rate}%</span><b>${fmt(t.service)}</b></div>` : ''}
      <div class="tline"><span>VAT ${State.settings.vat_rate}% ${State.settings.tax_mode === 'inclusive' ? '(incl.)' : ''}</span><b>${fmt(t.vat)}</b></div>
      <div class="tline total"><span>Total</span><b>${fmt(t.total)}</b></div>`;
  }

  /* --------------------------- line actions --------------------------- */
  async function addItem(host, mid) {
    const o = activeOrder();
    const m = State.menu.find((x) => x.id === mid);
    if (!m) return;
    if (!m.available) return toast(m.name + (State.settings.business_type === 'wines_spirits' ? ' is unavailable' : ' is marked 86 (unavailable)'), 'err');
    if (measureMode && State.settings.business_type === 'wines_spirits' && m.stock_mode !== 'pour') {
      if (!(Number(m.volume_ml) > 0)) return toast('Set this product’s size before selling a measured amount', 'err');
      return measurePicker(host, m);
    }
    const groups = groupsFor(mid);
    if (groups.length) return modifierPicker(host, m, groups);
    await pushLines(host, o.id, [{ menu_item_id: mid, qty: 1 }]);
  }

  function complimentaryModal(host) {
    const products = State.menu.filter((m) => m.stock_item_id);
    if (!products.length) return toast('No stock-linked products are available', 'err');
    modal({ title: 'Record complimentary stock', wide: true, body: `
      <p class="muted" style="margin-top:0">For owner consumption, staff, friends, tasting or promotion. No Cash/M-Pesa is expected; stock and inventory cost are still recorded.</p>
      <div class="grid2"><div><label class="fld">Product</label><select class="inp" id="compProduct">${products.map((m) =>
        `<option value="${m.id}">${esc(m.name)} · stock ${m.stock_qty ?? '—'}</option>`).join('')}</select></div>
        <div><label class="fld">Quantity</label><input class="inp" id="compQty" type="number" min="1" step="1" value="1"></div></div>
      <div class="card" style="margin-top:12px;background:#101820"><div class="card-b">
        <label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" id="compMeasured"> Give a measured amount instead of a full unit</label>
        <div class="grid2 hidden" id="compMeasureFields" style="margin-top:10px"><div><label class="fld">Amount</label><select class="inp" id="compMeasure"></select></div>
          <div><label class="fld">Custom ml</label><input class="inp" id="compCustomMl" type="number" min="0.01" step="0.01" placeholder="Optional"></div></div>
      </div></div>
      <div class="grid2" style="margin-top:12px"><div><label class="fld">Reason</label><select class="inp" id="compReason">
        <option>Owner consumption</option><option>Staff complimentary</option><option>Friends / guests</option><option>Promotion / tasting</option><option>Other</option></select></div>
        <div><label class="fld">Recipient / note</label><input class="inp" id="compRecipient" placeholder="Name or short explanation"></div></div>
      <div class="card" style="margin-top:12px"><div class="card-b"><div class="tline"><span>Retail value given</span><b id="compValue">—</b></div>
        <div class="tiny muted" id="compEffect" style="margin-top:6px"></div></div></div>`,
      footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Record complimentary</button>' });
    const ov = document.querySelector('#modalRoot .ov'), productSelect = ov.querySelector('#compProduct'),
      measured = ov.querySelector('#compMeasured'), measureSelect = ov.querySelector('#compMeasure'), custom = ov.querySelector('#compCustomMl');
    const selectedProduct = () => State.menu.find((m) => m.id === Number(productSelect.value));
    const rebuildMeasures = () => {
      const m = selectedProduct(), full = Number(m.volume_ml) || 0;
      measureSelect.innerHTML = full ? [['Full',full],['Half',full/2],['Quarter',full/4],['Shot (⅛)',full/8]].map(([l,v]) =>
        `<option value="${v}">${l} · ${Number(v.toFixed(2))} ml</option>`).join('') : '<option value="">Size not configured</option>';
      update();
    };
    const chosenMl = () => measured.checked ? (Number(custom.value) || Number(measureSelect.value)) : 0;
    const update = () => {
      const m = selectedProduct(), qty = Math.max(1, Number(ov.querySelector('#compQty').value) || 1), ml = chosenMl();
      const factor = ml && m.volume_ml ? ml / m.volume_ml : 1;
      const stockFactor = ml && m.stock_mode === 'weighed' ? ml / 1000 : factor;
      const deduction = (m.stock_deduction || 1) * stockFactor * qty;
      ov.querySelector('#compValue').textContent = fmt(Math.round(m.price * factor * qty));
      ov.querySelector('#compEffect').textContent = m.stock_mode === 'weighed' || m.stock_deduction_mode === 'count'
        ? `Theoretical usage ${Number(deduction.toFixed(4))} kg; actual keg reduction is captured at end-shift stocktake.`
        : `Stock deduction: ${Number(deduction.toFixed(4))} ${m.stock_unit || 'unit'}`;
    };
    productSelect.onchange = rebuildMeasures;
    measured.onchange = () => { ov.querySelector('#compMeasureFields').classList.toggle('hidden', !measured.checked); update(); };
    measureSelect.onchange = () => { custom.value = ''; update(); }; custom.oninput = update; ov.querySelector('#compQty').oninput = update;
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const product = selectedProduct(), ml = chosenMl();
      if (measured.checked && (!(ml > 0) || ml > product.volume_ml)) return toast('Enter a valid measured amount', 'err');
      try {
        const result = await api('/api/complimentaries', { body: { menu_item_id: product.id,
          qty: Number(ov.querySelector('#compQty').value), measure_ml: ml || null,
          reason: ov.querySelector('#compReason').value, recipient: ov.querySelector('#compRecipient').value.trim() } });
        closeModal(); await loadBootstrap(); State.openOrderId = activeOrder() ? activeOrder().id : State.openOrderId;
        renderEditor(host); toast(`Complimentary recorded · ${fmt(result.retail_value)} retail value · no cash due`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    rebuildMeasures();
  }

  function measurePicker(host, product) {
    const full = Number(product.volume_ml), presets = [
      ['Full', full], ['Half', full / 2], ['Quarter', full / 4], ['Shot (⅛)', full / 8]
    ];
    let selected = full;
    modal({ title: 'Measured sale — ' + product.name, body: `
      <div class="grid2" id="measureChoices">${presets.map(([label, ml]) => `<button class="btn ${ml === full ? 'primary' : 'ghost'}" data-ml="${ml}">
        <span>${label}</span><b class="grow right">${Number(ml.toFixed(2))} ml</b></button>`).join('')}</div>
      <div style="margin-top:14px"><label class="fld">Or custom amount (ml)</label><input class="inp mono" id="customMl" type="number" min="0.01" max="${full}" step="0.01" placeholder="e.g. 30 or 125"></div>
      <div class="card" style="background:#101820;margin-top:14px"><div class="card-b">
        <div class="tline"><span>Amount</span><b id="measureAmount">${full} ml</b></div>
        <div class="tline total"><span>Price</span><b id="measurePrice">${fmt(priceOf(product))}</b></div>
        <div class="tiny muted" id="measureStock" style="margin-top:6px">Uses one full product from stock</div>
      </div></div>`,
      footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Add measured sale</button>' });
    const ov = document.querySelector('#modalRoot .ov'), custom = ov.querySelector('#customMl');
    const draw = () => {
      ov.querySelector('#measureAmount').textContent = Number(selected.toFixed(2)) + ' ml';
      ov.querySelector('#measurePrice').textContent = fmt(Math.round(priceOf(product) * selected / full));
      ov.querySelector('#measureStock').textContent = product.stock_mode === 'weighed'
        ? `Records ${Number((selected / 1000).toFixed(4))} kg theoretical use; actual keg weight is entered at stocktake`
        : `Deducts ${Number((selected / full).toFixed(4))} of ${product.name}`;
      ov.querySelectorAll('[data-ml]').forEach((b) => b.classList.toggle('primary', Number(b.dataset.ml) === selected));
    };
    ov.querySelectorAll('[data-ml]').forEach((b) => b.onclick = () => { selected = Number(b.dataset.ml); custom.value = ''; draw(); });
    custom.oninput = () => { const value = Number(custom.value); if (value > 0 && value <= full) { selected = value; draw(); } };
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      if (!(selected > 0) || selected > full) return toast(`Enter an amount from 0.01 to ${full} ml`, 'err');
      closeModal();
      await pushLines(host, activeOrder().id, [{ menu_item_id: product.id, qty: 1,
        ...(selected === full ? {} : { measure_ml: selected }) }]);
    };
    draw();
  }

  async function pushLines(host, orderId, lines) {
    try {
      await api(`/api/orders/${orderId}/items`, { body: { items: lines } });
      await refresh();
      renderEditor(host);
    } catch (e) { toast(e.message, 'err'); }
  }

  /** Modal for choosing variants/options. Required groups must be satisfied
      before the line can be sent — the server enforces the same rule. */
  function modifierPicker(host, m, groups) {
    const picked = new Set();
    const draw = (ov) => {
      ov.querySelector('#modBody').innerHTML = groups.map((g) => `
        <div style="margin-bottom:14px">
          <label class="fld">${esc(g.name)}
            ${g.required ? '<span style="color:var(--red)">*</span>' : '<span class="tiny muted">(optional)</span>'}
            ${g.max_pick > 1 ? `<span class="tiny muted">up to ${g.max_pick}</span>` : ''}</label>
          <div class="row">
            ${g.options.map((o) => `<button class="btn sm ${picked.has(o.id) ? 'primary' : 'ghost'}" data-opt="${o.id}" data-g="${g.id}"
              data-max="${g.max_pick}">${esc(o.name)}${o.price ? ' +' + fmt(o.price) : ''}</button>`).join('')
              || '<span class="tiny muted">No options defined</span>'}
          </div>
        </div>`).join('');
      let extra = 0;
      for (const id of picked) {
        const o = State.modifierOptions.find((x) => x.id === id);
        if (o) extra += o.price;
      }
      ov.querySelector('#modTotal').innerHTML =
        `<div class="tline"><span>${esc(m.name)}</span><b>${fmt(priceOf(m))}</b></div>
         ${extra ? `<div class="tline"><span>Options</span><b>+${fmt(extra)}</b></div>` : ''}
         <div class="tline total"><span>Line total</span><b>${fmt(priceOf(m) + extra)}</b></div>`;
      ov.querySelectorAll('[data-opt]').forEach((b) => b.onclick = () => {
        const id = Number(b.dataset.opt), gid = Number(b.dataset.g), max = Number(b.dataset.max);
        if (picked.has(id)) return picked.delete(id);
        if (max <= 1) for (const x of [...picked]) {
          const o = State.modifierOptions.find((y) => y.id === x);
          if (o && o.group_id === gid) picked.delete(x);
        }
        else if ([...picked].filter((x) => (State.modifierOptions.find((y) => y.id === x) || {}).group_id === gid).length >= max)
          return toast(`Maximum ${max} from ${groups.find((g) => g.id === gid).name}`, 'err');
        picked.add(id);
        draw(ov);
      });
    };

    modal({
      title: m.name,
      body: `<div id="modBody"></div>
        <div class="card" style="background:#101820;margin-top:6px"><div class="card-b" id="modTotal"></div></div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Add to order</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    draw(ov);
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      for (const g of groups) {
        if (!g.required) continue;
        if (![...picked].some((id) => (State.modifierOptions.find((x) => x.id === id) || {}).group_id === g.id))
          return toast(`Please choose: ${g.name}`, 'err');
      }
      closeModal();
      await pushLines(host, activeOrder().id, [{ menu_item_id: m.id, qty: 1, modifiers: [...picked].map((id) => ({ id })) }]);
    };
  }

  async function bump(host, lineId, dir) {
    const o = activeOrder();
    const line = o.items.find((i) => i.id === lineId);
    if (!line) return;
    try {
      const nextQty = Number(line.qty) + dir;
      if (nextQty <= 0) await api(`/api/orders/${o.id}/items/${lineId}`, { method: 'DELETE' });
      else await api(`/api/orders/${o.id}/items/${lineId}/quantity`, { method: 'PATCH', body: { qty: nextQty } });
      await refresh(); renderEditor(host);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function removeLine(host, lineId) {
    const o = activeOrder();
    const line = o.items.find((i) => i.id === lineId);
    if (!line) return;
    if (line.status === 'pending') {
      await api(`/api/orders/${o.id}/items/${lineId}`, { method: 'DELETE' });
      await refresh(); renderEditor(host);
      return;
    }
    requireManagerPin(`"${line.name}" has already been sent to the ${line.station}. Removing it needs a manager.`, () => {
      confirmBox('Remove sent item', `Void "${line.name}" from order #${o.number}?`, {
        danger: true, okLabel: 'Void item', fields: [{ name: 'reason', label: 'Reason', placeholder: 'Guest changed mind / wrong item' }],
        onOk: async (v) => {
          try {
            await api(`/api/orders/${o.id}/items/${lineId}`, { method: 'PATCH', body: { status: 'void', reason: v.reason } });
            await refresh(); renderEditor(host); toast('Item voided', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        }
      });
    });
  }

  function noteLine(host, lineId) {
    const o = activeOrder();
    const line = o.items.find((i) => i.id === lineId);
    const retail = State.settings.business_type === 'wines_spirits';
    modal({
      title: 'Note — ' + line.name,
      body: `<label class="fld">${retail ? 'Sale note' : 'Preparation note'}</label>
        <input class="inp" id="nt" value="${esc(line.note || '')}" placeholder="${retail ? 'e.g. gift, chilled, customer request' : 'e.g. no onions, well done, extra ice'}">
        <div class="row" style="margin-top:10px">
          ${(retail ? ['Chilled', 'Gift purchase', 'Customer request'] : ['No onions', 'Well done', 'Extra spicy', 'No ice', 'Gluten free', 'Less sugar'])
            .map((s) => `<button class="btn xs ghost" data-q="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save note</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    const inp = ov.querySelector('#nt');
    ov.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => { inp.value = inp.value ? inp.value + ', ' + b.dataset.q : b.dataset.q; });
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const note = inp.value;
      closeModal();
      try {
        // replace the line with same qty + note
        if (line.status === 'pending') {
          await api(`/api/orders/${o.id}/items/${line.id}`, { method: 'DELETE' });
          await api(`/api/orders/${o.id}/items`, { body: { items: [{ menu_item_id: line.menu_item_id, qty: line.qty, note }] } });
        } else toast('Sent items keep their original note — add a new line instead.', 'err');
        await refresh(); renderEditor(host);
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function transferModal(o, host) {
    const free = State.tables.filter((t) => !tableStatus(t.id));
    modal({
      title: 'Move order #' + o.number,
      body: `<label class="fld">Move to a free table</label>
        <div class="table-grid" style="grid-template-columns:repeat(auto-fill,minmax(88px,1fr))">
          ${free.length ? free.map((t) => `<button class="tbl-card free" data-t="${t.id}" style="aspect-ratio:auto;padding:12px">
            <span class="nm" style="font-size:14px">${esc(t.name)}</span><span class="st">${esc(t.area)}</span></button>`).join('')
            : '<div class="empty">No free tables right now.</div>'}
        </div>`,
      footer: `<button class="btn" data-no>Cancel</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelectorAll('[data-t]').forEach((b) => b.onclick = async () => {
      try {
        await api(`/api/orders/${o.id}/transfer`, { body: { table_id: Number(b.dataset.t) } });
        closeModal(); await refresh(); toast('Order moved', 'ok'); renderEditor(host);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  function discountModal(o, host) {
    modal({
      title: 'Discount — order #' + o.number,
      body: `<div class="grid2">
          <div><label class="fld">Amount (${sym()})</label><input class="inp" id="damt" type="number" min="0" step="0.01" value="${(o.discount/100).toFixed(2)}"></div>
          <div><label class="fld">Or percent of subtotal</label><input class="inp" id="dpct" type="number" min="0" max="100" placeholder="e.g. 10"></div>
        </div>
        <div style="margin-top:12px"><label class="fld">Reason (appears in audit log)</label>
          <input class="inp" id="drsn" placeholder="e.g. loyal customer, cold food, promo"></div>
        <p class="tiny muted" style="margin:12px 0 0">Subtotal is ${fmt(o.totals.subtotal)}. Discounts apply before service charge and VAT.</p>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Apply discount</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const pct = Number(ov.querySelector('#dpct').value);
      let amt = Number(ov.querySelector('#damt').value) || 0;
      if (pct) amt = Math.round(o.totals.subtotal * pct) / 100;
      try {
        await api(`/api/orders/${o.id}/discount`, { body: { amount: amt, reason: ov.querySelector('#drsn').value } });
        closeModal(); await refresh(); renderEditor(host); toast('Discount applied', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function scanItem(code) {
    const normalized = String(code || '').trim().toLowerCase();
    const product = State.menu.find((m) => [m.barcode, m.sku].some((v) => String(v || '').trim().toLowerCase() === normalized));
    if (!product) return toast(`Barcode not found: ${code}`, 'err');
    if (!product.available) return toast(product.name + ' is unavailable', 'err');
    if (State.settings.business_type === 'wines_spirits' && State.shift?.status !== 'open' && State.user.role === 'seller')
      return toast('Open the till before scanning products', 'err');
    const host = document.getElementById('view');
    if (State.view !== 'tables') await navigate('tables');
    await refresh();
    let sale = activeOrder();
    if (!sale || !['open', 'billed'].includes(sale.status))
      sale = State.orders.find((o) => o.waiter_id === State.user.id && o.status === 'open' && !o.table_id);
    if (!sale) {
      sale = await api('/api/orders', { body: { people: 1 } });
      await refresh();
    }
    search = '';
    await openEditor(host, sale.id);
    await addItem(host, product.id);
    toast(`Scanned: ${product.name}`, 'ok');
  }

  async function refresh() {
    State.orders = await api('/api/orders');
  }

  /** Fire the docket the moment an order is sent.
      With a network printer configured it prints kitchen/bar dockets server-side;
      otherwise it falls back to the browser print dialog (combined docket). */
  async function autoPrintDocket(orderId) {
    const s = State.settings;
    if (s.auto_print_docket === '0') return;
    const o = State.orders.find((x) => x.id === orderId);
    if (!o) return;
    const has = (st) => o.items.some((i) => i.station === st && ['sent', 'ready'].includes(i.status));
    if (!has('kitchen') && !has('bar')) return;
    if (s.printer_enabled === '1' && (s.printer_host || s.kitchen_printer_host)) {
      if (has('kitchen')) api(`/api/print/kitchen/${orderId}`, { method: 'POST', body: { station: 'kitchen' } }).catch(() => {});
      if (has('bar')) api(`/api/print/kitchen/${orderId}`, { method: 'POST', body: { station: 'bar' } }).catch(() => {});
    } else {
      printDocket(orderId);
    }
  }

  return { renderFloor, openEditor, closeEditor, renderEditor, scanItem, refresh, totalRows };
})();

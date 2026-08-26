/* retail.js — supplier deliveries and full stocktakes for bottle shops */
'use strict';

const Retail = (() => {
  const canManage = () => ['manager', 'admin'].includes(State.user.role);

  async function suppliers(body) {
    const rows = await api('/api/suppliers');
    body.innerHTML = `<div class="row" style="margin-bottom:14px">
      <div><h3 style="margin:0">Suppliers</h3><div class="tiny muted">Distributor contacts and KRA details</div></div>
      <span class="grow"></span>${canManage() ? '<button class="btn primary" id="newSupplier">+ Supplier</button>' : ''}</div>
      <div class="card"><div class="scroll-x"><table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>KRA PIN</th><th>Address</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.phone || '—')}</td><td>${esc(s.email || '—')}</td>
        <td class="mono">${esc(s.kra_pin || '—')}</td><td class="muted small">${esc(s.address || '—')}</td>
        <td class="right">${canManage() ? `<button class="btn xs ghost" data-supplier="${s.id}">Edit</button>` : ''}</td></tr>`).join('') ||
        '<tr><td colspan="6" class="empty">No suppliers yet.</td></tr>'}</tbody></table></div></div>`;
    body.querySelector('#newSupplier')?.addEventListener('click', () => supplierForm(null, body));
    body.querySelectorAll('[data-supplier]').forEach((b) => b.onclick = () => supplierForm(rows.find((s) => s.id === Number(b.dataset.supplier)), body));
  }

  function supplierForm(s, body) {
    s = s || {};
    modal({ title: s.id ? 'Edit supplier' : 'New supplier', body: `
      <label class="fld">Supplier / distributor name</label><input class="inp" id="spName" value="${esc(s.name || '')}">
      <div class="grid2" style="margin-top:12px">
        <div><label class="fld">Phone</label><input class="inp" id="spPhone" value="${esc(s.phone || '')}"></div>
        <div><label class="fld">Email</label><input class="inp" id="spEmail" value="${esc(s.email || '')}"></div>
        <div><label class="fld">KRA PIN</label><input class="inp mono" id="spKra" value="${esc(s.kra_pin || '')}"></div>
        <div><label class="fld">Address</label><input class="inp" id="spAddress" value="${esc(s.address || '')}"></div>
      </div>`, footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save supplier</button>' });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const payload = { name: ov.querySelector('#spName').value.trim(), phone: ov.querySelector('#spPhone').value.trim(),
        email: ov.querySelector('#spEmail').value.trim(), kra_pin: ov.querySelector('#spKra').value.trim(), address: ov.querySelector('#spAddress').value.trim() };
      if (!payload.name) return toast('Supplier name required', 'err');
      try {
        await api(s.id ? '/api/suppliers/' + s.id : '/api/suppliers', { method: s.id ? 'PUT' : 'POST', body: payload });
        closeModal(); suppliers(body); toast('Supplier saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function deliveries(body) {
    const rows = await api('/api/goods-receipts');
    body.innerHTML = `<div class="row" style="margin-bottom:14px"><div><h3 style="margin:0">Stock deliveries</h3>
      <div class="tiny muted">Receive supplier invoices; quantities and latest costs update automatically</div></div>
      <span class="grow"></span><button class="btn primary" id="receiveDelivery">+ Receive delivery</button></div>
      <div class="card"><div class="scroll-x"><table class="tbl"><thead><tr><th>Received</th><th>Invoice / note</th><th>Supplier</th><th class="right">Lines</th><th class="right">Cost</th><th>Received by</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="nowrap muted">${esc(r.received_at)}</td><td class="mono"><b>${esc(r.invoice_no)}</b></td>
        <td>${esc(r.supplier_name || 'Cash supplier')}</td><td class="right">${r.lines}</td><td class="right mono">${fmt(r.total_cost)}</td><td>${esc(r.received_by_name || '—')}</td></tr>`).join('') ||
        '<tr><td colspan="6" class="empty">No deliveries received yet.</td></tr>'}</tbody></table></div></div>`;
    body.querySelector('#receiveDelivery').onclick = () => deliveryForm(body);
  }

  async function deliveryForm(body) {
    const [suppliers, stock] = await Promise.all([api('/api/suppliers'), api('/api/stock')]);
    const optionHtml = stock.map((x) => `<option value="${x.id}">${esc(x.name)} · ${x.qty} ${esc(x.unit)}</option>`).join('');
    modal({ title: 'Receive supplier delivery', wide: true, body: `
      <div class="grid2"><div><label class="fld">Supplier</label><select class="inp" id="grSupplier"><option value="">Cash / not listed</option>
        ${suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div><label class="fld">Invoice / delivery note no.</label><input class="inp mono" id="grInvoice" placeholder="Required"></div></div>
      <div class="row" style="margin:16px 0 8px"><b>Delivered products</b><span class="grow"></span><button class="btn sm" id="addDeliveryLine">+ Line</button></div>
      <div id="deliveryLines"></div>
      <div style="margin-top:12px"><label class="fld">Notes</label><input class="inp" id="grNotes" placeholder="Driver, payment terms, damaged cartons…"></div>`,
      footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Receive into stock</button>' });
    const ov = document.querySelector('#modalRoot .ov'), lines = ov.querySelector('#deliveryLines');
    const addLine = () => {
      const row = document.createElement('div'); row.className = 'grid';
      row.style.cssText = 'grid-template-columns:2fr .65fr .8fr .8fr .8fr auto;gap:8px;margin-bottom:8px;align-items:end';
      row.innerHTML = `<div><label class="fld">Product</label><select class="inp" data-stock>${optionHtml}</select></div>
        <div><label class="fld">Qty</label><input class="inp" data-qty type="number" min="0.01" step="0.01"></div>
        <div><label class="fld">Unit cost</label><input class="inp" data-cost type="number" min="0" step="0.01"></div>
        <div><label class="fld">Batch</label><input class="inp" data-batch></div>
        <div><label class="fld">Expiry</label><input class="inp" data-expiry type="date"></div><button class="btn red" data-remove>×</button>`;
      row.querySelector('[data-remove]').onclick = () => row.remove(); lines.appendChild(row);
    };
    addLine(); ov.querySelector('#addDeliveryLine').onclick = addLine; ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const items = [...lines.children].map((r) => ({ stock_item_id: Number(r.querySelector('[data-stock]').value),
        qty: Number(r.querySelector('[data-qty]').value), unit_cost: Number(r.querySelector('[data-cost]').value),
        batch_no: r.querySelector('[data-batch]').value.trim(), expiry_date: r.querySelector('[data-expiry]').value || null }));
      try {
        await api('/api/goods-receipts', { body: { supplier_id: Number(ov.querySelector('#grSupplier').value) || null,
          invoice_no: ov.querySelector('#grInvoice').value.trim(), notes: ov.querySelector('#grNotes').value.trim(), items } });
        closeModal(); await loadBootstrap(); deliveries(body); toast('Delivery received and stock updated', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function stocktakes(body) {
    const rows = await api('/api/stock-counts'), open = rows.find((r) => r.status === 'open');
    body.innerHTML = `<div class="row" style="margin-bottom:14px"><div><h3 style="margin:0">Full stocktakes</h3>
      <div class="tiny muted">Freeze an expected snapshot, count every product, then post all variances together</div></div><span class="grow"></span>
      ${open ? `<button class="btn primary" id="continueCount">Continue ${esc(open.reference)}</button>` : '<button class="btn primary" id="startCount">+ Start stocktake</button>'}</div>
      <div class="card"><div class="scroll-x"><table class="tbl"><thead><tr><th>Reference</th><th>Status</th><th>Started</th><th>Completed</th><th class="right">Products</th><th class="right">Variances</th><th>By</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><b>${esc(r.reference)}</b></td><td><span class="tag ${r.status === 'open' ? 'warn' : 'ok'}">${r.status}</span></td>
        <td class="muted nowrap">${esc(r.started_at)}</td><td class="muted nowrap">${esc(r.completed_at || '—')}</td><td class="right">${r.lines}</td>
        <td class="right">${r.variances || 0}</td><td>${esc(r.completed_by_name || r.started_by_name || '—')}</td></tr>`).join('') ||
        '<tr><td colspan="7" class="empty">No stocktakes yet.</td></tr>'}</tbody></table></div></div>`;
    body.querySelector('#continueCount')?.addEventListener('click', () => countForm(open.id, body));
    body.querySelector('#startCount')?.addEventListener('click', () => startCount(body));
  }

  function startCount(body) {
    modal({ title: 'Start full stocktake', body: `<label class="fld">Reference</label><input class="inp mono" id="countRef" value="COUNT-${today()}">
      <div style="margin-top:12px"><label class="fld">Notes</label><input class="inp" id="countNotes" placeholder="End of month / shift handover…"></div>
      <p class="tiny muted" style="margin-top:12px">The current expected quantity of every product will be saved. Only one stocktake can be open.</p>`,
      footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Start counting</button>' });
    const ov = document.querySelector('#modalRoot .ov'); ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      try { const r = await api('/api/stock-counts', { body: { reference: ov.querySelector('#countRef').value, notes: ov.querySelector('#countNotes').value } });
        closeModal(); countForm(r.id, body); } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function countForm(id, body) {
    const count = await api('/api/stock-counts/' + id);
    modal({ title: 'Stocktake — ' + count.reference, wide: true, body: `<p class="tiny muted">Enter the physical quantity for every product. Expected quantities remain visible for checking.</p>
      <input class="inp" id="countSearch" placeholder="Filter products…" style="margin-bottom:10px">
      <div class="scroll-x" style="max-height:58vh"><table class="tbl"><thead><tr><th>Product</th><th>Unit</th><th class="right">Expected</th><th style="width:160px">Counted</th><th class="right">Variance</th></tr></thead>
      <tbody>${count.items.map((x) => `<tr data-count-row data-name="${esc(x.name.toLowerCase())}"><td><b>${esc(x.name)}</b></td><td>${esc(x.unit)}</td>
        <td class="right mono">${x.expected}</td><td><input class="inp mono" data-count="${x.stock_item_id}" data-expected="${x.expected}" type="number" min="0" step="0.01" value="${x.counted ?? ''}"></td>
        <td class="right mono" data-var>—</td></tr>`).join('')}</tbody></table></div>`, footer: '<button class="btn" data-no>Save for later</button><button class="btn primary" data-yes>Complete & post variances</button>' });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('#countSearch').oninput = (e) => ov.querySelectorAll('[data-count-row]').forEach((r) => { r.style.display = r.dataset.name.includes(e.target.value.toLowerCase()) ? '' : 'none'; });
    ov.querySelectorAll('[data-count]').forEach((i) => i.oninput = () => { const v = Number(i.value) - Number(i.dataset.expected); i.closest('tr').querySelector('[data-var]').textContent = Number.isFinite(v) ? (v > 0 ? '+' : '') + v : '—'; });
    ov.querySelector('[data-no]').onclick = async () => {
      const inputs = [...ov.querySelectorAll('[data-count]')];
      try {
        await api(`/api/stock-counts/${id}/save`, { body: { items: inputs.map((i) => ({ stock_item_id: Number(i.dataset.count), counted: i.value })) } });
        closeModal(); stocktakes(body); toast('Stocktake progress saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    ov.querySelector('[data-yes]').onclick = async () => {
      const inputs = [...ov.querySelectorAll('[data-count]')];
      if (inputs.some((i) => i.value === '')) return toast('Count every product before completing', 'err');
      try { const r = await api(`/api/stock-counts/${id}/complete`, { body: { items: inputs.map((i) => ({ stock_item_id: Number(i.dataset.count), counted: Number(i.value) })) } });
        closeModal(); await loadBootstrap(); stocktakes(body); toast(`Stocktake posted · ${r.variances} variance(s)`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  return { suppliers, deliveries, stocktakes };
})();

/* retail.js — supplier deliveries and configurable physical stock counts */
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
      <div class="tiny muted">Select delivered products and quantities. Costs come from owner-controlled Product Settings.</div></div>
      <span class="grow"></span><button class="btn primary" id="receiveDelivery">+ Receive delivery</button></div>
      <div class="card"><div class="scroll-x"><table class="tbl"><thead><tr><th>Received</th><th>Invoice / reference</th><th>Supplier</th><th>Payment</th><th class="right">Lines</th><th class="right">Cost</th><th>Received by</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="nowrap muted">${esc(r.received_at)}</td><td class="mono"><b>${esc(r.invoice_no)}</b></td>
        <td>${esc(r.supplier_name || 'Cash supplier')}</td><td><span class="tag ${r.payment_status === 'paid' ? 'ok' : 'warn'}">${r.payment_method === 'pay_later' ? 'PAY LATER' : String(r.payment_method).toUpperCase()}</span></td>
        <td class="right">${r.lines}</td><td class="right mono">${fmt(r.total_cost)}</td><td>${esc(r.received_by_name || '—')}</td>
        <td>${r.payment_status !== 'paid' ? `<button class="btn xs" data-pay-delivery="${r.id}" data-ref="${esc(r.invoice_no)}">Mark paid</button>` : ''}</td></tr>`).join('') ||
        '<tr><td colspan="8" class="empty">No deliveries received yet.</td></tr>'}</tbody></table></div></div>`;
    body.querySelector('#receiveDelivery').onclick = () => deliveryForm(body);
    body.querySelectorAll('[data-pay-delivery]').forEach((b) => b.onclick = () => payDelivery(Number(b.dataset.payDelivery), b.dataset.ref, body));
  }

  function payDelivery(id, reference, body) {
    modal({ title: 'Mark delivery paid — ' + reference, body: `<label class="fld">Payment method</label>
      <select class="inp" id="deliveryPayMethod"><option value="cash">Cash from till</option><option value="mpesa">M-Pesa from till</option><option value="other">Already paid / other method</option></select>
      <p class="tiny muted" style="margin-top:10px">Cash or M-Pesa reduces that expected till balance immediately.</p>`,
      footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Confirm paid</button>' });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      try {
        await api(`/api/goods-receipts/${id}/pay`, { body: { method: ov.querySelector('#deliveryPayMethod').value } });
        closeModal(); await loadBootstrap(); deliveries(body); toast('Delivery payment recorded', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function deliveryForm(body) {
    const [suppliers, stock, packages] = await Promise.all([api('/api/suppliers'), api('/api/stock'), api('/api/stock-packages')]);
    const optionHtml = stock.map((x) => `<option value="${x.id}">${esc(x.name)} · ${esc(stockQtyLabel(x.qty, x.unit, x.capacity_ml))}</option>`).join('');
    const packageOptions=(stockId)=>{
      const item=stock.find((x)=>x.id===Number(stockId));
      return `<option value="">Base unit (${esc((item||{}).unit||'unit')})</option>`+packages.filter((p)=>p.stock_item_id===Number(stockId))
        .map((p)=>`<option value="${p.id}">${esc(p.name)} = ${roundStock(p.units_per_package)} ${esc(p.base_unit)}</option>`).join('');
    };
    const deliveryKey=window.crypto&&window.crypto.randomUUID?window.crypto.randomUUID():`delivery-${Date.now()}-${Math.random()}`;
    modal({ title: 'Receive supplier delivery', wide: true, body: `
      <div class="grid3"><div><label class="fld">Supplier</label><select class="inp" id="grSupplier"><option value="">Not listed / walk-in supplier</option>
        ${suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div><label class="fld">Invoice / delivery note no. <span class="muted">(optional)</span></label><input class="inp mono" id="grInvoice" placeholder="Auto-generated if blank"></div>
        <div><label class="fld">Payment</label><select class="inp" id="grPayment">
          <option value="pay_later">Pay later / supplier credit</option><option value="cash">Paid from till cash</option>
          <option value="mpesa">Paid from till M-Pesa</option><option value="other">Already paid / other method</option>
        </select></div></div>
      <p class="tiny muted" id="grPaymentHelp" style="margin:9px 0 0">Pay later records stock without reducing Cash or M-Pesa. Cash/M-Pesa payments reduce the matching expected till balance.</p>
      <div class="row" style="margin:16px 0 8px"><b>Delivered products</b><span class="grow"></span><button class="btn sm" id="addDeliveryLine">+ Line</button></div>
      <div id="deliveryLines"></div>
      <div style="margin-top:12px"><label class="fld">Notes</label><input class="inp" id="grNotes" placeholder="Driver, payment terms, damaged cartons…"></div>`,
      footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Receive into stock</button>' });
    const ov = document.querySelector('#modalRoot .ov'), lines = ov.querySelector('#deliveryLines');
    const addLine = () => {
      const row = document.createElement('div'); row.className = 'grid delivery-line delivery-line-simple';
      row.innerHTML = `<div><label class="fld">Product</label><select class="inp" data-stock>${optionHtml}</select></div>
        <div><label class="fld">Received as</label><select class="inp" data-package></select></div>
        <div><label class="fld">Quantity received</label><input class="inp" data-qty type="number" min="0.01" step="0.01" inputmode="decimal"></div>
        <button class="btn red" data-remove title="Remove line">×</button>`;
      const stockSelect=row.querySelector('[data-stock]'),packageSelect=row.querySelector('[data-package]');
      const refreshPackages=()=>{packageSelect.innerHTML=packageOptions(stockSelect.value);};
      stockSelect.onchange=refreshPackages;refreshPackages();
      row.querySelector('[data-remove]').onclick = () => row.remove(); lines.appendChild(row);
    };
    addLine(); ov.querySelector('#addDeliveryLine').onclick = addLine; ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const items = [...lines.children].map((r) => ({
        stock_item_id: Number(r.querySelector('[data-stock]').value),
        package_id: Number(r.querySelector('[data-package]').value)||null,
        qty: Number(r.querySelector('[data-qty]').value)
      }));
      try {
        const result = await api('/api/goods-receipts', { body: { supplier_id: Number(ov.querySelector('#grSupplier').value) || null,
          invoice_no: ov.querySelector('#grInvoice').value.trim(), payment_method: ov.querySelector('#grPayment').value,
          notes: ov.querySelector('#grNotes').value.trim(),idempotency_key:deliveryKey,items } });
        closeModal(); await loadBootstrap(); deliveries(body);
        toast(`Delivery ${result.invoice_no} received · ${result.payment_method === 'pay_later' ? 'payment pending' : 'payment recorded'}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function stocktakes(body) {
    const rows = await api('/api/stock-counts'), open = rows.find((r) => r.status === 'open');
    body.innerHTML = `<div class="row" style="margin-bottom:14px"><div><h3 style="margin:0">Physical stock counts</h3>
      <div class="tiny muted">Full, category, selected-product, cycle or spot counts using a frozen expected snapshot</div></div><span class="grow"></span>
      ${open ? `<button class="btn ghost" id="cancelCount">Cancel count</button><button class="btn primary" id="continueCount">Continue ${esc(open.reference)}</button>` : '<button class="btn primary" id="startCount">+ Start stocktake</button>'}</div>
      <div class="card"><div class="scroll-x"><table class="tbl"><thead><tr><th>Reference</th><th>Type / scope</th><th>Status</th><th>Started</th><th>Completed</th><th class="right">Coverage</th><th class="right">Variances</th><th class="right">Cost impact</th><th class="right">Retail impact</th><th>By</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><b>${esc(r.reference)}</b></td><td><span class="tag info">${esc(r.count_type||'full')}</span><div class="tiny muted">${esc(r.scope_label||'All stock')}${r.for_close?' · closing':''}</div></td><td><span class="tag ${r.status === 'open' ? 'warn' : 'ok'}">${r.status}</span></td>
        <td class="muted nowrap">${esc(r.started_at)}</td><td class="muted nowrap">${esc(r.completed_at || '—')}</td><td class="right">${r.coverage_count||r.lines}/${r.total_stock_items||r.lines}</td>
        <td class="right">${r.variances || 0}</td><td class="right mono">${fmt(r.cost_variance || 0)}</td><td class="right mono">${fmt(r.retail_variance || 0)}</td>
        <td>${esc(r.completed_by_name || r.started_by_name || '—')}</td></tr>`).join('') ||
        '<tr><td colspan="10" class="empty">No stock counts yet.</td></tr>'}</tbody></table></div></div>`;
    body.querySelector('#continueCount')?.addEventListener('click', () => countForm(open.id, body));
    body.querySelector('#cancelCount')?.addEventListener('click', () => {
      modal({title:'Cancel stock count',body:`<p>This abandons <b>${esc(open.reference)}</b>. No stock quantities will change. If it put the till into reconciliation, the till will return to open.</p><label class="fld">Reason</label><input class="inp" id="cancelCountReason" placeholder="Started by mistake, interrupted count…">`,
        footer:'<button class="btn" data-no>Keep counting</button><button class="btn danger" data-yes>Cancel count</button>'});
      const ov=document.querySelector('#modalRoot .ov');ov.querySelector('[data-no]').onclick=closeModal;
      ov.querySelector('[data-yes]').onclick=async()=>{try{await api(`/api/stock-counts/${open.id}/cancel`,{body:{reason:ov.querySelector('#cancelCountReason').value}});
        closeModal();await loadBootstrap();stocktakes(body);toast('Stock count cancelled; till recovered','ok');}catch(e){toast(e.message,'err');}};
    });
    body.querySelector('#startCount')?.addEventListener('click', () => startCount(body));
  }

  function startCount(body) {
    modal({ title: 'Start physical stock count', wide:true, body: `<div class="grid3">
      <div><label class="fld">Count type</label><select class="inp" id="countType">
        <option value="full">Full stock count</option><option value="category">Category count</option>
        <option value="selected">Selected products</option><option value="cycle">Cycle count</option>
        <option value="spot">Spot count</option><option value="correction">Correction / recount</option></select></div>
      <div><label class="fld">Reference</label><input class="inp mono" id="countRef" value="COUNT-${today()}"></div>
      <div><label class="fld">Notes</label><input class="inp" id="countNotes" placeholder="Shift handover / weekly cycle / recount…"></div></div>
      <div id="countCategoryWrap" class="hidden" style="margin-top:12px"><label class="fld">Category</label><select class="inp" id="countCategory">${State.categories.map((c)=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div id="countProductsWrap" class="hidden" style="margin-top:12px"><label class="fld">Products to count</label>
        <select class="inp" id="countProducts" multiple size="8">${State.stock.map((x)=>`<option value="${x.id}">${esc(x.name)} · ${esc(stockQtyLabel(x.qty,x.unit,x.capacity_ml))}</option>`).join('')}</select>
        <div class="tiny muted" style="margin-top:5px">Use Ctrl/Command to select several products.</div></div>
      <label class="row" style="margin-top:12px;gap:8px"><input type="checkbox" id="countForClose" checked> Use this count for the current till close</label>
      <p class="tiny muted" style="margin-top:12px">A closing count stops sales while quantities are counted. A non-closing spot/cycle count leaves the till open but safely rejects completion if stock moved after its snapshot.</p>`,
      footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Start counting</button>' });
    const ov = document.querySelector('#modalRoot .ov'),type=ov.querySelector('#countType');
    const paintScope=()=>{const v=type.value;ov.querySelector('#countCategoryWrap').classList.toggle('hidden',v!=='category');
      ov.querySelector('#countProductsWrap').classList.toggle('hidden',!['selected','cycle','spot','correction'].includes(v));
      if(['cycle','spot'].includes(v))ov.querySelector('#countForClose').checked=false;};
    type.onchange=paintScope;paintScope();ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const selected=[...ov.querySelector('#countProducts').selectedOptions].map((x)=>Number(x.value));
      try { const r = await api('/api/stock-counts', { body: { reference: ov.querySelector('#countRef').value,
        notes: ov.querySelector('#countNotes').value,count_type:type.value,category_id:Number(ov.querySelector('#countCategory').value)||null,
        stock_item_ids:selected,scope_label:type.options[type.selectedIndex].text,for_close:ov.querySelector('#countForClose').checked } });
        closeModal(); await loadBootstrap(); countForm(r.id, body); } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function countForm(id, body) {
    const count = await api('/api/stock-counts/' + id);
    let index = Math.max(0, count.items.findIndex((x) => x.counted == null));
    if (index < 0) index = 0;
    modal({ title: 'Stocktake — ' + count.reference, wide: true, body: '<div id="countWizard"></div>',
      footer: '<button class="btn" data-exit>Save & exit</button><span class="grow"></span><button class="btn primary" data-finish style="display:none">Complete stocktake</button>' });
    const ov = document.querySelector('#modalRoot .ov'), wizard = ov.querySelector('#countWizard');

    const saveItem = async (item, counted, added) => {
      await api(`/api/stock-counts/${id}/save`, { body: { items: [{ stock_item_id: item.stock_item_id, counted, added_qty: added }] } });
      item.counted = counted; item.added_qty = added; item.variance = counted - item.expected - added;
    };
    const draw = () => {
      const item = count.items[index], done = count.items.filter((x) => x.counted != null).length;
      wizard.innerHTML = `<div class="row" style="margin-bottom:10px"><span class="tag info">Product ${index + 1} of ${count.items.length}</span>
          <span class="muted small">${done} completed</span><span class="grow"></span><div style="width:180px" class="pbar"><i style="width:${Math.round(done / Math.max(1, count.items.length) * 100)}%"></i></div></div>
        <div class="row count-jump" style="margin-bottom:14px"><label class="fld" style="margin:0;white-space:nowrap">Jump to product</label>
          <select class="inp" id="countJump">${count.items.map((x, n) => `<option value="${n}" ${n === index ? 'selected' : ''}>${x.counted != null ? '✓ ' : ''}${n + 1}. ${esc(x.name)}</option>`).join('')}</select></div>
        <div class="card" style="background:#101820"><div class="card-b" style="padding:24px">
          <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.08em">Count this product</div>
          <h2 style="margin:6px 0 4px;font-size:24px">${esc(item.name)}</h2>
          <div class="muted">System quantity before count: <b class="mono">${esc(stockQtyLabel(item.expected, item.unit, item.capacity_ml))}</b></div>
          <div class="grid2" style="margin-top:22px">
            <div><label class="fld">Stock added but not yet received in POS</label>
              <input class="inp mono" id="countAdded" type="number" min="0" step="0.01" value="${item.added_qty || 0}" style="font-size:21px;padding:12px">
              <div class="tiny muted" style="margin-top:5px">Leave zero if all deliveries were already entered.</div></div>
            ${item.capacity_ml && item.unit !== 'kg' ? `<div><label class="fld">Physical stock at hand</label>
              <div class="grid2"><div><label class="tiny muted">Full sealed ${esc(item.unit)}s</label><input class="inp mono" id="countFullUnits" type="number" min="0" step="1" value="${item.counted == null ? '' : Math.floor(item.counted + 0.000001)}" placeholder="0"></div>
                <div><label class="tiny muted">Open container ml</label><input class="inp mono" id="countOpenMl" type="number" min="0" max="${item.capacity_ml}" step="0.01" value="${item.counted == null ? '' : roundStock((item.counted - Math.floor(item.counted + 0.000001)) * item.capacity_ml)}" placeholder="0"></div></div>
              <input type="hidden" id="countAtHand" value="${item.counted ?? ''}"><div class="tiny muted" id="countPhysicalLabel" style="margin-top:6px"></div></div>`
              : `<div><label class="fld">Physical stock at hand (${esc(item.unit)})</label>
              <input class="inp mono" id="countAtHand" type="number" min="0" step="0.01" value="${item.counted == null ? '' : roundStock(item.counted, 4)}" placeholder="Enter actual count" style="font-size:21px;padding:12px"></div>`}
          </div>
          <div class="card" style="margin-top:16px"><div class="card-b">
            <div class="tline"><span>Expected after added stock</span><b id="countAdjustedExpected">${esc(stockQtyLabel(item.expected + (item.added_qty || 0), item.unit, item.capacity_ml))}</b></div>
            <div class="tline"><span>Unexplained variance</span><b id="countDifference">—</b></div>
          </div></div>
        </div></div>
        <div class="row" style="margin-top:16px">
          <button class="btn" id="countPrev" ${index === 0 ? 'disabled' : ''}>← Previous</button>
          <button class="btn ghost" id="countSkip">No change / Skip</button><span class="grow"></span>
          <button class="btn primary" id="countNext">${index === count.items.length - 1 ? 'Save item' : 'Save & next →'}</button>
        </div>`;
      const hand = wizard.querySelector('#countAtHand'), added = wizard.querySelector('#countAdded'), diff = wizard.querySelector('#countDifference');
      const fullInput = wizard.querySelector('#countFullUnits'), openMlInput = wizard.querySelector('#countOpenMl');
      const syncPhysicalUnits = () => {
        if (!fullInput) return;
        const hasValue = fullInput.value !== '' || openMlInput.value !== '';
        hand.value = hasValue ? (Math.max(0, Number(fullInput.value) || 0) + Math.max(0, Number(openMlInput.value) || 0) / item.capacity_ml) : '';
        const label = wizard.querySelector('#countPhysicalLabel');
        if (label) label.textContent = hand.value === '' ? '' : stockQtyLabel(Number(hand.value), item.unit, item.capacity_ml);
      };
      const update = () => {
        syncPhysicalUnits();
        const adjusted = item.expected + (Number(added.value) || 0);
        wizard.querySelector('#countAdjustedExpected').textContent = stockQtyLabel(adjusted, item.unit, item.capacity_ml);
        if (hand.value === '') { diff.textContent = '—'; return; }
        const v = Number(hand.value) - adjusted;
        diff.textContent = (v > 0 ? '+' : '') + Number(v.toFixed(4)) + ' ' + item.unit;
        diff.style.color = v === 0 ? 'var(--green)' : 'var(--amber)';
      };
      hand.oninput = update; added.oninput = update;
      if (fullInput) { fullInput.oninput = update; openMlInput.oninput = update; }
      update(); setTimeout(() => (fullInput || hand).select(), 20);
      wizard.querySelector('#countJump').onchange = async (e) => {
        const target = Number(e.target.value);
        try {
          if (hand.value !== '') await saveItem(item, Number(hand.value), Number(added.value) || 0);
          index = target; draw();
        } catch (err) { toast(err.message, 'err'); }
      };
      wizard.querySelector('#countPrev').onclick = async () => {
        if (index <= 0) return;
        try {
          if (hand.value !== '') await saveItem(item, Number(hand.value), Number(added.value) || 0);
          index--; draw();
        } catch (err) { toast(err.message, 'err'); }
      };
      wizard.querySelector('#countSkip').onclick = async () => {
        try { await saveItem(item, item.expected, 0); if (index < count.items.length - 1) index++; draw(); }
        catch (e) { toast(e.message, 'err'); }
      };
      wizard.querySelector('#countNext').onclick = async () => {
        if (hand.value === '') return toast('Enter stock at hand, or use No change / Skip', 'err');
        try {
          await saveItem(item, Number(hand.value), Number(added.value) || 0);
          if (index < count.items.length - 1) index++;
          else {
            const pending = count.items.findIndex((x) => x.counted == null);
            if (pending >= 0) index = pending;
          }
          draw();
        } catch (e) { toast(e.message, 'err'); }
      };
      const allDone = count.items.every((x) => x.counted != null);
      ov.querySelector('[data-finish]').style.display = allDone ? '' : 'none';
    };
    ov.querySelector('[data-exit]').onclick = () => { closeModal(); stocktakes(body); toast('Stocktake progress saved', 'ok'); };
    ov.querySelector('[data-finish]').onclick = async () => {
      try {
        const r = await api(`/api/stock-counts/${id}/complete`, { body: { items: count.items.map((x) => ({
          stock_item_id: x.stock_item_id, counted: x.counted, added_qty: x.added_qty || 0 })) } });
        closeModal(); await loadBootstrap();
        if(r.for_close){Manager.tab='money';Manager.render(document.getElementById('view'));}
        else stocktakes(body);
        const financial = r.variances ? ` · cost ${fmt(r.cost_variance)} · retail ${fmt(r.retail_variance)}` : '';
        toast(`Stock count posted · ${r.variances} variance(s)${financial}${r.for_close?'. Now reconcile the till.':''}`, r.variances ? 'err' : 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    draw();
  }

  return { suppliers, deliveries, stocktakes };
})();

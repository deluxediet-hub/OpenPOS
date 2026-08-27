/* cashier.js — bill queue, payments (Cash / Card / M-Pesa), refunds */
'use strict';

const Cashier = (() => {
  const METHOD_LABEL = { cash: 'Cash', card: 'Card', mpesa: 'M-Pesa', refund: 'Refund' };

  function renderBills(host) {
    const open = State.orders.filter((o) => ['open', 'billed'].includes(o.status))
      .sort((a, b) => (a.status === 'billed' ? -1 : 1) - (b.status === 'billed' ? -1 : 1) || a.opened_at.localeCompare(b.opened_at));
    const due = open.reduce((a, o) => a + Math.max(0, o.balance), 0);

    host.innerHTML = `
      <div class="row bills-summary" style="margin-bottom:14px">
        <div class="stat" style="flex:1;min-width:130px"><div class="l">Sales outstanding</div><div class="v" style="color:var(--blue)">${fmt(due)}</div></div>
        <div class="stat" style="flex:1;min-width:130px"><div class="l">Open sales</div><div class="v">${open.length}</div></div>
        <div class="stat" style="flex:1;min-width:130px"><div class="l">Part-paid</div><div class="v">${open.filter(o=>o.status==='billed').length}</div></div>
        <span class="grow"></span>
        <button class="btn ghost" id="zbtn">🖨 Print Z-report</button>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-b row bills-tools">
          <button class="btn" id="reprintLast">🖨 Reprint last receipt</button>
          <button class="btn" id="shiftPdf">📄 End-of-shift totals</button>
          <input class="inp" id="payq" placeholder="Find a payment: order #, M-Pesa code, method…" style="max-width:340px">
          <span class="grow"></span>
        </div>
        <div class="scroll-x" id="payres" style="display:none"></div>
      </div>
      <div class="grid open-sales-grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
        ${open.length ? open.map((o) => {
          const t = orderTable(o), lines = groupedSaleItems(o.items);
          return `<div class="card">
            <div class="card-h">
              <h3>${t ? esc(t.name) + ' · ' + esc(t.area) : (State.settings.business_type === 'wines_spirits' ? 'Sale #' : 'Takeaway #') + o.number}</h3>
              <span class="grow"></span>
              <span class="tag ${o.status === 'billed' ? 'info' : 'warn'}">${o.status}</span>
            </div>
            <div class="card-b" style="padding:12px 15px">
              <div class="tiny muted">#${o.number}${State.settings.business_type === 'wines_spirits' ? '' : ' · ' + o.people + ' guests'} · ${esc(waiterName(o.waiter_id))} · ${ago(o.opened_at)}</div>
              <div style="margin:10px 0;font-size:12.5px;color:var(--dim);max-height:130px;overflow:auto">
                ${lines.slice(0, 12).map((i) => `<div class="row sale-item-row">
                  <span>${i.qty} × ${esc(i.name)}</span><span class="mono">${fmt(i.price*i.qty)}</span></div>`).join('')}
                ${lines.length > 12 ? `<div class="tiny muted">+ ${lines.length - 12} more products…</div>` : ''}
              </div>
              <div class="tline"><span>Subtotal</span><b>${fmt(o.totals.subtotal)}</b></div>
              ${o.totals.service ? `<div class="tline"><span>Service</span><b>${fmt(o.totals.service)}</b></div>` : ''}
              ${o.totals.discount ? `<div class="tline"><span>Discount</span><b style="color:var(--red)">−${fmt(o.totals.discount)}</b></div>` : ''}
              <div class="tline total"><span>Due</span><b>${fmt(Math.max(0, o.balance))}</b></div>
              <div class="row" style="margin-top:12px">
                <button class="btn primary" style="flex:1;justify-content:center" data-pay="${o.id}">Take payment</button>
                <button class="btn ghost sm" data-print="${o.id}">🖨</button>
              </div>
            </div>
          </div>`;
        }).join('') : '<div class="empty">No open sales.</div>'}
      </div>
      <h3 style="margin:24px 0 10px;font-size:13px;color:var(--dim)">RECENTLY CLOSED</h3>
      <div class="card"><div class="scroll-x" id="recentBox"><div class="empty">Loading…</div></div></div>`;

    host.querySelectorAll('[data-pay]').forEach((b) => b.onclick = () => payModal(Number(b.dataset.pay)));
    host.querySelectorAll('[data-print]').forEach((b) => b.onclick = () => printReceipt(Number(b.dataset.print), { paid: true }));
    host.querySelector('#reprintLast').onclick = async () => {
      try {
        const o = await api('/api/last-closed-order');
        await printReceipt(o.id, { paid: true });
        toast('Reprinting last receipt (#' + o.number + ')', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    const pq = host.querySelector('#payq');
    let pt;
    pq.oninput = () => { clearTimeout(pt); pt = setTimeout(async () => {
      const box = host.querySelector('#payres');
      const q = pq.value.trim();
      if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
      const rows = await api('/api/payments?q=' + encodeURIComponent(q));
      box.style.display = '';
      box.innerHTML = rows.length ? `<table class="tbl"><thead><tr>
          <th>Order</th><th>Method</th><th class="right">Amount</th><th>Reference</th><th>When</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="mono">#${r.order_number}</td>
          <td><span class="tag ${r.method === 'refund' ? 'bad' : 'info'}">${r.method}</span></td>
          <td class="right mono">${fmt(r.amount)}</td>
          <td class="small muted">${esc(r.reference || '')}</td>
          <td class="small muted">${(r.created_at || '').slice(0, 16)}</td>
          <td class="right"><button class="btn xs ghost" data-rp="${r.order_id}">Receipt</button></td>
        </tr>`).join('')}</tbody></table>`
        : '<div class="empty">No payments match.</div>';
      box.querySelectorAll('[data-rp]').forEach((b) => b.onclick = () => printReceipt(Number(b.dataset.rp), { paid: true }));
    }, 250); };

    host.querySelector('#shiftPdf').onclick = async () => {
      try {
        const c = await api('/api/shift-clearing');
        if (!c.shift) return toast('No shift found — open a shift first', 'err');
        const money2 = (v) => fmt(v);
        printReport({
          title: 'End-of-Shift Clearing Sheet',
          subtitle: `Shift opened ${c.shift.opened_at}${c.shift.closed_at ? ' · closed ' + c.shift.closed_at : ' · still open'}`,
          tables: [
            { title: 'Takings by payment method', head: ['Method', 'Txns', 'Total'], right: [1, 2],
              rows: c.by_method.map((m) => [m.method.toUpperCase(), String(m.n), (m.total / 100).toFixed(2)]) },
            State.settings.business_type === 'wines_spirits'
              ? { title: 'Sales by category', head: ['Category', 'Units', 'Sales'], right: [1, 2],
                  rows: (c.by_category || []).map((x) => [x.category, String(x.units), (x.v / 100).toFixed(2)]) }
              : { title: 'Sales by station', head: ['Station', 'Lines', 'Sales'], right: [1, 2],
                  rows: c.by_station.map((s2) => [s2.station.toUpperCase(), String(s2.lines), (s2.v / 100).toFixed(2)]) },
            ...((c.complimentary || []).length ? [{ title: 'Complimentary stock',
              head: ['Product', 'Qty', 'Recipient', 'Reason', 'Recorded / Authorized', 'Reference', 'Retail / Cost'], right: [1, 6],
              rows: c.complimentary.map((x) => [x.item_name, String(x.qty), x.recipient || '—', x.reason,
                `${x.created_by_name || '—'} / ${x.authorized_by_name || '—'}`, x.authorization_reference || '—',
                `${(x.retail_value / 100).toFixed(2)} / ${(x.cost_value / 100).toFixed(2)}`]) }] : [])
          ],
          summary: State.settings.business_type === 'wines_spirits' ? [
            ['Business expenses', money2(c.payouts)],
            ['Expected cash', c.drawer && c.drawer.expected != null ? money2(c.drawer.expected) : '—'],
            ['Counted cash', c.drawer && c.drawer.counted != null ? money2(c.drawer.counted) : '—'],
            ['Cash variance', c.drawer && c.drawer.variance != null ? money2(c.drawer.variance) : '—'],
            ['Expected M-Pesa', c.drawer && c.drawer.expected_mpesa != null ? money2(c.drawer.expected_mpesa) : '—'],
            ['Actual M-Pesa', c.drawer && c.drawer.counted_mpesa != null ? money2(c.drawer.counted_mpesa) : '—'],
            ['M-Pesa variance', c.drawer && c.drawer.mpesa_variance != null ? money2(c.drawer.mpesa_variance) : '—'],
            ['Expected Card/EDC', c.drawer && c.drawer.expected_card != null ? money2(c.drawer.expected_card) : '—'],
            ['Actual Card/EDC', c.drawer && c.drawer.counted_card != null ? money2(c.drawer.counted_card) : '—'],
            ['Card variance', c.drawer && c.drawer.card_variance != null ? money2(c.drawer.card_variance) : '—'],
            ['Total tender variance', c.drawer && c.drawer.tender_variance != null ? money2(c.drawer.tender_variance) : '—'],
            ['Stock variance at retail', c.drawer && c.drawer.stock_retail_variance != null ? money2(c.drawer.stock_retail_variance) : (c.stocktake ? money2(c.stocktake.retail_variance) : '—')],
            ['Overall operational variance', c.drawer && c.drawer.overall_variance != null ? money2(c.drawer.overall_variance) : '—'],
            ['Reconciliation status', c.drawer && c.drawer.reconciliation_status || 'OPEN'],
            ['Reconciliation note', c.drawer && c.drawer.reconciliation_note || '—'],
            ['Receipts closed', String(c.orders)], ['Units sold', String(c.units || 0)],
            ['Complimentary retail value', money2(c.complimentary_value || 0)],
            ['Complimentary inventory cost', money2(c.complimentary_cost || 0)],
            ['Stocktake variance at cost', c.stocktake ? money2(c.stocktake.cost_variance) : '—'],
            ['Stocktake variance at retail', c.stocktake ? money2(c.stocktake.retail_variance) : '—']
          ] : [
            ['Tips', money2(c.tips)], ['Cash payouts', money2(c.payouts)],
            ['Expected in drawer', c.drawer && c.drawer.expected != null ? money2(c.drawer.expected) : '—'],
            ['Counted', c.drawer && c.drawer.counted != null ? money2(c.drawer.counted) : '—'],
            ['Variance', c.drawer && c.drawer.variance != null ? money2(c.drawer.variance) : '—'],
            ['Receipts closed', String(c.orders)], ['Covers', String(c.covers)]
          ]
        });
      } catch (e) { toast(e.message, 'err'); }
    };

    host.querySelector('#zbtn').onclick = async () => {
      const z = await api('/api/zreport?date=' + today());
      printZReport(z);
    };
    loadRecent(host);
  }

  async function loadRecent(host) {
    const box = host.querySelector('#recentBox');
    if (!box) return;
    try {
      const closed = await api('/api/orders?status=closed');
      box.innerHTML = closed.length ? `<table class="tbl"><thead><tr>
          <th>#</th><th>Sale</th><th>Seller</th><th>Closed</th><th>Products</th><th class="right">Total</th><th></th></tr></thead>
        <tbody>${closed.slice(0, 25).map((o) => {
          const t = orderTable(o);
          return `<tr><td class="mono">${o.number}</td><td>${t ? esc(t.name) : (State.settings.business_type === 'wines_spirits' ? 'Retail sale' : 'Takeaway')}</td>
            <td>${esc(waiterName(o.waiter_id))}</td><td>${clockTime(o.closed_at)}</td>
            <td>${groupedSaleItems(o.items).length}</td><td class="right mono"><b>${fmt(o.totals.total)}</b></td>
            <td class="right"><button class="btn xs ghost" data-rp="${o.id}">Receipt</button>
            ${['manager','admin'].includes(State.user.role) ? `<button class="btn xs red" data-rf="${o.id}">Refund</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table>` : '<div class="empty">No closed orders today yet.</div>';
      box.querySelectorAll('[data-rp]').forEach((b) => b.onclick = () => printReceipt(Number(b.dataset.rp), { paid: true }));
      box.querySelectorAll('[data-rf]').forEach((b) => b.onclick = () => refundModal(Number(b.dataset.rf)));
    } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  function refundModal(orderId) {
    requireManagerPin('Refunds need manager authorisation.', async () => {
      const o = State.orders.find((x) => x.id === orderId) || await api('/api/orders/' + orderId);
      const paid = o.payments.reduce((a, p) => a + p.amount, 0);
      modal({
        title: 'Refund — order #' + o.number,
        body: `<p class="muted" style="margin-top:0">Paid on this order: <b>${fmt(paid)}</b></p>
          <label class="fld">Refund amount (${sym()})</label>
          <input class="inp" id="ra" type="number" min="0.01" step="0.01" max="${paid/100}" value="${(paid/100).toFixed(2)}">
          <div style="margin-top:12px"><label class="fld">Reason</label>
            <input class="inp" id="rr" placeholder="${State.settings.business_type === 'wines_spirits' ? 'e.g. approved return, duplicate payment' : 'e.g. item not served, card chargeback'}"></div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn red" data-yes>Issue refund</button>`
      });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        try {
          await api(`/api/orders/${o.id}/refund`, { body: { amount: Number(ov.querySelector('#ra').value), reason: ov.querySelector('#rr').value } });
          closeModal(); await Pos.refresh(); toast('Refund recorded', 'ok'); renderBills(document.getElementById('view'));
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  /* ------------------------- payment modal --------------------------- */
  function payModal(orderId, after) {
    const o = State.orders.find((x) => x.id === orderId);
    if (!o) return toast('Order not found', 'err');
    let method = 'cash';
    let tip = 0;
    let tendered = o.balance;

    const quick = [0, 500, 1000, 2000, 5000, 10000].map((v) => v);

    modal({
      title: `Payment — ${orderLabel(o)} · #${o.number}`,
      wide: true,
      body: `
      <div class="grid2" style="grid-template-columns:1fr 1.15fr;align-items:start">
        <div>
          <div class="card" style="background:#101820">
            <div class="card-b">
              <div class="tline"><span>Subtotal</span><b>${fmt(o.totals.subtotal)}</b></div>
              ${o.totals.discount ? `<div class="tline"><span>Discount</span><b style="color:var(--red)">−${fmt(o.totals.discount)}</b></div>` : ''}
              ${o.totals.service ? `<div class="tline"><span>Service charge ${State.settings.service_charge_rate}%</span><b>${fmt(o.totals.service)}</b></div>` : ''}
              <div class="tline"><span>VAT ${State.settings.vat_rate}% ${State.settings.tax_mode==='inclusive'?'(incl.)':''}</span><b>${fmt(o.totals.vat)}</b></div>
              <div class="tline"><span>Tip</span><b id="tipLine">${fmt(0)}</b></div>
              <div class="tline total"><span>Balance due</span><b id="balLine">${fmt(o.balance)}</b></div>
              ${o.paid ? `<div class="tiny muted" style="margin-top:6px">Already paid ${fmt(o.paid)}
                (${o.payments.map((p) => METHOD_LABEL[p.method]).join(', ')})</div>` : ''}
            </div>
          </div>
          <div style="margin-top:12px">
            <label class="fld">Tip (${sym()})</label>
            <div class="row">
              ${[0, 50, 100, 200, 500].map((v) => `<button class="btn sm" data-tip="${v}">${v === 0 ? 'None' : v}</button>`).join('')}
              <input class="inp" id="tipInp" type="number" min="0" step="1" placeholder="Custom" style="width:100px">
            </div>
          </div>
          <div style="margin-top:14px">
            <label class="fld">Split payment</label>
            <div class="row">
              <button class="btn sm ghost" data-split="half">½ each</button>
              <button class="btn sm ghost" data-split="third">⅓ each</button>
              <button class="btn sm ghost" data-split="full">Full balance</button>
            </div>
            <p class="tiny muted" style="margin-top:8px">Take a part-payment now, then settle the rest on the same sale.</p>
          </div>
        </div>
        <div>
          <div class="row" style="gap:8px;margin-bottom:12px">
            <button class="btn primary mbtn" data-m="cash" style="flex:1;justify-content:center">💵 Cash</button>
            <button class="btn mbtn" data-m="card" style="flex:1;justify-content:center">💳 Card</button>
            <button class="btn mbtn" data-m="mpesa" style="flex:1;justify-content:center">📱 M-Pesa</button>
          </div>
          <div id="payForm"></div>
        </div>
      </div>`,
      footer: `<button class="btn" data-no>Cancel</button>
               <button class="btn ghost" data-print>🖨 Pre-bill</button>
               <button class="btn green" data-go>Confirm payment</button>`
    });

    const ov = document.querySelector('#modalRoot .ov');
    const form = ov.querySelector('#payForm');
    const bal = () => Math.max(0, o.balance + tip - paidIn());
    let partial = null; // partial amount in cents when splitting

    function paidIn() { return partial == null ? 0 : 0; }

    function renderForm() {
      const due = partial != null ? partial : Math.max(0, o.balance + tip);
      const btns = ov.querySelectorAll('.mbtn');
      btns.forEach((b) => {
        b.classList.toggle('primary', b.dataset.m === method);
      });
      if (method === 'cash') {
        form.innerHTML = `
          <label class="fld">Amount tendered (${sym()})</label>
          <input class="inp mono" id="tend" type="number" step="0.01" value="${(due/100).toFixed(2)}" style="font-size:22px;padding:12px">
          <div class="row" style="margin-top:10px">
            <button class="btn sm" data-q="exact">Exact</button>
            ${quick.filter(v=>v>0).map((v) => `<button class="btn sm" data-q="${v}">${v}</button>`).join('')}
            <button class="btn sm" data-q="round">Round up</button>
          </div>
          <div class="card" style="margin-top:14px;background:#101820"><div class="card-b">
            <div class="tline"><span>Amount due</span><b>${fmt(due)}</b></div>
            <div class="tline"><span>Tendered</span><b id="tLine">${fmt(due)}</b></div>
            <div class="tline total"><span>Change</span><b id="cLine" style="color:var(--green)">${fmt(0)}</b></div>
          </div></div>`;
        const tend = form.querySelector('#tend');
        const upd = () => {
          const v = Math.round(Number(tend.value || 0) * 100);
          form.querySelector('#tLine').textContent = fmt(v);
          const ch = v - due;
          const cl = form.querySelector('#cLine');
          cl.textContent = fmt(Math.max(0, ch));
          cl.style.color = ch < 0 ? 'var(--red)' : 'var(--green)';
          if (ch < 0) cl.textContent = '−' + fmt(-ch) + ' short';
        };
        tend.oninput = upd; upd();
        form.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => {
          if (b.dataset.q === 'exact') tend.value = (due / 100).toFixed(2);
          else if (b.dataset.q === 'round') tend.value = (Math.ceil(due / 10000) * 10000 / 100).toFixed(2);
          else tend.value = ((due + Number(b.dataset.q) * 100) / 100).toFixed(2);
          upd();
        });
        setTimeout(() => tend.select(), 20);
      } else if (method === 'card') {
        form.innerHTML = `
          <label class="fld">Amount (${sym()})</label>
          <input class="inp mono" id="camt" type="number" step="0.01" value="${(due/100).toFixed(2)}" style="font-size:20px;padding:12px">
          <div style="margin-top:12px"><label class="fld">Card / EDC reference (optional)</label>
            <input class="inp" id="cref" placeholder="e.g. 000123 from the PDQ"></div>
          <p class="tiny muted">Card payments cannot exceed the balance due.</p>`;
      } else {
        form.innerHTML = `
          <div class="grid2">
            <div><label class="fld">Amount (${sym()})</label>
              <input class="inp mono" id="mamt" type="number" step="0.01" value="${(due/100).toFixed(2)}" style="font-size:20px;padding:12px"></div>
            <div><label class="fld">Customer phone</label>
              <input class="inp" id="mphone" placeholder="0712 345 678"></div>
          </div>
          <div style="margin-top:12px"><label class="fld">M-Pesa confirmation code <span style="color:var(--red)">*</span></label>
            <input class="inp mono" id="mref" placeholder="e.g. SDF4GH7JK9" style="text-transform:uppercase"></div>
          <div class="row" style="margin-top:12px">
            <button class="btn sm ghost" id="stk">📲 Send STK push</button>
            <span class="tiny muted" id="stkMsg">Paybill 123456 · Acc = ${o.number}</span>
          </div>`;
        form.querySelector('#stk').onclick = () => {
          const phone = form.querySelector('#mphone').value.trim();
          const amt = form.querySelector('#mamt').value;
          if (!phone) return (form.querySelector('#stkMsg').textContent = 'Enter the customer phone number first.');
          form.querySelector('#stkMsg').innerHTML =
            `⏳ STK push sent to <b>${esc(phone)}</b> for ${fmt(Math.round(Number(amt)*100))} — waiting for the customer to enter their M-Pesa PIN…`;
          form.querySelector('#mref').focus();
        };
      }
    }

    ov.querySelectorAll('.mbtn').forEach((b) => b.onclick = () => { method = b.dataset.m; renderForm(); });
    ov.querySelectorAll('[data-tip]').forEach((b) => b.onclick = () => {
      tip = Number(b.dataset.tip) * 100;
      ov.querySelector('#tipInp').value = tip ? tip / 100 : '';
      ov.querySelector('#tipLine').textContent = fmt(tip);
      ov.querySelector('#balLine').textContent = fmt(o.balance + tip - o.paid);
      renderForm();
    });
    ov.querySelector('#tipInp').oninput = (e) => {
      tip = Math.max(0, Math.round(Number(e.target.value || 0) * 100));
      ov.querySelector('#tipLine').textContent = fmt(tip);
      ov.querySelector('#balLine').textContent = fmt(o.balance + tip - o.paid);
      renderForm();
    };
    ov.querySelectorAll('[data-split]').forEach((b) => b.onclick = () => {
      const total = Math.max(0, o.balance + tip);
      if (b.dataset.split === 'half') partial = Math.round(total / 2);
      else if (b.dataset.split === 'third') partial = Math.round(total / 3);
      else partial = null;
      toast(partial != null ? 'Part payment: ' + fmt(partial) : 'Full balance', 'ok');
      renderForm();
    });
    ov.querySelector('[data-print]').onclick = () => printReceipt(o.id, { paid: false });
    ov.querySelector('[data-no]').onclick = closeModal;

    renderForm();

    ov.querySelector('[data-go]').onclick = async () => {
      let amount, reference, tendered;
      if (method === 'cash') {
        tendered = Math.round(Number(form.querySelector('#tend').value || 0) * 100);
        const due = partial != null ? partial : Math.max(0, o.balance + tip);
        if (tendered < due) return toast(`Short by ${fmt(due - tendered)} — cannot close a cash sale`, 'err');
        amount = due;
      } else if (method === 'card') {
        amount = Math.round(Number(form.querySelector('#camt').value || 0) * 100);
        reference = form.querySelector('#cref').value.trim() || null;
      } else {
        amount = Math.round(Number(form.querySelector('#mamt').value || 0) * 100);
        reference = form.querySelector('#mref').value.trim().toUpperCase();
        if (!reference) return toast('Enter the M-Pesa confirmation code', 'err');
      }
      try {
        /* Wire contract: money crosses the API in shillings (the server converts to
           cents for storage). amount/tendered/tip are held in cents locally. */
        const r = await api(`/api/orders/${o.id}/pay`, {
          body: {
            method,
            amount: amount / 100,
            reference,
            tendered: tendered == null ? undefined : tendered / 100,
            tip: tip / 100
          }
        });
        closeModal();
        if (State.settings.business_type === 'wines_spirits') await loadBootstrap();
        else await Pos.refresh();
        State.openOrderId = null;
        toast(`${METHOD_LABEL[method]} ${fmt(amount)} received${r.change ? ' · change ' + fmt(r.change) : ''}`, 'ok');
        await printReceipt(o.id, { paid: true });
        const host = document.getElementById('view');
        if (State.view === 'bills') renderBills(host);
        else if (State.view === 'tables') Pos.renderFloor(host);
        after && after();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  return { renderBills, payModal, refundModal };
})();

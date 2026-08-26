/* print.js — receipt & ticket rendering + browser print */
'use strict';

function receiptHtml(r, { paid = false } = {}) {
  const s = r.settings, t = r.totals || r.order.totals, o = r.order;
  const money = (c) => (Number(c || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label, value, cls = '') => `<div class="r ${cls}"><span>${label}</span><span>${value}</span></div>`;
  const seller = esc((r.waiter || {}).name || '—');
  const cashier = State.user ? esc(State.user.name) : seller;
  const chars = Number(s.printer_chars) || 42;
  const items = r.items.map((i) => `<tr>
    <td class="rq">${i.qty}</td><td class="ri">${esc(i.name)}${i.note ? `<div class="receipt-note">${esc(i.note)}</div>` : ''}
      <div class="receipt-unit">@ ${money(i.price)}</div></td><td class="ra">${money(i.price * i.qty)}</td></tr>`).join('');
  const payments = paid && o.payments && o.payments.length ? o.payments.map((p) =>
    `${row(esc(String(p.method || '').toUpperCase()), money(p.amount), 'payment')}${p.reference ? `<div class="receipt-ref">${esc(p.reference)}</div>` : ''}`).join('') : '';
  return `<div class="receipt${chars <= 32 ? ' receipt-58' : ''}">
    <div class="receipt-brand">${esc(s.business_name)}</div>
    ${s.address ? `<div class="c">${esc(s.address)}</div>` : ''}
    ${s.phone ? `<div class="c">Tel: ${esc(s.phone)}</div>` : ''}
    ${s.kra_pin ? `<div class="c">KRA PIN: ${esc(s.kra_pin)}</div>` : ''}
    ${s.business_type === 'wines_spirits' && s.licence_number ? `<div class="c">Licence: ${esc(s.licence_number)}</div>` : ''}
    <div class="receipt-title">${paid ? 'SALES RECEIPT · PAID' : 'SALE SUMMARY · UNPAID'}</div>
    ${row('Receipt', '#' + esc(o.number))}
    ${row('Date', esc((o.closed_at || o.opened_at || '').slice(0, 16)))}
    ${r.table ? row('Table', esc(r.table.name) + ' · ' + esc(r.table.area)) : ''}
    ${row(s.business_type === 'wines_spirits' ? 'Seller' : 'Served by', seller)}
    ${cashier !== seller ? row('Cashier', cashier) : ''}
    <div class="receipt-rule"></div>
    <table class="receipt-items"><thead><tr><th>QTY</th><th>ITEM</th><th>AMOUNT</th></tr></thead><tbody>${items}</tbody></table>
    <div class="receipt-rule"></div>
    ${row('Subtotal', money(t.subtotal))}
    ${t.discount ? row('Discount', '−' + money(t.discount)) : ''}
    ${t.service ? row(`Service ${esc(s.service_charge_rate)}%`, money(t.service)) : ''}
    ${row('TOTAL ' + esc(s.currency_symbol || 'KSh'), money(t.total), 'receipt-total')}
    ${t.tip ? row('Tip', money(t.tip)) : ''}
    ${t.grand_total !== t.total ? row('AMOUNT DUE', money(t.grand_total), 'receipt-due') : ''}
    ${row(`VAT ${esc(s.vat_rate)}% ${s.tax_mode === 'inclusive' ? 'included' : ''}`, money(t.vat), 'receipt-tax')}
    ${payments ? `<div class="receipt-rule"></div><div class="receipt-section">PAYMENT</div>${payments}` : ''}
    <div class="receipt-rule"></div>
    ${s.receipt_footer ? `<div class="c receipt-footer">${esc(s.receipt_footer)}</div>` : ''}
    ${s.business_type === 'wines_spirits' ? `<div class="c receipt-warning">${esc(s.minimum_sale_age || 18)}+ ONLY · DRINK RESPONSIBLY</div>` : ''}
    <div class="c receipt-copy">Thank you · Karibu tena</div>
  </div>`;
}

async function printReceipt(orderId, { paid = true } = {}) {
  try {
    const r = await api('/api/receipt/' + orderId);
    doPrint(receiptHtml(r, { paid }));
  } catch (e) { toast('Could not print: ' + e.message, 'err'); }
}

async function printTicketHtml(orderId, station) {
  const o = State.orders.find((x) => x.id === orderId) || await api('/api/orders/' + orderId);
  const lines = o.items.filter((i) => i.status === 'sent' && (!station || i.station === station));
  const t = orderTable(o);
  doPrint(`<div class="receipt">
    <h4>${station === 'bar' ? 'BAR ORDER' : 'KITCHEN ORDER'}</h4>
    <div class="c">${esc(State.settings.business_name)}</div>
    <hr>
    ${`<div class="r"><span><b>#${o.number}</b></span><span><b>${t ? esc(t.name) : 'TAKEAWAY'}</b></span></div>`}
    <div class="r"><span>${esc(waiterName(o.waiter_id))}</span><span>${clockTime(o.opened_at)}</span></div>
    <hr>
    <table>${lines.map((i) => `<tr><td style="width:30px;font-weight:700">${i.qty}x</td>
      <td style="font-size:14px;font-weight:700">${esc(i.name)}</td></tr>
      ${i.note ? `<tr><td></td><td style="font-size:11px">** ${esc(i.note)} **</td></tr>` : ''}`).join('')}</table>
    <hr>
    <div class="c">${lines.length} line(s)</div>
  </div>`);
}


/* ---------- A4 report sheet: letterhead on top, sign-off block at the bottom ---------- */
function letterheadHtml(s) {
  return `<div class="rpt-head">
    <div class="rpt-biz">${esc(s.business_name || 'POS')}</div>
    ${s.address ? `<div>${esc(s.address)}</div>` : ''}
    <div>${esc(s.phone || '')}${s.phone && s.kra_pin ? ' · ' : ''}${s.kra_pin ? 'KRA PIN ' + esc(s.kra_pin) : ''}</div>
  </div>`;
}
function signatureHtml() {
  return `<div class="rpt-sign">
    ${['Prepared by', 'Checked by', 'Approved by'].map((r) =>
      `<div class="rpt-sign-col"><div class="rpt-line"></div><div class="rpt-sign-l">${r}<br>Name / Signature / Date</div></div>`).join('')}
  </div>`;
}
function reportHtml({ settings, title, subtitle, tables = [], summary = [] }) {
  const s = settings || State.settings;
  return `<div class="sheet">
    ${letterheadHtml(s)}
    <div class="rpt-title">${esc(title)}</div>
    <div class="rpt-sub">${esc(subtitle || '')} · Generated ${new Date().toLocaleString('en-KE')} by ${esc(State.user ? State.user.name : '')}</div>
    ${tables.map((t) => `<div class="rpt-table">
        ${t.title ? `<div class="rpt-tt">${esc(t.title)}</div>` : ''}
        <table><thead><tr>${t.head.map((h, i) => `<th class="${(t.right || []).includes(i) ? 'right' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${(t.right || []).includes(i) ? 'right' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      </div>`).join('')}
    ${summary.length ? `<div class="rpt-sum">${summary.map(([l, v]) => `<div class="r"><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
    ${signatureHtml()}
  </div>`;
}
function printReport(opts) { doPrint(reportHtml(opts)); }

/* Combined kitchen+bar docket, used for auto-print the moment an order is fired. */
async function printDocket(orderId) {
  const o = State.orders.find((x) => x.id === orderId) || await api('/api/orders/' + orderId);
  const lines = o.items.filter((i) => ['sent', 'ready'].includes(i.status));
  const t = orderTable(o);
  const grp = (st) => lines.filter((i) => i.station === st);
  const sec = (st) => grp(st).length ? `<hr><div class="c"><b>${st === 'bar' ? 'BAR' : 'KITCHEN'}</b></div><table>${grp(st).map((i) =>
    `<tr><td style="width:30px;font-weight:700">${i.qty}x</td><td style="font-size:14px;font-weight:700">${esc(i.name)}</td></tr>
     ${i.note ? `<tr><td></td><td style="font-size:11px">** ${esc(i.note)} **</td></tr>` : ''}
     ${(i.modifiers || []).map((m) => `<tr><td></td><td style="font-size:11px">+ ${esc(m.name)}</td></tr>`).join('')}`).join('')}</table>` : '';
  doPrint(`<div class="receipt"><h4>DOCKET #${o.number}</h4>
    <div class="c">${esc(State.settings.business_name)}</div><hr>
    <div class="r"><span><b>${t ? esc(t.name) : 'TAKEAWAY'}</b></span><span>${esc(waiterName(o.waiter_id))}</span></div>
    <div class="r"><span>${clockTime(o.opened_at)}</span><span>${o.people} pax</span></div>
    ${sec('kitchen')}${sec('bar')}
    <hr><div class="c">${lines.length} line(s)</div></div>`);
}

function doPrint(html) {
  const root = document.getElementById('printRoot');
  if (!root) return;
  root.innerHTML = html;
  // hide the running app so only the receipt goes to the printer, then restore
  const app = document.getElementById('app');
  const login = document.getElementById('login');
  const hidden = [];
  [app, login].forEach((el) => {
    if (el && getComputedStyle(el).display !== 'none') { el.style.display = 'none'; hidden.push(el); }
  });
  root.style.display = 'block';
  setTimeout(() => {
    window.print();
    setTimeout(() => {
      root.style.display = 'none';
      hidden.forEach((el) => { el.style.display = ''; });
    }, 120);
  }, 60);
}

function printZReport(z) {
  const s = z.settings;
  printReport({ settings: s, title: 'Z-REPORT - END OF DAY', subtitle: 'Business date ' + z.date,
    tables: [{ title: 'Takings by payment method', head: ['Method', 'Count', 'Total'], right: [1, 2],
      rows: z.by_method.map((m) => [m.method.toUpperCase(), String(m.n), (m.total / 100).toFixed(2)]) }],
    summary: [
      ['Net sales', (z.net / 100).toFixed(2)], ['Receipts closed', String(z.orders)], ['Covers', String(z.covers)],
      ['Voids', String(z.voids)], ['Discounts', (z.discounts / 100).toFixed(2)], ['Tips', (z.tips / 100).toFixed(2)] ] });
}

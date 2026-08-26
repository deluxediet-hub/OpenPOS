/* print.js — receipt & ticket rendering + browser print */
'use strict';

function receiptHtml(r, { paid = false } = {}) {
  const s = r.settings, t = r.totals || r.order.totals, o = r.order;
  const line = (l, v) => `<div class="r"><span>${l}</span><span>${v}</span></div>`;
  const items = r.items.map((i) =>
    `<tr><td style="width:26px">${i.qty}&nbsp;x</td><td>${esc(i.name)}${i.note ? `<br><i style="font-size:10px">${esc(i.note)}</i>` : ''}</td>
     <td style="text-align:right;white-space:nowrap">${(i.price * i.qty / 100).toFixed(2)}</td></tr>`).join('');
  return `<div class="receipt">
    <h4>${esc(s.business_name)}</h4>
    <div class="c">${esc(s.address)}</div>
    <div class="c">${esc(s.phone)} · KRA PIN ${esc(s.kra_pin)}</div>
    ${s.business_type === 'wines_spirits' && s.licence_number ? `<div class="c">Alcohol licence ${esc(s.licence_number)}</div>` : ''}
    <hr>
    ${line('Receipt #', String(o.number))}
    ${line('Date', (o.closed_at || o.opened_at).slice(0, 16))}
    ${r.table ? line('Table', esc(r.table.name) + ' · ' + esc(r.table.area)) : ''}
    ${s.business_type === 'wines_spirits' ? '' : line('Guests', o.people)}
    ${line(s.business_type === 'wines_spirits' ? 'Sold by' : 'Served by', esc((r.waiter || {}).name || '—'))}
    ${line('Cashier', esc(State.user ? State.user.name : '—'))}
    <hr>
    <table>${items}</table>
    <hr>
    ${line('Subtotal', (t.subtotal / 100).toFixed(2))}
    ${t.discount ? line('Discount', '-' + (t.discount / 100).toFixed(2)) : ''}
    ${t.service ? line(`Service charge ${s.service_charge_rate}%`, (t.service / 100).toFixed(2)) : ''}
    ${line(`<b>TOTAL</b>`, `<b>${(t.total / 100).toFixed(2)}</b>`)}
    ${t.tip ? line('Tip', (t.tip / 100).toFixed(2)) : ''}
    ${line('<b>AMOUNT DUE</b>', `<b>${(t.grand_total / 100).toFixed(2)}</b>`)}
    <hr>
    ${s.tax_mode === 'inclusive'
      ? line(`VAT ${s.vat_rate}% included`, (t.vat / 100).toFixed(2))
      : line(`VAT ${s.vat_rate}%`, (t.vat / 100).toFixed(2))}
    ${paid ? `<hr>${r.order.payments.map((p) =>
      line(p.method.toUpperCase() + (p.reference ? ' ' + esc(p.reference) : ''), (p.amount / 100).toFixed(2))).join('')}` : ''}
    <hr>
    <div class="c" style="margin-top:6px">${esc(s.receipt_footer)}</div>
    ${s.business_type === 'wines_spirits' ? `<div class="c" style="margin-top:5px;font-weight:700">${esc(s.minimum_sale_age || 18)}+ ONLY · PLEASE DRINK RESPONSIBLY</div>` : ''}
    <div class="c" style="margin-top:8px;font-size:10px">${esc(s.business_name || 'POS')} · ${new Date().toLocaleString('en-KE')}</div>
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

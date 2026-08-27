'use strict';
/**
 * escpos.js — ESC/POS receipt & kitchen ticket generation.
 *
 * Produces raw byte buffers, so the same code can go to a network printer
 * (port 9100), a file (for testing / reprint archives), or a future USB driver.
 * No native dependencies.
 */
const net = require('net');
const fs = require('fs');

/* ---------------------------- ESC/POS commands ---------------------------- */
const ESC = 0x1b, GS = 0x1d;
const CMD = {
  INIT:        [ESC, 0x40],
  ALIGN_LEFT:  [ESC, 0x61, 0x00],
  ALIGN_CENTER:[ESC, 0x61, 0x01],
  ALIGN_RIGHT: [ESC, 0x61, 0x02],
  BOLD_ON:     [ESC, 0x45, 0x01],
  BOLD_OFF:    [ESC, 0x45, 0x00],
  DOUBLE_ON:   [GS, 0x21, 0x11],   // double width + height
  DOUBLE_OFF:  [GS, 0x21, 0x00],
  UNDER_ON:    [ESC, 0x2d, 0x01],
  UNDER_OFF:   [ESC, 0x2d, 0x00],
  FEED:        (n) => [ESC, 0x64, n],
  CUT:         [GS, 0x56, 0x42, 0x00],
  /* Open the cash drawer on pin 2 (standard for most 80mm/58mm tills) */
  DRAWER_KICK: [ESC, 0x70, 0x00, 0x19, 0xfa]
};

class Doc {
  constructor(width = 42) {
    this.w = width;
    this.chunks = [];
    this.push(...CMD.INIT);
  }
  push(...bytes) { this.chunks.push(Buffer.from(bytes)); return this; }
  text(s) { this.chunks.push(Buffer.from(String(s ?? ''), 'utf8')); return this; }
  ln(s = '') { return this.text(s + '\n'); }
  align(a) { return this.push(...CMD[`ALIGN_${a.toUpperCase()}`]); }
  bold(on) { return this.push(...(on ? CMD.BOLD_ON : CMD.BOLD_OFF)); }
  big(on) { return this.push(...(on ? CMD.DOUBLE_ON : CMD.DOUBLE_OFF)); }
  underline(on) { return this.push(...(on ? CMD.UNDER_ON : CMD.UNDER_OFF)); }
  feed(n = 1) { return this.push(...CMD.FEED(n)); }
  cut() { return this.push(...CMD.CUT); }
  drawer() { return this.push(...CMD.DRAWER_KICK); }
  hr(ch = '-') { return this.ln(ch.repeat(this.w)); }
  /** Two-column line: label left, value right, padded. */
  row(left, right) {
    const l = String(left ?? ''), r = String(right ?? '');
    if (l.length + r.length > this.w) {
      this.ln(l);
      return this.ln(' '.repeat(Math.max(0, this.w - r.length)) + r);
    }
    return this.ln(l + ' '.repeat(this.w - l.length - r.length) + r);
  }
  center(s) { return this.align('center').ln(s).align('left'); }
  buffer() { return Buffer.concat(this.chunks); }
}

/* --------------------------------- helpers -------------------------------- */
const money = (cents) => ((Number(cents) || 0) / 100).toFixed(2);

/* -------------------------------- receipt --------------------------------- */
function buildReceipt(r, { paid = true } = {}) {
  const s = r.settings, o = r.order, t = r.totals || o.totals;
  const W = Number(s.printer_chars) || 42;
  const d = new Doc(W);

  d.align('center').bold(true).big(true).ln(s.business_name).big(false);
  d.bold(false);
  if (s.address) d.ln(s.address);
  if (s.phone) d.ln(`Tel: ${s.phone}`);
  if (s.kra_pin) d.ln(`KRA PIN: ${s.kra_pin}`);
  if (s.business_type === 'wines_spirits' && s.licence_number) d.ln(`Licence: ${s.licence_number}`);
  d.feed(1).bold(true).ln(paid ? 'SALES RECEIPT - PAID' : 'SALE SUMMARY - UNPAID').bold(false).align('left');

  /* eTIMS placeholder — populated by lib/integrations.js once wired */
  if (o.etims_control) d.center(`CUIN: ${o.etims_control}`);

  d.hr();
  d.row('Receipt #', String(o.number));
  d.row('Date', (o.closed_at || o.opened_at || '').slice(0, 16));
  if (r.table) d.row('Table', `${r.table.name} (${r.table.area})`);
  if (o.channel && o.channel !== 'dine_in') d.row('Channel', String(o.channel).toUpperCase());
  if (s.business_type !== 'wines_spirits') d.row('Guests', o.people);
  d.row(s.business_type === 'wines_spirits' ? 'Seller' : 'Served by', (r.waiter || {}).name || '-');
  if (r.cashier && r.cashier !== (r.waiter || {}).name) d.row('Cashier', r.cashier);
  if (o.tab_customer) d.row('Tab', o.tab_customer);
  if (o.customer_phone) d.row('Member', o.customer_phone);
  d.hr();
  d.bold(true).row('QTY  ITEM', 'AMOUNT').bold(false);
  d.hr('.');

  /* Consolidate identical historical lines so receipts always read Product x Quantity. */
  const consolidated = [];
  for (const item of r.items) {
    const key = [item.menu_item_id, item.name, item.price, item.note || '', JSON.stringify(item.modifiers || [])].join('|');
    const existing = consolidated.find((x) => x._key === key);
    if (existing) existing.qty += Number(item.qty);
    else consolidated.push({ ...item, qty: Number(item.qty), _key: key });
  }
  /* line items */
  for (const i of consolidated) {
    d.bold(true).text(String(i.qty).padStart(2) + 'x ').bold(false);
    d.ln(i.name);
    if (i.modifiers && i.modifiers.length) {
      for (const m of i.modifiers) d.ln('   + ' + m.name + (m.price ? `  ${money(m.price)}` : ''));
    }
    if (i.note) d.ln('   * ' + i.note);
    d.row('', money(i.price * i.qty));
  }

  d.hr();
  d.row('Subtotal', money(t.subtotal));
  if (t.discount) d.row('Discount', '-' + money(t.discount));
  if (t.service) d.row(`Service ${s.service_charge_rate}%`, money(t.service));
  d.bold(true).big(true).row(`TOTAL ${s.currency_symbol || 'KSh'}`, money(t.total)).big(false).bold(false);
  if (t.tip) d.row('Tip', money(t.tip));
  if (t.points_redeemed) d.row('Points used', '-' + money(t.points_redeemed));
  if (t.points_earned) d.row('Points earned', String(t.points_earned));
  if (t.grand_total !== t.total) d.bold(true).row('AMOUNT DUE', money(t.grand_total)).bold(false);

  d.hr();
  if (s.tax_mode === 'inclusive') d.row(`VAT ${s.vat_rate}% incl.`, money(t.vat));
  else d.row(`VAT ${s.vat_rate}%`, money(t.vat));

  if (paid && o.payments && o.payments.length) {
    d.hr();
    for (const p of o.payments) {
      d.row(String(p.method).toUpperCase(), money(p.amount));
      if (p.reference) d.ln('  ' + p.reference);
    }
    if (o.change) d.row('CHANGE', money(o.change));
  }

  d.feed(1).hr();
  d.align('center').bold(true).ln(s.receipt_footer || '').bold(false);
  if (s.business_type === 'wines_spirits') {
    d.feed(1).bold(true).ln(`${s.minimum_sale_age || 18}+ ONLY - DRINK RESPONSIBLY`).bold(false);
  }
  d.ln('Thank you - Karibu tena');
  {
    /* local wall-clock — a UTC stamp would read hours off the till's own clock */
    const n = new Date(), q = (x) => String(x).padStart(2, '0');
    d.ln(`Printed ${n.getFullYear()}-${q(n.getMonth() + 1)}-${q(n.getDate())} ` +
      `${q(n.getHours())}:${q(n.getMinutes())}:${q(n.getSeconds())}`);
  }
  d.feed(3);
  if (s.drawer_kick_enabled === '1' && paid) d.drawer();
  d.cut();
  return d.buffer();
}

/* ------------------------------ kitchen ticket ---------------------------- */
function buildKitchenTicket(o, { table, waiter, station, settings }) {
  const d = new Doc(Number(settings && settings.printer_chars) || 42);
  d.align('center').bold(true).big(true)
    .ln(station === 'bar' ? 'BAR ORDER' : 'KITCHEN ORDER')
    .big(false);
  d.ln(settings ? settings.business_name : '').align('left').hr();
  d.bold(true).row('#' + o.number, table ? table.name : 'TAKEAWAY').bold(false);
  d.row(waiter || '-', (o.opened_at || '').slice(11, 16));
  if (o.channel && o.channel !== 'dine_in') d.row('Channel', String(o.channel).toUpperCase());
  d.hr();
  for (const i of o.items) {
    d.bold(true).text(`${i.qty}x `).bold(false).ln(i.name);
    if (i.modifiers && i.modifiers.length) for (const m of i.modifiers) d.ln('   + ' + m.name);
    if (i.note) d.bold(true).ln('   ** ' + i.note + ' **').bold(false);
  }
  d.hr();
  d.center(`${o.items.length} line(s)`);
  d.feed(3).cut();
  return d.buffer();
}

/* -------------------------------- delivery -------------------------------- */
/** Send bytes to a network printer. Resolves once the printer has accepted them. */
function send(host, port, buffer, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('Printer host is not configured'));
    const sock = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Printer timed out')); }, timeout);
    sock.setNoDelay(true);
    sock.once('error', (e) => { clearTimeout(timer); reject(new Error('Printer error: ' + e.message)); });
    sock.connect(Number(port) || 9100, host, () => {
      sock.write(buffer, () => { clearTimeout(timer); sock.end(); resolve(buffer.length); });
    });
  });
}

/** Persist a job to disk — used by tests and by the reprint archive. */
function writeToFile(filePath, buffer) {
  fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return buffer.length;
}

module.exports = { Doc, CMD, buildReceipt, buildKitchenTicket, send, writeToFile };

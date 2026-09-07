'use strict';
// ---------------------------------------------------------------------------
// hardware.js — the peripheral layer (Phase 27).
//
// The rule for this whole file: **hardware is replaceable, not proprietary.**
// Nothing above it knows a brand. A register points at a device profile (a row
// of data), the profile names a driver, and the driver renders BYTES. Whether
// those bytes travel over USB, Bluetooth, serial or a queue the shop already
// trusts is somebody else's problem — swap the row, keep the shop.
//
// Drivers that need no hardware at all are first-class citizens: `log` writes
// the job where the shop can see it, so a shop with no printer is not broken.
// ---------------------------------------------------------------------------

const ESC = 0x1b, GS = 0x1d;

const DEVICE_TYPES = [
  { id: 'printer', label: 'Receipt printer', sw: 'Printa ya risiti', desc: '58mm or 80mm thermal (ESC/POS).' },
  { id: 'label', label: 'Label / price-tag printer', sw: 'Printa ya lebo', desc: 'Shelf labels and barcoded price tags.' },
  { id: 'scanner', label: 'Barcode scanner', sw: 'Soma ya barcode', desc: 'USB or Bluetooth, usually a keyboard wedge.' },
  { id: 'drawer', label: 'Cash drawer', sw: 'Sanduku la pesa', desc: 'Kicked by the printer or by a serial pulse.' },
  { id: 'display', label: 'Customer display', sw: 'Onyesho la mteja', desc: 'Pole display or a second screen.' },
  { id: 'scale', label: 'Weighing scale', sw: 'Mizani', desc: 'Serial or USB scale for produce and butchery.' },
  { id: 'terminal', label: 'Card terminal', sw: 'Mashine ya kadi', desc: 'Standalone POS terminal, typed in by hand.' }
];

const DRIVERS = {
  escpos: { id: 'escpos', label: 'ESC/POS thermal', sw: 'ESC/POS', desc: 'The 58/80mm thermal standard — every cheap printer speaks it.' },
  zpl: { id: 'zpl', label: 'ZPL label', sw: 'ZPL', desc: 'Zebra label language, for barcode price tags.' },
  browser: { id: 'browser', label: 'Browser / USB', sw: 'Kivinjari / USB', desc: 'The browser talks to the device (WebUSB / Web Serial).' },
  keyboard: { id: 'keyboard', label: 'Keyboard wedge', sw: 'Kibodi', desc: 'The device types into whatever has focus — scanners, mostly.' },
  serial: { id: 'serial', label: 'Serial / RS-232', sw: 'Seriali', desc: 'Scales and pole displays on a serial port.' },
  log: { id: 'log', label: 'Local log only', sw: 'Kumbukumbu', desc: 'Rendered and stored in the shop — no hardware needed.' }
};

const DEFAULTS = {
  printer: { driver: 'escpos', width: 80, chars: 48, codepage: 'CP437', drawer: true, cut: true, qr: true, copies: 1 },
  label: { driver: 'escpos', width: 58, chars: 32, template: 'price_tag', show_sku: true, show_barcode: true },
  scanner: { driver: 'keyboard', suffix: 'Enter', prefix: '' },
  drawer: { driver: 'escpos', pin: 2, on_time: 25, off_time: 250 },
  display: { driver: 'browser', lines: 2, chars: 20 },
  scale: { driver: 'serial', baud: 9600, unit: 'kg', port: '' },
  terminal: { driver: 'log', reference: 'typed' }
};

function profileOf(type, stored) {
  const t = DEVICE_TYPES.some((x) => x.id === type) ? type : 'printer';
  return { ...(DEFAULTS[t] || {}), ...(stored || {}), type: t };
}

// ---- byte building ---------------------------------------------------------

function bytesOf(chunks) {
  const out = [];
  for (const c of chunks) {
    if (typeof c === 'number') out.push(c);
    else if (c instanceof Uint8Array) out.push(...c);
    else if (Array.isArray(c)) out.push(...bytesOf(c));
    else for (const ch of String(c)) out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out.map((b) => Math.max(0, Math.min(255, Math.round(b)))));
}

const enc = (s) => String(s == null ? '' : s);
const row = (left, right, chars) => {
  const l = enc(left).slice(0, Math.max(0, chars - String(right == null ? '' : right).length - 1));
  const r = enc(right);
  const pad = Math.max(1, chars - l.length - r.length);
  return `${l}${' '.repeat(pad)}${r}`;
};
const centre = (s, chars) => {
  const t = enc(s).slice(0, chars);
  const pad = Math.max(0, Math.floor((chars - t.length) / 2));
  return ' '.repeat(pad) + t;
};
const rule = (chars, ch = '-') => ch.repeat(chars);

/** QR code: ESC/POS "store symbol data" + print. Cheap printers fake it well. */
function qrBytes(text) {
  const data = Buffer.from(String(text || ''), 'utf8');
  const len = data.length + 3;
  const pL = len & 0xff, pH = (len >> 8) & 0xff;
  return bytesOf([
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,       // model 2
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x08,             // dot size 8
    GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, data,           // store
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30              // print
  ]);
}

function drawerKick(pin = 2, onTime = 25, offTime = 250) {
  const p = Math.max(0, Math.min(5, Number(pin) || 0));
  return bytesOf([ESC, 0x70, p, Math.max(1, Math.round(Number(onTime) || 25)), Math.max(1, Math.round((Number(offTime) || 250) / 10))]);
}

function cut(full = true) {
  return bytesOf([GS, 0x56, full ? 0x00 : 0x01]);
}

function money(n) {
  return `Ksh ${Number(n || 0).toLocaleString('en-KE')}`;
}

/**
 * A receipt, in bytes. Everything the till shows, in the order a Kenyan
 * receipt is expected to read: shop, lines, VAT, total, payment, QR, drawer.
 */
function receiptBytes({ business = {}, sale = {}, items = [], payments = [], customer = null, profile = {}, receiptLines = [] }) {
  const cfg = profileOf('printer', profile);
  const c = Number(cfg.chars) || 48;
  const out = [];
  out.push([ESC, 0x40]);                                  // init
  out.push([ESC, 0x61, 0x01]);                            // centre
  if (business.name) {
    out.push([ESC, 0x45, 0x01, enc(business.name).slice(0, c), '\n', ESC, 0x45, 0x00]);
  }
  if (business.address) out.push(centre(business.address, c) + '\n');
  if (business.phone) out.push(centre(business.phone, c) + '\n');
  if (business.kraPin) out.push(centre(`PIN: ${business.kraPin}`, c) + '\n');
  out.push('\n');
  out.push([ESC, 0x61, 0x00]);                            // left
  out.push(`${sale.invoice_no || ''}${sale.cashier ? `  ${sale.cashier}` : ''}\n`);
  out.push(`${new Date(sale.paid_at || sale.created_at || Date.now()).toLocaleString('en-KE')}\n`);
  if (customer && customer.name) out.push(`Customer: ${enc(customer.name).slice(0, c - 12)}\n`);
  out.push(rule(c) + '\n');
  for (const it of items) {
    out.push(`${enc(it.name).slice(0, c)}\n`);
    const left = `${Number(it.qty)} x ${money(it.unit_price != null ? it.unit_price : it.price)}`;
    out.push(row(left, money(it.gross != null ? it.gross : it.lineTotal), c) + '\n');
  }
  out.push(rule(c) + '\n');
  out.push(row('Subtotal', money(sale.subtotal), c) + '\n');
  if (Number(sale.discount)) out.push(row('Discount', `-${money(sale.discount)}`, c) + '\n');
  if (Number(sale.tax)) out.push(row('VAT (16%)', money(sale.tax), c) + '\n');
  out.push([ESC, 0x45, 0x01, row('TOTAL', money(sale.gross), c), '\n', ESC, 0x45, 0x00]);
  for (const p of payments || []) out.push(row(String(p.method || '').toUpperCase(), money(p.amount), c) + '\n');
  if (customer && customer.points != null) out.push(row('Points', String(customer.points), c) + '\n');
  out.push('\n');
  out.push([ESC, 0x61, 0x01]);
  if (business.footer) out.push(centre(business.footer, c) + '\n');
  // What this trade's receipt must say that another's does not (a chemist's
  // batch warning, a wines & spirits age notice). The core prints what the
  // modules hand it and never asks which trade it is.
  for (const line of receiptLines || []) out.push(centre(enc(line).slice(0, c), c) + '\n');
  if (cfg.qr && sale.invoice_no) {
    out.push(qrBytes(sale.qr || sale.cuin || sale.invoice_no));
    out.push('\n');
  }
  out.push('\n\n');
  if (cfg.drawer) out.push(drawerKick(cfg.pin, cfg.on_time, cfg.off_time));
  if (cfg.cut) out.push(cut(true));
  return bytesOf(out);
}

/** A shelf label / price tag. The price on it is the shelf price, not a guess. */
function labelBytes({ product = {}, variant = {}, price = 0, profile = {} }) {
  const cfg = profileOf('label', profile);
  if (cfg.driver === 'zpl') return zplLabelBytes({ product, variant, price, cfg });
  const c = Number(cfg.chars) || 32;
  const name = enc(product.name).slice(0, c);
  const out = [];
  out.push([ESC, 0x40]);
  out.push([ESC, 0x61, 0x01, ESC, 0x45, 0x01, name, '\n', ESC, 0x45, 0x00]);
  if (cfg.show_sku && product.sku) out.push(centre(product.sku, c) + '\n');
  out.push([ESC, 0x61, 0x01, ESC, 0x21, 0x30, money(variant.price != null ? variant.price : price), '\n', ESC, 0x21, 0x00]);
  if (cfg.show_barcode && (product.barcode || variant.barcode)) {
    const code = String(product.barcode || variant.barcode);
    out.push([GS, 0x48, 0x02, GS, 0x68, 0x40, GS, 0x6b, 0x45, code.length, code]);
  }
  out.push('\n\n');
  if (cfg.cut) out.push(cut(true));
  return bytesOf(out);
}

function zplLabelBytes({ product = {}, variant = {}, price = 0, cfg = {} }) {
  const name = enc(product.name).slice(0, 28);
  const code = String(product.barcode || variant.barcode || product.sku || '');
  return bytesOf([
    '^XA\n',
    '^CI28\n',
    `^FO20,20^A0N,28,28^FD${name}^FS\n`,
    `^FO20,60^A0N,36,36^FD${money(variant.price != null ? variant.price : price)}^FS\n`,
    code ? `^FO20,110^BY2^BCN,60,Y,N,N^FD${code}^FS\n` : '',
    '^XZ\n'
  ]);
}

/** A test page: proves the profile works before a customer is waiting. */
function testBytes(type, profile = {}) {
  const cfg = profileOf(type, profile);
  if (type === 'drawer') return drawerKick(cfg.pin, cfg.on_time, cfg.off_time);
  if (type === 'label') {
    return labelBytes({
      product: { name: 'Test label', sku: 'TEST-1', barcode: '0000001' },
      variant: { price: 100 }, price: 100, profile: cfg
    });
  }
  if (type === 'display') {
    return bytesOf([0x0c, 'OpenPOS\n', row('Welcome', '0.00', 20), '\n']);
  }
  return receiptBytes({
    business: { name: 'Printer test', address: 'OpenPOS', footer: 'If you can read this, the printer works.' },
    sale: { invoice_no: 'TEST-0001', subtotal: 200, discount: 0, tax: 28, gross: 200, created_at: new Date().toISOString() },
    items: [{ name: 'Test item', qty: 2, unit_price: 100, gross: 200 }],
    payments: [{ method: 'cash', amount: 200 }],
    profile: cfg
  });
}

/**
 * Scales talk in short ASCII frames; two dialects cover most Kenyan counters.
 * Returns null for a frame it cannot trust — a wrong weight is worse than none.
 */
function parseScaleFrame(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  let m = /^([+-]?\d+(?:\.\d+)?)\s*(kg|g|lb)$/i.exec(s);
  if (m) return { weight: Number(m[1]), unit: m[2].toLowerCase(), stable: true };
  m = /^(?:ST|US)?[,;]?(?:GS)?[,;]?([+-]?\d+(?:\.\d+)?)?[,;]?/i.exec(s);
  if (m && /kg|g\b/i.test(s)) {
    const num = /([+-]?\d+(?:\.\d+)?)/.exec(s);
    if (num) return { weight: Number(num[1]), unit: 'kg', stable: /^ST/i.test(s) };
  }
  m = /([+-]?\d+(?:\.\d+)?)/.exec(s.replace(/[^\d.\-+]/g, ''));
  if (m && m[1] !== '' && s.length <= 24) return { weight: Number(m[1]), unit: 'kg', stable: !/^US/i.test(s) };
  return null;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

module.exports = {
  DEVICE_TYPES, DRIVERS, DEFAULTS,
  profileOf, receiptBytes, labelBytes, zplLabelBytes, testBytes,
  drawerKick, cut, qrBytes, parseScaleFrame, bytesOf, toBase64
};

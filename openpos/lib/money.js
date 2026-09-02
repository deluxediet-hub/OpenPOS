'use strict';
// ---------------------------------------------------------------------------
// money.js — all money in WHOLE KES SHILLINGS (integers). No floats, ever.
// Kenyan retail convention: shelf prices are VAT-INCLUSIVE.
// ---------------------------------------------------------------------------

const VAT_RATES = { std: null, zero: 0, exempt: 0 }; // std uses the business rate

function toIntShillings(v, label = 'amount') {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error(`invalid ${label}`);
  return n;
}

/**
 * Split a VAT-inclusive gross amount into net + tax.
 * @param {number} gross  VAT-inclusive total (int shillings)
 * @param {string} taxType 'std' | 'zero' | 'exempt'
 * @param {number} ratePct business VAT rate (e.g. 16)
 */
function lineTax(gross, taxType, ratePct) {
  gross = toIntShillings(gross, 'gross');
  if (gross === 0) return { gross: 0, net: 0, tax: 0 };
  if (!ratePct || taxType === 'zero' || taxType === 'exempt') {
    return { gross, net: gross, tax: 0 };
  }
  const net = Math.round(gross / (1 + ratePct / 100));
  return { gross, net, tax: gross - net };
}

/**
 * Compute a full sale.
 * @param {Array} lines  [{ qty, price (VAT-incl unit), taxType, lineDiscount? (VAT-incl) }]
 * @param {number} vatRate  business VAT rate (16)
 * @param {number} orderDiscount  order-level VAT-inclusive discount
 * @returns {{lines:Array, subtotal:number, discount:number, gross:number, net:number, tax:number,
 *            taxByType:Object}}
 */
function calcSale(lines, vatRate, orderDiscount = 0) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('sale has no lines');
  const L = lines.map((l, i) => {
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`line ${i + 1}: bad qty`);
    const unit = toIntShillings(l.price, `line ${i + 1} price`);
    if (unit < 0) throw new Error(`line ${i + 1}: negative price`);
    const lineDisc = toIntShillings(l.lineDiscount || 0, `line ${i + 1} discount`);
    const gross = Math.round(qty * unit) - lineDisc;
    if (gross < 0) throw new Error(`line ${i + 1}: discount exceeds line total`);
    return { qty, unit, gross, taxType: l.taxType || 'std', lineDiscount: lineDisc };
  });

  const subtotal = L.reduce((s, l) => s + l.gross, 0);
  const disc = Math.min(toIntShillings(orderDiscount, 'order discount'), subtotal);
  if (disc < 0) throw new Error('order discount is negative');

  // Allocate the order discount across lines pro-rata by gross; last line eats the rounding remainder.
  let remaining = disc;
  L.forEach((l, i) => {
    if (i === L.length - 1) {
      l.allocDisc = remaining;
    } else {
      const share = subtotal ? Math.round((disc * l.gross) / subtotal) : 0;
      l.allocDisc = Math.min(share, remaining);
      remaining -= l.allocDisc;
    }
  });

  // Re-derive net/tax after allocation so the receipt breakdown always ties to the gross.
  L.forEach((l) => {
    const t = lineTax(l.gross - l.allocDisc, l.taxType, vatRate);
    l.gross = t.gross;
    l.net = t.net;
    l.tax = t.tax;
  });

  const taxByType = {};
  L.forEach((l) => {
    const k = l.taxType === 'std' ? `VAT ${vatRate}%` : l.taxType === 'zero' ? 'VAT 0%' : 'Exempt';
    if (!taxByType[k]) taxByType[k] = { net: 0, tax: 0 };
    taxByType[k].net += l.net;
    taxByType[k].tax += l.tax;
  });

  return {
    lines: L,
    subtotal,
    discount: disc,
    gross: subtotal - disc,
    net: L.reduce((s, l) => s + l.net, 0),
    tax: L.reduce((s, l) => s + l.tax, 0),
    taxByType
  };
}

module.exports = { toIntShillings, lineTax, calcSale, VAT_RATES };

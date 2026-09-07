'use strict';
// ---------------------------------------------------------------------------
// _kit.js — shared helpers for industry modules (not a module itself: files
// starting with "_" are skipped by the loader's discover()).
//
// Everything here reads the core's own tables through plain SQL. Modules stay
// configuration + hooks; they never fork behaviour (R-M2).
// ---------------------------------------------------------------------------

/** Variant meta merged over product meta (a module field lives in meta JSON). */
function metaOf(product, variant) {
  const pm = parse(product && product.meta);
  const vm = parse(variant && variant.meta);
  return { ...pm, ...vm };
}

function parse(m) {
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m) || {}; } catch { return {}; }
}

/** A variant's axes ({size:'M', colour:'Red'}) — the boutique/footwear identity. */
function axesOf(variant) {
  if (!variant) return {};
  return parse(variant.axes);
}

/** "M" / "Red" / "42" — one axis of a variant, tolerating odd casing. */
function axis(variant, key) {
  const ax = axesOf(variant);
  if (ax[key] !== undefined) return String(ax[key]);
  const k = Object.keys(ax).find((x) => String(x).toLowerCase() === String(key).toLowerCase());
  return k ? String(ax[k]) : '';
}

/** Sales rows for a set of branches inside a window (paid/partial only). */
function saleRows(d, { from, to, branches }) {
  if (!branches || !branches.length) return [];
  const ph = branches.map(() => '?').join(',');
  return d.prepare(`
    SELECT si.id AS sale_item_id, si.sale_id, si.product_id, si.variant_id, si.qty,
           si.gross, si.net, si.unit_price, si.line_discount, s.created_at, s.branch_id,
           p.name AS product_name
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
     WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
       AND s.created_at >= ? AND s.created_at <= ?
     ORDER BY s.created_at DESC
  `).all(...branches, from, to);
}

/** Stock on hand per variant across a branch's locations. */
function stockByVariant(d, branchIds) {
  if (!branchIds || !branchIds.length) return new Map();
  const ph = branchIds.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT v.id AS variant_id, v.product_id, COALESCE(SUM(st.qty), 0) AS qty
      FROM variants v
      JOIN stock st ON st.variant_id = v.id
      JOIN locations l ON l.id = st.location_id
     WHERE l.branch_id IN (${ph}) AND v.active = 1
     GROUP BY v.id
  `).all(...branchIds);
  return new Map(rows.map((r) => [r.variant_id, r]));
}

/** Units sold per variant in the window. */
function soldByVariant(d, opts) {
  const rows = saleRows(d, opts);
  const out = new Map();
  for (const r of rows) {
    const cur = out.get(r.variant_id) || { qty: 0, gross: 0, sales: 0 };
    cur.qty += r.qty;
    cur.gross += r.gross;
    cur.sales += 1;
    out.set(r.variant_id, cur);
  }
  return out;
}

/** Cost of a variant (variant override wins, else the product's). */
function unitCost(variant, product) {
  const c = variant && variant.cost != null ? variant.cost : (product ? product.cost : 0);
  return Number(c || 0);
}

function unitPrice(variant, product) {
  const p = variant && variant.price != null ? variant.price : (product ? product.price : 0);
  return Number(p || 0);
}

/** Days between two ISO dates (whole days, negative when in the future). */
function daysUntil(isoDate) {
  if (!isoDate) return null;
  const a = new Date(String(isoDate).slice(0, 10) + 'T00:00:00Z').getTime();
  const b = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((a - b) / 86400000);
}

/** An expiry bucket: expired / 30 / 60 / 90 / ok. */
function expiryBucket(daysLeft) {
  if (daysLeft === null) return 'none';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 30) return 'd30';
  if (daysLeft <= 60) return 'd60';
  if (daysLeft <= 90) return 'd90';
  return 'ok';
}

/** Percentage margin on a tax-inclusive price (integer, 0-100). */
function marginPct(price, cost) {
  const p = Number(price || 0);
  if (!p) return 0;
  return Math.round(((p - Number(cost || 0)) / p) * 100);
}

/** Rows the shell renders as a table, with a stable column order. */
function table(rows, columns) {
  return { columns, rows };
}

module.exports = {
  metaOf, parse, axesOf, axis, saleRows, stockByVariant, soldByVariant,
  unitCost, unitPrice, daysUntil, expiryBucket, marginPct, table
};

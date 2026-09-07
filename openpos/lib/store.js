'use strict';
// ---------------------------------------------------------------------------
// store.js — the online storefront's stock rules (Phase 26).
//
// Omni-channel is one promise: the website and the till sell the SAME units,
// at the SAME prices, to the SAME customer. Nothing here forks the engine —
// the storefront's cart is a held sale and its checkout is a payment.
//
// The one new idea is a RESERVATION: a web cart holds stock for a short window
// instead of taking it. Money has not moved, so the stock must not either,
// but the customer has been shown "2 in stock" and must not be embarrassed at
// the door. A reservation expires by itself — an abandoned cart gives the
// shelf its stock back.
// ---------------------------------------------------------------------------

const WINDOW_MINUTES = 15;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Reservations that still hold stock right now. */
function releaseExpired(d) {
  const now = new Date().toISOString();
  const r = d
    .prepare('UPDATE store_reservations SET released_at = ? WHERE released_at IS NULL AND expires_at < ?')
    .run(now, now);
  return r.changes || 0;
}

/**
 * `ownToken` is the basket asking: what I already hold does not block me —
 * otherwise a cart could never be rebuilt and an order could never be paid.
 */
function reservedQty(d, variantId, locationId, ownToken = null) {
  const now = new Date().toISOString();
  const row = d
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS q FROM store_reservations
        WHERE variant_id = ? AND location_id = ? AND released_at IS NULL AND expires_at >= ?
          AND (? IS NULL OR token <> ?)`
    )
    .get(variantId, locationId, now, ownToken || null, ownToken || null);
  return Number(row ? row.q : 0);
}

/** What a channel may actually promise a customer: on hand minus promises. */
function sellableQty(d, dbm, variantId, locationId, ownToken = null) {
  const row = d.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE variant_id = ? AND location_id = ?').get(variantId, locationId);
  const onHand = Number(row ? row.q : 0);
  const held = reservedQty(d, variantId, locationId, ownToken);
  return { onHand, held, available: Math.max(0, onHand - held) };
}

function reserve(d, { saleId, token, variantId, locationId, qty }) {
  const now = new Date();
  const expires = new Date(now.getTime() + WINDOW_MINUTES * 60 * 1000).toISOString();
  const id = d
    .prepare(
      `INSERT INTO store_reservations (business_id, sale_id, token, variant_id, location_id, qty, expires_at, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(saleId || null, token, variantId, locationId, qty, expires, now.toISOString()).lastInsertRowid;
  return d.prepare('SELECT * FROM store_reservations WHERE id = ?').get(id);
}

/** Give the shelf its stock back — on payment, on cancel, on expiry. */
function release(d, { token = null, saleId = null }) {
  const now = new Date().toISOString();
  if (token) {
    return d.prepare('UPDATE store_reservations SET released_at = ? WHERE token = ? AND released_at IS NULL').run(now, token).changes || 0;
  }
  if (saleId) {
    return d.prepare('UPDATE store_reservations SET released_at = ? WHERE sale_id = ? AND released_at IS NULL').run(now, saleId).changes || 0;
  }
  return 0;
}

function newToken() {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The shopfront catalogue: what we sell, at which price, and how much of it a
 * customer can honestly be promised.
 */
function catalogue(d, dbm, { search = '', limit = 60 } = {}) {
  releaseExpired(d);
  const q = String(search || '').trim();
  const rows = d
    .prepare(
      `SELECT p.id, p.name, p.sku, p.brand, p.unit, p.tax_type, p.image,
              v.id AS variant_id, COALESCE(v.price, p.price) AS price
         FROM products p JOIN variants v ON v.product_id = p.id AND COALESCE(v.axes_key, '{}') = '{}'
        WHERE p.active = 1 AND v.active = 1
          AND (? = '' OR LOWER(p.name) LIKE '%' || LOWER(?) || '%' OR LOWER(p.sku) LIKE '%' || LOWER(?) || '%' OR LOWER(COALESCE(p.brand, '')) LIKE '%' || LOWER(?) || '%')
        ORDER BY p.name LIMIT ?`
    )
    .all(q, q, q, q, Number(limit) || 60);
  const loc = sellingLocation(d);
  return rows.map((r) => {
    const s = sellableQty(d, dbm, r.variant_id, loc);
    return { ...r, price: Math.round(Number(r.price || 0)), available: s.available, location_id: loc };
  });
}

/** Web orders are booked against the shop's own selling location. */
function sellingLocation(d) {
  const row = d.prepare('SELECT id FROM locations WHERE active = 1 AND COALESCE(is_warehouse, 0) = 0 ORDER BY is_default DESC, id LIMIT 1').get();
  return row ? row.id : 1;
}

function cartByToken(d, token) {
  const t = String(token || '').trim();
  if (!t) throw httpError(400, 'a cart token is required');
  const sale = d.prepare("SELECT * FROM sales WHERE client_id = ? AND channel = 'web' ORDER BY id DESC LIMIT 1").get(t);
  if (!sale) throw httpError(404, 'no such cart — it may have expired');
  return sale;
}

function cartState(d, dbm, token) {
  const sale = cartByToken(d, token);
  const items = d
    .prepare('SELECT si.*, p.name, p.sku FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?')
    .all(sale.id);
  // The window comes from the reservations, live or already released: a cart
  // whose promise has lapsed must not quietly re-sell stock someone else took.
  const res = d.prepare('SELECT * FROM store_reservations WHERE token = ? ORDER BY id').all(token);
  const expiresAt = res.length ? res.map((r) => r.expires_at).sort().pop() : null;
  return {
    token,
    sale,
    items: items.map((i) => ({
      variant_id: i.variant_id, product_id: i.product_id, name: i.name, sku: i.sku,
      qty: i.qty, unit_price: i.unit_price, gross: i.gross
    })),
    gross: sale.gross,
    expires_at: expiresAt,
    expired: !!(expiresAt && new Date(expiresAt) < new Date())
  };
}

/**
 * Orders waiting to be picked, paid or cancelled — the shop's side of the
 * storefront, so a web order is never a mystery to the till.
 */
function orders(d, { status = 'all', limit = 50 } = {}) {
  const where = ["channel IN ('web', 'whatsapp')"];
  const args = [];
  if (status === 'unpaid') where.push("status = 'suspended'");
  if (status === 'paid') where.push("status = 'paid'");
  return d
    .prepare(`SELECT * FROM sales WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args, Number(limit) || 50);
}

module.exports = {
  WINDOW_MINUTES,
  releaseExpired, reservedQty, sellableQty, reserve, release,
  newToken, catalogue, sellingLocation, cartByToken, cartState, orders
};

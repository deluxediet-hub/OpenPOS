'use strict';
// ---------------------------------------------------------------------------
// loyalty.js — points that behave like money (Phase 24).
//
// A point has a shilling value, so redeeming points is a tender like any other:
// it goes through the payment engine, it is bounded by the customer's balance,
// and it can never take a sale below zero or above what the shop allows.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled: false,
  points_per_100: 1,      // 1 point for every 100 KES spent
  point_value: 1,         // 1 point = 1 KES at the till
  min_redeem_points: 0,
  max_redeem_pct: 50      // never more than half a basket on points
};

function settings(d, dbm) {
  const s = (dbm.getSetting(d, 'loyalty', {}) || {});
  return {
    enabled: !!s.enabled,
    points_per_100: Number(s.points_per_100) > 0 ? Number(s.points_per_100) : DEFAULTS.points_per_100,
    point_value: Number(s.point_value) > 0 ? Number(s.point_value) : DEFAULTS.point_value,
    min_redeem_points: Math.max(0, Number(s.min_redeem_points) || 0),
    max_redeem_pct: Math.min(100, Math.max(0, Number(s.max_redeem_pct) || 0))
  };
}

/** Points a customer holds right now (the log is the truth). */
function balance(d, customerId) {
  const row = d.prepare('SELECT COALESCE(SUM(points), 0) AS p FROM loyalty_log WHERE customer_id = ?').get(customerId);
  return Number((row && row.p) || 0);
}

/** What those points are worth at the till. */
function shillingValue(d, dbm, customerId) {
  const s = settings(d, dbm);
  return Math.max(0, Math.floor(balance(d, customerId) * s.point_value));
}

/** Points earned by a basket (net of discounts, tax-inclusive like the till). */
function pointsFor(d, dbm, netShillings) {
  const s = settings(d, dbm);
  const n = Math.max(0, Math.round(Number(netShillings) || 0));
  return Math.floor((n * s.points_per_100) / 100);
}

function log(d, { customerId, saleId = null, points, type, note = '', userId = null, now }) {
  return d.prepare(
    `INSERT INTO loyalty_log (customer_id, sale_id, points, type, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(customerId, saleId, points, type, now || new Date().toISOString()).lastInsertRowid;
}

/** Award points for a paid sale — once, and only while loyalty is on. */
function earn(d, dbm, { customerId, saleId, net, userId = null, now }) {
  const s = settings(d, dbm);
  if (!s.enabled || !customerId) return 0;
  const already = d.prepare("SELECT id FROM loyalty_log WHERE sale_id = ? AND type = 'earn'").get(saleId);
  if (already) return 0;
  const pts = pointsFor(d, dbm, net);
  if (pts <= 0) return 0;
  log(d, { customerId, saleId, points: pts, type: 'earn', userId, now });
  return pts;
}

/**
 * Validate a loyalty redemption BEFORE the payment engine sees it.
 * Returns the points to spend; throws httpError(400/403) if it is not allowed.
 */
function checkRedeem(d, dbm, { customer, sale, amount, paid = 0 }) {
  const s = settings(d, dbm);
  if (!s.enabled) throw httpError(400, 'loyalty points are switched off');
  if (!customer) throw httpError(400, 'loyalty points need a customer on the sale');
  const shillings = Math.round(Number(amount));
  if (!Number.isFinite(shillings) || shillings <= 0) {
    throw httpError(400, 'loyalty tender must be a positive amount');
  }
  const held = balance(d, customer.id);
  const worth = Math.max(0, Math.floor(held * s.point_value));
  if (shillings > worth) {
    throw httpError(400, `${customer.name} has ${held} points (${worth} KES) — not ${shillings}`);
  }
  if (s.min_redeem_points && held < s.min_redeem_points) {
    throw httpError(400, `points can only be spent from ${s.min_redeem_points} upwards`);
  }
  const gross = Math.round(Number(sale.gross) || 0);
  const cap = s.max_redeem_pct ? Math.floor((gross * s.max_redeem_pct) / 100) : gross;
  if (shillings > cap) {
    throw httpError(400, `at most ${s.max_redeem_pct}% of this sale (${cap} KES) can be paid with points`);
  }
  const due = Math.max(0, gross - Math.round(Number(paid) || 0));
  if (shillings > due) {
    throw httpError(400, `${shillings} is more than the ${due} still owed on this sale`);
  }
  // Points are spent in whole points; any remainder stays with the customer.
  return Math.ceil(shillings / s.point_value);
}

function spend(d, dbm, { customer, saleId, points, userId = null, now }) {
  return log(d, { customerId: customer.id, saleId, points: -Math.abs(points), type: 'redeem', userId, now });
}

function history(d, customerId, limit = 50) {
  return d.prepare('SELECT * FROM loyalty_log WHERE customer_id = ? ORDER BY id DESC LIMIT ?').all(customerId, limit);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  DEFAULTS, settings, balance, shillingValue, pointsFor,
  earn, checkRedeem, spend, history, log
};

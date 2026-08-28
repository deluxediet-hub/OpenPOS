'use strict';
/**
 * domain.js — business rules kept as pure functions so they can be tested
 * without a database or an HTTP server.
 */

const round = (n) => Math.round(n + Number.EPSILON);

/* ============================ DAYPART PRICING ============================ */

/**
 * Is `t` (minutes since midnight) inside [start, end)?
 * Handles ranges that wrap past midnight, e.g. 17:00 → 02:00.
 */
function inTimeRange(t, start, end) {
  if (start === end) return false;
  if (start < end) return t >= start && t < end;
  return t >= start || t < end;           // wraps midnight
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * Find every daypart active at `when`. A wrapping range (17:00–02:00) is
 * active after 02:00 only if *yesterday* was one of its days.
 */
function activeDayparts(dayparts, when = new Date()) {
  const t = when.getHours() * 60 + when.getMinutes();
  const dow = when.getDay();
  const yDow = new Date(when.getTime() - 86400000).getDay();

  return dayparts.filter((d) => {
    if (d.active === 0 || d.active === false) return false;
    const days = String(d.days).split(',').map(Number);
    const s = toMinutes(d.start_time), e = toMinutes(d.end_time);
    if (s < e) return days.includes(dow) && inTimeRange(t, s, e);
    /* wraps: either late today, or early tomorrow-of-yesterday */
    return (days.includes(dow) && t >= s) || (days.includes(yDow) && t < e);
  });
}

/**
 * Best discount available for an item right now.
 * Category-specific rules beat whole-menu rules; largest discount wins.
 */
function bestDiscountFor(item, dayparts, when = new Date()) {
  const active = activeDayparts(dayparts, when);
  let best = null;
  for (const d of active) {
    if (d.category_id && d.category_id !== item.category_id) continue;
    if (d.station && d.station !== item.station) continue;
    if (!best || Number(d.discount_pct) > Number(best.discount_pct)) best = d;
  }
  return best;
}

/** Price after the daypart discount. Integer cents, never below zero. */
function discountedPrice(price, discountPct) {
  if (!discountPct) return round(price);
  return Math.max(0, round(price * (1 - Number(discountPct) / 100)));
}

/* ============================== LOYALTY ================================== */

/** Points earned on a spend, given "1 point per N shillings". */
function pointsEarned(totalCents, earnPerShilling) {
  const per = Number(earnPerShilling) || 0;
  if (!per) return 0;
  return Math.floor(totalCents / 100 / per);
}

/** Cap a redemption at the customer's balance and at the bill total. */
function pointsToRedeem(requestedPoints, availablePoints, billTotalCents, valuePerPointShillings) {
  const val = Number(valuePerPointShillings) || 0;
  if (!val) return { points: 0, value: 0 };
  const pts = Math.max(0, Math.min(Number(requestedPoints) || 0, availablePoints || 0));
  const value = Math.min(pts * val * 100, billTotalCents);
  return { points: Math.floor(value / (val * 100)), value };
}

/* ========================== CASH DRAWER ================================= */

/**
 * Expected cash in the drawer at close.
 *   float + cash sales - cash refunds - payouts
 * Variance is what the cashier counted minus what should be there.
 */
function expectedCash({ openingFloat = 0, cashSales = 0, cashRefunds = 0, payouts = 0 }) {
  return openingFloat + cashSales - cashRefunds - payouts;
}
function drawerVariance(counted, expected) {
  return (Number(counted) || 0) - (Number(expected) || 0);
}

/** Expected balance for any tender account. Refunds/expenses are positive
 * outflow values, matching the existing drawer reconciliation contract. */
function expectedTender({ opening = 0, sales = 0, refunds = 0, expenses = 0 }) {
  return Number(opening || 0) + Number(sales || 0) - Number(refunds || 0) - Number(expenses || 0);
}

/** Authoritative reconciliation classification for API close and UI preview.
 * `stockVariance=null` means the stock scope was not counted; it must never be
 * silently treated as a zero whole-shop variance. */
function reconcile({ cashVariance = 0, mpesaVariance = 0, cardVariance = 0,
  stockVariance = null, stockCoverage = 'none', tolerance = 0, critical = 0 }) {
  const cash = Number(cashVariance) || 0, mpesa = Number(mpesaVariance) || 0, card = Number(cardVariance) || 0;
  const tenderVariance = cash + mpesa + card;
  const coverage = ['full', 'partial'].includes(stockCoverage) ? stockCoverage : 'none';
  const hasStock = stockVariance !== null && stockVariance !== undefined && coverage !== 'none';
  const stock = hasStock ? Number(stockVariance) || 0 : null;
  const overallVariance = hasStock ? tenderVariance + stock : null;
  const tol = Math.max(0, Number(tolerance) || 0);
  const crit = Math.max(tol, Number(critical) || 0);
  const tenderBalanced = [cash, mpesa, card].every((v) => Math.abs(v) <= tol);
  const stockBalanced = !hasStock || Math.abs(stock) <= tol;
  let status;

  if (coverage === 'none') {
    if (tenderBalanced) status = 'TENDERS BALANCED — STOCK NOT COUNTED';
    else if (tenderVariance < -crit) status = 'CRITICAL TENDER SHORTAGE — STOCK NOT COUNTED';
    else if (tenderVariance > crit) status = 'CRITICAL TENDER OVERAGE — STOCK NOT COUNTED';
    else status = tenderVariance < 0 ? 'TENDER SHORTAGE — STOCK NOT COUNTED' : 'TENDER OVERAGE — STOCK NOT COUNTED';
  } else if (coverage === 'partial') {
    if (tenderBalanced && stockBalanced) status = 'TENDERS BALANCED — PARTIAL STOCK COUNT';
    else if (Math.abs(overallVariance) <= tol && tenderVariance > tol && stock < -tol)
      status = 'SCOPED RECONCILED — POSSIBLE UNRECORDED SALES';
    else if (Math.abs(overallVariance) <= tol) status = 'SCOPED RECONCILED — OFFSETTING VARIANCES';
    else if (overallVariance < -crit) status = 'CRITICAL SCOPED SHORTAGE';
    else if (overallVariance > crit) status = 'CRITICAL SCOPED OVERAGE';
    else status = overallVariance < 0 ? 'SCOPED SHORTAGE — INVESTIGATE' : 'SCOPED OVERAGE — INVESTIGATE';
  } else {
    if (tenderBalanced && stockBalanced) status = 'FULLY BALANCED';
    else if (Math.abs(overallVariance) <= tol && tenderVariance > tol && stock < -tol)
      status = 'RECONCILED — POSSIBLE UNRECORDED SALES';
    else if (Math.abs(overallVariance) <= tol) status = 'RECONCILED — OFFSETTING VARIANCES';
    else if (overallVariance < -crit) status = 'CRITICAL SHORTAGE';
    else if (overallVariance > crit) status = 'CRITICAL OVERAGE';
    else status = overallVariance < 0 ? 'SHORTAGE — INVESTIGATE' : 'OVERAGE — INVESTIGATE';
  }

  return {
    cash_variance: cash, mpesa_variance: mpesa, card_variance: card,
    tender_variance: tenderVariance, stock_retail_variance: stock,
    overall_variance: overallVariance, stock_coverage: coverage, status,
    requires_note: !tenderBalanced || (hasStock && !stockBalanced), tolerance: tol
  };
}

/* ============================== RECIPES ================================= */

/**
 * Stock movements implied by an order's lines.
 * Returns [{ stock_item_id, qty }] aggregated across the whole order.
 */
function stockMovementsFor(items, recipes) {
  const out = new Map();
  for (const line of items) {
    if (line.status === 'void') continue;
    for (const r of recipes) {
      if (r.menu_item_id !== line.menu_item_id) continue;
      const need = Number(r.qty) * Number(line.qty);
      if (!need) continue;
      out.set(r.stock_item_id, (out.get(r.stock_item_id) || 0) + need);
    }
  }
  return [...out.entries()].map(([stock_item_id, qty]) => ({ stock_item_id, qty }));
}

/* ============================== LABOUR =================================== */

const HOURS = (a, b) => (new Date(String(b).replace(' ', 'T')) - new Date(String(a).replace(' ', 'T'))) / 3600000;

function labourCost(entries, users) {
  const rateOf = (id) => {
    const u = users.find((x) => x.id === id);
    return u && u.hourly_rate ? u.hourly_rate : 0;   // cents/hour
  };
  let hours = 0, cost = 0;
  for (const e of entries) {
    if (!e.clock_out) continue;
    const h = HOURS(e.clock_in, e.clock_out);
    if (h <= 0 || h > 24) continue;                 // guard against bad punches
    hours += h;
    cost += h * rateOf(e.user_id);
  }
  return { hours: Math.round(hours * 100) / 100, cost: round(cost) };
}

/** Labour as a percentage of net sales — the number operators actually watch. */
function labourPct(labourCents, salesCents) {
  if (!salesCents) return 0;
  return Math.round((labourCents / salesCents) * 1000) / 10;
}

/* =========================== GIFT CARDS ================================= */

function randomGiftCode(prefix = 'SRN') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1 — easy to read aloud
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

module.exports = {
  inTimeRange, toMinutes, activeDayparts, bestDiscountFor, discountedPrice,
  pointsEarned, pointsToRedeem,
  expectedCash, drawerVariance, expectedTender, reconcile,
  stockMovementsFor,
  labourCost, labourPct, HOURS,
  randomGiftCode, round
};

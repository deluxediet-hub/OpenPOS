'use strict';
// ---------------------------------------------------------------------------
// promos.js — the promotions engine (Phase 24).
//
// One engine for every kind of offer a Kenyan shop actually runs:
//   pct     % off a line, a category, a product or the whole basket
//   fixed   shillings off the basket (with a minimum spend)
//   bogo    buy N get M free — the free units are the cheapest ones
//   bundle  a set of items for one price ("tea + bread + milk 250")
//   time    happy hour: % off inside a time window, every day
//   coupon  any of the above, but only when the cashier keys the code
//
// Rules:
//   • money is integer shillings, and a line never goes below zero (R-PR)
//   • an automatic offer needs no permission; a manual discount still does
//   • offers do not stack unless they say so — the best one wins
//   • every application is recorded, so a campaign can be judged afterwards
// ---------------------------------------------------------------------------

const TYPES = ['pct', 'fixed', 'bogo', 'bundle', 'time'];
const APPLIES = ['all', 'category', 'product', 'variant', 'customer', 'tier', 'segment', 'bundle'];

const DEFAULTS = {
  pct: { value: 10, applies_to: 'all' },
  fixed: { value: 100, applies_to: 'all', min_spend: 0 },
  bogo: { buy_qty: 2, get_qty: 1, applies_to: 'all' },
  bundle: { value: 0, applies_to: 'bundle' },
  time: { value: 10, applies_to: 'all' }
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---- validation & CRUD helpers ---------------------------------------------

/** Parse + validate a promo from a request body. Throws httpError(400). */
function cleanPromo(b, existing = null) {
  const type = String((b && b.type) || (existing && existing.type) || '').trim();
  if (!TYPES.includes(type)) throw httpError(400, `type must be one of ${TYPES.join(', ')}`);
  const appliesTo = String((b && b.applies_to) || (existing && existing.applies_to) || DEFAULTS[type].applies_to).trim();
  if (!APPLIES.includes(appliesTo)) throw httpError(400, `applies_to must be one of ${APPLIES.join(', ')}`);
  const appliesRef = String((b && b.applies_ref) !== undefined && b.applies_ref !== null ? b.applies_ref : (existing ? existing.applies_ref : '')).trim();

  const int = (v, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) throw httpError(400, `${v} is not a number`);
    return Math.round(n);
  };

  const value = int(b && b.value !== undefined ? b.value : (existing ? existing.value : DEFAULTS[type].value), DEFAULTS[type].value || 0);
  if (value < 0) throw httpError(400, 'value cannot be negative');
  if (type === 'pct' && value > 100) throw httpError(400, 'a percentage offer cannot exceed 100%');
  if (type === 'bogo') {
    if (int(b && b.buy_qty, existing ? existing.buy_qty : 2) < 1) throw httpError(400, 'buy_qty must be at least 1');
    if (int(b && b.get_qty, existing ? existing.get_qty : 1) < 1) throw httpError(400, 'get_qty must be at least 1');
  }
  if (type === 'bundle' && appliesTo !== 'bundle') throw httpError(400, 'a bundle offer applies_to "bundle"');
  if (type === 'bundle' && !appliesRef) throw httpError(400, 'a bundle needs its items (applies_ref, e.g. "12:2,15:1")');

  // An empty field is no field at all: never store the STRING "null".
  const code = b && b.code !== undefined && b.code !== null ? String(b.code).trim().toUpperCase() : (existing ? existing.code || '' : '');
  const start = b && b.start_date !== undefined ? str(b.start_date) : (existing ? existing.start_date : null);
  const end = b && b.end_date !== undefined ? str(b.end_date) : (existing ? existing.end_date : null);
  if (start && end && end < start) throw httpError(400, 'end date is before the start date');
  const timeStart = b && b.time_start !== undefined && b.time_start !== null ? String(b.time_start).trim() : (existing ? existing.time_start : null);
  const timeEnd = b && b.time_end !== undefined && b.time_end !== null ? String(b.time_end).trim() : (existing ? existing.time_end : null);

  return {
    name: String((b && b.name) || (existing && existing.name) || '').trim(),
    type,
    value,
    applies_to: appliesTo,
    applies_ref: appliesRef,
    code: code || null,
    start_date: start || null,
    end_date: end || null,
    time_start: timeStart || null,
    time_end: timeEnd || null,
    max_uses: b && b.max_uses !== undefined ? int(b.max_uses, null) : (existing ? existing.max_uses : null),
    min_spend: int(b && b.min_spend !== undefined ? b.min_spend : (existing ? existing.min_spend : 0), 0),
    buy_qty: type === 'bogo' ? int(b && b.buy_qty, existing ? existing.buy_qty : 2) : null,
    get_qty: type === 'bogo' ? int(b && b.get_qty, existing ? existing.get_qty : 1) : null,
    stackable: (b && b.stackable !== undefined ? b.stackable : (existing ? existing.stackable : 0)) ? 1 : 0,
    priority: int(b && b.priority !== undefined ? b.priority : (existing ? existing.priority : 0), 0),
    tier: (b && b.tier !== undefined ? String(b.tier || '').trim() : (existing ? existing.tier : '')) || null,
    updated_at: new Date().toISOString()
  };
}

function str(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).slice(0, 10);
}

function insertPromo(d, row, { userId = null, branchId = null } = {}) {
  const now = new Date().toISOString();
  const id = d
    .prepare(
      `INSERT INTO promos (branch_id, name, type, value, applies_to, applies_ref, code, start_date, end_date,
         max_uses, uses, active, min_spend, buy_qty, get_qty, stackable, priority, tier, time_start, time_end,
         created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(branchId, row.name, row.type, row.value, row.applies_to, row.applies_ref, row.code,
      row.start_date, row.end_date, row.max_uses, row.min_spend, row.buy_qty, row.get_qty,
      row.stackable, row.priority, row.tier, row.time_start, row.time_end, now, now, userId).lastInsertRowid;
  return id;
}

function updatePromo(d, id, row) {
  d.prepare(
    `UPDATE promos SET name = ?, type = ?, value = ?, applies_to = ?, applies_ref = ?, code = ?, start_date = ?, end_date = ?,
       max_uses = ?, min_spend = ?, buy_qty = ?, get_qty = ?, stackable = ?, priority = ?, tier = ?,
       time_start = ?, time_end = ?, updated_at = ?
     WHERE id = ?`
  ).run(row.name, row.type, row.value, row.applies_to, row.applies_ref, row.code, row.start_date, row.end_date,
    row.max_uses, row.min_spend, row.buy_qty, row.get_qty, row.stackable, row.priority, row.tier,
    row.time_start, row.time_end, row.updated_at, id);
}

// ---- matching --------------------------------------------------------------

function windowOpen(p, now) {
  const today = now.toISOString().slice(0, 10);
  if (p.start_date && today < p.start_date) return false;
  if (p.end_date && today > p.end_date) return false;
  return true;
}

function timeOpen(p, now) {
  if (!p.time_start && !p.time_end) return true;
  const hhmm = now.toISOString().slice(11, 16);
  if (p.time_start && hhmm < p.time_start) return false;
  if (p.time_end && hhmm > p.time_end) return false;
  return true;
}

function usesLeft(p) {
  return p.max_uses === null || p.max_uses === undefined ? Infinity : Math.max(0, Number(p.max_uses) - Number(p.uses || 0));
}

/** Does the offer cover this line? (product/category/variant scope) */
function lineMatches(p, line) {
  const ref = String(p.applies_ref || '');
  switch (p.applies_to) {
    case 'all': return true;
    case 'category': return String(line.product.category_id) === ref;
    case 'product': return String(line.product.id) === ref;
    case 'variant': return String(line.variant.id) === ref;
    case 'bundle': return bundleRef(p).some((b) => String(b.variantId) === String(line.variant.id));
    default: return true;      // customer / tier / segment scope is checked once per sale
  }
}

/** "12:2,15:1" → [{variantId:12, qty:2}, {variantId:15, qty:1}] */
function bundleRef(p) {
  return String(p.applies_ref || '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [variantId, qty] = part.split(':');
    return { variantId: Number(variantId), qty: Number(qty || 1) };
  }).filter((b) => Number.isFinite(b.variantId));
}

/** Does the offer cover this customer? (customer / tier / segment scope) */
function customerMatches(d, p, customer, segmentOf) {
  switch (p.applies_to) {
    case 'customer': return !!customer && String(customer.id) === String(p.applies_ref);
    case 'tier': {
      if (!customer) return false;
      const tier = String(p.tier || p.applies_ref || '').trim();
      return String(customer.tier || 'standard') === tier;
    }
    case 'segment': {
      if (!customer || !segmentOf) return false;
      const name = String(p.applies_ref || '').trim();
      return segmentOf(customer.id, name);
    }
    default: return true;
  }
}

// ---- evaluation ------------------------------------------------------------

/**
 * Work out what the active offers do to a basket.
 * @returns {{applied:Array, lineDiscounts:Map<number,number>, orderDiscount:number}}
 *          lineDiscounts is keyed by line index, in shillings (tax-inclusive,
 *          exactly like a manual line discount).
 */
function evaluate(d, { lines, customer = null, branchId = null, codes = [], now = new Date(), segmentOf = null, enabled = true }) {
  const out = { applied: [], lineDiscounts: new Map(), orderDiscount: 0 };
  if (!enabled || !lines.length) return out;

  const basketLines = lines.map((L, i) => ({ i, L }));
  const subtotal = lines.reduce((s2, L) => s2 + Math.round(L.unitPrice * L.qty) - (L.disc || 0), 0);

  const wanted = new Set((codes || []).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean));
  const rows = d.prepare('SELECT * FROM promos WHERE active = 1 AND (branch_id IS NULL OR branch_id = ?) ORDER BY priority DESC, id').all(branchId);

  const candidates = [];
  for (const p of rows) {
    if (!windowOpen(p, now)) continue;
    if (p.type === 'time' && !timeOpen(p, now)) continue;
    if (usesLeft(p) <= 0) continue;
    if (!customerMatches(d, p, customer, segmentOf)) continue;
    // A coupon only fires when the code was keyed; an automatic offer never
    // asks for one.
    if (p.code) {
      if (!wanted.has(String(p.code).toUpperCase())) continue;
    } else if (p.applies_to === 'customer' || p.applies_to === 'tier' || p.applies_to === 'segment') {
      // targeted automatic offers are fine
    }
    if (p.min_spend && subtotal < Number(p.min_spend)) continue;
    candidates.push(p);
  }

  // Each candidate is priced against the basket as it stands; non-stackable
  // offers compete and the biggest win is kept.
  let taken = 0;
  const proposals = [];
  for (const p of candidates) {
    const plan = price(p, basketLines, lines, subtotal);
    if (!plan || plan.amount <= 0) continue;
    proposals.push({ p, ...plan });
  }
  proposals.sort((a, b) => b.amount - a.amount);
  for (const prop of proposals) {
    const room = roomLeft(lines, out.lineDiscounts);
    if (room <= 0) break;
    const amount = Math.min(prop.amount, room);
    if (amount <= 0) continue;
    if (taken > 0 && !prop.p.stackable) continue;      // first non-stackable wins
    applyPlan(prop, amount, lines, out);
    out.applied.push({
      promo_id: prop.p.id, name: prop.p.name, type: prop.p.type,
      code: prop.p.code || null, amount, lines: prop.lines.map((x) => x.i)
    });
    if (!prop.p.stackable) { taken++; break; }
    taken++;
  }
  return out;
}

/** Shillings still available to discount across the basket. */
function roomLeft(lines, lineDiscounts) {
  let room = 0;
  lines.forEach((L, i) => {
    const gross = Math.round(L.unitPrice * L.qty);
    room += Math.max(0, gross - (L.disc || 0) - (lineDiscounts.get(i) || 0));
  });
  return room;
}

/** What would this offer take off, and from which lines? */
function price(p, basketLines, lines, subtotal) {
  const matched = basketLines.filter(({ L }) => lineMatches(p, L));
  if (!matched.length) return null;

  switch (p.type) {
    case 'pct':
    case 'time': {
      const rate = Number(p.value || 0);
      let amount = 0;
      const hit = [];
      for (const { i, L } of matched) {
        const gross = Math.round(L.unitPrice * L.qty) - (L.disc || 0);
        const off = Math.min(gross, Math.round((gross * rate) / 100));
        if (off > 0) { amount += off; hit.push({ i, amount: off }); }
      }
      return amount > 0 ? { amount, lines: hit, kind: 'line' } : null;
    }
    case 'fixed': {
      const amount = Math.min(subtotal, Number(p.value || 0));
      return amount > 0 ? { amount, lines: basketLines.map(({ i }) => ({ i, amount: 0 })), kind: 'order' } : null;
    }
    case 'bogo': {
      const buy = Math.max(1, Number(p.buy_qty || 2));
      const get = Math.max(1, Number(p.get_qty || 1));
      let amount = 0;
      const hit = [];
      for (const { i, L } of matched) {
        const q = Number(L.qty);
        if (!Number.isInteger(q)) continue;                 // BOGO counts units
        const groups = Math.floor(q / (buy + get));
        const freeUnits = Math.min(groups * get, q - 1);
        const off = Math.min(Math.round(L.unitPrice * q) - (L.disc || 0), Math.round(L.unitPrice * freeUnits));
        if (off > 0) { amount += off; hit.push({ i, amount: off }); }
      }
      return amount > 0 ? { amount, lines: hit, kind: 'line' } : null;
    }
    case 'bundle': {
      // Every item of the bundle present, in the right quantity → one price.
      const want = bundleRef(p);
      const have = new Map(matched.map(({ i, L }) => [String(L.variant.id), { i, L }]));
      let complete = true;
      let normal = 0;
      for (const w of want) {
        const entry = have.get(String(w.variantId));
        if (!entry || Number(entry.L.qty) < Number(w.qty)) { complete = false; break; }
        normal += Math.round(entry.L.unitPrice * Number(w.qty));
      }
      if (!complete) return null;
      const target = Number(p.value || 0);
      const amount = Math.max(0, normal - target);
      return amount > 0 ? { amount, lines: want.map((w) => ({ i: have.get(String(w.variantId)).i, amount: 0 })), kind: 'bundle', normal } : null;
    }
    default: return null;
  }
}

/** Put the discount on the lines (pro-rata for order-level offers). */
function applyPlan(prop, amount, lines, out) {
  if (prop.kind === 'line') {
    for (const hit of prop.lines) {
      if (!hit.amount) continue;
      out.lineDiscounts.set(hit.i, (out.lineDiscounts.get(hit.i) || 0) + hit.amount);
    }
    return;
  }
  // order-level: spread pro-rata over the lines that still have room, the same
  // way an order-level discount is allocated in lib/money.js
  const weights = [];
  let total = 0;
  lines.forEach((L, i) => {
    const gross = Math.round(L.unitPrice * L.qty);
    const w = Math.max(0, gross - (L.disc || 0) - (out.lineDiscounts.get(i) || 0));
    weights.push(w);
    total += w;
  });
  if (!total) return;
  let given = 0;
  weights.forEach((w, i) => {
    if (i === lines.length - 1) {
      const rest = amount - given;
      if (rest > 0) out.lineDiscounts.set(i, (out.lineDiscounts.get(i) || 0) + rest);
      return;
    }
    const share = w > 0 ? Math.min(w, Math.round((amount * w) / total)) : 0;
    if (share > 0) { out.lineDiscounts.set(i, (out.lineDiscounts.get(i) || 0) + share); given += share; }
  });
  out.orderDiscount += amount;
}

/** Persist what was applied (campaign evidence) and spend the coupon's uses. */
function record(d, { saleId, applied, now }) {
  if (!applied || !applied.length) return;
  const ins = d.prepare(
    `INSERT INTO sale_promos (business_id, sale_id, promo_id, name, kind, amount, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)`
  );
  const bump = d.prepare('UPDATE promos SET uses = uses + 1 WHERE id = ?');
  for (const a of applied) {
    ins.run(saleId, a.promo_id, a.name || '', a.type || '', Math.round(a.amount || 0), now || new Date().toISOString());
    if (a.promo_id) bump.run(a.promo_id);
  }
}

/** What each offer has actually earned back (campaign performance). */
function performance(d, { from, to, branches }) {
  if (!branches || !branches.length) return { rows: [] };
  const ph = branches.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT p.id AS promo_id, p.name, p.type, p.code, p.max_uses, p.uses, p.active,
           COUNT(sp.id) AS sales, COALESCE(SUM(sp.amount), 0) AS discount_given,
           COALESCE(SUM(s.gross), 0) AS revenue,
           CASE WHEN p.max_uses IS NULL THEN NULL
                ELSE MAX(0, p.max_uses - p.uses) END AS uses_left
      FROM promos p
      LEFT JOIN sale_promos sp ON sp.promo_id = p.id
      LEFT JOIN sales s ON s.id = sp.sale_id AND s.status IN ('paid','partial')
     WHERE (p.branch_id IS NULL OR p.branch_id IN (${ph}))
     GROUP BY p.id
     ORDER BY discount_given DESC, p.id
  `).all(...branches);
  return { rows };
}

module.exports = {
  TYPES, APPLIES, DEFAULTS,
  cleanPromo, insertPromo, updatePromo,
  evaluate, record, performance,
  bundleRef, usesLeft, windowOpen, timeOpen
};

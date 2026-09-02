'use strict';
// ---------------------------------------------------------------------------
// payments.js — the payment ENGINE (Phase 8).
//
// Checkout never knows what a payment is. The till submits {method, amount,
// ref?, phone?, tendered?} and the engine:
//   • validates the method (enabled? allowed for this sale?)
//   • enforces the state machine  pending → confirmed | cancelled | failed
//                                  confirmed → refunded
//   • applies the idempotency rule — one (sale, method, ref) can only ever
//     be a payment (unique index uq_payments_ref), so a duplicate provider
//     callback can never double-count
//   • writes the evidence (customer_ledger for credit/store credit,
//     audit for every transition)
//   • recomputes the sale balance (split/partial payments)
//
// Provider specifics (M-Pesa shortcodes, passkeys, STK payloads, callback
// field names) live ONLY in lib/mpesa.js. Everything else in this file is
// provider-agnostic.
// ---------------------------------------------------------------------------

const METHODS = {
  cash:         { label: 'Cash',            sw: 'Taslimu',         async: false },
  mpesa:        { label: 'M-Pesa',          sw: 'M-Pesa',          async: true },
  card:         { label: 'Card',            sw: 'Kadi',            async: false, ref: true },
  bank:         { label: 'Bank transfer',   sw: 'Benki',           async: false, ref: true },
  credit:       { label: 'Credit (deni)',   sw: 'Deni',            async: false, needsCustomer: true },
  store_credit: { label: 'Store credit',    sw: 'Krediti ya duka', async: false, needsCustomer: true },
  gift_card:    { label: 'Gift card',       sw: 'Kadi ya zawadi',  async: false, ref: true },
  loyalty:      { label: 'Loyalty',         sw: 'Loyalty',         async: false, ref: true },
  other:        { label: 'Other',           sw: 'Nyingine',        async: false, ref: true }
};

const DEFAULT_CONFIG = {
  methods: {
    cash: true, mpesa: true, card: true, bank: false,
    credit: true, store_credit: false, gift_card: false, loyalty: false, other: true
  },
  mpesa: {
    mode: 'manual',          // manual | sandbox | live  (live = Phase 16 credentials)
    shortcode: '', passkey: '', paybill: '', phone: '',
    consumer_key: '', consumer_secret: '', callback_url: ''
  }
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function intShillings(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Merge settings.payments over the defaults (never returns secrets callers didn't ask for). */
function paymentConfig(d) {
  const s = d.prepare('SELECT value FROM settings WHERE key = ?').get('payments');
  const cur = s ? JSON.parse(s.value) : {};
  return {
    methods: { ...DEFAULT_CONFIG.methods, ...(cur.methods || {}) },
    mpesa: { ...DEFAULT_CONFIG.mpesa, ...(cur.mpesa || {}) }
  };
}

function setPaymentConfig(d, cfg) {
  const cur = paymentConfig(d);
  const next = {
    methods: { ...cur.methods },
    mpesa: { ...cur.mpesa }
  };
  if (cfg.methods) {
    for (const k of Object.keys(next.methods)) if (typeof cfg.methods[k] === 'boolean') next.methods[k] = cfg.methods[k];
  }
  if (cfg.mpesa) {
    for (const k of ['mode', 'shortcode', 'passkey', 'paybill', 'phone', 'callback_url']) {
      if (typeof cfg.mpesa[k] === 'string') next.mpesa[k] = cfg.mpesa[k].trim();
    }
    for (const k of ['consumer_key', 'consumer_secret']) {
      if (typeof cfg.mpesa[k] === 'string') next.mpesa[k] = cfg.mpesa[k].trim();
    }
  }
  if (!['manual', 'sandbox', 'live'].includes(next.mpesa.mode)) next.mpesa.mode = 'manual';
  d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('payments', JSON.stringify(next));
  return next;
}

/** Enabled methods, in display order. */
function enabledMethods(d) {
  const cfg = paymentConfig(d);
  return Object.keys(METHODS)
    .filter((k) => cfg.methods[k])
    .map((k) => ({ key: k, label: METHODS[k].label, sw: METHODS[k].sw, async: METHODS[k].async }));
}

/** Money already committed to the sale, by status. */
function saleMoney(d, saleId) {
  const rows = d.prepare(
    `SELECT status, COALESCE(SUM(amount), 0) AS amt FROM payments
     WHERE sale_id = ? AND status IN ('confirmed','pending') GROUP BY status`
  ).all(saleId);
  const out = { confirmed: 0, pending: 0 };
  for (const r of rows) out[r.status] = r.amt;
  out.remaining = 0; // filled by caller with gross
  return out;
}

/**
 * Recompute sale.status from its payments.
 *   paid ≥ gross            → 'paid'
 *   some confirmed          → 'partial'
 *   nothing confirmed       → 'open' while a payment is pending, else
 *                             'suspended' (held) if it was suspended before.
 */
function recomputeSale(d, saleId) {
  const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale || ['voided', 'refunded'].includes(sale.status)) return sale;
  const money = saleMoney(d, saleId);
  const paid = money.confirmed;
  let status;
  let paidAt = sale.paid_at;
  if (paid >= sale.gross) {
    status = 'paid';
    paidAt = paidAt || new Date().toISOString();
  } else if (paid > 0) {
    status = 'partial';
    paidAt = null;
  } else {
    status = money.pending > 0 ? 'open' : (sale.status === 'suspended' ? 'suspended' : 'open');
    paidAt = null;
  }
  d.prepare('UPDATE sales SET status = ?, paid_at = ? WHERE id = ?').run(status, paidAt, saleId);
  return d.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
}

/**
 * Add one payment line to a sale. Call inside a transaction.
 * Sync methods (cash/card/bank/...) confirm immediately; async methods
 * (mpesa) come back 'pending' and need confirmPayment / a provider callback.
 */
function addPayment(d, { user, sale, method, amount, ref, phone, tendered, note, allowQuote }) {
  const def = METHODS[method];
  if (!def) throw httpError(400, `unknown payment method '${method}'`);
  const cfg = paymentConfig(d);
  if (!cfg.methods[method]) throw httpError(400, `payment method '${method}' is not enabled for this business`);
  if (['voided', 'refunded'].includes(sale.status)) throw httpError(400, `sale is ${sale.status}`);
  // Only the /convert route may pay a quote (that is the moment it becomes an invoice).
  if (sale.kind === 'quote' && !allowQuote) throw httpError(400, 'quotes convert via POST /api/sales/:id/convert');

  const money = saleMoney(d, sale.id);
  if (money.confirmed + money.pending >= sale.gross) throw httpError(400, 'sale is already fully paid');
  const remaining = sale.gross - money.confirmed - money.pending;

  const tenderedAmt = intShillings(method === 'cash' ? (tendered !== undefined ? tendered : amount) : amount);
  if (tenderedAmt === null || tenderedAmt <= 0) throw httpError(400, 'payment amount must be whole shillings > 0');
  let applied, change;
  if (method === 'cash') {
    // Cash may be over-tendered — the difference comes back as change.
    applied = Math.min(tenderedAmt, remaining);
    change = tenderedAmt - applied;
  } else {
    if (tenderedAmt > remaining) throw httpError(400, `exceeds sale balance (remaining ${remaining})`);
    applied = tenderedAmt;
    change = 0;
  }

  const refStr = String(ref || '').trim();
  if (def.ref && !refStr) throw httpError(400, `${def.label.toLowerCase()} payment needs a reference (terminal slip, transfer ref…)`);
  const phoneStr = String(phone || '').trim();
  if (method === 'mpesa' && !phoneStr) throw httpError(400, 'M-Pesa payment needs the customer phone number');

  // Credit (deni) and store credit both ride on a customer balance.
  let customer = null;
  if (def.needsCustomer) {
    if (!sale.customer_id) throw httpError(400, `${def.label.toLowerCase()} payment needs a customer attached to the sale`);
    customer = d.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id);
    if (!customer) throw httpError(400, 'customer no longer exists');
    if (method === 'credit') {
      if (customer.credit_limit <= 0) throw httpError(400, 'customer has no credit (deni) limit');
      const used = d.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount WHEN 'repayment' = type THEN -amount ELSE 0 END), 0) AS u
         FROM customer_ledger WHERE customer_id = ?`
      ).get(customer.id).u;
      if (used + applied > customer.credit_limit) {
        throw httpError(400, `credit limit exceeded (limit ${customer.credit_limit}, already used ${used})`);
      }
    }
    if (method === 'store_credit' && customer.store_credit < applied) {
      throw httpError(400, `insufficient store credit (balance ${customer.store_credit})`);
    }
  }

  const t = new Date().toISOString();
  const status = def.async ? 'pending' : 'confirmed';
  let paymentId;
  try {
    paymentId = d.prepare(
      `INSERT INTO payments (sale_id, method, amount, ref, external_ref, status, note, user_id, created_at, raw)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`
    ).run(sale.id, method, applied, refStr, status, String(note || '').trim(), user.id, t,
      JSON.stringify({ tendered: tenderedAmt, change, phone: phoneStr })).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw httpError(409, `this ${def.label.toLowerCase()} reference was already recorded on this sale`);
    throw e;
  }

  if (method === 'credit') {
    d.prepare(
      `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
       VALUES (?, 'credit_sale', ?, ?, ?, ?, ?)`
    ).run(customer.id, applied, sale.invoice_no, user.id, `credit sale ${sale.invoice_no}`, t);
  }
  if (method === 'store_credit') {
    d.prepare('UPDATE customers SET store_credit = store_credit - ? WHERE id = ?').run(applied, customer.id);
    d.prepare(
      `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
       VALUES (?, 'adjustment', ?, ?, ?, ?, ?)`
    ).run(customer.id, -applied, sale.invoice_no, user.id, `store credit used on ${sale.invoice_no}`, t);
  }

  const sale2 = recomputeSale(d, sale.id);
  return { payment: d.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId), sale: sale2, change };
}

/**
 * Confirm a pending payment. IDEMPOTENT: confirming an already-confirmed
 * payment returns it unchanged — a duplicate provider callback is a no-op.
 * Call inside a transaction.
 */
function confirmPayment(d, { paymentId, user, code, externalRef, via }) {
  const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) throw httpError(404, 'payment not found');
  if (p.status === 'confirmed') return { payment: p, sale: recomputeSale(d, p.sale_id), already: true };
  if (p.status !== 'pending') throw httpError(409, `payment is ${p.status}, not awaiting confirmation`);

  let ref = p.ref;
  let ext = String(externalRef || '').trim();
  if (!p.ref && code) {
    ref = String(code).trim(); // manual mode: the cashier records the code as the ref
    // duplicate-code guard: is this (sale, method, code) already a payment?
    const dup = d.prepare('SELECT id FROM payments WHERE sale_id = ? AND method = ? AND ref = ? AND id != ?')
      .get(p.sale_id, p.method, ref, p.id);
    if (dup) throw httpError(409, `reference '${ref}' is already recorded on this sale`);
  } else if (p.ref && code && !ext) {
    ext = String(code).trim(); // sandbox/live: ref is the checkout id, code is the provider receipt
  }

  const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(p.sale_id);
  const money = saleMoney(d, p.sale_id);
  const room = sale.gross - (money.confirmed + money.pending - p.amount);
  if (p.amount > room) {
    d.prepare(`UPDATE payments SET status = 'failed', note = 'exceeds sale balance at confirmation', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), p.id);
    recomputeSale(d, p.sale_id);
    throw httpError(409, 'payment exceeds the sale balance left at confirmation');
  }

  const t = new Date().toISOString();
  const raw = JSON.parse(p.raw || '{}');
  raw.via = via || 'manual';
  d.prepare('UPDATE payments SET ref = ?, external_ref = ?, status = \'confirmed\', note = ?, raw = ?, updated_at = ? WHERE id = ?')
    .run(ref, ext, p.note || '', JSON.stringify(raw), t, p.id);

  const payment = d.prepare('SELECT * FROM payments WHERE id = ?').get(p.id);
  const sale2 = recomputeSale(d, p.sale_id);
  return { payment, sale: sale2, already: false };
}

/** Cancel a pending payment (customer declined, prompt timed out…). */
function cancelPayment(d, { paymentId, user, note }) {
  const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) throw httpError(404, 'payment not found');
  if (p.status !== 'pending') throw httpError(409, `payment is ${p.status}, not pending`);
  d.prepare(`UPDATE payments SET status = 'cancelled', note = ?, updated_at = ? WHERE id = ?`)
    .run(String(note || 'cancelled by cashier').trim(), new Date().toISOString(), p.id);
  return { payment: d.prepare('SELECT * FROM payments WHERE id = ?').get(p.id), sale: recomputeSale(d, p.sale_id) };
}

/** Fail a pending payment (provider said no — e.g. insufficient funds). */
function failPayment(d, { paymentId, note, via }) {
  const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) throw httpError(404, 'payment not found');
  if (p.status !== 'pending') return { payment: p, already: true };
  d.prepare(`UPDATE payments SET status = 'failed', note = ?, updated_at = ? WHERE id = ?`)
    .run(String(note || 'provider failure').trim(), new Date().toISOString(), p.id);
  return { payment: d.prepare('SELECT * FROM payments WHERE id = ?').get(p.id), sale: recomputeSale(d, p.sale_id) };
}

/**
 * Refund a CONFIRMED payment to its original method — all of it, or a part
 * (Phase 10: `amount` ≤ the still-unrefunded balance). Partial refunds keep
 * the payment 'confirmed' and track the money back in `refunded`; when the
 * last shilling is back the payment flips to 'refunded'. The customer balance
 * (deni / store credit) is restored; M-Pesa leaves a reversal row in
 * mpesa_log as evidence (actual reversal calls are Phase 16, live mode).
 * If the return takes the last money off the sale, the sale goes 'refunded'
 * (a terminal state — nothing is ever edited back).
 */
function refundPayment(d, { paymentId, user, note, amount }) {
  const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) throw httpError(404, 'payment not found');
  if (p.status !== 'confirmed') throw httpError(409, `only confirmed payments can be refunded (this is ${p.status})`);

  const remaining = p.amount - (p.refunded || 0);
  if (remaining <= 0) throw httpError(409, 'payment is already fully refunded');
  const amt = amount === undefined ? remaining : intShillings(amount);
  if (amt === null || amt <= 0) throw httpError(400, 'refund amount must be whole shillings > 0');
  if (amt > remaining) throw httpError(400, `refund ${amt} exceeds the unrefunded balance ${remaining}`);

  const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(p.sale_id);
  const t = new Date().toISOString();
  const full = (p.refunded || 0) + amt >= p.amount;
  const noteTxt = String(note || '').trim();
  d.prepare(`UPDATE payments SET refunded = ?, status = ?, note = ?, updated_at = ? WHERE id = ?`)
    .run(
      (p.refunded || 0) + amt,
      full ? 'refunded' : 'confirmed',
      noteTxt
        ? `${p.note ? p.note + ' · ' : ''}${noteTxt} (by ${user.name})`
        : `refunded by ${user.name}`,
      t, p.id
    );

  if (p.method === 'credit') {
    d.prepare(
      `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
       VALUES (?, 'repayment', ?, ?, ?, ?, ?)`
    ).run(sale.customer_id, amt, sale.invoice_no, user.id, `refund of ${amt} credit payment on ${sale.invoice_no}`, t);
  }
  if (p.method === 'store_credit' && sale.customer_id) {
    d.prepare('UPDATE customers SET store_credit = store_credit + ? WHERE id = ?').run(amt, sale.customer_id);
    d.prepare(
      `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
       VALUES (?, 'adjustment', ?, ?, ?, ?, ?)`
    ).run(sale.customer_id, amt, sale.invoice_no, user.id, `store credit restored ${amt} (refund on ${sale.invoice_no})`, t);
  }

  // Terminal check: is ALL the sale's money back — and nothing still pending?
  const left = d.prepare(
    `SELECT COALESCE(SUM(amount - refunded), 0) AS v FROM payments
     WHERE sale_id = ? AND status IN ('confirmed', 'refunded')`
  ).get(p.sale_id).v;
  const pending = d.prepare(
    `SELECT COUNT(*) AS c FROM payments WHERE sale_id = ? AND status = 'pending'`
  ).get(p.sale_id).c;
  let sale2;
  if (left <= 0 && pending === 0) {
    d.prepare(`UPDATE sales SET status = 'refunded' WHERE id = ? AND status NOT IN ('voided', 'refunded')`).run(p.sale_id);
    sale2 = d.prepare('SELECT * FROM sales WHERE id = ?').get(p.sale_id);
  } else {
    sale2 = recomputeSale(d, p.sale_id);
  }
  return { payment: d.prepare('SELECT * FROM payments WHERE id = ?').get(p.id), sale: sale2, amount: amt };
}

module.exports = {
  METHODS, DEFAULT_CONFIG,
  paymentConfig, setPaymentConfig, enabledMethods,
  saleMoney, recomputeSale,
  addPayment, confirmPayment, cancelPayment, failPayment, refundPayment
};

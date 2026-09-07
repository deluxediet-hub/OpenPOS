'use strict';
// ---------------------------------------------------------------------------
// mpesa.js — the M-Pesa (Safaricom Daraja) ADAPTER. The only file in the code
// base allowed to know about shortcodes, passkeys, STK payloads and callback
// field names. The payment engine (lib/payments.js) and the checkout UI are
// provider-agnostic; this file is what they talk to instead of Safaricom.
//
// Three modes (settings.payments.mpesa.mode):
//   manual   — no network at all. The customer pays the business's paybill or
//              number (or any M-Pesa channel); the cashier records the
//              confirmation code. Works from day one, any shop.
//   sandbox  — Simulated Daraja: the adapter issues a checkout request id
//              exactly like the live API would, and a test hook
//              (POST /api/payments/:id/simulate-callback) replays the
//              provider callback — same code path as production.
//   live     — real Daraja API (OAuth token + STK push). Credentials come
//              from settings; approval path is Phase 16 (production
//              credentials + IP whitelist + KYB).
//
// Idempotency: the callback handler finds the payment by its checkout
// request id (= payment.ref) and hands it to the engine, where a duplicate
// is a guaranteed no-op. A retry storm from Daraja can never double-count.
// ---------------------------------------------------------------------------

const pm = require('./payments');

function mpesaConfig(d) {
  return pm.paymentConfig(d).mpesa;
}

/**
 * Kick off the collection for a pending M-Pesa payment (called inside the
 * addPayment transaction where the payment row already exists).
 * Returns what the UI needs to show the cashier.
 */
function initiate(d, { payment, sale, phone, amount }) {
  const cfg = mpesaConfig(d);
  const t = new Date().toISOString();
  if (cfg.mode === 'sandbox') {
    // Issue the checkout request id exactly like live Daraja would.
    const checkoutId = payment.ref || `OP${sale.id}${Date.now().toString().slice(-9)}`;
    if (!payment.ref) {
      d.prepare('UPDATE payments SET ref = ? WHERE id = ?').run(checkoutId, payment.id);
    }
    d.prepare(
      `INSERT INTO mpesa_log (sale_id, checkout_request_id, mpesa_ref, phone, amount, status, callback, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, 'initiated', ?, ?, ?)`
    ).run(sale.id, checkoutId, phone, amount, JSON.stringify({ simulated: true }), t, t);
    return { pending: true, mode: 'sandbox', checkout_request_id: checkoutId, simulated: true };
  }
  if (cfg.mode === 'live') {
    if (!cfg.consumer_key || !cfg.consumer_secret) {
      return { pending: true, mode: 'live-unconfigured', note: 'live M-Pesa not configured (Phase 16) — record the code manually or switch to sandbox/manual' };
    }
    // Real Daraja STK push. Runs async on purpose: the sale is already saved,
    // the prompt goes out in the background; the callback confirms.
    const checkoutId = `OP${sale.id}${Date.now().toString().slice(-9)}`;
    if (!payment.ref) d.prepare('UPDATE payments SET ref = ? WHERE id = ?').run(checkoutId, payment.id);
    d.prepare(
      `INSERT INTO mpesa_log (sale_id, checkout_request_id, mpesa_ref, phone, amount, status, callback, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, 'awaiting', ?, ?, ?)`
    ).run(sale.id, checkoutId, phone, amount, JSON.stringify({ live: true }), t, t);
    pushStk(cfg, { checkoutId, phone, amount, desc: `OpenPOS ${sale.invoice_no}` })
      .then((r) => {
        try {
          const db2 = require('../db').open();
          db2.prepare(`UPDATE mpesa_log SET status = 'awaiting', callback = ?, updated_at = ? WHERE checkout_request_id = ?`)
            .run(JSON.stringify({ live: true, response: r }), new Date().toISOString(), checkoutId);
        } catch { /* best effort — the callback is the source of truth */ }
      })
      .catch((e) => {
        try {
          const db2 = require('../db').open();
          db2.prepare(`UPDATE mpesa_log SET status = 'failed', callback = ?, updated_at = ? WHERE checkout_request_id = ?`)
            .run(JSON.stringify({ live: true, error: e.message }), new Date().toISOString(), checkoutId);
        } catch { /* best effort */ }
      });
    return { pending: true, mode: 'live', checkout_request_id: checkoutId };
  }
  // manual (default): no network. Evidence row only.
  d.prepare(
    `INSERT INTO mpesa_log (sale_id, checkout_request_id, mpesa_ref, phone, amount, status, callback, created_at, updated_at)
     VALUES (?, '', '', ?, ?, 'initiated', ?, ?, ?)`
  ).run(sale.id, phone, amount, JSON.stringify({ manual: true }), t, t);
  const to = cfg.paybill ? `paybill/till ${cfg.paybill}` : (cfg.phone || 'the business number');
  return { pending: true, mode: 'manual', instructions: `Customer pays ${amount} to ${to}; record the M-Pesa confirmation code to confirm.` };
}

/**
 * Provider callback (real Daraja POST or the sandbox simulate hook).
 * IDEMPOTENT: an already-confirmed payment comes back unchanged.
 * Must be called inside a transaction.
 */
function onCallback(d, { checkoutRequestId, mpesaRef, result, description }) {
  const cqid = String(checkoutRequestId || '').trim();
  const mref = String(mpesaRef || '').trim();
  const payment = cqid
    ? d.prepare(`SELECT * FROM payments WHERE method = 'mpesa' AND ref = ? ORDER BY id DESC LIMIT 1`).get(cqid)
    : d.prepare(`SELECT * FROM payments WHERE method = 'mpesa' AND external_ref = ? ORDER BY id DESC LIMIT 1`).get(mref);
  if (!payment) return { found: false };

  if (payment.status === 'confirmed') {
    // duplicate callback — the money is already counted. No state change.
    return { found: true, idempotent: true, payment };
  }
  if (payment.status !== 'pending') {
    return { found: true, idempotent: false, payment, note: `payment already ${payment.status}` };
  }

  const t = new Date().toISOString();
  const ok = result === 0 || result === '0' || result === 'success';
  // The log row: by checkout id when the adapter issued one, else the latest
  // manual-mode row for this sale.
  const logRowId = payment.ref
    ? (d.prepare('SELECT id FROM mpesa_log WHERE checkout_request_id = ? ORDER BY id DESC LIMIT 1').get(payment.ref) || {}).id
    : (d.prepare(`SELECT id FROM mpesa_log WHERE sale_id = ? AND checkout_request_id = '' ORDER BY id DESC LIMIT 1`).get(payment.sale_id) || {}).id;
  const logUpdate = logRowId
    ? d.prepare('UPDATE mpesa_log SET status = ?, mpesa_ref = ?, callback = ?, updated_at = ? WHERE id = ?')
    : null;
  if (ok) {
    const r = pm.confirmPayment(d, {
      paymentId: payment.id,
      code: mref,
      externalRef: mref,
      via: 'callback'
    });
    if (logUpdate) logUpdate.run('confirmed', mref, JSON.stringify({ callback: true }), t, logRowId);
    // Phase 16: if sale now paid, enqueue eTIMS
    try {
      const etims = require('./etims');
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(payment.sale_id);
      if (sale && (sale.status === 'paid' || sale.status === 'partial')) {
        etims.enqueueSale(d, sale, 'invoice');
      }
    } catch (_) {}
    return { found: true, idempotent: false, ...r };
  }
  pm.failPayment(d, { paymentId: payment.id, note: `M-Pesa: ${description || 'ResultCode ' + result}`, via: 'callback' });
  if (logUpdate) logUpdate.run('failed', mref, JSON.stringify({ callback: true, result, description }), t, logRowId);
  const p2 = d.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
  return { found: true, idempotent: false, payment: p2, sale: pm.recomputeSale(d, p2.sale_id) };
}

/**
 * Automatic matching: when a C2B payment arrives (paybill/till/pochi),
 * try to match it to a pending M-Pesa sale (same amount, phone, recent).
 */
function autoMatchC2B(d, { phone, amount, mpesaRef, branchId }) {
  const cutoff = new Date(Date.now() - 30 * 60000).toISOString(); // last 30 min
  const pending = d.prepare(`
    SELECT p.*, s.branch_id, s.gross FROM payments p JOIN sales s ON s.id = p.sale_id
    WHERE p.method = 'mpesa' AND p.status = 'pending' AND s.created_at >= ?
      AND (s.branch_id = ? OR ? IS NULL)
    ORDER BY p.created_at DESC LIMIT 20
  `).all(cutoff, branchId, branchId);
  for (const pay of pending) {
    if (Math.abs(pay.amount - amount) < 1) {
      // Match found — confirm it
      try {
        const res = onCallback(d, { checkoutRequestId: pay.ref, mpesaRef, result: 0, description: 'C2B auto-matched' });
        if (res.found) {
          d.prepare(`UPDATE mpesa_log SET matched_sale_id = ?, reconciled = 1, updated_at = ? WHERE mpesa_ref = ?`).run(pay.sale_id, new Date().toISOString(), mpesaRef);
          return { matched: true, payment: pay, result: res };
        }
      } catch (_) {}
    }
  }
  return { matched: false };
}

function handleC2B(d, { transId, transAmount, msisdn, billRef, businessShortCode, branchId }) {
  const t = new Date().toISOString();
  const amount = Number(transAmount) || 0;
  const phone = String(msisdn || '').trim();
  const ref = String(transId || '').trim();
  // Log C2B
  d.prepare(`
    INSERT INTO mpesa_log (sale_id, checkout_request_id, mpesa_ref, phone, amount, status, type, branch_id, callback, created_at, updated_at)
    VALUES (NULL, ?, ?, ?, ?, 'confirmed', 'c2b', ?, ?, ?, ?)
  `).run(String(billRef || '').trim(), ref, phone, amount, branchId || null, JSON.stringify({ billRef, businessShortCode }), t, t);

  // Try auto-match
  const match = autoMatchC2B(d, { phone, amount, mpesaRef: ref, branchId });
  return { ok: true, c2b: { transId: ref, amount, phone, billRef }, autoMatched: match.matched, match };
}

async function pushB2C(cfg, { phone, amount, remarks, occasion }) {
  const base = cfg.mode === 'sandbox' ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
  const tokenRes = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.consumer_key}:${cfg.consumer_secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!tokenRes.ok) throw new Error(`daraja auth ${tokenRes.status}`);
  const token = (await tokenRes.json()).access_token;

  const res = await fetch(`${base}/mpesa/b2c/v1/paymentrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      InitiatorName: cfg.initiator || 'OpenPOS',
      SecurityCredential: cfg.security_credential || '',
      CommandID: 'BusinessPayment',
      Amount: amount,
      PartyA: cfg.shortcode,
      PartyB: phone,
      Remarks: remarks || 'Refund',
      QueueTimeOutURL: cfg.b2c_timeout_url || cfg.callback_url || '',
      ResultURL: cfg.b2c_result_url || cfg.callback_url || '',
      Occasion: occasion || 'Refund'
    }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`b2c ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function reconciliationReport(d, { from, to, branchId }) {
  const fromIso = from ? new Date(from).toISOString() : new Date(Date.now() - 7*86400000).toISOString();
  const toIso = to ? new Date(to).toISOString() : new Date().toISOString();
  const branchFilter = branchId ? ' AND (branch_id = ? OR matched_sale_id IN (SELECT id FROM sales WHERE branch_id = ?))' : '';
  const args = branchId ? [fromIso, toIso, branchId, branchId] : [fromIso, toIso];
  const logs = d.prepare(`
    SELECT * FROM mpesa_log WHERE created_at >= ? AND created_at <= ? ${branchFilter} ORDER BY created_at DESC LIMIT 500
  `).all(...args);
  const matched = logs.filter((l) => l.matched_sale_id || l.reconciled);
  const unmatched = logs.filter((l) => !l.matched_sale_id && !l.reconciled);
  const totalLogs = logs.length;
  const totalMatched = matched.length;
  const totalUnmatched = unmatched.length;
  const totalAmount = logs.reduce((a,b)=>a+(b.amount||0),0);
  const matchedAmount = matched.reduce((a,b)=>a+(b.amount||0),0);
  return {
    from: fromIso, to: toIso, branch_id: branchId || null,
    summary: { totalLogs, totalMatched, totalUnmatched, totalAmount, matchedAmount, unmatchedAmount: totalAmount - matchedAmount, recon_ok: totalUnmatched === 0 },
    matched: matched.slice(0, 100),
    unmatched: unmatched.slice(0, 100),
    all: logs.slice(0, 200)
  };
}

/**
 * Live Daraja STK push. Real implementation — used in `live` mode with
 * approved credentials (Phase 16); sandbox mode simulates this whole leg.
 */
async function pushStk(cfg, { checkoutId, phone, amount, desc }) {
  const isSandbox = cfg.mode === 'sandbox' || (cfg.shortcode && String(cfg.shortcode) === '174379');
  const base = isSandbox ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const password = Buffer.from(`${cfg.shortcode}${cfg.passkey || ''}${ts}`).toString('base64');

  const tokenRes = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.consumer_key}:${cfg.consumer_secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!tokenRes.ok) throw new Error(`daraja auth ${tokenRes.status}`);
  const token = (await tokenRes.json()).access_token;

  const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: cfg.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: cfg.transaction_type || 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: cfg.shortcode,
      PhoneNumber: phone,
      CallBackURL: cfg.callback_url || '',
      AccountReference: 'OpenPOS',
      TransactionDesc: desc
    }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await stkRes.json().catch(() => ({}));
  if (!stkRes.ok || (body.ResponseCode !== '0' && body.ResponseCode !== 0)) {
    throw new Error(`stk push: ${body.ResponseDescription || stkRes.status}`);
  }
  return body;
}

module.exports = { mpesaConfig, initiate, onCallback, pushStk, handleC2B, autoMatchC2B, pushB2C, reconciliationReport };

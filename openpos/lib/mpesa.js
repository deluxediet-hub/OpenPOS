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
    return { found: true, idempotent: false, ...r };
  }
  pm.failPayment(d, { paymentId: payment.id, note: `M-Pesa: ${description || 'ResultCode ' + result}`, via: 'callback' });
  if (logUpdate) logUpdate.run('failed', mref, JSON.stringify({ callback: true, result, description }), t, logRowId);
  const p2 = d.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
  return { found: true, idempotent: false, payment: p2, sale: pm.recomputeSale(d, p2.sale_id) };
}

/**
 * Live Daraja STK push. Real implementation — used in `live` mode with
 * approved credentials (Phase 16); sandbox mode simulates this whole leg.
 */
async function pushStk(cfg, { checkoutId, phone, amount, desc }) {
  const base = 'https://api.safaricom.co.ke';
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
      TransactionType: 'CustomerPayBillOnline',
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

module.exports = { mpesaConfig, initiate, onCallback, pushStk };

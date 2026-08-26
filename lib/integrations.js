'use strict';
/**
 * integrations.js — extension points for KRA eTIMS and Safaricom Daraja (M-Pesa).
 *
 * STATUS: CONFIGURATION + VALIDATION ONLY. No live network calls are made.
 *
 * Each business has its own credentials, so nothing is hard-coded: everything is
 * read from the settings table and edited by an admin under
 * Manager → Settings → Integrations.
 *
 * To go live, implement the two functions marked IMPLEMENT. They already receive
 * fully-formed payloads, so the work is transport + response handling, not
 * reshaping data. Until then they return { status: 'not_implemented' } and the
 * UI says so plainly rather than pretending a transmission happened.
 */

const REQUIRED_ETIMS = ['etims_endpoint', 'etims_username', 'etims_password', 'etims_device_serial'];
const REQUIRED_MPESA = ['mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_shortcode', 'mpesa_passkey'];

/** Report which credentials are missing so the admin sees a checklist, not a mystery. */
function checkConfig(settings, which) {
  const required = which === 'etims' ? REQUIRED_ETIMS : REQUIRED_MPESA;
  const missing = required.filter((k) => !String(settings[k] || '').trim());
  return {
    enabled: settings[which + '_enabled'] === '1',
    configured: missing.length === 0,
    missing
  };
}

/* ============================== KRA eTIMS ================================ */

/**
 * Shape an invoice payload in the form KRA's VSCU API expects.
 * Kept separate from transport so it can be unit-tested without credentials.
 */
function buildEtimsInvoice(order, { items, settings, table, customer }) {
  const now = new Date();
  const vatRate = Number(settings.vat_rate) || 0;
  const inclusive = settings.tax_mode === 'inclusive';
  const taxable = order.totals.total;
  const vat = order.totals.vat;

  return {
    /* seller */
    tin: settings.kra_pin,
    taxpayerName: settings.business_name,
    branchCode: settings.etims_branch_code || '00',
    deviceSerial: settings.etims_device_serial,
    receiptNumber: `${settings.etims_receipt_prefix || 'SRN'}-${order.number}`,
    /* buyer — PIN only required for B2B above the KRA threshold */
    buyerTin: (customer && customer.kra_pin) || null,
    buyerName: (customer && customer.name) || null,
    /* invoice */
    receiptDate: now.toISOString().slice(0, 10),
    receiptTime: now.toTimeString().slice(0, 8),
    invoiceNumber: String(order.number),
    paymentType: order.payments && order.payments.length
      ? order.payments.map((p) => p.method).join(',') : 'cash',
    /* lines: each needs a KRA item classification code */
    items: items.map((i) => ({
      itemCode: i.kra_item_code || null,     // admin-assigned per menu item
      itemName: i.name,
      quantity: i.qty,
      unitPrice: i.price / 100,
      totalAmount: (i.price * i.qty) / 100,
      /* A = 16% standard, B = 0% zero-rated, C = exempt, D = non-VAT */
      taxClass: i.tax_class || 'A',
      supplyAmount: (i.price * i.qty) / 100
    })),
    /* totals — respect Kenyan rule: mandatory service charge is VATable,
       a freely-given tip is not */
    totalSupplyAmount: taxable / 100,
    totalTaxAmount: vat / 100,
    totalAmount: order.totals.grand_total / 100,
    taxRate: vatRate,
    taxMode: inclusive ? 'inclusive' : 'exclusive',
    serviceCharge: (order.totals.service || 0) / 100,
    tip: (order.totals.tip || 0) / 100,
    /* offline tolerance: KRA allows a submission window after the sale */
    offlineQueueHours: Number(settings.etims_offline_queue_hours) || 48
  };
}

/**
 * IMPLEMENT: transmit the invoice to KRA and return the control unit number.
 *
 * Expected shape on success:
 *   { status: 'transmitted', control_number: 'CUIN...', qr: '<payload>' }
 *
 * The returned control_number and qr are what must print on the receipt.
 * Queue and retry when offline, within settings.etims_offline_queue_hours.
 */
async function transmitInvoice(payload, settings) {
  const cfg = checkConfig(settings, 'etims');
  if (!cfg.enabled) return { status: 'disabled', control_number: null, qr: null };
  if (!cfg.configured) {
    return { status: 'misconfigured', missing: cfg.missing, control_number: null, qr: null };
  }
  return {
    status: 'not_implemented',
    message: 'eTIMS credentials are configured but the VSCU client is not wired up. ' +
      'Implement transmitInvoice() in lib/integrations.js.',
    control_number: null,
    qr: null,
    payloadPreview: payload.receiptNumber
  };
}

/* ============================== M-Pesa =================================== */

/** Normalise Kenyan numbers to the 254XXXXXXXXX form Daraja expects. */
function normalisePhone(raw) {
  let p = String(raw || '').replace(/[\s\-+()]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  else if (p.startsWith('254')) { /* already fine */ }
  return /^\d{12}$/.test(p) ? p : null;
}

/** Build the STK Push request body. Password = base64(shortcode + passkey + timestamp). */
function buildStkRequest({ phone, amount, settings, reference }) {
  /* Daraja expects YYYYMMDDHHmmss in the merchant's local time. Do not use
     toISOString() — that is UTC and would be hours off for a Kenyan paybill. */
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const timestamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const shortcode = settings.mpesa_shortcode;
  const password = Buffer
    .from(`${shortcode}${settings.mpesa_passkey}${timestamp}`)
    .toString('base64');
  const partyA = normalisePhone(phone);

  return {
    valid: !!partyA,
    invalidPhone: !partyA ? phone : undefined,
    baseUrl: settings.mpesa_env === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke',
    body: {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      /* Daraja requires a whole shilling amount, no decimals */
      Amount: Math.round(Number(amount)),
      PartyA: partyA,
      PartyB: shortcode,
      PhoneNumber: partyA,
      CallBackURL: settings.mpesa_callback_url,
      AccountReference: reference || settings.mpesa_paybill_account || 'POS',
      TransactionDesc: `POS bill ${reference || ''}`.trim()
    }
  };
}

/**
 * IMPLEMENT: POST the STK request, persist CheckoutRequestID, and reconcile
 * against the async callback.
 *
 * CRITICAL: a 200 from Safaricom means the prompt was *sent*, NOT that the
 * customer paid. Do not record a payment here. Wait for the callback, match it
 * by CheckoutRequestID, and make the handler idempotent — Safaricom retries.
 */
async function requestStkPush(request, settings) {
  const cfg = checkConfig(settings, 'mpesa');
  if (!cfg.enabled) return { status: 'disabled' };
  if (!cfg.configured) return { status: 'misconfigured', missing: cfg.missing };
  if (!request.valid) {
    return { status: 'invalid_phone', phone: request.invalidPhone };
  }
  if (!settings.mpesa_callback_url) {
    return { status: 'no_callback', message: 'Daraja needs a publicly reachable HTTPS callback URL.' };
  }
  return {
    status: 'not_implemented',
    message: 'M-Pesa credentials are configured but the Daraja client is not wired up. ' +
      'Implement requestStkPush() in lib/integrations.js. Keep collecting the confirmation ' +
      'code manually until then.',
    endpoint: request.baseUrl + '/mpesa/stkpush/v1/processrequest'
  };
}

module.exports = {
  checkConfig,
  buildEtimsInvoice,
  transmitInvoice,
  normalisePhone,
  buildStkRequest,
  requestStkPush,
  REQUIRED_ETIMS,
  REQUIRED_MPESA
};

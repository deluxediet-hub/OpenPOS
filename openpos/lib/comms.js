'use strict';
// ---------------------------------------------------------------------------
// comms.js — WhatsApp & SMS for a Kenyan shop (Phase 25).
//
// Three rules shape this file:
//
//  1. A message is EVIDENCE, not a chat. Every one is stored (who, what, which
//     sale, did the provider take it) before it is sent — so a receipt exists
//     even when there is no airtime, no internet and no provider account.
//  2. The provider is PLUGGABLE and replaceable. `log` (the default) keeps the
//     message inside the business; `africas_talking` and `twilio` are HTTP
//     adapters configured from settings. No other file knows a provider.
//  3. An order is not a new kind of sale. Inbound text is parsed into the same
//     cart the till builds, and the order becomes a real sale through the same
//     engine — one inventory, one book (R-CH).
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const CHANNELS = ['whatsapp', 'sms'];

const PROVIDERS = {
  log: {
    id: 'log',
    label: 'Local log only',
    sw: 'Kumbukumbu ya ndani',
    desc: 'Messages are written and shown in the back office — nothing leaves the shop. Works with no internet and no airtime.'
  },
  africas_talking: {
    id: 'africas_talking',
    label: "Africa's Talking",
    sw: "Africa's Talking",
    desc: 'Kenyan gateway: SMS and WhatsApp, paid in M-Pesa.'
  },
  twilio: {
    id: 'twilio',
    label: 'Twilio',
    sw: 'Twilio',
    desc: 'Global gateway for WhatsApp and SMS.'
  }
};

const DEFAULTS = {
  enabled: false,
  provider: 'log',
  default_channel: 'whatsapp',
  business_phone: '',
  owner_phone: '',
  order_enabled: true,
  paybill: '',
  account_prefix: '',
  low_stock_alerts: false,
  africas_talking: { username: '', api_key: '', sender_id: '', whatsapp_number: '' },
  twilio: { account_sid: '', auth_token: '', from: '' }
};

function settings(d, dbm) {
  const cur = (dbm.getSetting(d, 'comms', null) || {});
  return {
    ...DEFAULTS,
    ...cur,
    africas_talking: { ...DEFAULTS.africas_talking, ...(cur.africas_talking || {}) },
    twilio: { ...DEFAULTS.twilio, ...(cur.twilio || {}) }
  };
}

function saveSettings(d, dbm, patch) {
  const cur = settings(d, dbm);
  const next = {
    ...cur,
    ...patch,
    africas_talking: { ...cur.africas_talking, ...(patch.africas_talking || {}) },
    twilio: { ...cur.twilio, ...(patch.twilio || {}) }
  };
  dbm.setSetting(d, 'comms', next);
  return next;
}

/** Kenyan numbers travel as 07… / +254… / 254… — one shape in the book. */
function normalisePhone(raw) {
  const s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('254')) return `+${s}`;
  if (s.startsWith('0')) return `+254${s.slice(1)}`;
  return `+${s}`;
}

function samePhone(a, b) {
  const x = normalisePhone(a);
  const y = normalisePhone(b);
  return !!x && x === y;
}

// ---- message store ---------------------------------------------------------

function insert(d, row) {
  return Number(
    d
      .prepare(
        `INSERT INTO messages (business_id, customer_id, sale_id, channel, direction, kind,
           to_number, from_number, body, provider, provider_ref, status, error, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.businessId || 1,
        row.customerId || null,
        row.saleId || null,
        row.channel || 'whatsapp',
        row.direction || 'out',
        row.kind || 'note',
        row.to || '',
        row.from || '',
        String(row.body || ''),
        row.provider || 'log',
        row.providerRef || null,
        row.status || 'queued',
        row.error || null,
        row.meta ? JSON.stringify(row.meta) : null,
        row.now || new Date().toISOString()
      ).lastInsertRowid
  );
}

function mark(d, id, status, extra = {}) {
  d.prepare('UPDATE messages SET status = ?, error = ?, provider_ref = COALESCE(?, provider_ref), sent_at = ? WHERE id = ?')
    .run(status, extra.error || null, extra.providerRef || null, status === 'sent' || status === 'logged' ? (extra.sentAt || new Date().toISOString()) : null, id);
  return d.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

// ---- dispatch --------------------------------------------------------------

/** Africa's Talking: POST form-encoded to their SMS / WhatsApp endpoint. */
async function africasTalking(cfg, { to, body, channel }) {
  const base = channel === 'whatsapp' ? 'https://api.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';
  const form = new URLSearchParams({
    username: cfg.username, to, message: body, ...(cfg.sender_id ? { from: cfg.sender_id } : {})
  });
  if (channel === 'whatsapp' && cfg.whatsapp_number) form.set('from', cfg.whatsapp_number);
  const res = await fetch(base, {
    method: 'POST',
    headers: { apiKey: cfg.api_key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const text = await res.text();
  if (!res.ok) throw httpError(502, `provider returned ${res.status}: ${text.slice(0, 180)}`);
  const m = /"messageId"\s*:\s*"([^"]+)"/.exec(text);
  return { providerRef: m ? m[1] : null, raw: text.slice(0, 500) };
}

/** Twilio: POST form-encoded to the Messages resource. */
async function twilio(cfg, { to, body, channel }) {
  const from = channel === 'whatsapp' ? `whatsapp:${cfg.from}` : cfg.from;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.account_sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.account_sid}:${cfg.auth_token}`).toString('base64') },
    body: new URLSearchParams({ To: channel === 'whatsapp' ? `whatsapp:${to}` : to, From: from, Body: body }).toString()
  });
  const text = await res.text();
  if (!res.ok) throw httpError(502, `provider returned ${res.status}: ${text.slice(0, 180)}`);
  const m = /"sid"\s*:\s*"([^"]+)"/.exec(text);
  return { providerRef: m ? m[1] : null, raw: text.slice(0, 500) };
}

/**
 * STORE first. Everything that owes a customer a receipt calls this: the row
 * exists before we know whether the provider will take it, so a failed send
 * can be retried and an offline shop keeps its own copy.
 */
function enqueue(d, dbm, { to, body, channel, kind = 'note', customerId = null, saleId = null, meta = null, providerRef = null }) {
  const cfg = settings(d, dbm);
  const toN = normalisePhone(to);
  if (!toN) throw httpError(400, 'a message needs a phone number');
  if (!String(body || '').trim()) throw httpError(400, 'a message needs a body');
  const ch = CHANNELS.includes(channel) ? channel : cfg.default_channel || 'whatsapp';
  const id = insert(d, {
    customerId, saleId, channel: ch, direction: 'out', kind,
    to: toN, body, provider: cfg.provider, status: 'queued', meta, providerRef
  });
  return d.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

/** HAND it to the provider (or log it locally). Never throws. */
async function dispatch(d, dbm, id) {
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!row || row.direction !== 'out') return row;
  const cfg = settings(d, dbm);
  if (!cfg.enabled) return mark(d, id, 'pending_switch', { error: 'messaging is switched off' });
  if (row.provider === 'log') return mark(d, id, 'logged', {});
  try {
    let out;
    if (row.provider === 'africas_talking') out = await africasTalking(cfg.africas_talking, { to: row.to_number, body: row.body, channel: row.channel });
    else if (row.provider === 'twilio') out = await twilio(cfg.twilio, { to: row.to_number, body: row.body, channel: row.channel });
    else throw httpError(400, `unknown provider ${row.provider}`);
    return mark(d, id, 'sent', { providerRef: out.providerRef });
  } catch (e) {
    return mark(d, id, 'failed', { error: e.message });
  }
}

/** Store + send in one step (routes). */
async function send(d, dbm, opts) {
  const row = enqueue(d, dbm, opts);
  return dispatch(d, dbm, row.id);
}

/** Store now, send on the next tick — for code paths that must not await. */
function enqueueAndDispatch(d, dbm, opts) {
  const row = enqueue(d, dbm, opts);
  setImmediate(() => { dispatch(d, dbm, row.id).catch(() => {}); });
  return row;
}

/** Idempotent inbound store: a provider replaying a webhook changes nothing. */
function receive(d, { provider, providerRef, from, body, channel = 'whatsapp' }) {
  if (providerRef) {
    const existing = d.prepare('SELECT * FROM messages WHERE provider = ? AND provider_ref = ?').get(provider, providerRef);
    if (existing) return { message: existing, duplicate: true };
  }
  const id = insert(d, {
    channel, direction: 'in', kind: 'inbound', from: normalisePhone(from), body,
    provider: provider || 'manual', providerRef: providerRef || null, status: 'received'
  });
  return { message: d.prepare('SELECT * FROM messages WHERE id = ?').get(id), duplicate: false };
}

function list(d, { limit = 100, customerId = null, saleId = null, direction = null, kind = null } = {}) {
  const where = ['business_id = 1'];
  const args = [];
  if (customerId) { where.push('customer_id = ?'); args.push(customerId); }
  if (saleId) { where.push('sale_id = ?'); args.push(saleId); }
  if (direction) { where.push('direction = ?'); args.push(direction); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  return d
    .prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args, Number(limit) || 100);
}

// ---- message bodies --------------------------------------------------------

function money(n) {
  return `Ksh ${Number(n || 0).toLocaleString('en-KE')}`;
}

function receiptText(biz, sale, items) {
  const lines = (items || []).map((i) => `• ${i.qty} × ${i.name} — ${money(i.gross)}`);
  return [
    `${biz.name || 'Shop'} — ${sale.invoice_no}`,
    ...lines,
    `Total ${money(sale.gross)}`,
    sale.discount ? `(discount ${money(sale.discount)})` : null,
    'Asante!'
  ].filter(Boolean).join('\n');
}

function statementText(biz, customer, rows) {
  const body = (rows || []).slice(-8).map((r) => {
    const bal = Number(r.balance || 0);
    return `${String(r.created_at || '').slice(0, 10)} ${r.type === 'credit_sale' ? 'deni' : 'paid'} ${money(Math.abs(Number(r.amount || 0)))} → bal ${money(bal)}`;
  });
  return [
    `${biz.name || 'Shop'} — statement for ${customer.name}`,
    ...(body.length ? body : ['No entries yet.']),
    `Balance: ${money(customer.deni_outstanding || 0)}`
  ].join('\n');
}

function catalogueText(biz, items) {
  const rows = (items || []).map((p) => {
    const code = p.sku || `#${p.id}`;
    return `${code} ${p.name} — ${money(p.price)}`;
  });
  return [
    `${biz.name || 'Shop'} catalogue`,
    ...(rows.length ? rows : ['Nothing on the shelf yet.']),
    'Reply e.g. "2 TEA01, 1 Soda" to order.'
  ].join('\n');
}

function paymentRequestText(biz, sale, cfg) {
  const ref = `${cfg.account_prefix || ''}${sale.invoice_no}`;
  const how = cfg.paybill
    ? `Pay ${money(sale.gross)} to Paybill ${cfg.paybill}, account ${ref}`
    : `Pay ${money(sale.gross)} to ${biz.phone || 'the shop'} — reference ${ref}`;
  return [`${biz.name || 'Shop'} — order ${sale.invoice_no}`, how, 'We will send your receipt the moment it lands.'].join('\n');
}

// ---- inbound orders --------------------------------------------------------

const QTY_RE = /^(\d+(?:\.\d+)?)\s*(?:x|\*|×)?\s*(.+)$/i;

/**
 * Read a customer's message as an order. Forgiving by design: people write
 * "2 tea", "2x TEA01", "1 soda 500ml". A code matches a SKU, a barcode or the
 * product's #id; anything we cannot read comes back in `unmatched`.
 */
function parseOrder(d, text) {
  const body = String(text || '').trim();
  if (!body) return { items: [], unmatched: [] };
  const chunks = body.split(/[,;\n]+|\band\b/i).map((c) => c.trim()).filter(Boolean);
  const items = [];
  const unmatched = [];
  for (const chunk of chunks) {
    const m = QTY_RE.exec(chunk);
    const qty = m ? Number(m[1]) : 1;
    const code = (m ? m[2] : chunk).trim();
    if (!code || !Number.isFinite(qty) || qty <= 0) { unmatched.push(chunk); continue; }
    const row = lookupCode(d, code);
    if (!row) { unmatched.push(chunk); continue; }
    items.push({ variant_id: row.variant_id, qty, name: row.name, code });
  }
  return { items, unmatched };
}

/**
 * Code → product. Ranked, so "chai" finds Chai before "Chain Test":
 * exact SKU · exact name · a WORD in the name starting with it · anything.
 */
function lookupCode(d, code) {
  const c = String(code).trim();
  const id = /^#?(\d+)$/.exec(c) ? Number(/^#?(\d+)$/.exec(c)[1]) : null;
  const rows = d
    .prepare(
      `SELECT v.id AS variant_id, p.name, p.id AS product_id,
              CASE WHEN LOWER(p.sku) = LOWER(?) THEN 0
                   WHEN LOWER(p.name) = LOWER(?) THEN 1
                   WHEN LOWER(p.name) LIKE '% ' || LOWER(?) || '%' THEN 2
                   WHEN LOWER(p.name) LIKE LOWER(?) || '%' THEN 3
                   ELSE 4 END AS rank
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND p.active = 1
          AND (LOWER(p.sku) = LOWER(?) OR LOWER(p.name) LIKE '%' || LOWER(?) || '%' OR p.id = ?)
        ORDER BY rank ASC, p.id ASC LIMIT 1`
    )
    .all(c, c, c, c, c, c, id === null ? -1 : id);
  if (rows.length) return rows[0];
  const barcode = d
    .prepare(
      `SELECT v.id AS variant_id, p.name, p.id AS product_id
         FROM variant_barcodes b JOIN variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
        WHERE b.barcode = ? AND v.active = 1 AND p.active = 1 LIMIT 1`
    )
    .get(c);
  return barcode || null;
}

/** The mini catalogue a customer can order from (id, name, price, stock). */
function catalogue(d, { limit = 40, search = '' } = {}) {
  const like = `%${String(search).trim()}%`;
  return d
    .prepare(
      `SELECT p.id, p.name, p.sku, COALESCE(v.price, p.price) AS price
         FROM products p JOIN variants v ON v.product_id = p.id AND COALESCE(v.axes_key, '{}') = '{}'
        WHERE p.active = 1 AND (? = '' OR LOWER(p.name) LIKE LOWER(?) OR LOWER(p.sku) LIKE LOWER(?))
        ORDER BY p.name LIMIT ?`
    )
    .all(String(search).trim() === '' ? '' : 'x', like, like, Number(limit) || 40);
}

module.exports = {
  CHANNELS, PROVIDERS, DEFAULTS,
  settings, saveSettings, normalisePhone, samePhone,
  send, enqueue, dispatch, enqueueAndDispatch, receive, list, mark,
  receiptText, statementText, catalogueText, paymentRequestText,
  parseOrder, catalogue, money
};

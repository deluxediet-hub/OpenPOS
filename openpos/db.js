'use strict';
// ---------------------------------------------------------------------------
// db.js — SQLite schema (v1) + low-level helpers.
// Multi-tenant-lite: every operational row is branch-scoped; branch_id NULL
// means "global to the business" (catalog products, HQ-level staff, promos).
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Database } = require('./lib/sqlite');

const DATA_DIR = process.env.OPENPOS_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.OPENPOS_DB || path.join(DATA_DIR, 'openpos.db');

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    kra_pin TEXT NOT NULL DEFAULT '',
    vat_registered INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('owner','manager','cashier','staff')),
    branch_id INTEGER REFERENCES branches(id),
    pin_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_locks (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS terminals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    name TEXT NOT NULL,
    printer_ip TEXT NOT NULL DEFAULT '',
    printer_width TEXT NOT NULL DEFAULT '80',
    drawer INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    parent_id INTEGER,
    name TEXT NOT NULL,
    name_sw TEXT NOT NULL DEFAULT '',
    age_restricted INTEGER NOT NULL DEFAULT 0,
    requires_rx INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    sku TEXT NOT NULL DEFAULT '',
    barcode TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    name_sw TEXT NOT NULL DEFAULT '',
    category_id INTEGER,
    brand TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT 'pcs',
    pack_size INTEGER NOT NULL DEFAULT 1,
    pack_name TEXT NOT NULL DEFAULT '',
    cost INTEGER NOT NULL DEFAULT 0,
    price INTEGER NOT NULL DEFAULT 0,
    wholesale_price INTEGER NOT NULL DEFAULT 0,
    member_price INTEGER NOT NULL DEFAULT 0,
    tax_type TEXT NOT NULL DEFAULT 'std' CHECK(tax_type IN ('std','zero','exempt')),
    kra_item_code TEXT NOT NULL DEFAULT '',
    age_min INTEGER,
    requires_rx INTEGER NOT NULL DEFAULT 0,
    is_controlled INTEGER NOT NULL DEFAULT 0,
    track_batches INTEGER NOT NULL DEFAULT 0,
    open_priced INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    image TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

  CREATE TABLE IF NOT EXISTS price_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    price INTEGER NOT NULL,
    wholesale_price INTEGER,
    UNIQUE(product_id, branch_id)
  );

  CREATE TABLE IF NOT EXISTS stock (
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, branch_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_branch ON stock(branch_id);

  CREATE TABLE IF NOT EXISTS stock_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    type TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    batch_id INTEGER,
    user_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_moves(product_id, branch_id, created_at);

  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    batch_no TEXT NOT NULL DEFAULT '',
    expiry_date TEXT,
    qty REAL NOT NULL DEFAULT 0,
    cost INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batches_fefo ON batches(product_id, branch_id, expiry_date);

  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    from_branch INTEGER NOT NULL REFERENCES branches(id),
    to_branch INTEGER NOT NULL REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'requested'
      CHECK(status IN ('requested','approved','shipped','received','cancelled')),
    created_by INTEGER,
    created_at TEXT NOT NULL,
    shipped_at TEXT,
    received_at TEXT,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS transfer_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL REFERENCES transfers(id),
    product_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    received_qty REAL NOT NULL DEFAULT 0,
    batch_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    kra_pin TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    terms TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','sent','partial','received','cancelled')),
    expected_date TEXT,
    note TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS po_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    product_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    unit_cost INTEGER NOT NULL DEFAULT 0,
    received_qty REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS goods_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    po_id INTEGER REFERENCES purchase_orders(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    total INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gr_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gr_id INTEGER NOT NULL REFERENCES goods_receipts(id),
    product_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    unit_cost INTEGER NOT NULL DEFAULT 0,
    batch_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    terminal TEXT NOT NULL DEFAULT '',
    order_no INTEGER NOT NULL,
    invoice_no TEXT NOT NULL,
    customer_id INTEGER,
    user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK(status IN ('open','partial','paid','suspended','voided','refunded')),
    subtotal INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    net INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    gross INTEGER NOT NULL DEFAULT 0,
    tender TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    etims_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(etims_status IN ('pending','queued','transmitted','failed','exempt')),
    cuin TEXT,
    invoice_id TEXT,
    qr TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sales_branch_date ON sales(branch_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status, etims_status);

  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    product_id INTEGER,
    name TEXT NOT NULL,
    qty REAL NOT NULL,
    unit INTEGER NOT NULL,
    line_discount INTEGER NOT NULL DEFAULT 0,
    net INTEGER NOT NULL,
    tax INTEGER NOT NULL,
    gross INTEGER NOT NULL,
    tax_type TEXT NOT NULL DEFAULT 'std',
    kra_item_code TEXT NOT NULL DEFAULT '',
    batch_id INTEGER,
    line_note TEXT NOT NULL DEFAULT '',
    age_verified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    method TEXT NOT NULL
      CHECK(method IN ('cash','mpesa','card','gift_card','loyalty','credit')),
    amount INTEGER NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'confirmed'
      CHECK(status IN ('pending','confirmed','failed','refunded')),
    user_id INTEGER,
    created_at TEXT NOT NULL,
    raw TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);

  CREATE TABLE IF NOT EXISTS mpesa_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER,
    checkout_request_id TEXT,
    mpesa_ref TEXT,
    phone TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'initiated'
      CHECK(status IN ('initiated','awaiting','confirmed','failed','cancelled','timeout')),
    callback TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mpesa_ref ON mpesa_log(mpesa_ref);

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    terminal TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    float_open INTEGER NOT NULL DEFAULT 0,
    expected_cash INTEGER NOT NULL DEFAULT 0,
    counted_cash INTEGER,
    variance INTEGER,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_shifts_branch ON shifts(branch_id, status);

  CREATE TABLE IF NOT EXISTS shift_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    kra_pin TEXT NOT NULL DEFAULT '',
    credit_limit INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'standard',
    birthday TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

  CREATE TABLE IF NOT EXISTS customer_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    type TEXT NOT NULL CHECK(type IN ('credit_sale','repayment','adjustment','loyalty_grant','loyalty_redeem')),
    amount INTEGER NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger(customer_id, created_at);

  CREATE TABLE IF NOT EXISTS gift_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    balance INTEGER NOT NULL DEFAULT 0,
    owner_name TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS loyalty_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    sale_id INTEGER,
    points INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('earn','redeem','adjust')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS promos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('pct','fixed','bogo','bundle','time')),
    value INTEGER NOT NULL DEFAULT 0,
    applies_to TEXT NOT NULL DEFAULT 'all',
    applies_ref TEXT NOT NULL DEFAULT '',
    code TEXT,
    start_date TEXT,
    end_date TEXT,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prescriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers(id),
    prescriber TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL,
    filled_at TEXT,
    sale_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS controlled_register (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    batch_id INTEGER,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    qty REAL NOT NULL,
    sale_id INTEGER,
    user_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    user_id INTEGER,
    branch_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '{}',
    hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

  CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS etims_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try INTEGER NOT NULL DEFAULT 0,
    cuin TEXT,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS timeclock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    branch_id INTEGER,
    event TEXT NOT NULL CHECK(event IN ('in','out')),
    at TEXT NOT NULL
  );
  `);
}

// ---- settings (JSON-encoded key/value) --------------------------------------
function setSetting(d, key, value) {
  d.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

function getSetting(d, key, fallback = null) {
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function getSettings(d) {
  const rows = d.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

function isInitialized(d) {
  return d.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

// ---- counters ----------------------------------------------------------------
function nextCounter(d, key, prefix = '') {
  const row = d.prepare('SELECT value FROM counters WHERE key = ?').get(key);
  const next = (row ? row.value : 0) + 1;
  d.prepare(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, next);
  return `${prefix}${String(next).padStart(6, '0')}`;
}

// ---- audit log (hash-chained: tamper-evident) --------------------------------
const AUDIT_GENESIS = 'GENESIS';
function lastAuditHash(d) {
  const row = d.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return row ? row.hash : AUDIT_GENESIS;
}

function audit(d, { userId = null, branchId = null, action, entity = '', entityId = '', detail = {} }) {
  const ts = new Date().toISOString();
  const prev = lastAuditHash(d);
  const base = `${prev}|${ts}|${userId}|${branchId}|${action}|${entity}|${entityId}|${JSON.stringify(detail)}`;
  const hash = crypto.createHash('sha256').update(base).digest('hex');
  d.prepare(
    `INSERT INTO audit_log (ts, user_id, branch_id, action, entity, entity_id, detail, hash, prev_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ts, userId, branchId, action, entity, entityId, JSON.stringify(detail), hash, prev);
}

function auditRows(d, limit = 200) {
  return d.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

function verifyAuditChain(d) {
  const rows = d.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  let prev = AUDIT_GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, at: r.id };
    const base = `${r.prev_hash}|${r.ts}|${r.user_id}|${r.branch_id}|${r.action}|${r.entity}|${r.entity_id}|${r.detail}`;
    const hash = crypto.createHash('sha256').update(base).digest('hex');
    if (hash !== r.hash) return { ok: false, at: r.id };
    prev = r.hash;
  }
  return { ok: true, length: rows.length };
}

module.exports = {
  open, DB_PATH,
  setSetting, getSetting, getSettings, isInitialized,
  nextCounter,
  audit, auditRows, verifyAuditChain, AUDIT_GENESIS
};

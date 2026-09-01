'use strict';
/**
 * db.js — schema, onboarding/seed data and money helpers.
 * All money is stored as INTEGER cents to avoid floating point drift.
 *
 * PINs are stored as salted scrypt hashes, never plaintext.
 * A fresh install is EMPTY (white-label): no business name, menu or staff.
 * The shop configures itself through the first-run onboarding flow,
 * optionally loading a wines and spirits catalogue as a starting template.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.POS_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.POS_DB || path.join(DATA_DIR, 'pos.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const startupCheck=db.pragma('quick_check',{simple:true});
if(startupCheck!=='ok')throw new Error('Database quick_check failed: '+startupCheck);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  pin        TEXT NOT NULL,
  role       TEXT NOT NULL,            -- admin|seller (legacy restaurant roles remain supported)
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_pin ON users(pin) WHERE active = 1;

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  station    TEXT NOT NULL DEFAULT 'kitchen',   -- kitchen|bar
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL,                 -- cents, VAT-inclusive
  cost        INTEGER NOT NULL DEFAULT 0,       -- cents
  station     TEXT NOT NULL DEFAULT 'kitchen',
  available   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  sku         TEXT,
  barcode     TEXT,
  volume_ml   INTEGER,
  stock_mode  TEXT NOT NULL DEFAULT 'unit',     -- unit|pour
  serving_ml  INTEGER,
  sale_unit   TEXT NOT NULL DEFAULT 'piece',
  kra_item_code TEXT,
  tax_type    TEXT NOT NULL DEFAULT 'B'
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_sku ON menu_items(sku) WHERE sku IS NOT NULL AND sku != '';
CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_barcode ON menu_items(barcode) WHERE barcode IS NOT NULL AND barcode != '';
CREATE INDEX IF NOT EXISTS ix_menu_cat ON menu_items(category_id);

CREATE TABLE IF NOT EXISTS tables (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  area       TEXT NOT NULL,
  seats      INTEGER NOT NULL DEFAULT 4,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         INTEGER NOT NULL,
  table_id       INTEGER REFERENCES tables(id),
  waiter_id      INTEGER REFERENCES users(id),
  people         INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'open',  -- open|billed|closed|void
  discount       INTEGER NOT NULL DEFAULT 0,    -- cents
  discount_reason TEXT,
  tip            INTEGER NOT NULL DEFAULT 0,    -- cents
  notes          TEXT,
  opened_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at      TEXT,
  closed_by      INTEGER REFERENCES users(id),
  age_verified   INTEGER NOT NULL DEFAULT 0,
  age_check_note TEXT,
  closed_out INTEGER NOT NULL DEFAULT 0,
  subtotal_snapshot INTEGER, service_snapshot INTEGER, vat_snapshot INTEGER,
  total_snapshot INTEGER, grand_total_snapshot INTEGER
);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_number ON orders(number);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id),
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL,                 -- cents
  qty         REAL NOT NULL DEFAULT 1,
  note        TEXT,
  station     TEXT NOT NULL DEFAULT 'kitchen',
  status      TEXT NOT NULL DEFAULT 'pending',  -- retail: pending|sold|void; legacy: sent|ready|served
  added_by    INTEGER REFERENCES users(id),
  added_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  sent_at     TEXT,
  void_reason TEXT,
  stock_factor REAL NOT NULL DEFAULT 1,
  cost_snapshot INTEGER, discount_allocated INTEGER NOT NULL DEFAULT 0,
  package_id INTEGER REFERENCES stock_packages(id), package_name TEXT,
  units_per_package REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_oi_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method     TEXT NOT NULL,                     -- cash|card|mpesa
  amount     INTEGER NOT NULL,                  -- cents
  reference  TEXT,
  tip        INTEGER NOT NULL DEFAULT 0,
  cashier_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  kind TEXT NOT NULL DEFAULT 'sale',
  idempotency_key TEXT,
  tendered INTEGER,
  change_given INTEGER NOT NULL DEFAULT 0,
  return_id INTEGER REFERENCES returns(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pay_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS stock_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  unit     TEXT NOT NULL DEFAULT 'pcs',
  qty      REAL NOT NULL DEFAULT 0,
  min_qty  REAL NOT NULL DEFAULT 0,
  cost     INTEGER NOT NULL DEFAULT 0,          -- cents per unit
  deduction_mode TEXT NOT NULL DEFAULT 'auto',  -- auto|count (weighed at stocktake)
  capacity_ml REAL                              -- ml in one bottle/can/keg unit
);

CREATE TABLE IF NOT EXISTS stock_packages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_item_id     INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  units_per_package REAL NOT NULL CHECK(units_per_package > 0),
  sku               TEXT,
  barcode           TEXT,
  purchase_cost     INTEGER NOT NULL DEFAULT 0,
  sale_price        INTEGER NOT NULL DEFAULT 0,
  saleable          INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_package_sku ON stock_packages(sku) WHERE sku IS NOT NULL AND sku!='';
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_package_barcode ON stock_packages(barcode) WHERE barcode IS NOT NULL AND barcode!='';

CREATE TABLE IF NOT EXISTS stock_moves (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_item_id  INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  delta          REAL NOT NULL,
  reason         TEXT,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  movement_type  TEXT NOT NULL DEFAULT 'LEGACY',
  reference_type TEXT,
  reference_id   INTEGER,
  reference_code TEXT,
  qty_before     REAL,
  qty_after      REAL,
  unit_cost_snapshot INTEGER,
  idempotency_key TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  user_name  TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

/* ---------------- Phase 2-4 schema ---------------- */

-- Multi-location (Phase 4)
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT,
  phone      TEXT,
  kra_pin    TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);

-- Recipe / bill of materials (Phase 2.4)
CREATE TABLE IF NOT EXISTS recipes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  qty           REAL NOT NULL DEFAULT 0,
  UNIQUE(menu_item_id, stock_item_id)
);

-- Happy hour / daypart pricing (Phase 2.7)
CREATE TABLE IF NOT EXISTS dayparts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  days         TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',  -- 0=Sun
  start_time   TEXT NOT NULL,                            -- 'HH:MM'
  end_time     TEXT NOT NULL,                            -- 'HH:MM' (may wrap past midnight)
  discount_pct REAL NOT NULL DEFAULT 0,
  category_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,  -- NULL = whole menu
  station      TEXT,                                     -- NULL/kitchen/bar
  active       INTEGER NOT NULL DEFAULT 1
);

-- Modifiers & variant groups (Phase 3.9)
CREATE TABLE IF NOT EXISTS modifier_groups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  min_pick INTEGER NOT NULL DEFAULT 0,
  max_pick INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS modifier_options (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  price    INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_item_modifiers (
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id     INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (menu_item_id, group_id)
);

-- Cash drawer / shift reconciliation (Phase 2.6)
CREATE TABLE IF NOT EXISTS shifts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id    INTEGER REFERENCES locations(id),
  opened_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at      TEXT,
  opened_by      INTEGER REFERENCES users(id),
  closed_by      INTEGER REFERENCES users(id),
  opening_float  INTEGER NOT NULL DEFAULT 0,
  opening_mpesa  INTEGER NOT NULL DEFAULT 0,
  opening_card   INTEGER NOT NULL DEFAULT 0,
  counted_cash   INTEGER,
  expected_cash  INTEGER,
  variance       INTEGER,
  counted_mpesa  INTEGER,
  expected_mpesa INTEGER,
  mpesa_variance INTEGER,
  counted_card   INTEGER,
  expected_card  INTEGER,
  card_variance  INTEGER,
  tender_variance INTEGER,
  stock_retail_variance INTEGER,
  overall_variance INTEGER,
  reconciliation_status TEXT,
  reconciliation_note TEXT,
  stock_count_id INTEGER REFERENCES stock_counts(id),
  stock_count_type TEXT,
  stock_coverage TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'open'   -- open|reconciling|closed
);
CREATE TABLE IF NOT EXISTS cash_payouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id   INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  amount     INTEGER NOT NULL,
  reason     TEXT,
  method     TEXT NOT NULL DEFAULT 'cash',
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Open bar tabs / card pre-authorisation (Phase 3.8)
CREATE TABLE IF NOT EXISTS tabs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  phone         TEXT,
  card_last4    TEXT,
  preauth_amount INTEGER NOT NULL DEFAULT 0,
  preauth_ref   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open|settled|released
  notes         TEXT,
  opened_by     INTEGER REFERENCES users(id),
  opened_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at     TEXT
);

-- Staff time & labour cost (Phase 3.10)
CREATE TABLE IF NOT EXISTS timeclock (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  clock_out  TEXT,
  note       TEXT
);

-- Reservations (Phase 3.11)
CREATE TABLE IF NOT EXISTS reservations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT,
  people      INTEGER NOT NULL DEFAULT 2,
  res_date    TEXT NOT NULL,             -- YYYY-MM-DD
  res_time    TEXT NOT NULL,             -- HH:MM
  table_id    INTEGER REFERENCES tables(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'booked',  -- booked|seated|cancelled|no_show
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by  INTEGER REFERENCES users(id)
);

-- Loyalty & gift cards (Phase 3.12)
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT UNIQUE,
  email      TEXT,
  points     INTEGER NOT NULL DEFAULT 0,
  total_spend INTEGER NOT NULL DEFAULT 0,
  visits     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS gift_card_funding (
  id INTEGER PRIMARY KEY AUTOINCREMENT, amount INTEGER NOT NULL, method TEXT NOT NULL,
  reference TEXT, shift_id INTEGER REFERENCES shifts(id), created_by INTEGER REFERENCES users(id),
  idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS gift_cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  value      INTEGER NOT NULL,
  balance    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',   -- active|depleted|void
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER REFERENCES users(id),
  funding_id INTEGER REFERENCES gift_card_funding(id)
);
CREATE TABLE IF NOT EXISTS loyalty_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id    INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  points      INTEGER NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Staff bulk settlement: a waiter hands over the day's takings and is cleared at once.
CREATE TABLE IF NOT EXISTS staff_settlements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  method     TEXT NOT NULL DEFAULT 'cash',
  note       TEXT,
  by_id      INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

/* ------------------------------------------------------------------ */
/* Credential hashing — salted scrypt, timing-safe compare              */
/* ------------------------------------------------------------------ */
const hashPin = (pin) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
};
const verifyPin = (pin, stored) => {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(String(pin), salt, 64);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};
/** First active user whose stored hash matches the candidate, else null. */
const findUserByPin = (pin) =>
  db.prepare('SELECT id,name,role FROM users WHERE active=1').all()
    .find((u) => verifyPin(pin, db.prepare('SELECT pin FROM users WHERE id=?').get(u.id).pin)) || null;
/** True if any other active user already uses this PIN. */
const pinTaken = (pin, excludeId = null) =>
  db.prepare('SELECT id,pin FROM users WHERE active=1').all()
    .some((u) => u.id !== excludeId && verifyPin(pin, u.pin));

/* ------------------------------------------------------------------ */
/* Migration — add columns to databases created by an earlier version   */
/* ------------------------------------------------------------------ */
function migrate() {
  const has = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const add = (table, col, ddl) => {
    if (!has(table, col)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
  };

  add('order_items', 'modifiers', 'modifiers TEXT');
  add('order_items', 'stock_factor', 'stock_factor REAL NOT NULL DEFAULT 1');
  add('order_items', 'cost_snapshot', 'cost_snapshot INTEGER');
  add('order_items', 'discount_allocated', 'discount_allocated INTEGER NOT NULL DEFAULT 0');
  add('order_items', 'package_id', 'package_id INTEGER REFERENCES stock_packages(id)');
  add('order_items', 'package_name', 'package_name TEXT');
  add('order_items', 'units_per_package', 'units_per_package REAL NOT NULL DEFAULT 1');
  add('orders', 'channel', "channel TEXT NOT NULL DEFAULT 'dine_in'");
  add('orders', 'commission', 'commission INTEGER NOT NULL DEFAULT 0');
  add('orders', 'location_id', 'location_id INTEGER REFERENCES locations(id)');
  add('orders', 'tab_id', 'tab_id INTEGER REFERENCES tabs(id)');
  add('orders', 'customer_id', 'customer_id INTEGER REFERENCES customers(id)');
  add('orders', 'shift_id', 'shift_id INTEGER REFERENCES shifts(id)');
  add('tables', 'location_id', 'location_id INTEGER REFERENCES locations(id)');
  add('tables', 'qr_token', 'qr_token TEXT');
  add('users', 'hourly_rate', 'hourly_rate INTEGER NOT NULL DEFAULT 0');
  add('stock_items', 'location_id', 'location_id INTEGER REFERENCES locations(id)');
  add('stock_items', 'deduction_mode', "deduction_mode TEXT NOT NULL DEFAULT 'auto'");
  add('stock_items', 'capacity_ml', 'capacity_ml REAL');
  add('stock_moves', 'movement_type', "movement_type TEXT NOT NULL DEFAULT 'LEGACY'");
  add('stock_moves', 'reference_type', 'reference_type TEXT');
  add('stock_moves', 'reference_id', 'reference_id INTEGER');
  add('stock_moves', 'reference_code', 'reference_code TEXT');
  add('stock_moves', 'qty_before', 'qty_before REAL');
  add('stock_moves', 'qty_after', 'qty_after REAL');
  add('stock_moves', 'unit_cost_snapshot', 'unit_cost_snapshot INTEGER');
  add('stock_moves', 'idempotency_key', 'idempotency_key TEXT');
  db.prepare(`UPDATE stock_moves SET movement_type=CASE
    WHEN reason LIKE 'Recipe usage%' THEN 'SALE'
    WHEN reason LIKE 'Delivery %' THEN 'PURCHASE'
    WHEN reason LIKE 'Opening stock%' OR reason LIKE 'CSV opening stock%' THEN 'OPENING_STOCK'
    WHEN reason LIKE 'Stocktake %' THEN 'STOCKTAKE'
    WHEN reason LIKE 'Complimentary:%' THEN 'COMPLIMENTARY'
    WHEN reason LIKE 'Return %' THEN 'RETURN'
    ELSE movement_type END WHERE movement_type='LEGACY'`).run();
  add('payments', 'shift_id', 'shift_id INTEGER REFERENCES shifts(id)');
  add('payments', 'kind', "kind TEXT NOT NULL DEFAULT 'sale'");
  add('payments', 'idempotency_key', 'idempotency_key TEXT');
  add('payments', 'tendered', 'tendered INTEGER');
  add('payments', 'change_given', 'change_given INTEGER NOT NULL DEFAULT 0');
  add('payments', 'return_id', 'return_id INTEGER REFERENCES returns(id)');
  db.prepare("UPDATE payments SET kind='refund' WHERE method='refund'").run();
  add('gift_cards', 'funding_id', 'funding_id INTEGER REFERENCES gift_card_funding(id)');
  add('menu_items', 'sku', 'sku TEXT');
  add('menu_items', 'barcode', 'barcode TEXT');
  add('menu_items', 'volume_ml', 'volume_ml INTEGER');
  add('menu_items', 'stock_mode', "stock_mode TEXT NOT NULL DEFAULT 'unit'");
  add('menu_items', 'serving_ml', 'serving_ml INTEGER');
  add('menu_items', 'sale_unit', "sale_unit TEXT NOT NULL DEFAULT 'piece'");
  add('menu_items', 'kra_item_code', 'kra_item_code TEXT');
  add('menu_items', 'tax_type', "tax_type TEXT NOT NULL DEFAULT 'B'");
  add('orders', 'age_verified', 'age_verified INTEGER NOT NULL DEFAULT 0');
  add('orders', 'age_check_note', 'age_check_note TEXT');
  add('orders', 'closed_out', 'closed_out INTEGER NOT NULL DEFAULT 0');
  add('orders', 'subtotal_snapshot', 'subtotal_snapshot INTEGER');
  add('orders', 'service_snapshot', 'service_snapshot INTEGER');
  add('orders', 'vat_snapshot', 'vat_snapshot INTEGER');
  add('orders', 'total_snapshot', 'total_snapshot INTEGER');
  add('orders', 'grand_total_snapshot', 'grand_total_snapshot INTEGER');
  db.prepare("UPDATE orders SET closed_out=1 WHERE status='closed'").run();
  db.prepare(`UPDATE order_items SET cost_snapshot=ROUND(COALESCE((SELECT cost FROM menu_items m WHERE m.id=order_items.menu_item_id),0)*stock_factor)
    WHERE cost_snapshot IS NULL`).run();
  add('shifts', 'opening_mpesa', 'opening_mpesa INTEGER NOT NULL DEFAULT 0');
  add('shifts', 'opening_card', 'opening_card INTEGER NOT NULL DEFAULT 0');
  add('shifts', 'counted_mpesa', 'counted_mpesa INTEGER');
  add('shifts', 'expected_mpesa', 'expected_mpesa INTEGER');
  add('shifts', 'mpesa_variance', 'mpesa_variance INTEGER');
  add('shifts', 'counted_card', 'counted_card INTEGER');
  add('shifts', 'expected_card', 'expected_card INTEGER');
  add('shifts', 'card_variance', 'card_variance INTEGER');
  add('shifts', 'tender_variance', 'tender_variance INTEGER');
  add('shifts', 'stock_retail_variance', 'stock_retail_variance INTEGER');
  add('shifts', 'overall_variance', 'overall_variance INTEGER');
  add('shifts', 'reconciliation_status', 'reconciliation_status TEXT');
  add('shifts', 'reconciliation_note', 'reconciliation_note TEXT');
  add('shifts', 'stock_count_id', 'stock_count_id INTEGER REFERENCES stock_counts(id)');
  add('shifts', 'stock_count_type', 'stock_count_type TEXT');
  add('shifts', 'stock_coverage', 'stock_coverage TEXT');
  add('cash_payouts', 'method', "method TEXT NOT NULL DEFAULT 'cash'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS gift_card_funding (
      id INTEGER PRIMARY KEY AUTOINCREMENT, amount INTEGER NOT NULL, method TEXT NOT NULL,
      reference TEXT, shift_id INTEGER REFERENCES shifts(id), created_by INTEGER REFERENCES users(id),
      idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
      amount INTEGER NOT NULL, method TEXT NOT NULL, reason TEXT NOT NULL,
      restocked INTEGER NOT NULL DEFAULT 0, shift_id INTEGER REFERENCES shifts(id),
      created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
      order_item_id INTEGER REFERENCES order_items(id), menu_item_id INTEGER REFERENCES menu_items(id),
      item_name TEXT NOT NULL, qty REAL NOT NULL, stock_factor REAL NOT NULL DEFAULT 1,
      amount INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_return ON payments(return_id) WHERE return_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gift_funding ON gift_cards(funding_id) WHERE funding_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gift_funding_idem ON gift_card_funding(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_sku ON menu_items(sku) WHERE sku IS NOT NULL AND sku != '';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_barcode ON menu_items(barcode) WHERE barcode IS NOT NULL AND barcode != '';
    CREATE TABLE IF NOT EXISTS stock_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL, units_per_package REAL NOT NULL CHECK(units_per_package > 0),
      sku TEXT, barcode TEXT, purchase_cost INTEGER NOT NULL DEFAULT 0,
      sale_price INTEGER NOT NULL DEFAULT 0, saleable INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_package_sku ON stock_packages(sku) WHERE sku IS NOT NULL AND sku!='';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_package_barcode ON stock_packages(barcode) WHERE barcode IS NOT NULL AND barcode!='';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_move_idempotency ON stock_moves(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT,
      kra_pin TEXT, address TEXT, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER REFERENCES suppliers(id),
      invoice_no TEXT NOT NULL, notes TEXT, total_cost INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'pay_later', payment_status TEXT NOT NULL DEFAULT 'unpaid',
      received_by INTEGER REFERENCES users(id), received_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS goods_receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id), qty REAL NOT NULL,
      unit_cost INTEGER NOT NULL DEFAULT 0, batch_no TEXT, expiry_date TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      notes TEXT, started_by INTEGER REFERENCES users(id), completed_by INTEGER REFERENCES users(id),
      started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), completed_at TEXT,
      cost_variance INTEGER NOT NULL DEFAULT 0, retail_variance INTEGER NOT NULL DEFAULT 0,
      count_type TEXT NOT NULL DEFAULT 'full', scope_label TEXT, category_id INTEGER REFERENCES categories(id),
      for_close INTEGER NOT NULL DEFAULT 1, shift_id INTEGER REFERENCES shifts(id),
      total_stock_items INTEGER NOT NULL DEFAULT 0, coverage_count INTEGER NOT NULL DEFAULT 0,
      coverage_ratio REAL NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS stock_count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, stock_count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id), expected REAL NOT NULL,
      counted REAL, variance REAL, added_qty REAL NOT NULL DEFAULT 0,
      cost_variance INTEGER NOT NULL DEFAULT 0, retail_variance INTEGER NOT NULL DEFAULT 0,
      UNIQUE(stock_count_id,stock_item_id)
    );
    CREATE TABLE IF NOT EXISTS complimentary_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER REFERENCES menu_items(id), item_name TEXT NOT NULL,
      qty REAL NOT NULL, measure_ml REAL, stock_factor REAL NOT NULL DEFAULT 1,
      retail_value INTEGER NOT NULL DEFAULT 0, cost_value INTEGER NOT NULL DEFAULT 0,
      stock_item_id INTEGER REFERENCES stock_items(id), stock_qty REAL NOT NULL DEFAULT 0,
      deducted INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL, recipient TEXT,
      shift_id INTEGER REFERENCES shifts(id), created_by INTEGER REFERENCES users(id),
      authorized_by INTEGER REFERENCES users(id), authorization_reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS ix_complimentary_created ON complimentary_issues(created_at);
  `);
  add('stock_count_items', 'added_qty', 'added_qty REAL NOT NULL DEFAULT 0');
  add('stock_count_items', 'cost_variance', 'cost_variance INTEGER NOT NULL DEFAULT 0');
  add('stock_count_items', 'retail_variance', 'retail_variance INTEGER NOT NULL DEFAULT 0');
  add('stock_counts', 'cost_variance', 'cost_variance INTEGER NOT NULL DEFAULT 0');
  add('stock_counts', 'retail_variance', 'retail_variance INTEGER NOT NULL DEFAULT 0');
  add('stock_counts', 'count_type', "count_type TEXT NOT NULL DEFAULT 'full'");
  add('stock_counts', 'scope_label', 'scope_label TEXT');
  add('stock_counts', 'category_id', 'category_id INTEGER REFERENCES categories(id)');
  add('stock_counts', 'for_close', 'for_close INTEGER NOT NULL DEFAULT 1');
  add('stock_counts', 'shift_id', 'shift_id INTEGER REFERENCES shifts(id)');
  add('stock_counts', 'total_stock_items', 'total_stock_items INTEGER NOT NULL DEFAULT 0');
  add('stock_counts', 'coverage_count', 'coverage_count INTEGER NOT NULL DEFAULT 0');
  add('stock_counts', 'coverage_ratio', 'coverage_ratio REAL NOT NULL DEFAULT 1');
  db.prepare(`UPDATE stock_counts SET total_stock_items=CASE WHEN total_stock_items=0 THEN
    (SELECT COUNT(*) FROM stock_items) ELSE total_stock_items END,
    coverage_count=CASE WHEN coverage_count=0 THEN (SELECT COUNT(*) FROM stock_count_items i WHERE i.stock_count_id=stock_counts.id) ELSE coverage_count END,
    coverage_ratio=CASE WHEN total_stock_items>0 THEN 1.0*(SELECT COUNT(*) FROM stock_count_items i WHERE i.stock_count_id=stock_counts.id)/total_stock_items ELSE 1 END`).run();
  add('goods_receipts', 'payment_method', "payment_method TEXT NOT NULL DEFAULT 'pay_later'");
  add('goods_receipts', 'payment_status', "payment_status TEXT NOT NULL DEFAULT 'unpaid'");
  add('goods_receipts', 'idempotency_key', 'idempotency_key TEXT');
  add('goods_receipt_items', 'package_id', 'package_id INTEGER REFERENCES stock_packages(id)');
  add('goods_receipt_items', 'package_name', 'package_name TEXT');
  add('goods_receipt_items', 'package_qty', 'package_qty REAL');
  add('goods_receipt_items', 'units_per_package', 'units_per_package REAL NOT NULL DEFAULT 1');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_goods_receipt_idempotency ON goods_receipts(idempotency_key) WHERE idempotency_key IS NOT NULL");
  add('complimentary_issues', 'authorized_by', 'authorized_by INTEGER REFERENCES users(id)');
  add('complimentary_issues', 'authorization_reference', 'authorization_reference TEXT');
  add('stock_counts', 'cancelled_by', 'cancelled_by INTEGER REFERENCES users(id)');
  add('stock_counts', 'cancelled_at', 'cancelled_at TEXT');
  add('stock_counts', 'cancel_reason', 'cancel_reason TEXT');

  /* A durable migration ledger starts here. The existing additive migration is
     recorded as the baseline; all new migrations are checksum-identified and
     applied transactionally so support can tell exactly what ran on each till. */
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
  const applyMigration=(version,name,sql)=>{
    const checksum=crypto.createHash('sha256').update(sql).digest('hex');
    const prior=db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(version);
    if(prior){
      if(prior.checksum!==checksum)throw new Error(`Schema migration ${version} checksum mismatch (${name})`);
      return;
    }
    db.transaction(()=>{if(sql.trim())db.exec(sql);db.prepare(
      'INSERT INTO schema_migrations(version,name,checksum) VALUES(?,?,?)').run(version,name,checksum);})();
  };
  applyMigration(1,'legacy additive schema baseline','-- OpenPOS schema through compact receipts');
  applyMigration(2,'operational recovery and reversals',`
    CREATE TABLE transaction_reversals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_type TEXT NOT NULL, transaction_id INTEGER NOT NULL,
      reason TEXT NOT NULL, reversed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(transaction_type,transaction_id)
    );
    CREATE INDEX ix_reversals_created ON transaction_reversals(created_at);
  `);
  /* Existing owner-entered complementaries were self-authorized. */
  db.prepare('UPDATE complimentary_issues SET authorized_by=created_by WHERE authorized_by IS NULL').run();
  const isRetailDatabase = (db.prepare("SELECT value FROM settings WHERE key='business_type'").get() || {}).value === 'wines_spirits';
  /* Retail policy: buyers are handled as adults at entry; checkout must stay fast. */
  if (isRetailDatabase) {
    db.prepare("INSERT INTO settings(key,value) VALUES('age_verification_required','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
    /* Remove restaurant station semantics from existing retail catalogues once. */
    if (!db.prepare("SELECT value FROM settings WHERE key='retail_catalogue_cleanup_v1'").get()) {
      db.prepare("UPDATE categories SET station='retail'").run();
      db.prepare("UPDATE menu_items SET station='retail'").run();
      db.prepare("INSERT INTO settings(key,value) VALUES('retail_catalogue_cleanup_v1','1')").run();
    }
  }

  /* Consolidate duplicate pending retail lines created by earlier builds. */
  const duplicateLines = isRetailDatabase ? db.prepare(`SELECT MIN(id) keep_id,order_id,menu_item_id,name,price,stock_factor,
      COALESCE(note,'') note_key,COALESCE(modifiers,'') modifiers_key,SUM(qty) total_qty,COUNT(*) n
    FROM order_items WHERE status='pending' GROUP BY order_id,menu_item_id,name,price,stock_factor,COALESCE(note,''),COALESCE(modifiers,'') HAVING COUNT(*)>1`).all() : [];
  const mergeLines = db.transaction(() => {
    for (const row of duplicateLines) {
      db.prepare('UPDATE order_items SET qty=? WHERE id=?').run(row.total_qty, row.keep_id);
      db.prepare(`DELETE FROM order_items WHERE order_id=? AND menu_item_id=? AND name=? AND price=? AND stock_factor=? AND id!=?
        AND COALESCE(note,'')=? AND COALESCE(modifiers,'')=? AND status='pending'`)
        .run(row.order_id, row.menu_item_id, row.name, row.price, row.stock_factor, row.keep_id, row.note_key, row.modifiers_key);
    }
  });
  mergeLines();

  /* Older retail catalogues encoded size only in the product name. Backfill it so measured sales work immediately. */
  for (const item of db.prepare('SELECT id,name FROM menu_items WHERE volume_ml IS NULL OR volume_ml<=0').all()) {
    const matches = [...String(item.name).matchAll(/(\d+(?:\.\d+)?)\s*(ml|l)\b/ig)];
    const match = matches[matches.length - 1];
    if (match) {
      const volume = Math.round(Number(match[1]) * (match[2].toLowerCase() === 'l' ? 1000 : 1));
      if (volume > 0) db.prepare('UPDATE menu_items SET volume_ml=? WHERE id=?').run(volume, item.id);
    }
  }

  /* Attach physical container capacity to stock so every screen can show a rounded unit balance plus ml remaining. */
  db.prepare(`UPDATE stock_items SET capacity_ml=COALESCE(capacity_ml,
    (SELECT m.volume_ml FROM recipes r JOIN menu_items m ON m.id=r.menu_item_id
      WHERE r.stock_item_id=stock_items.id AND r.qty=1 AND m.stock_mode IN ('unit','weighed')
      ORDER BY m.id LIMIT 1), CASE WHEN deduction_mode='count' AND unit='kg' THEN 1000 END)
    WHERE capacity_ml IS NULL OR capacity_ml<=0`).run();

  /* Repair financial values for stocktakes completed by the build that saved data then returned HTTP 500. */
  const completedCounts = db.prepare(`SELECT id FROM stock_counts c WHERE status='completed' AND cost_variance=0 AND retail_variance=0
    AND EXISTS (SELECT 1 FROM stock_count_items i WHERE i.stock_count_id=c.id AND ABS(COALESCE(i.variance,0))>0.000001)`).all();
  for (const count of completedCounts) {
    let costTotal = 0, retailTotal = 0;
    for (const row of db.prepare('SELECT * FROM stock_count_items WHERE stock_count_id=?').all(count.id)) {
      const stock = db.prepare('SELECT cost FROM stock_items WHERE id=?').get(row.stock_item_id) || { cost: 0 };
      const retail = db.prepare(`SELECT COALESCE(MAX(CASE WHEN m.stock_mode='unit' AND r.qty=1 THEN m.price END),
        MAX(CASE WHEN r.qty>0 AND m.available=1 THEN m.price/r.qty END),0) value
        FROM recipes r JOIN menu_items m ON m.id=r.menu_item_id WHERE r.stock_item_id=?`).get(row.stock_item_id);
      const costValue = Math.round((row.variance || 0) * stock.cost), retailValue = Math.round((row.variance || 0) * (retail.value || 0));
      costTotal += costValue; retailTotal += retailValue;
      db.prepare('UPDATE stock_count_items SET cost_variance=?,retail_variance=? WHERE id=?').run(costValue, retailValue, row.id);
    }
    db.prepare('UPDATE stock_counts SET cost_variance=?,retail_variance=? WHERE id=?').run(costTotal, retailTotal, count.id);
  }

  /* Upgrade any credentials left in plaintext by an older release.
     A stored value not starting with the hash marker is plaintext. */
  for (const u of db.prepare("SELECT id, pin FROM users WHERE pin NOT LIKE 'scrypt$%'").all()) {
    db.prepare('UPDATE users SET pin=? WHERE id=?').run(hashPin(u.pin), u.id);
  }
}
migrate();

/* ------------------------------------------------------------------ */
/* Money helpers                                                       */
/* ------------------------------------------------------------------ */
const round = (n) => Math.round(n + Number.EPSILON);
const money = (cents) => (Number(cents) || 0) / 100;
const toCents = (v) => round((Number(v) || 0) * 100);

/**
 * Local wall-clock time as 'YYYY-MM-DD HH:MM:SS' — byte-identical in format to
 * SQLite's datetime('now','localtime'), which is what every row timestamp uses.
 *
 * Never substitute `new Date().toISOString()` here: that is UTC. On any machine
 * whose timezone is not UTC the two disagree, and every `BETWEEN a AND b` over
 * timestamps silently inverts or misses. This was a live bug — it only showed up
 * outside UTC.
 */
const pad = (n) => String(n).padStart(2, '0');
const nowLocal = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const todayLocal = (d = new Date()) => nowLocal(d).slice(0, 10);

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
/* Generic, white-label defaults. A real deployment overrides these in onboarding
   or under Manager → Settings; nothing here is tied to a specific business. */
const DEFAULT_SETTINGS = {
  business_name: 'My Wines & Spirits',
  address: '',
  phone: '',
  kra_pin: '',
  currency: 'KES',
  currency_symbol: 'KSh',
  vat_rate: '16',
  tax_mode: 'inclusive',
  service_charge_enabled: '0',
  service_charge_rate: '0',
  receipt_footer: 'Asante sana. Please drink responsibly. No sale to persons under 18.',
  receipt_footer_lines: '3',
  receipt_show_address: '1',
  receipt_show_phone: '1',
  receipt_show_kra_pin: '1',
  receipt_show_licence: '1',
  default_people: '1',
  business_type: 'wines_spirits',
  minimum_sale_age: '18',
  age_verification_required: '0',
  prevent_negative_stock: '1',
  barcode_scanner_enabled: '0',
  reconciliation_tolerance: '20',
  reconciliation_critical_threshold: '500',
  stock_count_close_policy: 'none',       // none|any|full; tender close remains required daily
  licence_number: '',
  licence_expiry: '',
  sales_hours_enforced: '0',
  sales_open_time: '00:00',
  sales_close_time: '23:59',

  /* --- ESC/POS thermal printing (Phase 2.5) ---
     Leave printer_host blank to keep using browser printing. */
  printer_enabled: '0',
  printer_host: '',
  printer_port: '9100',
  printer_chars: '42',
  printer_code_page: 'cp437',
  kitchen_printer_host: '',
  kitchen_printer_port: '9100',
  drawer_kick_enabled: '1',
  auto_print_docket: '1',   // print the kitchen/bar docket the moment an order is fired

  /* --- Loyalty (Phase 3.12) --- */
  loyalty_enabled: '0',
  loyalty_earn_per: '100',        // 1 point per this many shillings
  loyalty_redeem_per: '1',        // 1 point = this many shillings off
  giftcard_prefix: 'GC',

  /* --- Labour (Phase 3.10) --- */
  labour_target_pct: '30',

  /* --- Multi-location (Phase 4.13) --- */
  multi_location: '0',
  active_location_id: '1',

  /* --- KRA eTIMS integration — CONFIG ONLY, no live transmission yet.
         Credentials live here so each business supplies its own.
         When an integration is written it should read these keys and
         hook transmitInvoice() in lib/integrations.js. --- */
  etims_enabled: '0',
  etims_endpoint: 'https://etims-api.kra.go.ke/etims-api',
  etims_username: '',
  etims_password: '',
  etims_branch_code: '00',
  etims_device_serial: '',
  etims_receipt_prefix: '',
  etims_offline_queue_hours: '48',

  /* --- Safaricom Daraja / M-Pesa — CONFIG ONLY, no live push yet.
         STK push remains a manual confirmation-code flow until
         lib/integrations.js is implemented against these keys. --- */
  mpesa_enabled: '0',
  mpesa_env: 'sandbox',
  mpesa_consumer_key: '',
  mpesa_consumer_secret: '',
  mpesa_shortcode: '174379',
  mpesa_passkey: '',
  mpesa_callback_url: '',
  mpesa_paybill_account: ''
};

const isAllowedSetting=(key)=>Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS,key);
const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  return DEFAULT_SETTINGS[key] ?? '';
};
const getSettings = () => {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  out.vat_rate = Number(out.vat_rate) || 0;
  out.service_charge_rate = Number(out.service_charge_rate) || 0;
  out.service_charge_enabled = out.service_charge_enabled === '1';
  return out;
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Onboarding & seeding — white-label                                 */
/*                                                                    */
/* A fresh install is deliberately EMPTY. initBase() only writes      */
/* structural rows (settings defaults, counters, one location).       */
/* loadSampleData() is an OPT-IN template a restaurant may load       */
/* during onboarding or later from Settings; it never runs on its own.*/
/* ------------------------------------------------------------------ */

/** Structural rows needed for the app to run before any data exists. */
function initBase() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);
  db.prepare("INSERT INTO counters(key,value) VALUES('order_number',1000) ON CONFLICT(key) DO NOTHING").run();
  if (!db.prepare('SELECT id FROM locations LIMIT 1').get())
    db.prepare("INSERT INTO locations(name,address,phone) VALUES('Main Branch',NULL,NULL)").run();
}

/** Has the restaurant completed first-run setup? (i.e. at least one user exists) */
const setupStatus = () => ({
  needs_setup: db.prepare('SELECT COUNT(*) c FROM users').get().c === 0,
  business_name: getSetting('business_name')
});


/** RFC-4180-style CSV parser used by onboarding and owner bulk import. */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  if (quoted) throw new Error('CSV has an unclosed quoted field');
  return rows;
}

function importRetailCsv(text, userId = null) {
  if (!String(text || '').trim()) throw new Error('CSV file is empty');
  if (String(text).length > 2_000_000) throw new Error('CSV is too large (maximum 2 MB)');
  const matrix = parseCsv(text);
  if (matrix.length < 2) throw new Error('CSV needs a header and at least one product');
  const headers = matrix[0].map((h) => h.toLowerCase().trim().replace(/[\s-]+/g, '_'));
  const required = ['name', 'category', 'size_ml', 'price'];
  for (const key of required) if (!headers.includes(key)) throw new Error(`CSV is missing required column: ${key}`);
  const rows = matrix.slice(1).map((values, i) => ({ line: i + 2,
    ...Object.fromEntries(headers.map((h, n) => [h, values[n] == null ? '' : values[n]])) }));
  if (rows.length > 2000) throw new Error('CSV supports up to 2,000 products per import');
  const skuSeen = new Set(), barcodeSeen = new Set();
  for (const r of rows) {
    if (!r.name || !r.category) throw new Error(`Line ${r.line}: name and category are required`);
    if (!(Number(r.size_ml) > 0) || !(Number(r.price) >= 0)) throw new Error(`Line ${r.line}: size_ml and price must be valid numbers`);
    if (r.sku && (skuSeen.has(r.sku.toLowerCase()) || db.prepare('SELECT id FROM menu_items WHERE lower(sku)=lower(?)').get(r.sku)))
      throw new Error(`Line ${r.line}: duplicate SKU ${r.sku}`);
    if (r.barcode && (barcodeSeen.has(r.barcode) || db.prepare('SELECT id FROM menu_items WHERE barcode=?').get(r.barcode)))
      throw new Error(`Line ${r.line}: duplicate barcode ${r.barcode}`);
    if (r.sku) skuSeen.add(r.sku.toLowerCase()); if (r.barcode) barcodeSeen.add(r.barcode);
  }
  const tx = db.transaction(() => {
    const categories = new Map(db.prepare('SELECT id,name FROM categories').all().map((c) => [c.name.toLowerCase(), c.id]));
    const categoryId = (name) => {
      const key = name.toLowerCase(); if (categories.has(key)) return categories.get(key);
      const id = db.prepare("INSERT INTO categories(name,station,sort_order) VALUES(?,'retail',(SELECT COALESCE(MAX(sort_order),0)+1 FROM categories))").run(name).lastInsertRowid;
      categories.set(key, id); return id;
    };
    const created = new Map(); let imported = 0;
    const ordered = [...rows.filter((r) => (r.stock_mode || 'unit').toLowerCase() !== 'pour'),
      ...rows.filter((r) => (r.stock_mode || '').toLowerCase() === 'pour')];
    for (const r of ordered) {
      const mode = ['pour', 'weighed'].includes(String(r.stock_mode).toLowerCase()) ? String(r.stock_mode).toLowerCase() : 'unit';
      const size = Number(r.size_ml), saleUnit = r.selling_unit || (mode === 'pour' ? 'shot' : mode === 'weighed' ? 'kg' : 'bottle');
      const name = /\d+(?:\.\d+)?\s*(?:ml|l)$/i.test(r.name) ? r.name : `${r.name} ${size >= 1000 ? size / 1000 + 'L' : size + 'ml'}`;
      let source = null, recipeQty = 1, cost = Math.round(Number(r.cost || 0) * 100);
      if (mode === 'pour') {
        if (!r.source_sku) throw new Error(`Line ${r.line}: pour product needs source_sku`);
        source = created.get(r.source_sku.toLowerCase()) || db.prepare(`SELECT m.id menu_id,si.* FROM menu_items m JOIN recipes x ON x.menu_item_id=m.id JOIN stock_items si ON si.id=x.stock_item_id WHERE lower(m.sku)=lower(?) LIMIT 1`).get(r.source_sku);
        if (!source) throw new Error(`Line ${r.line}: source_sku ${r.source_sku} was not found`);
        const sourceSize = Number(r.source_size_ml);
        if (!(sourceSize >= size)) throw new Error(`Line ${r.line}: source_size_ml must be at least the serving size`);
        recipeQty = source.deduction_mode === 'count' ? size / 1000 : size / sourceSize;
        if (!cost) cost = Math.round(source.cost * recipeQty);
      }
      const available = r.available === '' || r.available == null ? (mode === 'weighed' ? 0 : 1)
        : (!['0', 'false', 'no'].includes(String(r.available).toLowerCase()) ? 1 : 0);
      const itemId = db.prepare(`INSERT INTO menu_items(category_id,name,price,cost,station,available,sort_order,sku,barcode,volume_ml,stock_mode,serving_ml,sale_unit,kra_item_code,tax_type)
        VALUES(?,?,?,?, 'retail',?,999,?,?,?,?,?,?,?,?)`).run(categoryId(r.category), name,
        Math.round(Number(r.price) * 100), cost, available, r.sku || null, r.barcode || null, size, mode,
        mode === 'pour' ? size : null, saleUnit, r.kra_item_code || null, r.tax_type || 'B').lastInsertRowid;
      let stockId;
      if (mode === 'pour') stockId = source.id;
      else {
        stockId = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost,deduction_mode,capacity_ml) VALUES(?,?,?,?,?,?,?)')
          .run(name, mode === 'weighed' ? 'kg' : saleUnit, Number(r.opening_stock || 0), Number(r.reorder_level || 0), cost,
            mode === 'weighed' ? 'count' : 'auto', mode === 'weighed' ? 1000 : size).lastInsertRowid;
        if (Number(r.opening_stock || 0)) db.prepare(`INSERT INTO stock_moves(stock_item_id,delta,reason,user_id,movement_type,
          reference_type,reference_id,reference_code,qty_before,qty_after,unit_cost_snapshot)
          VALUES(?,?,?,?,'OPENING_STOCK','menu_item',?,?,0,?,?)`)
          .run(stockId, Number(r.opening_stock), 'CSV opening stock', userId, itemId, r.sku || null,
            Number(r.opening_stock), cost);
      }
      db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,?)').run(itemId, stockId, recipeQty);
      if (r.sku) created.set(r.sku.toLowerCase(), db.prepare('SELECT * FROM stock_items WHERE id=?').get(stockId));
      imported++;
    }
    return imported;
  });
  try { return { imported: tx() }; } catch (e) { throw new Error(`CSV import failed: ${e.message}`); }
}

/**
 * First-run onboarding. Only allowed while no users exist, so an installed
 * system can never be silently re-onboarded.
 */
function runSetup(p = {}) {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0)
    return { ok: false, error: 'This system is already set up. Sign in instead.' };

  const b = p.business || {};
  const ownerName = String(p.owner_name || '').trim();
  const ownerPin = String(p.owner_pin || '').trim();
  if (!ownerName) return { ok: false, error: 'An owner / admin name is required.' };
  if (!/^\d{4,6}$/.test(ownerPin)) return { ok: false, error: 'Owner PIN must be 4-6 digits.' };

  const tx = db.transaction(() => {
    initBase();

    /* business identity & tax configuration from the onboarding form */
    const set = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') setSetting(k, String(v).trim()); };
    set('business_name', b.business_name || ownerName);
    set('address', b.address); set('phone', b.phone); set('kra_pin', b.kra_pin);
    set('currency', b.currency); set('currency_symbol', b.currency_symbol);
    set('vat_rate', b.vat_rate); set('service_charge_rate', b.service_charge_rate);
    set('receipt_footer', b.receipt_footer);
    set('tax_mode', b.tax_mode);
    if (b.service_charge_enabled !== undefined) setSetting('service_charge_enabled', b.service_charge_enabled ? '1' : '0');

    /* the owner / admin account */
    const ownerId = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)').run(ownerName, hashPin(ownerPin), 'admin').lastInsertRowid;

    if (p.sample && String(p.product_csv || '').trim()) throw new Error('Choose either starter products or CSV import, not both');
    if (String(p.product_csv || '').trim()) importRetailCsv(p.product_csv, ownerId);
    if (p.sample) {
      if (b.business_type === 'wines_spirits') loadSampleData();
      else {
        setSetting('business_type', 'restaurant');
        setSetting('service_charge_enabled', '1');
        setSetting('service_charge_rate', '10');
        setSetting('default_people', '2');
        loadLegacySampleData();
      }
    }
  });
  try { tx(); } catch (e) { return { ok: false, error: e.message }; }
  audit(null, 'setup.complete', `business="${getSetting('business_name')}" sample=${p.sample ? 'yes' : 'no'} csv=${String(p.product_csv || '').trim() ? 'yes' : 'no'}`);
  return { ok: true, needs_setup: false };
}

/** Fresh install: empty base only. No demo menu, staff or tables. */
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return false;
  initBase();
  return true;
}

/** Legacy restaurant template retained for existing deployments and API regression tests.
 * New retail onboarding explicitly sets business_type=wines_spirits and never uses it. */
function loadLegacySampleData() {
  if (db.prepare('SELECT COUNT(*) c FROM menu_items').get().c > 0) return false; // don't clobber

  /* sample staff (the owner/admin was created by setup; not duplicated here) */
  const insUser = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)');
  [
    ['Amina (Manager)', '1111', 'manager'],
    ['Brian (Waiter)', '1234', 'waiter'],
    ['Achieng (Waiter)', '1235', 'waiter'],
    ['Njeri (Cashier)', '2345', 'cashier'],
    ['Otis (Bar)', '3456', 'bartender'],
    ['Kamau (Kitchen)', '4567', 'kitchen']
  ].forEach(([n, pin, role]) => insUser.run(n, hashPin(pin), role));

  const insCat = db.prepare('INSERT INTO categories(name,station,sort_order) VALUES(?,?,?)');
  const cats = {};
  [
    ['Starters', 'kitchen'], ['Swahili Mains', 'kitchen'], ['Grills & Choma', 'kitchen'],
    ['Pizza', 'kitchen'], ['Sides', 'kitchen'], ['Desserts', 'kitchen'],
    ['Cocktails', 'bar'], ['Spirits', 'bar'], ['Wine & Bubbles', 'bar'],
    ['Beer & Cider', 'bar'], ['Soft Drinks', 'bar'], ['Hot Drinks', 'bar'], ['Shisha', 'bar']
  ].forEach(([n, st], i) => { cats[n] = insCat.run(n, st, i + 1).lastInsertRowid; });

  const insItem = db.prepare(
    'INSERT INTO menu_items(category_id,name,price,cost,station,sort_order) VALUES(?,?,?,?,?,?)');
  const MENU = {
    Starters: [
      ['Samosa - Beef (4 pcs)', 250, 90], ['Chicken Wings - BBQ (6 pcs)', 650, 320],
      ['Mishkaki Skewers (3)', 550, 260], ['Fish Fingers & Tartare', 700, 330],
      ['Spring Rolls (6 pcs)', 350, 140], ['Garlic Prawns', 950, 520], ['Soup of the Day', 300, 90]],
    'Swahili Mains': [
      ['Pilau Special', 750, 280], ['Chicken Biryani', 850, 340], ['Beef Stew & Ugali', 600, 230],
      ['Mukimo & Beef', 700, 270], ['Coconut Fish Curry', 1100, 520], ['Chicken Curry & Rice', 800, 350]],
    'Grills & Choma': [
      ['Nyama Choma 500g', 900, 420], ['Nyama Choma 1kg', 1750, 820], ['Wet Fry Beef', 850, 400],
      ['Kuku Choma (Half)', 900, 430], ['Grilled Whole Tilapia', 1200, 620],
      ['Mixed Grill Platter', 1950, 950], ['BBQ Pork Ribs (Full Rack)', 1600, 780],
      ['Grilled Chicken Quarter', 650, 300]],
    Pizza: [
      ['Margherita', 900, 280], ['Chicken Tikka Pizza', 1200, 430], ['Beef Pepperoni', 1250, 460],
      ['Veggie Supreme', 1100, 360], ['BBQ Chicken Pizza', 1250, 440]],
    Sides: [
      ['Ugali', 100, 20], ['Chapati', 60, 12], ['Sukuma Wiki', 150, 45], ['Kachumbari', 120, 40],
      ['Chips (Fries)', 250, 80], ['Masala Chips', 350, 120], ['Steamed Rice', 150, 40]],
    Desserts: [
      ['Chocolate Lava Cake', 450, 160], ['Fresh Fruit Platter', 400, 180], ['Ice Cream (2 scoops)', 300, 100]],
    Cocktails: [
      ['Dawa', 650, 220], ['Mojito', 700, 230], ['Passion Mojito', 750, 250], ['Margarita', 750, 260],
      ['Pina Colada', 800, 280], ['Tequila Sunrise', 700, 240], ['Sex on the Beach', 700, 230],
      ['Whiskey Sour', 750, 300], ['Espresso Martini', 850, 330], ['Baileys Shake', 800, 320]],
    Spirits: [
      ['Whiskey - Single 30ml', 350, 150], ['Vodka - Single 30ml', 300, 120],
      ['Gin - Single 30ml', 300, 120], ['Rum - Single 30ml', 320, 130],
      ['Tequila - Single 30ml', 350, 150], ['Baileys - Single 30ml', 380, 170]],
    'Wine & Bubbles': [
      ['House Red (Glass)', 450, 160], ['House White (Glass)', 450, 160],
      ['Chenin Blanc (Bottle)', 2600, 1400], ['Cabernet Sauvignon (Bottle)', 3200, 1750],
      ['4th Street Sweet Red (Bottle)', 1600, 850], ['Prosecco (Bottle)', 3800, 2100],
      ['Moët & Chandon (Bottle)', 12000, 7200]],
    'Beer & Cider': [
      ['Tusker (Bottle)', 250, 150], ['Tusker Lite', 250, 150], ['White Cap', 250, 150],
      ['Pilsner', 280, 170], ['Summit Lager', 280, 170], ['Heineken', 350, 220],
      ['Savanna Dry', 350, 220], ['Savanna Dark', 350, 220], ['Somersby Cider', 300, 180],
      ['Tusker Malt 500ml', 300, 180]],
    'Soft Drinks': [
      ['Coca-Cola 500ml', 120, 70], ['Sprite 500ml', 120, 70], ['Fanta 500ml', 120, 70],
      ['Soda Water', 120, 60], ['Tonic Water', 150, 80], ['Fresh Orange Juice', 250, 100],
      ['Passion Juice', 250, 100], ['Mango Smoothie', 350, 150], ['Still Water 500ml', 100, 50],
      ['Sparkling Water 750ml', 250, 130]],
    'Hot Drinks': [
      ['Chai', 150, 40], ['Kenyan AA Coffee', 200, 70], ['Hot Dawa', 300, 110], ['Hot Chocolate', 250, 90]],
    Shisha: [
      ['Shisha - Single Flavour', 1500, 450], ['Shisha - Double Flavour', 1800, 550],
      ['Ice Hose Upgrade', 300, 60], ['Shisha Head Refill', 800, 250]]
  };
  const KITCHEN = new Set(['Starters', 'Swahili Mains', 'Grills & Choma', 'Pizza', 'Sides', 'Desserts']);
  for (const [cat, items] of Object.entries(MENU))
    items.forEach((it, i) => insItem.run(cats[cat], it[0], it[1] * 100, it[2] * 100, KITCHEN.has(cat) ? 'kitchen' : 'bar', i + 1));

  const insTable = db.prepare('INSERT INTO tables(name,area,seats,sort_order) VALUES(?,?,?,?)');
  let tn = 0;
  for (let i = 1; i <= 10; i++) insTable.run('T' + i, 'Restaurant', [2, 4, 4, 6, 4, 2, 4, 4, 6, 4][(i - 1) % 10], ++tn);
  for (let i = 1; i <= 6; i++) insTable.run('TT' + i, 'Terrace', [4, 4, 6, 4, 2, 6][(i - 1) % 6], ++tn);
  for (let i = 1; i <= 8; i++) insTable.run('L' + i, 'Lounge', [4, 6, 4, 4, 6, 8, 4, 4][(i - 1) % 8], ++tn);
  for (let i = 1; i <= 3; i++) insTable.run('VIP' + i, 'VIP', [8, 10, 12][i - 1], ++tn);

  const insStock = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost) VALUES(?,?,?,?,?)');
  [
    ['Beef', 'kg', 42, 15, 65000], ['Chicken', 'kg', 38, 15, 45000], ['Tilapia', 'kg', 20, 8, 70000],
    ['Rice', 'kg', 80, 30, 18000], ['Potatoes', 'kg', 95, 40, 8000], ['Wheat Flour', 'kg', 45, 20, 12000],
    ['Cooking Oil', 'L', 30, 12, 35000], ['Milk', 'L', 18, 10, 15000], ['Tomatoes', 'kg', 25, 12, 12000],
    ['Onions', 'kg', 30, 12, 9000], ['Sukuma Wiki', 'bunch', 60, 30, 5000], ['Lemons', 'kg', 12, 6, 15000],
    ['Sugar', 'kg', 22, 10, 16000], ['Coffee Beans', 'kg', 6, 3, 180000], ['Charcoal', 'bag', 14, 6, 90000],
    ['Shisha Coal', 'pack', 9, 5, 70000], ['Shisha Molasses', 'kg', 7, 4, 120000],
    ['Tusker', 'crate', 18, 8, 420000], ['Soda (Assorted)', 'crate', 12, 6, 240000],
    ['Napkins', 'pack', 40, 20, 4000]
  ].forEach((st) => insStock.run(...st));

  /* attach tables & stock to the default location */
  const locId = (db.prepare('SELECT id FROM locations LIMIT 1').get() || {}).id;
  if (locId) {
    db.prepare('UPDATE tables SET location_id=? WHERE location_id IS NULL').run(locId);
    db.prepare('UPDATE stock_items SET location_id=? WHERE location_id IS NULL').run(locId);
  }

  /* staff pay rates (Phase 3.10) — cents per hour */
  const RATE = { admin: 40000, manager: 30000, waiter: 12000, cashier: 15000, bartender: 14000, kitchen: 13000 };
  const setRate = db.prepare('UPDATE users SET hourly_rate=? WHERE role=?');
  for (const [role, rate] of Object.entries(RATE)) setRate.run(rate, role);

  /* recipes / BOM */
  const stockId = (nm) => (db.prepare('SELECT id FROM stock_items WHERE name=?').get(nm) || {}).id;
  const itemId = (nm) => (db.prepare('SELECT id FROM menu_items WHERE name=?').get(nm) || {}).id;
  const RECIPES = {
    'Nyama Choma 500g':      { Beef: 0.55, Charcoal: 0.10 },
    'Nyama Choma 1kg':       { Beef: 1.10, Charcoal: 0.20 },
    'Wet Fry Beef':          { Beef: 0.45, Tomatoes: 0.10, Onions: 0.10, 'Cooking Oil': 0.03 },
    'Grilled Whole Tilapia': { Tilapia: 0.60, Charcoal: 0.05, Lemons: 0.05 },
    'Kuku Choma (Half)':     { Chicken: 0.70, Charcoal: 0.10 },
    'Chicken Biryani':       { Chicken: 0.35, Rice: 0.25, Onions: 0.08, 'Cooking Oil': 0.03 },
    'Pilau Special':         { Beef: 0.25, Rice: 0.25, Onions: 0.08, 'Cooking Oil': 0.03 },
    'Beef Stew & Ugali':     { Beef: 0.30, Tomatoes: 0.10, Onions: 0.08 },
    'Mukimo & Beef':         { Beef: 0.25, Potatoes: 0.30 },
    'Chips (Fries)':         { Potatoes: 0.30, 'Cooking Oil': 0.05 },
    'Masala Chips':          { Potatoes: 0.30, 'Cooking Oil': 0.05, Tomatoes: 0.05 },
    'Sukuma Wiki':           { 'Sukuma Wiki': 0.40, Tomatoes: 0.05, Onions: 0.05 },
    'Chapati':               { 'Wheat Flour': 0.08, 'Cooking Oil': 0.01 },
    'Shisha - Single Flavour': { 'Shisha Molasses': 0.05, 'Shisha Coal': 0.10 },
    'Shisha - Double Flavour': { 'Shisha Molasses': 0.08, 'Shisha Coal': 0.10 },
    'Tusker (Bottle)':       { Tusker: 0.04 },
    'Kenyan AA Coffee':      { 'Coffee Beans': 0.02, Milk: 0.05 },
    'Chai':                  { Milk: 0.15, Sugar: 0.02 }
  };
  const insRecipe = db.prepare('INSERT OR IGNORE INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,?)');
  for (const [item, parts] of Object.entries(RECIPES)) {
    const mi = itemId(item); if (!mi) continue;
    for (const [stock, qty] of Object.entries(parts)) { const si = stockId(stock); if (si) insRecipe.run(mi, si, qty); }
  }

  /* happy hour / dayparts */
  const barCat = (db.prepare("SELECT id FROM categories WHERE name='Beer & Cider'").get() || {}).id;
  const cockCat = (db.prepare("SELECT id FROM categories WHERE name='Cocktails'").get() || {}).id;
  db.prepare(`INSERT INTO dayparts(name,days,start_time,end_time,discount_pct,category_id,station,active) VALUES(?,?,?,?,?,?,?,?)`)
    .run('Happy Hour - Beers', '0,1,2,3,4,5,6', '17:00', '19:00', 20, barCat, 'bar', 1);
  db.prepare(`INSERT INTO dayparts(name,days,start_time,end_time,discount_pct,category_id,station,active) VALUES(?,?,?,?,?,?,?,?)`)
    .run('Happy Hour - Cocktails', '0,1,2,3,4,5,6', '17:00', '19:00', 15, cockCat, 'bar', 1);
  db.prepare(`INSERT INTO dayparts(name,days,start_time,end_time,discount_pct,category_id,station,active) VALUES(?,?,?,?,?,?,?,?)`)
    .run('Late Night Lounge', '4,5,6', '22:00', '02:00', 10, null, 'bar', 0);   // ships disabled

  /* modifiers & variants */
  const doneness = db.prepare("INSERT INTO modifier_groups(name,required,min_pick,max_pick) VALUES('Steak doneness',1,1,1)").run().lastInsertRowid;
  [['Rare', 0], ['Medium rare', 0], ['Medium', 0], ['Well done', 0]]
    .forEach(([nm, pr], i) => db.prepare('INSERT INTO modifier_options(group_id,name,price,sort_order) VALUES(?,?,?,?)').run(doneness, nm, pr, i));
  const shishaFlav = db.prepare("INSERT INTO modifier_groups(name,required,min_pick,max_pick) VALUES('Shisha flavour',1,1,2)").run().lastInsertRowid;
  ['Double apple', 'Mint', 'Grape', 'Mango', 'Blueberry'].forEach((nm, i) =>
    db.prepare('INSERT INTO modifier_options(group_id,name,price,sort_order) VALUES(?,?,?,?)').run(shishaFlav, nm, 0, i));
  const sauce = db.prepare("INSERT INTO modifier_groups(name,required,min_pick,max_pick) VALUES('Sauce',0,0,2)").run().lastInsertRowid;
  [['Kachumbari', 0], ['Chilli sauce', 5000], ['Garlic sauce', 5000], ['BBQ sauce', 5000]]
    .forEach(([nm, pr], i) => db.prepare('INSERT INTO modifier_options(group_id,name,price,sort_order) VALUES(?,?,?,?)').run(sauce, nm, pr, i));
  const drinkSize = db.prepare("INSERT INTO modifier_groups(name,required,min_pick,max_pick) VALUES('Pour size',1,1,1)").run().lastInsertRowid;
  [['Single 30ml', 0], ['Double 60ml', 30000], ['Tot 50ml', 15000]]
    .forEach(([nm, pr], i) => db.prepare('INSERT INTO modifier_options(group_id,name,price,sort_order) VALUES(?,?,?,?)').run(drinkSize, nm, pr, i));
  const link = db.prepare('INSERT OR IGNORE INTO menu_item_modifiers(menu_item_id,group_id) VALUES(?,?)');
  for (const nm of ['Whiskey - Single 30ml', 'Vodka - Single 30ml', 'Gin - Single 30ml', 'Rum - Single 30ml']) {
    const id = itemId(nm); if (id) link.run(id, drinkSize);
  }
  for (const nm of ['Nyama Choma 500g', 'Nyama Choma 1kg', 'Wet Fry Beef', 'BBQ Pork Ribs (Full Rack)']) {
    const id = itemId(nm); if (id) { link.run(id, doneness); link.run(id, sauce); }
  }
  for (const nm of ['Shisha - Single Flavour', 'Shisha - Double Flavour']) { const id = itemId(nm); if (id) link.run(id, shishaFlav); }

  /* QR ordering tokens per table */
  const setToken = db.prepare('UPDATE tables SET qr_token=? WHERE id=?');
  for (const t of db.prepare('SELECT id FROM tables').all()) setToken.run(crypto.randomBytes(9).toString('hex'), t.id);

  /* sample customers + a gift card */
  const c1 = db.prepare("INSERT INTO customers(name,phone,email,points) VALUES('Wanjiru Kamau','0712345678','wanjiru@example.com',250)").run().lastInsertRowid;
  db.prepare("INSERT INTO customers(name,phone,email,points) VALUES('Otieno Odhiambo','0723456789',NULL,80)").run();
  db.prepare('INSERT INTO gift_cards(code,value,balance,customer_id,created_by) VALUES(?,?,?,?,?)')
    .run('GC-DEMO-1234-ABCD', 200000, 200000, c1, 1);

  return true;
}


/** Optional Kenyan wines and spirits retail template. */
function loadSampleData() {
  if (db.prepare('SELECT COUNT(*) c FROM menu_items').get().c > 0) return false; // do not clobber

  /* A small-shop team: the owner/admin already exists; these two sellers can
     sell, receive stock, perform counts, reconcile the drawer and reprint receipts. */
  const insUser = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)');
  [['Seller 1', '1234', 'seller'], ['Seller 2', '2345', 'seller']]
    .forEach(([name, pin, role]) => {
      if (!pinTaken(pin)) insUser.run(name, hashPin(pin), role);
    });

  const insCat = db.prepare('INSERT INTO categories(name,station,sort_order) VALUES(?,?,?)');
  const cats = {};
  ['Whisky', 'Vodka', 'Gin', 'Rum & Brandy', 'Wine', 'Beer & Cider', 'Liqueurs', 'Mixers & Soft Drinks']
    .forEach((name, i) => { cats[name] = insCat.run(name, 'retail', i + 1).lastInsertRowid; });

  /* Starter prices are examples in KES and are intentionally easy to edit. */
  const products = {
    Whisky: [['Kenya Cane Smooth 750ml', 850, 650], ['Johnnie Walker Red 750ml', 2100, 1750],
      ['Johnnie Walker Black 750ml', 4200, 3500], ['Jameson 750ml', 3200, 2700], ['VAT 69 750ml', 1600, 1300]],
    Vodka: [['Chrome Vodka 750ml', 750, 560], ['Smirnoff Red 750ml', 1800, 1450], ['Absolut Vodka 750ml', 2600, 2150]],
    Gin: [['Gilbeys Gin 750ml', 1400, 1100], ['Gordon’s Gin 750ml', 2400, 1950], ['Tanqueray Gin 750ml', 3500, 2900]],
    'Rum & Brandy': [['Viceroy Brandy 750ml', 1500, 1200], ['Captain Morgan Gold 750ml', 1900, 1500], ['Bacardi Carta Blanca 750ml', 2300, 1850]],
    Wine: [['Four Cousins Sweet Red 750ml', 1300, 1000], ['Four Cousins Sweet White 750ml', 1300, 1000],
      ['Drostdy-Hof Red 750ml', 1450, 1150], ['Nederburg Cabernet 750ml', 2200, 1750]],
    'Beer & Cider': [['Tusker Lager 500ml', 250, 190], ['Tusker Malt 330ml', 280, 210],
      ['White Cap 500ml', 280, 210], ['Guinness 500ml', 300, 225], ['Savanna Dry 330ml', 350, 280]],
    Liqueurs: [['Baileys 750ml', 3200, 2650], ['Jägermeister 700ml', 3500, 2900], ['Amarula 750ml', 2800, 2300]],
    'Mixers & Soft Drinks': [['Coca-Cola 500ml', 100, 65], ['Tonic Water 300ml', 120, 80],
      ['Soda Water 300ml', 100, 65], ['Minute Maid 1L', 250, 190], ['Bottled Water 500ml', 60, 35]]
  };
  const insItem = db.prepare('INSERT INTO menu_items(category_id,name,price,cost,station,sort_order,volume_ml,sale_unit) VALUES(?,?,?,?,?,?,?,?)');
  const insStock = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost,capacity_ml) VALUES(?,?,?,?,?,?)');
  const insRecipe = db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,1)');
  for (const [category, items] of Object.entries(products)) {
    items.forEach(([name, price, cost], i) => {
      const match = name.match(/(\d+(?:\.\d+)?)\s*(ml|l)\b/i);
      const volume = match ? Math.round(Number(match[1]) * (match[2].toLowerCase() === 'l' ? 1000 : 1)) : null;
      const menuId = insItem.run(cats[category], name, price * 100, cost * 100, 'retail', i + 1, volume, 'bottle').lastInsertRowid;
      const stockId = insStock.run(name, 'bottle', 12, 4, cost * 100, volume).lastInsertRowid;
      insRecipe.run(menuId, stockId); // one retail unit sold = one unit removed
      const owner=(db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get()||{}).id||null;
      db.prepare(`INSERT INTO stock_moves(stock_item_id,delta,reason,user_id,movement_type,reference_type,
        reference_id,qty_before,qty_after,unit_cost_snapshot) VALUES(?,12,'Starter opening stock',?,'OPENING_STOCK','menu_item',?,0,12,?)`)
        .run(stockId,owner,menuId,cost*100);
    });
  }

  const locId = (db.prepare('SELECT id FROM locations LIMIT 1').get() || {}).id;
  if (locId) db.prepare('UPDATE stock_items SET location_id=? WHERE location_id IS NULL').run(locId);
  db.prepare("UPDATE users SET hourly_rate=15000 WHERE role='seller'").run();
  return true;
}

/* ------------------------------------------------------------------ */
/* Order maths                                                         */
/* ------------------------------------------------------------------ */
function computeTotals(items, discount = 0, s = getSettings(), tip = 0) {
  const subtotal = items.reduce((a, it) => a + it.price * it.qty, 0);
  const disc = Math.min(Math.max(discount, 0), subtotal);
  const net = subtotal - disc;
  const scRate = s.service_charge_enabled ? s.service_charge_rate / 100 : 0;
  const service = round(net * scRate);
  const taxable = net + service;
  const vatRate = (s.vat_rate || 0) / 100;
  let vat, total;
  if (s.tax_mode === 'exclusive') { vat = round(taxable * vatRate); total = taxable + vat; }
  else { vat = round(taxable - taxable / (1 + vatRate)); total = taxable; }
  return { subtotal, discount: disc, service, vat, total, tip, grand_total: total + tip, currency: s.currency };
}

const nextOrderNumber = () => {
  db.prepare(`INSERT INTO counters(key,value) VALUES('order_number',1001)
    ON CONFLICT(key) DO UPDATE SET value = value + 1`).run();
  return db.prepare("SELECT value FROM counters WHERE key='order_number'").get().value;
};

const audit = (user, action, detail) =>
  db.prepare('INSERT INTO audit_log(user_id,user_name,action,detail) VALUES(?,?,?,?)')
    .run(user ? user.id : null, user ? user.name : 'system', action, detail || null);

module.exports = { db, seed, loadSampleData, importRetailCsv, parseCsv, setupStatus, runSetup, hashPin, verifyPin, findUserByPin, pinTaken, getSettings, setSetting, getSetting, isAllowedSetting, computeTotals, nextOrderNumber, audit, money, toCents, round, nowLocal, todayLocal, DB_PATH, DATA_DIR };

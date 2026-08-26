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
  age_check_note TEXT
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
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|ready|served|void
  added_by    INTEGER REFERENCES users(id),
  added_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  sent_at     TEXT,
  void_reason TEXT
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
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_pay_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS stock_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  unit     TEXT NOT NULL DEFAULT 'pcs',
  qty      REAL NOT NULL DEFAULT 0,
  min_qty  REAL NOT NULL DEFAULT 0,
  cost     INTEGER NOT NULL DEFAULT 0           -- cents per unit
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_item_id  INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  delta          REAL NOT NULL,
  reason         TEXT,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
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
  counted_cash   INTEGER,
  expected_cash  INTEGER,
  variance       INTEGER,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'open'   -- open|closed
);
CREATE TABLE IF NOT EXISTS cash_payouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id   INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  amount     INTEGER NOT NULL,
  reason     TEXT,
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
CREATE TABLE IF NOT EXISTS gift_cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  value      INTEGER NOT NULL,
  balance    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',   -- active|depleted|void
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER REFERENCES users(id)
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
  add('payments', 'shift_id', 'shift_id INTEGER REFERENCES shifts(id)');
  add('menu_items', 'sku', 'sku TEXT');
  add('menu_items', 'barcode', 'barcode TEXT');
  add('menu_items', 'volume_ml', 'volume_ml INTEGER');
  add('menu_items', 'kra_item_code', 'kra_item_code TEXT');
  add('menu_items', 'tax_type', "tax_type TEXT NOT NULL DEFAULT 'B'");
  add('orders', 'age_verified', 'age_verified INTEGER NOT NULL DEFAULT 0');
  add('orders', 'age_check_note', 'age_check_note TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_sku ON menu_items(sku) WHERE sku IS NOT NULL AND sku != '';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_menu_barcode ON menu_items(barcode) WHERE barcode IS NOT NULL AND barcode != '';
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT,
      kra_pin TEXT, address TEXT, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER REFERENCES suppliers(id),
      invoice_no TEXT NOT NULL, notes TEXT, total_cost INTEGER NOT NULL DEFAULT 0,
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
      started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, stock_count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id), expected REAL NOT NULL,
      counted REAL, variance REAL, UNIQUE(stock_count_id,stock_item_id)
    );
  `);

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
  default_people: '1',
  business_type: 'wines_spirits',
  minimum_sale_age: '18',
  age_verification_required: '1',
  prevent_negative_stock: '1',
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
  kitchen_printer_host: '',
  kitchen_printer_port: '9100',
  drawer_kick_enabled: '1',
  auto_print_docket: '1',   // print the kitchen/bar docket the moment an order is fired

  /* --- Loyalty (Phase 3.12) --- */
  loyalty_enabled: '1',
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
    db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)').run(ownerName, hashPin(ownerPin), 'admin');

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
  tx();
  audit(null, 'setup.complete', `business="${getSetting('business_name')}" sample=${p.sample ? 'yes' : 'no'}`);
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
    .forEach((name, i) => { cats[name] = insCat.run(name, 'bar', i + 1).lastInsertRowid; });

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
  const insItem = db.prepare('INSERT INTO menu_items(category_id,name,price,cost,station,sort_order) VALUES(?,?,?,?,?,?)');
  const insStock = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost) VALUES(?,?,?,?,?)');
  const insRecipe = db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,1)');
  for (const [category, items] of Object.entries(products)) {
    items.forEach(([name, price, cost], i) => {
      const menuId = insItem.run(cats[category], name, price * 100, cost * 100, 'bar', i + 1).lastInsertRowid;
      const stockId = insStock.run(name, 'bottle', 12, 4, cost * 100).lastInsertRowid;
      insRecipe.run(menuId, stockId); // one retail unit sold = one unit removed
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

module.exports = { db, seed, loadSampleData, setupStatus, runSetup, hashPin, verifyPin, findUserByPin, pinTaken, getSettings, setSetting, getSetting, computeTotals, nextOrderNumber, audit, money, toCents, round, nowLocal, todayLocal, DB_PATH, DATA_DIR };

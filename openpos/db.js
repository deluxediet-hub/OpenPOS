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

function tableExists(d, name) {
  return !!d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function colExists(d, table, col) {
  return d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

function addCol(d, table, col, def) {
  if (tableExists(d, table) && !colExists(d, table, col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

function migrate(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    kra_pin TEXT NOT NULL DEFAULT '',
    vat_registered INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('owner','manager','cashier','staff')),
    branch_id INTEGER REFERENCES branches(id),
    location_id INTEGER,
    register_id INTEGER,
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

  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    is_warehouse INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_locations_branch ON locations(branch_id);

  CREATE TABLE IF NOT EXISTS registers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    location_id INTEGER,
    name TEXT NOT NULL,
    printer_ip TEXT NOT NULL DEFAULT '',
    printer_width TEXT NOT NULL DEFAULT '80',
    drawer INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_registers_branch ON registers(branch_id);

  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    name TEXT NOT NULL,
    name_sw TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS business_capabilities (
    business_id INTEGER NOT NULL DEFAULT 1,
    capability TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    enabled_at TEXT,
    enabled_by INTEGER,
    PRIMARY KEY (business_id, capability)
  );

  CREATE TABLE IF NOT EXISTS user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    permission TEXT NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_id, permission)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
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
    business_id INTEGER NOT NULL DEFAULT 1,
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

  CREATE TABLE IF NOT EXISTS variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL DEFAULT '',
    axes TEXT NOT NULL DEFAULT '{}',
    axes_key TEXT NOT NULL DEFAULT '{}',
    sku TEXT NOT NULL DEFAULT '',
    price INTEGER,
    cost INTEGER,
    wholesale_price INTEGER,
    member_price INTEGER,
    tax_type TEXT,
    kra_item_code TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(product_id, axes_key)
  );
  CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);

  CREATE TABLE IF NOT EXISTS variant_barcodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    variant_id INTEGER NOT NULL REFERENCES variants(id),
    barcode TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unit' CHECK(kind IN ('unit','pack')),
    pack_id INTEGER,
    label TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(barcode)
  );
  CREATE INDEX IF NOT EXISTS idx_vbarcodes_variant ON variant_barcodes(variant_id);

  CREATE TABLE IF NOT EXISTS packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    variant_id INTEGER NOT NULL REFERENCES variants(id),
    name TEXT NOT NULL,
    multiple INTEGER NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    cost INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(variant_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_packs_variant ON packs(variant_id);

  CREATE TABLE IF NOT EXISTS serials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    variant_id INTEGER NOT NULL REFERENCES variants(id),
    serial_no TEXT NOT NULL,
    location_id INTEGER,
    status TEXT NOT NULL DEFAULT 'in_stock' CHECK(status IN ('in_stock','sold','returned','writeoff')),
    sale_id INTEGER,
    customer_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(variant_id, serial_no)
  );
  CREATE INDEX IF NOT EXISTS idx_serials_variant ON serials(variant_id, status);

  CREATE TABLE IF NOT EXISTS attribute_defs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL DEFAULT 1,
    key TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    label_sw TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text','number','select','boolean')),
    options TEXT NOT NULL DEFAULT '',
    applies_to TEXT NOT NULL DEFAULT 'variant' CHECK(applies_to IN ('product','variant')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(business_id, key)
  );

  CREATE TABLE IF NOT EXISTS price_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    price INTEGER NOT NULL,
    wholesale_price INTEGER,
    UNIQUE(product_id, branch_id)
  );

  CREATE TABLE IF NOT EXISTS stock (
    variant_id INTEGER NOT NULL,
    location_id INTEGER NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (variant_id, location_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stock_branch ON stock(location_id);

  CREATE TABLE IF NOT EXISTS stock_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    location_id INTEGER,
    qty REAL NOT NULL,
    type TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
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
    location_id INTEGER,
    batch_no TEXT NOT NULL DEFAULT '',
    expiry_date TEXT,
    qty REAL NOT NULL DEFAULT 0,
    cost INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batches_fefo ON batches(product_id, location_id, expiry_date);

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
    business_id INTEGER NOT NULL DEFAULT 1,
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
    location_id INTEGER,
    register_id INTEGER,
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
    business_id INTEGER NOT NULL DEFAULT 1,
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

  // ---- additive migrations (pre-Phase-2 dev databases) ---------------------
  // tenant hook columns (Phase 33 = many businesses in one DB)
  for (const [t, col] of [
    ['branches', 'business_id'], ['users', 'business_id'], ['categories', 'business_id'],
    ['products', 'business_id'], ['suppliers', 'business_id'], ['customers', 'business_id'],
    ['locations', 'business_id'], ['registers', 'business_id'], ['departments', 'business_id']
  ]) addCol(d, t, col, 'INTEGER NOT NULL DEFAULT 1');
  addCol(d, 'branches', 'settings', "TEXT NOT NULL DEFAULT '{}'");
  addCol(d, 'users', 'location_id', 'INTEGER');
  addCol(d, 'users', 'register_id', 'INTEGER');
  addCol(d, 'stock_moves', 'location_id', 'INTEGER');
  addCol(d, 'stock_moves', "reason", "TEXT NOT NULL DEFAULT ''");
  addCol(d, 'sales', 'location_id', 'INTEGER');
  addCol(d, 'sales', 'register_id', 'INTEGER');
  addCol(d, 'batches', 'location_id', 'INTEGER');

  // terminals → registers (Phase 2 vocabulary)
  if (tableExists(d, 'terminals') && !tableExists(d, 'registers')) {
    d.exec('ALTER TABLE terminals RENAME TO registers');
  }
  addCol(d, 'registers', 'location_id', 'INTEGER');

  // every branch gets its default location ("Main Store")
  const now = new Date().toISOString();
  for (const b of d.prepare('SELECT id FROM branches').all()) {
    const has = d.prepare('SELECT id FROM locations WHERE branch_id = ?').get(b.id);
    if (!has) {
      d.prepare(
        `INSERT INTO locations (branch_id, name, is_warehouse, is_default, active, created_at)
         VALUES (?, 'Main Store', 0, 1, 1, ?)`
      ).run(b.id, now);
    }
  }
  // bind orphan registers to their branch's default location
  d.exec(
    `UPDATE registers SET location_id = (
       SELECT l.id FROM locations l WHERE l.branch_id = registers.branch_id AND l.is_default = 1 LIMIT 1
     ) WHERE location_id IS NULL`
  );

  // stock: branch-scoped → location-scoped
  if (tableExists(d, 'stock') && colExists(d, 'stock', 'branch_id')) {
    d.exec('ALTER TABLE stock RENAME TO stock_old');
    d.exec(
      `CREATE TABLE stock (
         product_id INTEGER NOT NULL,
         location_id INTEGER NOT NULL,
         qty REAL NOT NULL DEFAULT 0,
         PRIMARY KEY (product_id, location_id)
       )`
    );
    d.exec(
      `INSERT INTO stock (product_id, location_id, qty)
       SELECT product_id,
              (SELECT l.id FROM locations l WHERE l.branch_id = stock_old.branch_id AND l.is_default = 1 LIMIT 1),
              qty
         FROM stock_old
        WHERE (SELECT l.id FROM locations l WHERE l.branch_id = stock_old.branch_id AND l.is_default = 1 LIMIT 1) IS NOT NULL`
    );
    d.exec('DROP TABLE stock_old');
  }
  // backfill move location refs from branch defaults
  d.exec(
    `UPDATE stock_moves SET location_id = (
       SELECT l.id FROM locations l WHERE l.branch_id = stock_moves.branch_id AND l.is_default = 1 LIMIT 1
     ) WHERE location_id IS NULL`
  );

  // capability rows (R-C3: data, not deployment)
  const caps = require('./lib/capabilities');
  caps.ensureCapabilityRows(d);

  // ---- Phase 3: variants engine (additive; R-P1 stock lives on the variant) --
  addCol(d, 'products', 'track_serials', 'INTEGER NOT NULL DEFAULT 0');
  addCol(d, 'products', 'supplier_id', 'INTEGER');
  addCol(d, 'products', 'reorder_level', 'INTEGER NOT NULL DEFAULT 0');
  addCol(d, 'stock_moves', 'variant_id', 'INTEGER');
  addCol(d, 'batches', 'variant_id', 'INTEGER');

  // every product gets exactly one implicit variant (flat Day-1/2 products become these)
  {
    const now = new Date().toISOString();
    const prods = d.prepare('SELECT id, sku, barcode, created_at FROM products').all();
    const insV = d.prepare(
      `INSERT OR IGNORE INTO variants (product_id, name, axes, axes_key, sku, active, created_at, updated_at)
       VALUES (?, '', '{}', '{}', ?, 1, ?, ?)`
    );
    const insB = d.prepare(
      `INSERT OR IGNORE INTO variant_barcodes (variant_id, barcode, kind, active) VALUES (?, ?, 'unit', 1)`
    );
    for (const p of prods) {
      const created = d.prepare('SELECT id FROM variants WHERE product_id = ? AND axes_key = \'{}\'').get(p.id);
      let vId = created && created.id;
      if (!vId) {
        vId = insV.run(p.id, p.sku || '', p.created_at || now, p.created_at || now).lastInsertRowid;
      }
      if (p.barcode) insB.run(vId, p.barcode);
    }
  }

  // stock: product-scoped (pre-Phase-3 dev DBs) → variant-scoped
  if (tableExists(d, 'stock') && colExists(d, 'stock', 'product_id')) {
    d.exec('ALTER TABLE stock RENAME TO stock_old');
    d.exec(
      `CREATE TABLE stock (
         variant_id INTEGER NOT NULL,
         location_id INTEGER NOT NULL,
         qty REAL NOT NULL DEFAULT 0,
         PRIMARY KEY (variant_id, location_id)
       )`
    );
    d.exec(
      `INSERT INTO stock (variant_id, location_id, qty)
       SELECT (SELECT v.id FROM variants v WHERE v.product_id = stock_old.product_id
               AND v.axes_key = '{}' ORDER BY v.id LIMIT 1),
              stock_old.location_id, stock_old.qty
         FROM stock_old
        WHERE (SELECT v.id FROM variants v WHERE v.product_id = stock_old.product_id
               AND v.axes_key = '{}' ORDER BY v.id LIMIT 1) IS NOT NULL`
    );
    d.exec('DROP TABLE stock_old');
  }

  // backfill variant refs on moves & batches from the implicit variant
  d.exec(
    `UPDATE stock_moves SET variant_id = (
       SELECT v.id FROM variants v WHERE v.product_id = stock_moves.product_id
         AND v.axes_key = '{}' ORDER BY v.id LIMIT 1
     ) WHERE variant_id IS NULL`
  );
  d.exec(
    `UPDATE batches SET variant_id = (
       SELECT v.id FROM variants v WHERE v.product_id = batches.product_id
         AND v.axes_key = '{}' ORDER BY v.id LIMIT 1
     ) WHERE variant_id IS NULL`
  );

  // ---- Phase 4: stock ledger (additive; R-S1 every change is a move) --------
  addCol(d, 'stock_moves', 'serial_id', 'INTEGER');
  addCol(d, 'stock_moves', 'unit_cost', 'INTEGER NOT NULL DEFAULT 0');
  d.exec('CREATE INDEX IF NOT EXISTS idx_moves_variant ON stock_moves(variant_id, location_id, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_moves_type ON stock_moves(type, created_at)');

  // R-S7: the ledger recomputed as a view — the integrity job asserts stock == this.
  d.exec(
    `DROP VIEW IF EXISTS stock_ledger_balances;
     CREATE VIEW stock_ledger_balances AS
     SELECT variant_id, location_id,
            SUM(qty) AS expected_qty,
            COUNT(*) AS move_count,
            MAX(created_at) AS last_moved_at
       FROM stock_moves
      GROUP BY variant_id, location_id`
  );

  // Stocktakes: expected vs physical, variance reportable, approved = stocktake moves.
  d.exec(
    `CREATE TABLE IF NOT EXISTS stocktakes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       location_id INTEGER NOT NULL,
       branch_id INTEGER NOT NULL,
       status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','cancelled')),
       taken_by INTEGER,
       approved_by INTEGER,
       note TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL,
       approved_at TEXT
     )`
  );
  d.exec(
    `CREATE TABLE IF NOT EXISTS stocktake_lines (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id),
       variant_id INTEGER NOT NULL,
       batch_id INTEGER,
       expected_qty REAL NOT NULL DEFAULT 0,
       physical_qty REAL,
       variance REAL,
       created_at TEXT NOT NULL
     )`
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_st_lines ON stocktake_lines(stocktake_id)');

  // ---- Phase 5: purchasing & suppliers (additive) ----------------------------------
  addCol(d, 'suppliers', 'lead_days', 'INTEGER NOT NULL DEFAULT 7');
  addCol(d, 'po_items', 'variant_id', 'INTEGER');
  addCol(d, 'po_items', 'discrepancy', "TEXT NOT NULL DEFAULT '' CHECK(discrepancy IN ('', 'over_qty', 'price'))");
  addCol(d, 'po_items', 'discrepancy_status', "TEXT NOT NULL DEFAULT '' CHECK(discrepancy_status IN ('', 'pending', 'approved', 'rejected'))");
  addCol(d, 'gr_items', 'variant_id', 'INTEGER');
  addCol(d, 'gr_items', 'po_id', 'INTEGER');
  d.exec('UPDATE gr_items SET po_id = (SELECT po_id FROM goods_receipts WHERE id = gr_items.gr_id) WHERE po_id IS NULL');
  d.exec(
    `UPDATE po_items SET variant_id = (
       SELECT v.id FROM variants v WHERE v.product_id = po_items.product_id
         AND v.axes_key = '{}' ORDER BY v.id LIMIT 1
     ) WHERE variant_id IS NULL`
  );
  d.exec(
    `UPDATE gr_items SET variant_id = (
       SELECT v.id FROM variants v WHERE v.product_id = gr_items.product_id
         AND v.axes_key = '{}' ORDER BY v.id LIMIT 1
     ) WHERE variant_id IS NULL`
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_gr_items_gr ON gr_items(gr_id)');

  // Invoices we owe suppliers + payments we make (evidence per payment, R-PAY principle).
  d.exec(
    `CREATE TABLE IF NOT EXISTS supplier_invoices (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ref TEXT NOT NULL,
       supplier_ref TEXT NOT NULL DEFAULT '',
       supplier_id INTEGER NOT NULL,
       po_id INTEGER,
       amount INTEGER NOT NULL,
       vat INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','partial','paid','disputed')),
       due_date TEXT,
       note TEXT NOT NULL DEFAULT '',
       created_by INTEGER,
       created_at TEXT NOT NULL,
       paid_at TEXT
     )`
  );
  d.exec(
    `CREATE TABLE IF NOT EXISTS invoice_payments (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       invoice_id INTEGER NOT NULL,
       amount INTEGER NOT NULL,
       method TEXT NOT NULL DEFAULT 'bank',
       channel_ref TEXT NOT NULL DEFAULT '',
       note TEXT NOT NULL DEFAULT '',
       created_by INTEGER,
       created_at TEXT NOT NULL
     )`
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_inv_payments ON invoice_payments(invoice_id)');

  // The invoice/payment tables pre-date Phase 5 (Day-1 shape); evolve them additively.
  addCol(d, 'supplier_invoices', 'paid', 'INTEGER NOT NULL DEFAULT 0');
  addCol(d, 'supplier_invoices', 'outstanding', 'INTEGER NOT NULL DEFAULT 0');
  d.exec("UPDATE supplier_invoices SET outstanding = amount - COALESCE(paid, 0) WHERE status IN ('open', 'partial', 'disputed')");
  addCol(d, 'invoice_payments', 'supplier_id', 'INTEGER');
  d.exec(
    `UPDATE invoice_payments SET supplier_id = (SELECT supplier_id FROM supplier_invoices WHERE id = invoice_payments.invoice_id)
      WHERE supplier_id IS NULL`
  );

  // Goods going back to a supplier (rejected over-receipts, defects, stock returns).
  d.exec(
    `CREATE TABLE IF NOT EXISTS supplier_returns (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ref TEXT NOT NULL,
       supplier_id INTEGER NOT NULL,
       po_id INTEGER,
       variant_id INTEGER NOT NULL,
       product_id INTEGER NOT NULL,
       qty REAL NOT NULL,
       unit_cost INTEGER NOT NULL DEFAULT 0,
       reason TEXT NOT NULL DEFAULT '',
       created_by INTEGER,
       created_at TEXT NOT NULL
     )`
  );

  // ---- Phase 6: pricing engine (additive; R-PR) -----------------------------------
  // Price rules — one row per override. Primary scope (exactly one): promo_code,
  // customer, branch or tier; a time window (dates and/or HH:MM) may combine with any.
  // The resolver walks the R-PR chain: promo/time → customer → branch → pack → level → default.
  d.exec(
    `CREATE TABLE IF NOT EXISTS price_rules (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       business_id INTEGER NOT NULL DEFAULT 1,
       variant_id INTEGER NOT NULL REFERENCES variants(id),
       branch_id INTEGER REFERENCES branches(id),
       customer_id INTEGER REFERENCES customers(id),
       tier TEXT CHECK(tier IS NULL OR tier IN ('retail','wholesale','member')),
       promo_code TEXT,
       price INTEGER NOT NULL,
       valid_from TEXT,
       valid_to TEXT,
       time_start TEXT,
       time_end TEXT,
       note TEXT NOT NULL DEFAULT '',
       active INTEGER NOT NULL DEFAULT 1,
       created_by INTEGER,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_price_rules_variant ON price_rules(variant_id, active)');

  // R-PR3: append-only price history (who/when/from/to/scope). No update/delete routes.
  d.exec(
    `CREATE TABLE IF NOT EXISTS price_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       business_id INTEGER NOT NULL DEFAULT 1,
       product_id INTEGER NOT NULL,
       variant_id INTEGER,
       pack_id INTEGER,
       scope TEXT NOT NULL,
       field TEXT NOT NULL DEFAULT 'price',
       old_price INTEGER,
       new_price INTEGER,
       note TEXT NOT NULL DEFAULT '',
       user_id INTEGER,
       approved_by INTEGER,
       created_at TEXT NOT NULL
     )`
  );
  d.exec('CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, id)');

  // R-PR1: per-product margin floor (branch floors live in branches.settings,
  // the global floor in settings.pricing). Frozen unit price on sale lines:
  // written at line add (Phase 7), never altered afterwards.
  addCol(d, 'products', 'min_margin_pct', 'INTEGER');
  addCol(d, 'sale_items', 'unit_price', 'INTEGER');

  // Phase 7 (Day 10): who approved a discount beyond the cashier's permission on a sale,
  // and the exact variant on each sale line (held sales re-validate + FEFO at payment).
  addCol(d, 'sales', 'discount_by', 'INTEGER');
  addCol(d, 'sale_items', 'variant_id', 'INTEGER');
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

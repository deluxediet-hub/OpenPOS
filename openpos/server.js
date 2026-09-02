'use strict';
// ---------------------------------------------------------------------------
// OpenPOS v2 — server (Express + built-in SQLite, no build step).
// Phase 2: business/tenancy foundation — locations, registers, departments,
// capabilities (R-C), fine-grained permissions, solo-first onboarding.
// ---------------------------------------------------------------------------
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dbm = require('./db');
const pme = require('./lib/payments');
const mpesa = require('./lib/mpesa');
const auth = require('./lib/auth');
const perms = require('./lib/permissions');
const caps = require('./lib/capabilities');
const { TRADES } = require('./lib/sample');

const ROLES = ['owner', 'manager', 'cashier', 'staff'];

function publicUser(u) {
  return {
    id: u.id, name: u.name, role: u.role,
    branchId: u.branch_id ?? null,
    locationId: u.location_id ?? null,
    registerId: u.register_id ?? null
  };
}

function activeBranches(d) {
  return d.prepare('SELECT * FROM branches WHERE active = 1 ORDER BY id').all();
}

function branchRow(d, id) {
  return d.prepare('SELECT * FROM branches WHERE id = ?').get(id);
}

function visibleBranches(d, user) {
  const all = activeBranches(d);
  if (user.branchId) return all.filter((b) => b.id === user.branchId);
  return all;
}

function locationsOf(d, branchId) {
  return d.prepare('SELECT * FROM locations WHERE branch_id = ? AND active = 1 ORDER BY is_default DESC, id').all(branchId);
}

function defaultLocation(d, branchId) {
  return locationsOf(d, branchId).find((l) => l.is_default) || locationsOf(d, branchId)[0] || null;
}

function startOfTodayIso() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate()).toISOString();
}

function nextBranchCode(d) {
  const n = d.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
  let code;
  do {
    code = `BR${String(n + 1).padStart(2, '0')}`;
  } while (d.prepare('SELECT id FROM branches WHERE code = ?').get(code));
  return code;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// ---- Phase 3: variants helpers ------------------------------------------------
// Axes = the variant's distinguishing attributes ({size:'M', colour:'Red'}).
// axes_key is the canonical (sorted-key) JSON — the identity of a variant.
function canonicalAxes(axes) {
  const obj = {};
  for (const [k, v] of Object.entries(axes || {})) {
    const key = String(k).trim();
    const val = String(v ?? '').trim();
    if (key) obj[key] = val;
  }
  return JSON.stringify(Object.keys(obj).sort().reduce((o, k) => (o[k] = obj[k], o), {}));
}

/** Parse axes from an object, a JSON string, or a "size: M, colour: Red" string. */
function parseAxesInput(input) {
  if (!input) return {};
  if (typeof input === 'object') return input;
  const s = String(input).trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch { /* fall through to key:value parsing */ }
  }
  const out = {};
  for (const part of s.split(',')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function productRow(d, id) {
  return d.prepare('SELECT * FROM products WHERE id = ?').get(id) || null;
}

function implicitVariant(d, productId) {
  return d.prepare("SELECT * FROM variants WHERE product_id = ? AND axes_key = '{}'").get(productId) || null;
}

function activeVariantsOf(d, productId) {
  return d.prepare('SELECT * FROM variants WHERE product_id = ? AND active = 1 ORDER BY id').all(productId);
}

function barcodesOfVariant(d, variantId) {
  return d.prepare('SELECT * FROM variant_barcodes WHERE variant_id = ? ORDER BY id').all(variantId);
}

function packsOfVariant(d, variantId) {
  return d.prepare('SELECT * FROM packs WHERE variant_id = ? AND active = 1 ORDER BY id').all(variantId);
}

/** R-P2: prices are integer shillings, VAT-inclusive. Rejects fractions (no silent rounding). */
function intShillings(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Effective field: variant override wins, else product default. */
function eff(product, variant, field) {
  const v = variant ? variant[field] : null;
  return v === null || v === undefined || v === '' ? product[field] : v;
}

function effPrice(product, variant, level = 'retail') {
  const col = level === 'wholesale' ? 'wholesale_price' : level === 'member' ? 'member_price' : 'price';
  return Number(eff(product, variant, col) || 0);
}

function stockQty(d, variantId, locationId) {
  if (!variantId || !locationId) return 0;
  const r = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(variantId, locationId);
  return r ? r.qty : 0;
}

function addStockMove(d, { product, variant, branchId, locationId, qty, type, reason, ref = '', userId = null, note = '', batchId = null }) {
  d.prepare(
    `INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, batch_id, user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(product.id, variant.id, branchId, locationId, qty, type, reason, ref, batchId, userId, note, new Date().toISOString());
}

function upsertStock(d, variantId, locationId, delta) {
  d.prepare(
    `INSERT INTO stock (variant_id, location_id, qty) VALUES (?, ?, ?)
     ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = qty + ?`
  ).run(variantId, locationId, delta, delta);
}

// ---- Phase 4: stock ledger (R-S) ---------------------------------------------
// R-S1: every quantity change is exactly one move, with a reason code + reference.
const MOVE_TYPES = [
  'opening', 'purchase', 'sale', 'return_in', 'return_out', 'transfer_in', 'transfer_out',
  'adjustment', 'damage', 'expiry_writeoff', 'stocktake', 'conversion', 'refund', 'hold', 'release'
];
const MOVE_REASONS = {
  opening: ['opening'],
  purchase: ['purchase'],
  sale: ['sale'],
  return_in: ['return_in'],
  return_out: ['return_out'],
  transfer_in: ['transfer_in'],
  transfer_out: ['transfer_out'],
  adjustment: ['stocktake', 'damage', 'expired', 'other', 'integrity'],
  damage: ['damage'],
  expiry_writeoff: ['expired'],
  stocktake: ['stocktake', 'integrity'],
  conversion: ['conversion'],
  refund: ['refund'],
  hold: ['hold'],
  release: ['hold']
};
const INBOUND_TYPES = new Set(['opening', 'purchase', 'return_in', 'transfer_in', 'release']);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Apply one quantity change as ledger move(s). FeFO batch allocation may produce
 * several move rows (one per batch consumed) — each is a complete, auditable change.
 * R-S8: negative stock is impossible unless allowOversell (manager/owner) — which is
 * recorded on the move and in the audit trail. Batch-tracked variants are strict.
 * Throws httpError for validation failures. Returns { moveIds, newQty, oversell }.
 */
function writeMove(d, { product, variant, branchId, locationId, qty, type, reason, ref = '', batchId = null, serialId = null, unitCost = 0, userId = null, note = '', allowOversell = false }) {
  if (!MOVE_TYPES.includes(type)) throw httpError(400, `unknown move type: ${type}`);
  if (!MOVE_REASONS[type].includes(reason)) throw httpError(400, `invalid reason for ${type}: ${reason}`);
  if (!Number.isFinite(qty) || qty === 0) throw httpError(400, 'qty must be non-zero');
  const t = new Date().toISOString();
  const cur = stockQty(d, variant.id, locationId);
  const newQty = cur + qty;
  const willOversell = newQty < -1e-9;
  if (willOversell && !allowOversell) {
    throw httpError(400, `insufficient stock: ${cur} on hand, move ${qty} (R-S8)`);
  }
  if (willOversell && product.track_batches) {
    throw httpError(400, 'oversell not allowed for batch-tracked stock');
  }
  if (product.track_serials && !Number.isInteger(qty)) {
    throw httpError(400, 'serial-tracked stock moves must be whole units');
  }
  if (serialId) {
    const s = d.prepare('SELECT id, variant_id FROM serials WHERE id = ?').get(serialId);
    if (!s || s.variant_id !== variant.id) throw httpError(400, 'serial does not belong to this variant');
  }

  // Batch allocation
  const allocs = []; // { batchId, qty }
  if (product.track_batches) {
    if (qty > 0) {
      if (!batchId) throw httpError(400, 'batch_id required for stock in on a batch-tracked product');
      const b = d.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
      if (!b || b.variant_id !== variant.id) throw httpError(400, 'batch does not belong to this variant');
      allocs.push({ batchId, qty });
    } else if (batchId) {
      const b = d.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
      if (!b || b.variant_id !== variant.id) throw httpError(400, 'batch does not belong to this variant');
      if (b.qty + qty < -1e-9) throw httpError(400, `insufficient batch stock: ${b.qty} in batch`);
      allocs.push({ batchId, qty });
    } else {
      // FEFO: earliest expiry first (no-expiry last), oldest batch id first
      const lots = d
        .prepare('SELECT * FROM batches WHERE variant_id = ? AND location_id = ? AND qty > 0 ORDER BY expiry_date IS NULL, expiry_date ASC, id ASC')
        .all(variant.id, locationId);
      const avail = lots.reduce((s, b) => s + b.qty, 0);
      if (avail + qty < -1e-9) throw httpError(400, `insufficient batch stock: ${avail} across batches, move ${qty}`);
      let remaining = -qty;
      for (const b of lots) {
        if (remaining <= 1e-9) break;
        const take = Math.min(b.qty, remaining);
        allocs.push({ batchId: b.id, qty: -take });
        remaining -= take;
      }
    }
  } else if (batchId) {
    throw httpError(400, 'product does not track batches');
  }

  const insMove = d.prepare(
    `INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, batch_id, serial_id, unit_cost, user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertBatch = d.prepare('UPDATE batches SET qty = qty + ? WHERE id = ?');
  const moveIds = [];
  for (const a of allocs.length ? allocs : [{ batchId: null, qty }]) {
    moveIds.push(insMove.run(product.id, variant.id, branchId, locationId, a.qty, type, reason, ref, a.batchId, serialId, unitCost || 0, userId, note, t).lastInsertRowid);
    if (a.batchId) upsertBatch.run(a.qty, a.batchId);
  }
  upsertStock(d, variant.id, locationId, qty);
  return { moveIds, newQty, oversell: willOversell && allowOversell };
}

/** R-P3: one call resolves barcode → variant → location stock → price. */
function resolveBarcode(d, user, barcode) {
  const row = d
    .prepare(
      `SELECT vb.*, v.product_id, v.name AS variant_name, v.axes
         FROM variant_barcodes vb JOIN variants v ON v.id = vb.variant_id
        WHERE vb.barcode = ? AND vb.active = 1 AND v.active = 1`
    )
    .get(String(barcode).trim());
  if (!row) return { error: 'barcode not recognized', status: 404 };
  const product = productRow(d, row.product_id);
  if (!product || !product.active) return { error: 'product not active', status: 404 };
  const branches = visibleBranches(d, user);
  const branchId = (branches[0] && branches[0].id) || null;
  const locs = branchId ? locationsOf(d, branchId) : [];
  const locationId = (locs.find((l) => l.is_default) || locs[0] || {}).id || null;
  const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(row.variant_id);
  const out = {
    barcode: row.barcode,
    type: row.kind,
    product: {
      id: product.id, name: product.name, unit: product.unit, tax_type: eff(product, variant, 'tax_type'),
      kra_item_code: eff(product, variant, 'kra_item_code'), age_min: product.age_min,
      requires_rx: product.requires_rx, is_controlled: product.is_controlled,
      open_priced: product.open_priced, track_serials: product.track_serials,
      track_batches: product.track_batches, image: product.image
    },
    variant: { id: variant.id, name: variant.name || '', axes: safeJson(variant.axes), sku: variant.sku },
    location_id: locationId,
    stock_qty: locationId ? stockQty(d, variant.id, locationId) : 0,
    price: effPrice(product, variant, 'retail'),
    cost: Number(eff(product, variant, 'cost') || 0)
  };
  if (row.kind === 'pack' && row.pack_id) {
    const pack = d.prepare('SELECT * FROM packs WHERE id = ? AND active = 1').get(row.pack_id);
    if (pack) {
      out.pack = { id: pack.id, name: pack.name, multiple: pack.multiple, unit: pack.unit, price: pack.price };
      out.stock_in_packs = pack.multiple > 0 ? Math.floor((out.stock_qty + Number.EPSILON) / pack.multiple) : 0;
    }
  }
  return out;
}

function publicProduct(p) {
  const out = { ...p };
  if (out.meta) {
    try { out.meta = JSON.parse(out.meta); } catch { out.meta = {}; }
  }
  return out;
}

function cleanProduct(p) {
  const num = (v, def = 0) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const name = String(p.name || '').trim();
  if (!name) return { error: 'product name required' };
  const taxType = ['std', 'zero', 'exempt'].includes(p.tax_type) ? p.tax_type : 'std';
  const price = num(p.price);
  if (price <= 0) return { error: 'price must be greater than 0' };
  return {
    name,
    name_sw: String(p.name_sw || '').trim(),
    sku: String(p.sku || '').trim(),
    barcode: String(p.barcode || '').trim(),
    categoryId: numOrNull(p.category_id),
    brand: String(p.brand || '').trim(),
    unit: String(p.unit || 'pcs').trim() || 'pcs',
    packSize: Math.max(1, Math.trunc(Number(p.pack_size) || 1)),
    packName: String(p.pack_name || '').trim(),
    cost: num(p.cost),
    price,
    wholesalePrice: num(p.wholesale_price),
    memberPrice: num(p.member_price),
    taxType,
    kraCode: String(p.kra_item_code || '').trim(),
    ageMin: numOrNull(p.age_min),
    requiresRx: p.requires_rx ? 1 : 0,
    isControlled: p.is_controlled ? 1 : 0,
    trackBatches: p.track_batches ? 1 : 0,
    trackSerials: p.track_serials ? 1 : 0,
    openPriced: p.open_priced ? 1 : 0,
    supplierId: numOrNull(p.supplier_id),
    reorderLevel: num(p.reorder_level),
    minMarginPct: p.min_margin_pct === undefined || p.min_margin_pct === null || p.min_margin_pct === ''
      ? null
      : (Number.isFinite(Number(p.min_margin_pct)) && Number(p.min_margin_pct) >= 0 ? Number(p.min_margin_pct) : 0),
    image: String(p.image || '').trim()
  };
}

/** Clean a variant's overridable fields (NULL = inherit from product). */
function cleanVariant(p, product) {
  const price = p.price !== undefined && p.price !== '' ? intShillings(p.price) : null;
  if (price === null && p.price !== undefined && p.price !== '') return { error: 'variant price must be a whole number of shillings' };
  const cost = p.cost !== undefined && p.cost !== '' ? intShillings(p.cost) : null;
  if (cost === null && p.cost !== undefined && p.cost !== '') return { error: 'variant cost must be a whole number of shillings' };
  const taxType = p.tax_type ? (['std', 'zero', 'exempt'].includes(p.tax_type) ? p.tax_type : null) : null;
  if (p.tax_type && !taxType) return { error: 'bad tax type' };
  return {
    name: String(p.name || '').trim(),
    sku: String(p.sku || '').trim(),
    price,
    cost,
    wholesalePrice: p.wholesale_price !== undefined && p.wholesale_price !== '' ? intShillings(p.wholesale_price) : null,
    memberPrice: p.member_price !== undefined && p.member_price !== '' ? intShillings(p.member_price) : null,
    taxType,
    kraCode: p.kra_item_code !== undefined ? String(p.kra_item_code || '').trim() : null,
    meta: typeof p.meta === 'object' && p.meta ? JSON.stringify(p.meta) : (p.meta || null)
  };
}

function createApp(d) {
  const app = express();
  const me = auth.sessionPath(d);
  const can = (perm) => perms.requirePerm(d, perm);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- health / status ------------------------------------------------------
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'openpos-v2', phase: 12 }));

  app.get('/api/setup/status', (req, res) => {
    res.json({
      initialized: dbm.isInitialized(d),
      trades: TRADES,
      businessName: dbm.getSetting(d, 'business', {}).name || null
    });
  });

  app.get('/api/trades', (req, res) => res.json(TRADES));

  // ---- first-run setup v2 (solo-first, R-C1) --------------------------------
  // No branch/register questions: every business gets 1 branch + "Main Store"
  // location + "Till 1" register, invisibly. KRA/VAT optional & deferrable.
  app.post('/api/setup', (req, res) => {
    if (dbm.isInitialized(d)) return res.status(409).json({ error: 'already initialized' });
    const b = (req.body && req.body.business) || {};
    const owner = (req.body && req.body.owner) || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'business name required' });
    if (!owner.name || !String(owner.name).trim()) return res.status(400).json({ error: 'owner name required' });
    const pin = String(owner.pin || '');
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'owner PIN must be 4-8 digits' });
    const trade = TRADES[b.trade] ? b.trade : 'duka';
    const vatRate = Number(b.vatRate) > 0 ? Number(b.vatRate) : 16;
    const now = new Date().toISOString();

    const run = d.transaction(() => {
      dbm.setSetting(d, 'business', {
        name: String(b.name).trim(),
        address: b.address || '',
        phone: b.phone || '',
        kraPin: b.kraPin || '',
        kraPinType: b.kraPinType || 'pin',
        trade,
        currency: b.currency || 'KES',
        symbol: b.symbol || 'Ksh'
      });
      dbm.setSetting(d, 'tax', { vatRate, vatRegistered: b.vatRegistered ? 1 : 0 });
      dbm.setSetting(d, 'receipt', {
        footer: b.receiptFooter || '',
        language: 'en',
        showQr: 1
      });

      const brId = d
        .prepare(
          `INSERT INTO branches (code, name, address, phone, kra_pin, vat_registered, is_default, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          'BR01', 'Main Branch', b.address || '', b.phone || '',
          b.kraPin || '', b.vatRegistered ? 1 : 0, now
        ).lastInsertRowid;

      const locId = d
        .prepare(
          `INSERT INTO locations (branch_id, name, address, phone, is_warehouse, is_default, active, created_at)
           VALUES (?, 'Main Store', ?, ?, 0, 1, 1, ?)`
        ).run(brId, b.address || '', b.phone || '', now).lastInsertRowid;

      d.prepare(
        'INSERT INTO registers (branch_id, location_id, name, created_at) VALUES (?, ?, ?, ?)'
      ).run(brId, locId, 'Till 1', now);

      const salt = crypto.randomBytes(16).toString('hex');
      const ownerId = d
        .prepare(
          `INSERT INTO users (name, role, branch_id, pin_hash, salt, active, created_at)
           VALUES (?, 'owner', NULL, ?, ?, 1, ?)`
        )
        .run(String(owner.name).trim(), auth.hashPin(pin, salt), salt, now).lastInsertRowid;

      caps.ensureCapabilityRows(d);
      caps.seedForTrade(d, trade);

      if (req.body.sample) {
        const { buildSample } = require('./lib/sample');
        const sample = buildSample(trade);
        const insCat = d.prepare(
          'INSERT INTO categories (branch_id, name, name_sw, active) VALUES (NULL, ?, ?, 1)'
        );
        sample.categories.forEach((c) => insCat.run(c.name, c.name_sw));
        const cats = d.prepare('SELECT id, name FROM categories ORDER BY id').all();
        const insProd = d.prepare(
          `INSERT INTO products
            (branch_id, sku, barcode, name, name_sw, category_id, unit, cost, price,
             tax_type, kra_item_code, age_min, requires_rx, is_controlled, track_batches,
             open_priced, active, created_at, updated_at)
           VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        );
        const insVariant = d.prepare(
          `INSERT INTO variants (product_id, name, axes, axes_key, sku, active, created_at, updated_at)
           VALUES (?, '', '{}', '{}', ?, 1, ?, ?)`
        );
        const insVBarcode = d.prepare(
          `INSERT OR IGNORE INTO variant_barcodes (variant_id, barcode, kind, active) VALUES (?, ?, 'unit', 1)`
        );
        const stock = d.prepare(
          `INSERT INTO stock (variant_id, location_id, qty) VALUES (?, ?, ?)
           ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = qty + excluded.qty`
        );
        const move = d.prepare(
          `INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, user_id, note, created_at)
           VALUES (?, ?, ?, ?, ?, 'opening', 'opening', 'SAMPLE', ?, '', ?)`
        );
        const insBatch = d.prepare(
          `INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        sample.products.forEach((p, i) => {
          const cat = cats[p.categoryId - 1] || cats[0];
          const pid = insProd.run(
            p.sku, p.barcode, p.name, p.name_sw, cat ? cat.id : null, p.unit, p.cost, p.price,
            p.taxType, p.kraItemCode, p.ageMin, p.requiresRx, p.isControlled, p.trackBatches,
            p.openPriced, now, now
          ).lastInsertRowid;
          const vid = insVariant.run(pid, p.sku, now, now).lastInsertRowid;
          if (p.barcode) insVBarcode.run(vid, p.barcode);
          stock.run(vid, locId, 24);
          move.run(pid, vid, brId, locId, 24, ownerId, now);
          if (p.trackBatches) {
            const exp = new Date(Date.now() + 540 * 86400e3).toISOString().slice(0, 10);
            insBatch.run(pid, vid, brId, locId, `S-${p.sku}`, exp, 24, p.cost, now);
          }
        });
      }

      dbm.audit(d, {
        userId: ownerId, branchId: brId, action: 'system/setup', entity: 'business',
        detail: { name: b.name, trade, sample: !!req.body.sample }
      });
      return { brId, locId, ownerId };
    });

    const { ownerId } = run();
    const token = auth.createSession(d, ownerId);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, auth.SESSION_HOURS * 3600e3));
    const user = d.prepare('SELECT * FROM users WHERE id = ?').get(ownerId);
    res.json({ ok: true, user: publicUser(user) });
  });

  // ---- auth -----------------------------------------------------------------
  app.get('/api/staff/public', (req, res) => {
    const rows = d.prepare("SELECT id, name, role FROM users WHERE active = 1 ORDER BY name").all();
    res.json(rows.map((u) => ({ id: u.id, name: u.name, role: u.role })));
  });

  app.post('/api/login', (req, res) => {
    const ip = auth.clientIp(req);
    const name = String((req.body && req.body.name) || '').trim();
    const pin = String((req.body && req.body.pin) || '');
    if (!name) return res.status(400).json({ error: 'select staff member' });

    const byName = auth.isLocked(d, 'name', name);
    const byIp = auth.isLocked(d, 'ip', ip);
    if (byName || byIp) {
      const ms = Math.max(byName || 0, byIp || 0);
      return res.status(429).json({ error: `locked — try again in ${Math.ceil(ms / 60000)} min` });
    }

    const user = d.prepare('SELECT * FROM users WHERE lower(name) = lower(?) AND active = 1').get(name);
    if (!user || !auth.verifyPin(pin, user.salt, user.pin_hash)) {
      const r1 = auth.recordFail(d, 'name', name);
      const r2 = auth.recordFail(d, 'ip', ip);
      const locked = r1.locked || r2.locked;
      return res.status(401).json({
        error: locked ? 'locked — too many attempts, try again in 5 min' : 'wrong PIN',
        fails: Math.max(r1.fails, r2.fails), max: auth.MAX_FAILS
      });
    }

    auth.clearFails(d, 'name', name);
    auth.clearFails(d, 'ip', ip);
    const token = auth.createSession(d, user.id);
    d.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    dbm.audit(d, { userId: user.id, action: 'auth/login', entity: 'user', entityId: String(user.id) });
    res.setHeader('Set-Cookie', auth.sessionCookie(token, auth.SESSION_HOURS * 3600e3));
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    auth.destroySession(d, auth.getCookie(req, 'openpos_session'));
    res.setHeader('Set-Cookie', 'openpos_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/me', me, (req, res) => {
    res.json({ user: req.user, branches: visibleBranches(d, req.user) });
  });

  // ---- bootstrap --------------------------------------------------------------
  app.get('/api/bootstrap', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    const qBranch = numOrNull(req.query.branch_id);
    const branchId = (qBranch && branches.some((b) => b.id === qBranch)) ? qBranch : (branches[0] && branches[0].id) || null;

    const locs = branchId ? locationsOf(d, branchId) : [];
    // Phase 12: the full location map across every visible branch (owner = all
    // branches). The selling context below still defaults to one location.
    const allLocations = d
      .prepare(`SELECT * FROM locations WHERE active = 1 AND branch_id IN (${branches.map(() => '?').join(',')}) ORDER BY branch_id, is_default DESC, id`)
      .all(...branches.map((b) => b.id));
    const qLoc = numOrNull(req.query.location_id);
    let locationId = qLoc && locs.some((l) => l.id === qLoc)
      ? qLoc
      : req.user.locationId && locs.some((l) => l.id === req.user.locationId)
        ? req.user.locationId
        : (locs.find((l) => l.is_default) || locs[0] || {}).id || null;

    const settings = dbm.getSettings(d);
    const categories = d.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name').all();
    const products = d
      .prepare(
        `SELECT p.*, c.name AS category_name, s.name AS supplier_name,
           (SELECT COALESCE(SUM(st.qty), 0) FROM variants v
             JOIN stock st ON st.variant_id = v.id AND st.location_id = ?
            WHERE v.product_id = p.id AND v.active = 1) AS stock_qty,
           (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.active = 1) AS variant_count,
           (SELECT v.id FROM variants v WHERE v.product_id = p.id AND v.active = 1 AND v.axes_key = '{}' LIMIT 1) AS base_variant_id
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.active = 1
          ORDER BY c.name, p.name`
      )
      .all(locationId || 0);
    const registers = branchId
      ? d.prepare('SELECT * FROM registers WHERE branch_id = ? AND active = 1 ORDER BY id').all(branchId)
      : [];
    const openShift = branchId
      ? d.prepare(`SELECT * FROM shifts WHERE branch_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(branchId)
      : null;
    const isManagerLike = req.user.role === 'owner' || req.user.role === 'manager';

    res.json({
      settings,
      me: req.user,
      caps: caps.getCapabilityMap(d),
      branches,
      branchId,
      locationId,
      locations: locs,
      allLocations,
      registers,
      categories,
      products: products.map(publicProduct),
      openShift: openShift
        ? { id: openShift.id, openedAt: openShift.opened_at, float: openShift.float_open, userName: userName(d, openShift.user_id) }
        : null,
      suggestions: isManagerLike ? caps.getSuggestions(d) : []
    });
  });

  // ---- today ---------------------------------------------------------------------
  app.get('/api/today', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    const scope = (branches[0] && branches[0].id) || null;
    const row = d
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(gross), 0) AS total
           FROM sales
          WHERE status IN ('paid','partial') AND created_at >= ?
            AND (? IS NULL OR branch_id = ?)`
      )
      .get(startOfTodayIso(), scope, scope);
    const prods = d.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n;
    res.json({ ...row, branchId: scope, products: prods, branches: branches.length });
  });

  // ---- branches ---------------------------------------------------------------------
  app.get('/api/branches', me, (req, res) => {
    const rows = visibleBranches(d, req.user);
    res.json(rows.map((b) => ({
      ...b,
      settings: safeJson(b.settings || '{}'),
      locations: locationsOf(d, b.id),
      salesToday: d
        .prepare('SELECT COALESCE(SUM(gross),0) AS t, COUNT(*) AS n FROM sales WHERE branch_id = ? AND status IN (\'paid\',\'partial\') AND created_at >= ?')
        .get(b.id, startOfTodayIso())
    })));
  });

  app.post('/api/branches', me, can('branches.manage'), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'branch name required' });
    const now = new Date().toISOString();
    const id = d
      .prepare('INSERT INTO branches (code, name, address, phone, kra_pin, vat_registered, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(
        nextBranchCode(d), name, b.address || '', b.phone || '',
        b.kraPin || dbm.getSetting(d, 'business', {}).kraPin || '', b.vatRegistered ? 1 : 0, now
      ).lastInsertRowid;
    d.prepare(
      `INSERT INTO locations (branch_id, name, address, phone, is_warehouse, is_default, active, created_at)
       VALUES (?, 'Main Store', ?, ?, 0, 1, 1, ?)`
    ).run(id, b.address || '', b.phone || '', now);
    dbm.audit(d, { userId: req.user.id, action: 'branch/create', entity: 'branch', entityId: String(id), detail: { name } });
    res.json({ ok: true, id });
  });

  app.put('/api/branches/:id', me, can('branches.manage'), (req, res) => {
    const b = branchRow(d, numOrNull(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    const patch = req.body || {};
    d.prepare(
      `UPDATE branches SET name = ?, address = ?, phone = ?, kra_pin = ?, vat_registered = ?, active = ?, settings = ? WHERE id = ?`
    ).run(
      String(patch.name || b.name).trim(),
      patch.address !== undefined ? patch.address : b.address,
      patch.phone !== undefined ? patch.phone : b.phone,
      patch.kraPin !== undefined ? patch.kraPin : b.kra_pin,
      patch.vatRegistered !== undefined ? (patch.vatRegistered ? 1 : 0) : b.vat_registered,
      patch.active !== undefined ? (patch.active ? 1 : 0) : b.active,
      JSON.stringify(patch.settings || safeJson(b.settings || '{}')),
      b.id
    );
    if (patch.isDefault) {
      d.prepare('UPDATE branches SET is_default = 0').run();
      d.prepare('UPDATE branches SET is_default = 1 WHERE id = ?').run(b.id);
    }
    dbm.audit(d, { userId: req.user.id, branchId: b.id, action: 'branch/update', entity: 'branch', entityId: String(b.id), detail: patch });
    res.json({ ok: true });
  });

  app.delete('/api/branches/:id', me, can('branches.manage'), (req, res) => {
    const b = branchRow(d, numOrNull(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    if (b.is_default) return res.status(400).json({ error: 'cannot delete the default branch' });
    const sales = d.prepare('SELECT COUNT(*) AS n FROM sales WHERE branch_id = ?').get(b.id).n;
    const users = d.prepare('SELECT COUNT(*) AS n FROM users WHERE branch_id = ?').get(b.id).n;
    if (sales > 0) return res.status(400).json({ error: 'branch has sales — deactivate it instead' });
    if (users > 0) return res.status(400).json({ error: 'branch has staff — move them first' });
    d.prepare('DELETE FROM registers WHERE branch_id = ?').run(b.id);
    d.prepare('DELETE FROM stock WHERE location_id IN (SELECT id FROM locations WHERE branch_id = ?)').run(b.id);
    d.prepare('DELETE FROM stock_moves WHERE branch_id = ?').run(b.id);
    d.prepare('DELETE FROM locations WHERE branch_id = ?').run(b.id);
    d.prepare('DELETE FROM branches WHERE id = ?').run(b.id);
    dbm.audit(d, { userId: req.user.id, action: 'branch/delete', entity: 'branch', entityId: String(b.id), detail: { name: b.name } });
    res.json({ ok: true });
  });

  // ---- locations ---------------------------------------------------------------------
  app.get('/api/locations', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    const rows = [];
    for (const b of branches) {
      for (const l of locationsOf(d, b.id)) {
        rows.push({
          ...l,
          branch_id: l.branch_id,
          branchName: b.name,
          registers: d.prepare('SELECT COUNT(*) AS n FROM registers WHERE location_id = ? AND active = 1').get(l.id).n,
          stockLines: d.prepare('SELECT COUNT(*) AS n FROM stock WHERE location_id = ? AND qty != 0').get(l.id).n
        });
      }
    }
    res.json(rows);
  });

  app.post('/api/locations', me, can('locations.manage'), (req, res) => {
    const l = req.body || {};
    const name = String(l.name || '').trim();
    if (!name) return res.status(400).json({ error: 'location name required' });
    const branches = visibleBranches(d, req.user);
    const branchId = numOrNull(l.branch_id) && branches.some((b) => b.id === l.branch_id)
      ? l.branch_id : (branches[0] && branches[0].id);
    if (!branchId) return res.status(400).json({ error: 'no branch to attach location to' });
    const id = d
      .prepare(
        `INSERT INTO locations (branch_id, name, address, phone, is_warehouse, is_default, active, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?)`
      )
      .run(branchId, name, l.address || '', l.phone || '', l.isWarehouse ? 1 : 0, new Date().toISOString())
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, branchId, action: 'location/create', entity: 'location', entityId: String(id), detail: { name, warehouse: !!l.isWarehouse } });
    res.json({ ok: true, id });
  });

  app.put('/api/locations/:id', me, can('locations.manage'), (req, res) => {
    const l = d.prepare('SELECT * FROM locations WHERE id = ?').get(numOrNull(req.params.id));
    if (!l) return res.status(404).json({ error: 'not found' });
    const p = req.body || {};
    d.prepare(
      `UPDATE locations SET name = ?, address = ?, phone = ?, is_warehouse = ?, active = ? WHERE id = ?`
    ).run(
      String(p.name || l.name).trim(),
      p.address !== undefined ? p.address : l.address,
      p.phone !== undefined ? p.phone : l.phone,
      p.isWarehouse !== undefined ? (p.isWarehouse ? 1 : 0) : l.is_warehouse,
      p.active !== undefined ? (p.active ? 1 : 0) : l.active,
      l.id
    );
    dbm.audit(d, { userId: req.user.id, action: 'location/update', entity: 'location', entityId: String(l.id), detail: p });
    res.json({ ok: true });
  });

  app.delete('/api/locations/:id', me, can('locations.manage'), (req, res) => {
    const l = d.prepare('SELECT * FROM locations WHERE id = ?').get(numOrNull(req.params.id));
    if (!l) return res.status(404).json({ error: 'not found' });
    if (l.is_default) return res.status(400).json({ error: 'cannot delete the main location — deactivate it' });
    const regs = d.prepare('SELECT COUNT(*) AS n FROM registers WHERE location_id = ?').get(l.id).n;
    if (regs > 0) return res.status(400).json({ error: 'location has tills — move them first' });
    const stock = d.prepare('SELECT COUNT(*) AS n FROM stock WHERE location_id = ? AND qty != 0').get(l.id).n;
    if (stock > 0) return res.status(400).json({ error: 'location still holds stock — transfer it first' });
    d.prepare('DELETE FROM locations WHERE id = ?').run(l.id);
    dbm.audit(d, { userId: req.user.id, action: 'location/delete', entity: 'location', entityId: String(l.id), detail: { name: l.name } });
    res.json({ ok: true });
  });

  // ---- registers (tills) --------------------------------------------------------------
  app.get('/api/registers', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    const rows = [];
    for (const b of branches) {
      for (const r of d.prepare('SELECT * FROM registers WHERE branch_id = ? AND active = 1 ORDER BY id').all(b.id)) {
        const loc = d.prepare('SELECT * FROM locations WHERE id = ?').get(r.location_id);
        rows.push({ ...r, locationName: loc ? loc.name : '' });
      }
    }
    res.json(rows);
  });

  app.post('/api/registers', me, can('registers.manage'), (req, res) => {
    const r = req.body || {};
    const name = String(r.name || '').trim();
    if (!name) return res.status(400).json({ error: 'till name required' });
    const branches = visibleBranches(d, req.user);
    const branchId = numOrNull(r.branch_id) && branches.some((b) => b.id === r.branch_id)
      ? r.branch_id : (branches[0] && branches[0].id);
    const locs = locationsOf(d, branchId);
    const locationId = numOrNull(r.location_id) && locs.some((l) => l.id === r.location_id)
      ? r.location_id : (locs[0] && locs[0].id) || null;
    const id = d
      .prepare('INSERT INTO registers (branch_id, location_id, name, printer_ip, printer_width, drawer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(branchId, locationId, name, r.printerIp || '', r.printerWidth || '80', r.drawer ? 1 : 0, new Date().toISOString())
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, branchId, action: 'register/create', entity: 'register', entityId: String(id), detail: { name, locationId } });
    res.json({ ok: true, id });
  });

  app.put('/api/registers/:id', me, can('registers.manage'), (req, res) => {
    const r = d.prepare('SELECT * FROM registers WHERE id = ?').get(numOrNull(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    const p = req.body || {};
    d.prepare(
      `UPDATE registers SET name = ?, location_id = ?, printer_ip = ?, printer_width = ?, drawer = ?, active = ? WHERE id = ?`
    ).run(
      String(p.name || r.name).trim(),
      p.location_id !== undefined ? numOrNull(p.location_id) || r.location_id : r.location_id,
      p.printerIp !== undefined ? p.printerIp : r.printer_ip,
      p.printerWidth !== undefined ? p.printerWidth : r.printer_width,
      p.drawer !== undefined ? (p.drawer ? 1 : 0) : r.drawer,
      p.active !== undefined ? (p.active ? 1 : 0) : r.active,
      r.id
    );
    dbm.audit(d, { userId: req.user.id, action: 'register/update', entity: 'register', entityId: String(r.id), detail: p });
    res.json({ ok: true });
  });

  app.delete('/api/registers/:id', me, can('registers.manage'), (req, res) => {
    const r = d.prepare('SELECT * FROM registers WHERE id = ?').get(numOrNull(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    d.prepare('UPDATE registers SET active = 0 WHERE id = ?').run(r.id);
    d.prepare('UPDATE users SET register_id = NULL WHERE register_id = ?').run(r.id);
    dbm.audit(d, { userId: req.user.id, action: 'register/delete', entity: 'register', entityId: String(r.id), detail: { name: r.name } });
    res.json({ ok: true });
  });

  // ---- departments (API-first; UI lands with its first report phase) -------------
  app.get('/api/departments', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    const rows = [];
    for (const b of branches) {
      for (const dep of d.prepare('SELECT * FROM departments WHERE branch_id = ? AND active = 1 ORDER BY name').all(b.id)) {
        rows.push({ ...dep, branchName: b.name });
      }
    }
    res.json(rows);
  });

  app.post('/api/departments', me, can('departments.manage'), (req, res) => {
    const p = req.body || {};
    const name = String(p.name || '').trim();
    if (!name) return res.status(400).json({ error: 'department name required' });
    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    const id = d
      .prepare('INSERT INTO departments (branch_id, name, name_sw, active, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(branchId, name, p.name_sw || '', new Date().toISOString()).lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'department/create', entity: 'department', entityId: String(id), detail: { name } });
    res.json({ ok: true, id });
  });

  app.delete('/api/departments/:id', me, can('departments.manage'), (req, res) => {
    const dep = d.prepare('SELECT * FROM departments WHERE id = ?').get(numOrNull(req.params.id));
    if (!dep) return res.status(404).json({ error: 'not found' });
    d.prepare('UPDATE departments SET active = 0 WHERE id = ?').run(dep.id);
    dbm.audit(d, { userId: req.user.id, action: 'department/delete', entity: 'department', entityId: String(dep.id), detail: { name: dep.name } });
    res.json({ ok: true });
  });

  // ---- capabilities (R-C) ------------------------------------------------------------
  app.get('/api/capabilities', me, (req, res) => {
    const map = caps.getCapabilityMap(d);
    res.json(caps.CAPABILITIES.map((c) => ({ ...c, enabled: !!map[c.id] })));
  });

  app.post('/api/capabilities', me, can('capabilities.manage'), (req, res) => {
    const { capability, enabled } = req.body || {};
    if (!caps.isCap(capability)) return res.status(400).json({ error: 'unknown capability' });
    const on = enabled ? 1 : 0;
    d.prepare(
      'UPDATE business_capabilities SET enabled = ?, enabled_at = ?, enabled_by = ? WHERE capability = ?'
    ).run(on, on ? new Date().toISOString() : null, on ? req.user.id : null, capability);
    if (on) caps.runSeed(d, capability, req.user.id);
    dbm.audit(d, {
      userId: req.user.id, action: on ? 'capability/enable' : 'capability/disable',
      entity: 'capability', entityId: capability
    });
    res.json({ ok: true, capability, enabled: !!on });
  });

  app.get('/api/suggestions', me, (req, res) => {
    if (req.user.role !== 'owner' && req.user.role !== 'manager') return res.json([]);
    res.json(caps.getSuggestions(d));
  });

  // ---- staff -----------------------------------------------------------------------------
  app.get('/api/staff', me, can('staff.manage'), (req, res) => {
    const rows = d.prepare(
      `SELECT u.id, u.name, u.role, u.branch_id, u.location_id, u.register_id, u.active, u.last_login_at,
              b.name AS branch_name, l.name AS location_name, r.name AS register_name
         FROM users u
         LEFT JOIN branches b ON b.id = u.branch_id
         LEFT JOIN locations l ON l.id = u.location_id
         LEFT JOIN registers r ON r.id = u.register_id
        ORDER BY u.name`
    ).all();
    res.json(rows);
  });

  app.post('/api/staff', me, can('staff.manage'), (req, res) => {
    const s = req.body || {};
    const name = String(s.name || '').trim();
    const pin = String(s.pin || '');
    const role = ROLES.includes(s.role) ? s.role : null;
    if (!name || !role || !/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'name, role and a 4-8 digit PIN are required' });
    }
    const exists = d.prepare('SELECT id FROM users WHERE lower(name) = lower(?)').get(name);
    if (exists) return res.status(409).json({ error: 'name already in use' });
    const branchId = numOrNull(s.branch_id);
    if (branchId && !branchRow(d, branchId)) return res.status(400).json({ error: 'unknown branch' });
    const salt = crypto.randomBytes(16).toString('hex');
    const id = d
      .prepare(
        `INSERT INTO users (name, role, branch_id, location_id, register_id, pin_hash, salt, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(name, role, branchId, numOrNull(s.location_id), numOrNull(s.register_id),
        auth.hashPin(pin, salt), salt, new Date().toISOString()).lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'staff/create', entity: 'user', entityId: String(id), detail: { name, role, branchId } });
    res.json({ ok: true, id });
  });

  app.put('/api/staff/:id', me, can('staff.manage'), (req, res) => {
    const u = d.prepare('SELECT * FROM users WHERE id = ?').get(numOrNull(req.params.id));
    if (!u) return res.status(404).json({ error: 'not found' });
    const s = req.body || {};
    if (s.role && !ROLES.includes(s.role)) return res.status(400).json({ error: 'bad role' });
    if (s.pin && !/^\d{4,8}$/.test(String(s.pin))) return res.status(400).json({ error: 'PIN must be 4-8 digits' });
    if (u.role === 'owner' && (s.active === false || s.role)) {
      return res.status(400).json({ error: 'cannot demote or disable the owner' });
    }
    const salt = s.pin ? crypto.randomBytes(16).toString('hex') : u.salt;
    d.prepare(
      `UPDATE users SET name = ?, role = ?, branch_id = ?, location_id = ?, register_id = ?, active = ?, pin_hash = ?, salt = ? WHERE id = ?`
    ).run(
      String(s.name || u.name).trim(),
      s.role || u.role,
      s.branch_id !== undefined ? numOrNull(s.branch_id) : u.branch_id,
      s.location_id !== undefined ? numOrNull(s.location_id) : u.location_id,
      s.register_id !== undefined ? numOrNull(s.register_id) : u.register_id,
      s.active !== undefined ? (s.active ? 1 : 0) : u.active,
      s.pin ? auth.hashPin(s.pin, salt) : u.pin_hash,
      salt,
      u.id
    );
    dbm.audit(d, { userId: req.user.id, action: 'staff/update', entity: 'user', entityId: String(u.id), detail: { name: s.name, role: s.role, active: s.active, pinChanged: !!s.pin } });
    res.json({ ok: true });
  });

  app.get('/api/staff/:id/permissions', me, can('staff.manage'), (req, res) => {
    const u = d.prepare('SELECT * FROM users WHERE id = ?').get(numOrNull(req.params.id));
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json({
      role: u.role,
      perms: perms.userPerms(d, { id: u.id, role: u.role }),
      grants: d.prepare('SELECT permission, allowed FROM user_permissions WHERE user_id = ?').all(u.id)
    });
  });

  app.post('/api/staff/:id/permissions', me, can('staff.permissions'), (req, res) => {
    const u = d.prepare('SELECT * FROM users WHERE id = ?').get(numOrNull(req.params.id));
    if (!u) return res.status(404).json({ error: 'not found' });
    const { permission, allowed } = req.body || {};
    if (!perms.PERMISSIONS.includes(permission)) return res.status(400).json({ error: 'unknown permission' });
    if (allowed) {
      d.prepare(
        `INSERT INTO user_permissions (user_id, permission, allowed) VALUES (?, ?, 1)
         ON CONFLICT(user_id, permission) DO UPDATE SET allowed = 1`
      ).run(u.id, permission);
    } else {
      d.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?').run(u.id, permission);
    }
    dbm.audit(d, { userId: req.user.id, action: allowed ? 'permission/grant' : 'permission/revoke', entity: 'user', entityId: String(u.id), detail: { permission } });
    res.json({ ok: true });
  });

  // ---- categories ---------------------------------------------------------------------------
  app.get('/api/categories', me, (req, res) => {
    res.json(d.prepare('SELECT * FROM categories ORDER BY name').all());
  });

  app.post('/api/categories', me, can('categories.manage'), (req, res) => {
    const c = req.body || {};
    const name = String(c.name || '').trim();
    if (!name) return res.status(400).json({ error: 'category name required' });
    const id = d
      .prepare('INSERT INTO categories (branch_id, name, name_sw, age_restricted, requires_rx, active) VALUES (NULL, ?, ?, ?, ?, 1)')
      .run(name, c.name_sw || '', c.ageRestricted ? 1 : 0, c.requiresRx ? 1 : 0)
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'category/create', entity: 'category', entityId: String(id), detail: { name } });
    res.json({ ok: true, id });
  });

  app.put('/api/categories/:id', me, can('categories.manage'), (req, res) => {
    const c = d.prepare('SELECT * FROM categories WHERE id = ?').get(numOrNull(req.params.id));
    if (!c) return res.status(404).json({ error: 'not found' });
    const p = req.body || {};
    d.prepare('UPDATE categories SET name = ?, name_sw = ?, age_restricted = ?, requires_rx = ?, active = ? WHERE id = ?').run(
      String(p.name || c.name).trim(),
      p.name_sw !== undefined ? p.name_sw : c.name_sw,
      p.ageRestricted !== undefined ? (p.ageRestricted ? 1 : 0) : c.age_restricted,
      p.requiresRx !== undefined ? (p.requiresRx ? 1 : 0) : c.requires_rx,
      p.active !== undefined ? (p.active ? 1 : 0) : c.active,
      c.id
    );
    dbm.audit(d, { userId: req.user.id, action: 'category/update', entity: 'category', entityId: String(c.id), detail: p });
    res.json({ ok: true });
  });

  app.delete('/api/categories/:id', me, can('categories.manage'), (req, res) => {
    const c = d.prepare('SELECT * FROM categories WHERE id = ?').get(numOrNull(req.params.id));
    if (!c) return res.status(404).json({ error: 'not found' });
    const used = d.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(c.id).n;
    if (used > 0) return d.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(c.id);
    d.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
    dbm.audit(d, { userId: req.user.id, action: 'category/delete', entity: 'category', entityId: String(c.id), detail: { name: c.name, detached: used } });
    res.json({ ok: true, detached: used });
  });

  // ---- products --------------------------------------------------------------------------------
  app.get('/api/products', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    let branchId = (branches[0] && branches[0].id) || null;
    // Phase 12: ?branch_id= lets the owner (and a manager, for their own
    // branch) read another branch's catalogue/stock — used by the transfer
    // builder to source products from the destination branch.
    if (req.query.branch_id) {
      const b = numOrNull(req.query.branch_id);
      if (!b || !branches.some((x) => x.id === b)) return res.status(404).json({ error: 'branch not found' });
      branchId = b;
    }
    const loc = branchId ? defaultLocation(d, branchId) : null;
    const rows = d
      .prepare(
        `SELECT p.*, c.name AS category_name, s.name AS supplier_name,
           (SELECT COALESCE(SUM(st.qty), 0) FROM variants v
             JOIN stock st ON st.variant_id = v.id AND st.location_id = ?
            WHERE v.product_id = p.id AND v.active = 1) AS stock_qty,
           (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.active = 1) AS variant_count,
           (SELECT v.id FROM variants v WHERE v.product_id = p.id AND v.active = 1 AND v.axes_key = '{}' LIMIT 1) AS base_variant_id
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE p.active = 1
           ORDER BY c.name, p.name`
      )
      .all(loc ? loc.id : 0);
    res.json(rows.map(publicProduct));
  });

  app.post('/api/products', me, can('products.manage'), (req, res) => {
    const p = cleanProduct(req.body || {});
    if (p.error) return res.status(400).json({ error: p.error });
    if (p.barcode && d.prepare('SELECT id FROM variant_barcodes WHERE barcode = ? AND active = 1').get(p.barcode)) {
      return res.status(409).json({ error: 'barcode already in use by another product/variant' });
    }
    if (p.supplierId && !d.prepare('SELECT id FROM suppliers WHERE id = ?').get(p.supplierId)) {
      return res.status(400).json({ error: 'unknown supplier' });
    }
    const now = new Date().toISOString();
    // R-PR1: below-floor guard (PIN/block) on every price being set
    let approver = null;
    for (const [field, price] of [['price', p.price], ['wholesale_price', p.wholesalePrice], ['member_price', p.memberPrice]]) {
      const g = marginGuard(req, { min_margin_pct: p.minMarginPct }, null, price, p.cost);
      if (g && g.status) return res.status(g.status).json({ code: g.code, error: g.error });
      if (g && g.approver) approver = g.approver;
    }
    const run = d.transaction(() => {
      const id = d
        .prepare(
          `INSERT INTO products
             (branch_id, sku, barcode, name, name_sw, category_id, brand, unit, pack_size, pack_name,
              cost, price, wholesale_price, member_price, tax_type, kra_item_code,
              age_min, requires_rx, is_controlled, track_batches, track_serials, open_priced,
              supplier_id, reorder_level, min_margin_pct, image, active, created_at, updated_at)
           VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          p.sku, p.barcode, p.name, p.name_sw, p.categoryId, p.brand, p.unit, p.packSize, p.packName,
          p.cost, p.price, p.wholesalePrice, p.memberPrice, p.taxType, p.kraCode,
          p.ageMin, p.requiresRx, p.isControlled, p.trackBatches, p.trackSerials, p.openPriced,
          p.supplierId, p.reorderLevel, p.minMarginPct, p.image, now, now
        ).lastInsertRowid;
      // R-P1: every product carries at least its implicit variant
      const vid = d
        .prepare(`INSERT INTO variants (product_id, name, axes, axes_key, sku, active, created_at, updated_at)
                  VALUES (?, '', '{}', '{}', ?, 1, ?, ?)`)
        .run(id, p.sku, now, now).lastInsertRowid;
      if (p.barcode) {
        d.prepare(`INSERT OR IGNORE INTO variant_barcodes (variant_id, barcode, kind, active) VALUES (?, ?, 'unit', 1)`)
          .run(vid, p.barcode);
      }
      // R-PR3: every price leaves history from the first moment
      for (const [field, price] of [['price', p.price], ['wholesale_price', p.wholesalePrice], ['member_price', p.memberPrice]]) {
        if (price > 0) priceHist({ id }, { variantId: vid, scope: 'product', field, oldPrice: null, newPrice: price, user: req.user, approver });
      }
      return id;
    });
    const id = run();
    dbm.audit(d, { userId: req.user.id, action: 'product/create', entity: 'product', entityId: String(id), detail: { name: p.name, price: p.price } });
    res.json({ ok: true, id });
  });

  app.put('/api/products/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM products WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const merged = cleanProduct({ ...cur, ...b });
    if (merged.error) return res.status(400).json({ error: merged.error });
    const barcodeChanged = merged.barcode && merged.barcode !== cur.barcode;
    if (barcodeChanged) {
      const clash = d.prepare('SELECT id FROM variant_barcodes WHERE barcode = ? AND active = 1').get(merged.barcode);
      if (clash) return res.status(409).json({ error: 'barcode already in use by another product/variant' });
    }
    // R-PR1: guard + R-PR3: history for each price that actually changes
    const priceChanges = [
      ['price', cur.price, merged.price],
      ['wholesale_price', cur.wholesale_price, merged.wholesalePrice],
      ['member_price', cur.member_price, merged.memberPrice]
    ].filter(([, o, n]) => o !== n);
    let approver = null;
    for (const [field, , newPrice] of priceChanges) {
      const g = marginGuard(req, { ...cur, min_margin_pct: merged.minMarginPct }, null, newPrice, merged.cost);
      if (g && g.status) return res.status(g.status).json({ code: g.code, error: g.error });
      if (g && g.approver) approver = g.approver;
    }
    const run = d.transaction(() => {
      d.prepare(
        `UPDATE products SET sku = ?, barcode = ?, name = ?, name_sw = ?, category_id = ?, brand = ?,
          unit = ?, pack_size = ?, pack_name = ?, cost = ?, price = ?, wholesale_price = ?, member_price = ?,
          tax_type = ?, kra_item_code = ?, age_min = ?, requires_rx = ?, is_controlled = ?,
          track_batches = ?, track_serials = ?, open_priced = ?, supplier_id = ?, reorder_level = ?, min_margin_pct = ?, image = ?,
          active = ?, updated_at = ? WHERE id = ?`
      ).run(
        merged.sku, merged.barcode, merged.name, merged.name_sw, merged.categoryId, merged.brand,
        merged.unit, merged.packSize, merged.packName, merged.cost, merged.price, merged.wholesalePrice,
        merged.memberPrice, merged.taxType, merged.kraCode, merged.ageMin, merged.requiresRx,
        merged.isControlled, merged.trackBatches, merged.trackSerials, merged.openPriced,
        merged.supplierId, merged.reorderLevel, merged.minMarginPct, merged.image,
        b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
        new Date().toISOString(),
        cur.id
      );
      for (const [field, oldPrice, newPrice] of priceChanges) {
        priceHist(cur, { scope: 'product', field, oldPrice, newPrice, user: req.user, approver });
      }
      // keep the implicit variant in sync with the product's master barcode
      const iv = implicitVariant(d, cur.id);
      if (iv) {
        d.prepare('UPDATE variants SET sku = ?, active = ?, updated_at = ? WHERE id = ?')
          .run(merged.sku, b.active !== undefined ? (b.active ? 1 : 0) : iv.active, new Date().toISOString(), iv.id);
        if (barcodeChanged) {
          const old = d.prepare('SELECT * FROM variant_barcodes WHERE variant_id = ? AND kind = \'unit\' AND active = 1 ORDER BY id LIMIT 1').get(iv.id);
          if (old) d.prepare('UPDATE variant_barcodes SET barcode = ?, active = 0 WHERE id = ?').run(merged.barcode, old.id);
          if (merged.barcode) {
            d.prepare(`INSERT OR IGNORE INTO variant_barcodes (variant_id, barcode, kind, active) VALUES (?, ?, 'unit', 1)`)
              .run(iv.id, merged.barcode);
          }
        }
      }
    });
    run();
    dbm.audit(d, { userId: req.user.id, action: 'product/update', entity: 'product', entityId: String(cur.id), detail: { name: merged.name, price: merged.price } });
    res.json({ ok: true });
  });

  app.delete('/api/products/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM products WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    const now = new Date().toISOString();
    d.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(now, cur.id);
    d.prepare('UPDATE variants SET active = 0, updated_at = ? WHERE product_id = ?').run(now, cur.id);
    d.prepare(`UPDATE variant_barcodes SET active = 0 WHERE variant_id IN (SELECT id FROM variants WHERE product_id = ?)`).run(cur.id);
    dbm.audit(d, { userId: req.user.id, action: 'product/delete', entity: 'product', entityId: String(cur.id), detail: { name: cur.name } });
    res.json({ ok: true });
  });

  // ---- stock adjust (core housekeeping — not a capability) --------------------------------------
  const ADJUST_REASONS = ['stocktake', 'damage', 'expired', 'other'];
  app.post('/api/stock/adjust', me, can('stock.adjust'), (req, res) => {
    const b = req.body || {};
    const qty = Number(b.qty);
    const reason = ADJUST_REASONS.includes(b.reason) ? b.reason : null;
    if (!Number.isFinite(qty) || qty === 0) return res.status(400).json({ error: 'qty must be non-zero' });
    if (!reason) return res.status(400).json({ error: 'reason required' });

    // R-P1: stock moves target a variant. product_id alone is fine only while
    // the product has a single active variant.
    let variant = numOrNull(b.variant_id)
      ? d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(b.variant_id))
      : null;
    let productId = numOrNull(b.product_id);
    if (variant) productId = variant.product_id;
    else if (!productId) return res.status(400).json({ error: 'product_id or variant_id required' });
    if (!variant) {
      const vs = activeVariantsOf(d, productId);
      if (vs.length === 1) variant = vs[0];
      else if (vs.length > 1) return res.status(400).json({ error: 'product has multiple variants — specify variant_id' });
      else variant = null;
    }
    if (!variant) return res.status(400).json({ error: 'no active variant' });
    const product = productRow(d, productId);
    if (!product || !product.active) return res.status(400).json({ error: 'unknown product' });

    const { branchId, locationId, error: scopeError } = stockScope(req.user, b);
    if (scopeError) return res.status(400).json({ error: scopeError });

    let out;
    try {
      out = d.transaction(() =>
        writeMove(d, {
          product, variant, branchId, locationId, qty, type: 'adjustment', reason,
          ref: 'ADJ', unitCost: variant.cost || 0, userId: req.user.id, note: String(b.note || ''), allowOversell: false
        })
      )();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, {
      userId: req.user.id, branchId, action: 'stock/adjust', entity: 'product', entityId: String(productId),
      detail: { name: product.name, variant: variant.name || '(base)', qty, reason, newQty: out.newQty }
    });
    res.json({ ok: true, newQty: out.newQty, variant_id: variant.id });
  });

  // ---- Phase 4: stock ledger & inventory (R-S) ---------------------------------------------
  const stockScope = (user, b = {}) => {
    const branches = visibleBranches(d, user);
    const branchId = (branches[0] && branches[0].id) || null;
    // R-2/R-3: an owner may move stock at any branch's locations; the move is
    // tagged with the location's own branch, never the first visible one.
    const locs = user.role === 'owner'
      ? d.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY id').all()
      : (branchId ? locationsOf(d, branchId) : []);
    const locationId = numOrNull(b.location_id) && locs.some((l) => l.id === b.location_id)
      ? b.location_id : (locs[0] && locs[0].id);
    const loc = locs.find((l) => l.id === locationId) || null;
    return {
      branchId: user.role === 'owner' && loc ? loc.branch_id : branchId,
      locationId,
      error: locationId ? null : 'no location'
    };
  };

  // Generic move — the one door through which every quantity change flows (R-S1).
  app.post('/api/stock/moves', me, can('stock.adjust'), (req, res) => {
    const b = req.body || {};
    const qty = Number(b.qty);
    const type = String(b.type || '');
    const reason = String(b.reason || '').trim();
    let variant = numOrNull(b.variant_id)
      ? d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(b.variant_id))
      : null;
    let productId = numOrNull(b.product_id);
    if (variant) productId = variant.product_id;
    if (!variant && productId) {
      const vs = activeVariantsOf(d, productId);
      variant = vs.length === 1 ? vs[0] : null;
      if (!variant) return res.status(400).json({ error: 'product has multiple variants — specify variant_id' });
    }
    if (!variant) return res.status(400).json({ error: 'no active variant' });
    const product = productRow(d, productId);
    if (!product || !product.active) return res.status(400).json({ error: 'unknown product' });
    const { branchId, locationId, error } = stockScope(req.user, b);
    if (error) return res.status(400).json({ error });

    // R-S8: oversell is an explicit, audited manager/owner act — never a cashier's.
    const allowOversell = b.oversell === true && ['owner', 'manager'].includes(req.user.role);

    let out;
    try {
      out = d.transaction(() =>
        writeMove(d, {
          product, variant, branchId, locationId, qty, type, reason,
          ref: String(b.ref || ''), batchId: numOrNull(b.batch_id), serialId: numOrNull(b.serial_id),
          unitCost: intShillings(b.unit_cost) || 0, userId: req.user.id, note: String(b.note || ''),
          allowOversell
        })
      )();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, {
      userId: req.user.id, branchId, action: 'stock/move', entity: 'product', entityId: String(productId),
      detail: { name: product.name, variant: variant.name || '(base)', type, reason, qty, ref: String(b.ref || ''), newQty: out.newQty, oversell: out.oversell || undefined }
    });
    res.json({ ok: true, move_ids: out.moveIds, newQty: out.newQty, oversell: out.oversell || undefined, variant_id: variant.id });
  });

  // Ledger query — who changed what, when, why, on what evidence.
  app.get('/api/stock/moves', me, can('stock.view'), (req, res) => {
    const q = req.query;
    const where = [];
    const args = [];
    // R-2: a branch manager must never see another branch's stock ledger
    if (req.user.role !== 'owner') {
      const vis = visibleBranches(d, req.user).map((b) => b.id);
      where.push(`m.branch_id IN (${vis.map(() => '?').join(',')})`);
      args.push(...vis);
    }
    if (q.variant_id) { where.push('m.variant_id = ?'); args.push(numOrNull(q.variant_id)); }
    if (q.product_id) { where.push('m.product_id = ?'); args.push(numOrNull(q.product_id)); }
    if (q.location_id) { where.push('m.location_id = ?'); args.push(numOrNull(q.location_id)); }
    if (q.type) { where.push('m.type = ?'); args.push(String(q.type)); }
    if (q.from) { where.push('m.created_at >= ?'); args.push(String(q.from)); }
    if (q.to) { where.push('m.created_at <= ?'); args.push(String(q.to)); }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
    const rows = d
      .prepare(
        `SELECT m.*, p.name AS product_name, v.name AS variant_name, b.batch_no, u.name AS user_name, l.name AS location_name
           FROM stock_moves m
           JOIN products p ON p.id = m.product_id
           LEFT JOIN variants v ON v.id = m.variant_id
           LEFT JOIN batches b ON b.id = m.batch_id
           LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN locations l ON l.id = m.location_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY m.id DESC LIMIT ?`
      )
      .all(...args, limit);
    res.json(rows);
  });

  // Balances: materialized stock vs ledger view, per variant × location (R-S7 surface).
  app.get('/api/stock/balances', me, can('stock.view'), (req, res) => {
    const locId = numOrNull(req.query.location_id);
    const vis = req.user.role === 'owner' ? null : visibleBranches(d, req.user).map((b) => b.id);
    const whereParts = [];
    const mArgs = [];
    if (locId) { whereParts.push('s.location_id = ?'); mArgs.push(locId); }
    if (vis) { whereParts.push(`l.branch_id IN (${vis.map(() => '?').join(',')})`); mArgs.push(...vis); }
    const materialized = d
      .prepare(
        `SELECT s.variant_id, s.location_id, s.qty, l.name AS location_name, l.branch_id,
                COALESCE(lb.expected_qty, 0) AS expected, COALESCE(lb.last_moved_at, '') AS last_moved_at
           FROM stock s
           JOIN locations l ON l.id = s.location_id
           LEFT JOIN stock_ledger_balances lb ON lb.variant_id = s.variant_id AND lb.location_id = s.location_id
          ${whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''}
          ORDER BY l.id, s.variant_id`
      )
      .all(...mArgs);
    const out = new Map();
    for (const r of materialized) {
      const p = d.prepare('SELECT p.id, p.name, p.unit, p.sku, v.name AS variant_name FROM products p JOIN variants v ON v.id = ? WHERE p.id = v.product_id').get(r.variant_id);
      if (!p) continue;
      const key = r.variant_id;
      if (!out.has(key)) out.set(key, { variant_id: r.variant_id, product_id: p.id, product_name: p.name, sku: p.sku, unit: p.unit, variant_name: p.variant_name || '(base)', total: 0, expected_total: 0, match: true, locations: [] });
      const e = out.get(key);
      e.total += r.qty;
      e.expected_total += r.expected;
      if (Math.abs(r.qty - r.expected) > 1e-9) e.match = false;
      e.locations.push({ location_id: r.location_id, location_name: r.location_name, qty: r.qty, expected: r.expected, last_moved_at: r.last_moved_at });
    }
    res.json([...out.values()]);
  });

  // Day 18 convenience: flat stock list per location (for blind 50 and UI)
  app.get('/api/stock', me, can('stock.view'), (req, res) => {
    const locId = numOrNull(req.query.location_id);
    const branchId = numOrNull(req.query.branch_id);
    const vis = req.user.role === 'owner' ? null : visibleBranches(d, req.user).map((b) => b.id);
    const where = [];
    const args = [];
    if (locId) { where.push('s.location_id = ?'); args.push(locId); }
    if (branchId) { where.push('l.branch_id = ?'); args.push(branchId); }
    if (vis && !branchId) { where.push(`l.branch_id IN (${vis.map(() => '?').join(',')})`); args.push(...vis); }
    if (vis && branchId && !vis.includes(branchId)) return res.status(404).json({ error: 'branch not found' });
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = d.prepare(
      `SELECT s.variant_id, s.location_id, s.qty, l.name AS location_name, l.branch_id, b.name AS branch_name,
              p.id AS product_id, p.name AS product_name, v.name AS variant_name,
              COALESCE(v.cost, p.cost, 0) AS unit_cost
         FROM stock s
         JOIN locations l ON l.id = s.location_id
         JOIN branches b ON b.id = l.branch_id
         JOIN variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
         ${whereSql}
        ORDER BY s.location_id, p.name`
    ).all(...args);
    res.json(rows);
  });

  // R-S7 integrity job: assert materialized == recomputed ledger. Mismatch = alert,
  // never silent — repair is an explicit, audited act (owner/stocktake.approve).
  app.post('/api/stock/integrity', me, can('stocktake.approve'), (req, res) => {
    const repair = (req.body || {}).repair === true;
    const scan = () => {
      const materialized = d.prepare('SELECT variant_id, location_id, qty FROM stock').all();
      const ledger = d.prepare('SELECT variant_id, location_id, expected_qty FROM stock_ledger_balances').all();
      const keys = new Map();
      for (const r of materialized) keys.set(r.variant_id + ':' + r.location_id, { qty: r.qty, expected: 0 });
      for (const r of ledger) {
        const k = r.variant_id + ':' + r.location_id;
        const e = keys.get(k) || { qty: 0, expected: 0 };
        e.expected = r.expected_qty;
        keys.set(k, e);
      }
      const mismatches = [];
      for (const [k, v] of keys) {
        if (Math.abs(v.qty - v.expected) > 1e-9) {
          const [variant_id, location_id] = k.split(':').map(Number);
          mismatches.push({ variant_id, location_id, materialized: v.qty, expected: v.expected, product: (d.prepare('SELECT p.name FROM products p JOIN variants v ON v.product_id = p.id WHERE v.id = ?').get(variant_id) || {}).name || '?' });
        }
      }
      return { checked: keys.size, mismatches };
    };
    const { checked, mismatches } = scan();
    let afterRepair = null;
    if (repair) {
      d.transaction(() => {
        for (const m of mismatches) {
          d.prepare(
            `INSERT INTO stock (variant_id, location_id, qty) VALUES (?, ?, ?)
             ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = excluded.qty`
          ).run(m.variant_id, m.location_id, m.expected);
        }
      })();
      for (const m of mismatches) {
        dbm.audit(d, {
          userId: req.user.id, action: 'stock/integrity_repair', entity: 'product', entityId: String(m.variant_id),
          detail: { ...m, from: m.materialized, to: m.expected }
        });
      }
      afterRepair = scan().mismatches;
    }
    res.json({ ok: true, checked, mismatches, repaired: repair, ...(afterRepair !== null ? { after_repair: afterRepair } : {}) });
  });

  // R-S2 — the five questions, one call: where from? who? why? where now? what should physically be there?
  app.get('/api/stock/trace/:variantId', me, can('stock.view'), (req, res) => {
    const v = d.prepare('SELECT * FROM variants WHERE id = ?').get(numOrNull(req.params.variantId));
    if (!v) return res.status(404).json({ error: 'not found' });
    const product = productRow(d, v.product_id);
    const moves = d.prepare('SELECT * FROM stock_moves WHERE variant_id = ? ORDER BY id DESC LIMIT 500').all(v.id);
    const userNames = new Map(d.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    const mapMove = (m) => ({
      id: m.id, type: m.type, reason: m.reason, qty: m.qty, ref: m.ref,
      at: m.created_at, user: userNames.get(m.user_id) || 'system',
      batch: m.batch_id ? (d.prepare('SELECT batch_no, expiry_date FROM batches WHERE id = ?').get(m.batch_id) || {}).batch_no : null,
      note: m.note
    });
    const byLoc = d
      .prepare(
        `SELECT s.location_id, l.name AS location_name, l.branch_id, s.qty,
                COALESCE(lb.expected_qty, 0) AS expected
           FROM stock s JOIN locations l ON l.id = s.location_id
           LEFT JOIN stock_ledger_balances lb ON lb.variant_id = s.variant_id AND lb.location_id = s.location_id
          WHERE s.variant_id = ? ORDER BY l.id`
      )
      .all(v.id);
    const batches = d
      .prepare(
        `SELECT b.batch_no, b.expiry_date, b.qty, b.location_id, l.name AS location_name
           FROM batches b LEFT JOIN locations l ON l.id = b.location_id
          WHERE b.variant_id = ? AND b.qty > 0
          ORDER BY b.expiry_date IS NULL, b.expiry_date ASC, b.id ASC`
      )
      .all(v.id);
    res.json({
      variant: { id: v.id, name: v.name || '(base)', axes: safeJson(v.axes) },
      product: { id: product.id, name: product.name, unit: product.unit },
      from: moves.filter((m) => INBOUND_TYPES.has(m.type)).reverse().map(mapMove).slice(-50).reverse(),
      changes: moves.map(mapMove).slice(0, 100),
      now: byLoc.map((r) => ({ location_id: r.location_id, location_name: r.location_name, branch_id: r.branch_id, qty: r.qty, expected: r.expected })),
      expected: byLoc.reduce((s, r) => s + r.expected, 0),
      batches
    });
  });

  // Stock ageing: per variant × location, qty by batch age (or age since last inbound).
  app.get('/api/stock/aging', me, can('stock.view'), (req, res) => {
    const rows = d
      .prepare(
        `SELECT v.id AS variant_id, v.name AS variant_name, p.name AS product_name, p.track_batches,
                s.location_id, l.name AS location_name, s.qty
           FROM stock s
           JOIN variants v ON v.id = s.variant_id
           JOIN products p ON p.id = v.product_id
           JOIN locations l ON l.id = s.location_id
          WHERE s.qty > 0
          ORDER BY l.id, v.id`
      )
      .all();
    const out = [];
    for (const r of rows) {
      const buckets = { fresh: 0, maturing: 0, aging: 0 }; // ≤30d / 31–90d / >90d
      let oldest = 0;
      if (r.track_batches) {
        const lots = d
          .prepare(
            `SELECT b.qty, CAST(julianday('now') - julianday(b.created_at) AS INTEGER) AS age_days
               FROM batches b WHERE b.variant_id = ? AND b.location_id = ? AND b.qty > 0`
          )
          .all(r.variant_id, r.location_id);
        for (const b of lots) {
          const k = b.age_days <= 30 ? 'fresh' : b.age_days <= 90 ? 'maturing' : 'aging';
          buckets[k] += b.qty;
          oldest = Math.max(oldest, b.age_days);
        }
      } else {
        const last = d
          .prepare(
            `SELECT MAX(created_at) AS at FROM stock_moves
              WHERE variant_id = ? AND location_id = ? AND qty > 0`
          )
          .get(r.variant_id, r.location_id);
        const age = last && last.at
          ? Math.max(0, Math.round((Date.now() - new Date(last.at).getTime()) / 86400000))
          : 0;
        const k = age <= 30 ? 'fresh' : age <= 90 ? 'maturing' : 'aging';
        buckets[k] = r.qty;
        oldest = age;
      }
      out.push({ variant_id: r.variant_id, variant_name: r.variant_name || '(base)', product_name: r.product_name, location_id: r.location_id, location_name: r.location_name, qty: r.qty, buckets, oldest_age_days: oldest });
    }
    res.json(out);
  });

  // Dead stock: on hand but no consumption (negative move) in N days.
  app.get('/api/stock/dead', me, can('stock.view'), (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 3650);
    const rows = d
      .prepare(
        `SELECT v.id AS variant_id, v.name AS variant_name, p.name AS product_name, p.sku, l.name AS location_name, s.qty,
                (SELECT MAX(m.created_at) FROM stock_moves m
                  WHERE m.variant_id = v.id AND m.location_id = s.location_id
                    AND m.qty < 0 AND m.type NOT IN ('stocktake')) AS last_out
           FROM stock s
           JOIN variants v ON v.id = s.variant_id
           JOIN products p ON p.id = v.product_id AND p.active = 1
           JOIN locations l ON l.id = s.location_id
          WHERE s.qty > 0
          ORDER BY p.name`
      )
      .all();
    const cutoff = Date.now() - days * 86400000;
    res.json(
      rows
        .map((r) => ({ ...r, idle_days: r.last_out ? Math.max(0, Math.round((Date.now() - new Date(r.last_out).getTime()) / 86400000)) : null }))
        .filter((r) => r.idle_days === null || r.idle_days >= days)
    );
  });

  // ---- stocktakes (Phase 13 Day 18: full/partial/blind, reason codes, recount, shrinkage) --
  const STOCKTAKE_REASONS = ['damage', 'expired', 'theft', 'lost', 'found', 'correction', 'other', 'stocktake', 'integrity', ''];
  // Extend move reasons for Day 18 (stocktake may carry detailed reason)
  MOVE_REASONS.stocktake = ['stocktake', 'integrity', 'damage', 'expired', 'theft', 'lost', 'found', 'correction', 'other'];
  MOVE_REASONS.adjustment = ['stocktake', 'damage', 'expired', 'other', 'integrity', 'theft', 'lost', 'found', 'correction'];

  app.get('/api/stocktakes', me, can('stock.view'), (req, res) => {
    const user = req.user;
    const vis = user.role === 'owner' ? null : visibleBranches(d, user).map((b) => b.id);
    const branchId = numOrNull(req.query.branch_id);
    const locationId = numOrNull(req.query.location_id);
    const status = req.query.status ? String(req.query.status) : null;
    const countType = req.query.count_type ? String(req.query.count_type) : null;
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    const where = [];
    const args = [];
    if (vis) { where.push(`st.branch_id IN (${vis.map(() => '?').join(',')})`); args.push(...vis); }
    if (branchId) { where.push('st.branch_id = ?'); args.push(branchId); }
    if (locationId) { where.push('st.location_id = ?'); args.push(locationId); }
    if (status) { where.push('st.status = ?'); args.push(status); }
    if (countType) { where.push('st.count_type = ?'); args.push(countType); }
    if (from) { where.push('st.created_at >= ?'); args.push(from); }
    if (to) { where.push('st.created_at <= ?'); args.push(to); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = d
      .prepare(
        `SELECT st.*, l.name AS location_name, b.name AS branch_name, u.name AS taken_by_name, au.name AS approved_by_name,
                (SELECT COUNT(*) FROM stocktake_lines ln WHERE ln.stocktake_id = st.id) AS lines,
                (SELECT COUNT(*) FROM stocktake_lines ln WHERE ln.stocktake_id = st.id AND ln.physical_qty IS NOT NULL) AS counted,
                (SELECT COALESCE(SUM(ABS(COALESCE(ln.variance, ln.recount_variance, 0))), 0) FROM stocktake_lines ln WHERE ln.stocktake_id = st.id) AS total_abs_variance,
                (SELECT COALESCE(SUM(CASE WHEN COALESCE(ln.recount_variance, ln.variance, 0) < 0 THEN COALESCE(ln.recount_variance, ln.variance, 0) ELSE 0 END), 0) FROM stocktake_lines ln WHERE ln.stocktake_id = st.id) AS total_shrinkage_qty
           FROM stocktakes st
           JOIN locations l ON l.id = st.location_id
           JOIN branches b ON b.id = st.branch_id
           LEFT JOIN users u ON u.id = st.taken_by
           LEFT JOIN users au ON au.id = st.approved_by
           ${whereSql}
          ORDER BY st.id DESC LIMIT 200`
      )
      .all(...args);
    res.json(rows);
  });

  app.post('/api/stocktakes', me, can('stocktake.manage'), (req, res) => {
    const b = req.body || {};
    const { branchId, locationId, error } = stockScope(req.user, b);
    if (error) return res.status(400).json({ error });
    const countType = ['full', 'partial', 'blind'].includes(String(b.count_type || '').trim()) ? String(b.count_type).trim() : (b.is_blind ? 'blind' : 'full');
    const isBlind = b.is_blind ? 1 : (countType === 'blind' ? 1 : 0);
    const title = String(b.title || '').trim();
    const note = String(b.note || '').trim();
    const variantIds = Array.isArray(b.variant_ids) ? b.variant_ids.map((x) => numOrNull(x)).filter(Boolean) : [];
    const productIds = Array.isArray(b.product_ids) ? b.product_ids.map((x) => numOrNull(x)).filter(Boolean) : [];
    const t = new Date().toISOString();
    const id = d.prepare(
      `INSERT INTO stocktakes (location_id, branch_id, status, count_type, is_blind, title, taken_by, note, created_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`
    ).run(locationId, branchId, countType, isBlind, title, req.user.id, note, t).lastInsertRowid;

    const insLine = d.prepare(
      `INSERT INTO stocktake_lines (stocktake_id, variant_id, batch_id, expected_qty, physical_qty, variance, reason, note, counted_by, counted_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, '', '', NULL, NULL, ?)`
    );

    d.transaction(() => {
      let stockRows = [];
      if (countType === 'partial' && (variantIds.length || productIds.length)) {
        // Build variant list from explicit variant_ids + all variants of product_ids
        let vIds = [...variantIds];
        if (productIds.length) {
          const ph = productIds.map(() => '?').join(',');
          const prodVars = d.prepare(`SELECT id FROM variants WHERE product_id IN (${ph}) AND active = 1`).all(...productIds);
          vIds.push(...prodVars.map((r) => r.id));
        }
        vIds = [...new Set(vIds)];
        if (!vIds.length) return;
        const ph = vIds.map(() => '?').join(',');
        // For partial, snapshot current stock even if zero? Use stock table left join to include zero-stock variants
        stockRows = d.prepare(
          `SELECT v.id AS variant_id, COALESCE(s.qty, 0) AS qty FROM variants v LEFT JOIN stock s ON s.variant_id = v.id AND s.location_id = ? WHERE v.id IN (${ph})`
        ).all(locationId, ...vIds).map((r) => ({ variant_id: r.variant_id, qty: r.qty }));
      } else {
        // full / blind: all positive stock at location
        stockRows = d.prepare('SELECT variant_id, qty FROM stock WHERE location_id = ? AND qty != 0').all(locationId).map((r) => ({ variant_id: r.variant_id, qty: r.qty }));
        // If blind of 50 variants acceptance wants ability to count 50 even if some zero, allow empty snapshot to be filled later via add-line endpoint
      }

      for (const s of stockRows) {
        const variant = d.prepare('SELECT product_id FROM variants WHERE id = ?').get(s.variant_id);
        if (!variant) continue;
        const product = productRow(d, variant.product_id);
        if (product && product.track_batches) {
          const lots = d.prepare('SELECT id, qty FROM batches WHERE variant_id = ? AND location_id = ? AND qty > 0').all(s.variant_id, locationId);
          let allocated = 0;
          for (const lot of lots) { insLine.run(id, s.variant_id, lot.id, lot.qty, t); allocated += lot.qty; }
          const residual = Math.round((s.qty - allocated) * 1e6) / 1e6;
          if (residual > 1e-9 || (countType === 'partial' && lots.length === 0)) {
            // For partial, keep even zero-stock lines as expected 0 so they can be counted as found stock
            insLine.run(id, s.variant_id, null, Math.max(0, residual), t);
          }
        } else {
          insLine.run(id, s.variant_id, null, s.qty, t);
        }
      }
    })();

    dbm.audit(d, { userId: req.user.id, branchId, action: 'stocktake/create', entity: 'stocktake', entityId: String(id), detail: { location_id: locationId, count_type: countType, is_blind: isBlind, lines: variantIds.length || 'full' } });
    res.json({ ok: true, id, count_type: countType, is_blind: isBlind });
  });

  // Add ad-hoc lines to a draft (useful for blind counts where you discover stock not in snapshot)
  app.post('/api/stocktakes/:id/lines', me, can('stocktake.manage'), (req, res) => {
    const st = d.prepare('SELECT * FROM stocktakes WHERE id = ?').get(numOrNull(req.params.id));
    if (!st) return res.status(404).json({ error: 'not found' });
    if (st.status !== 'draft') return res.status(400).json({ error: 'stocktake is not a draft' });
    const b = req.body || {};
    const variantId = numOrNull(b.variant_id);
    if (!variantId) return res.status(400).json({ error: 'variant_id required' });
    const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(variantId);
    if (!variant) return res.status(400).json({ error: 'variant not found' });
    const expected = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(variantId, st.location_id);
    const expQty = expected ? expected.qty : 0;
    const batchId = numOrNull(b.batch_id);
    const t = new Date().toISOString();
    const id = d.prepare(
      `INSERT INTO stocktake_lines (stocktake_id, variant_id, batch_id, expected_qty, physical_qty, variance, reason, note, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, '', '', ?)`
    ).run(st.id, variantId, batchId, expQty, t).lastInsertRowid;
    res.json({ ok: true, id, expected_qty: expQty });
  });

  app.get('/api/stocktakes/:id', me, can('stock.view'), (req, res) => {
    const st = d.prepare('SELECT * FROM stocktakes WHERE id = ?').get(numOrNull(req.params.id));
    if (!st) return res.status(404).json({ error: 'not found' });
    const canApprove = perms.userHasPerm(d, req.user, 'stocktake.approve') || req.user.role === 'owner';
    const isBlindDraft = st.is_blind && st.status === 'draft';
    const hideExpected = isBlindDraft && !canApprove;
    const lines = d
      .prepare(
        `SELECT ln.*, p.name AS product_name, p.sku, v.name AS variant_name, b.batch_no, b.expiry_date,
                u.name AS counted_by_name, ru.name AS recount_by_name,
                COALESCE(v.cost, p.cost, 0) AS unit_cost,
                (COALESCE(v.cost, p.cost, 0) * ABS(COALESCE(ln.recount_variance, ln.variance, 0))) AS variance_value
           FROM stocktake_lines ln
           JOIN variants v ON v.id = ln.variant_id
           JOIN products p ON p.id = v.product_id
           LEFT JOIN batches b ON b.id = ln.batch_id
           LEFT JOIN users u ON u.id = ln.counted_by
           LEFT JOIN users ru ON ru.id = ln.recount_by
          WHERE ln.stocktake_id = ? ORDER BY ln.id`
      )
      .all(st.id)
      .map((ln) => {
        if (hideExpected) {
          return { ...ln, expected_qty: null, variance: ln.physical_qty !== null ? null : ln.variance, variance_value: null };
        }
        return ln;
      });
    const loc = d.prepare('SELECT name FROM locations WHERE id = ?').get(st.location_id);
    const br = d.prepare('SELECT name FROM branches WHERE id = ?').get(st.branch_id);
    res.json({ ...st, location_name: loc ? loc.name : '', branch_name: br ? br.name : '', lines, blind_hidden: hideExpected });
  });

  app.put('/api/stocktakes/:id/lines/:lineId', me, can('stocktake.manage'), (req, res) => {
    const st = d.prepare('SELECT * FROM stocktakes WHERE id = ?').get(numOrNull(req.params.id));
    if (!st) return res.status(404).json({ error: 'not found' });
    if (st.status !== 'draft') return res.status(400).json({ error: 'stocktake is not a draft' });
    const line = d.prepare('SELECT * FROM stocktake_lines WHERE id = ? AND stocktake_id = ?').get(numOrNull(req.params.lineId), st.id);
    if (!line) return res.status(404).json({ error: 'line not found' });
    const body = req.body || {};
    const physical = body.physical_qty !== undefined ? Number(body.physical_qty) : (line.physical_qty !== null ? line.physical_qty : null);
    if (physical !== null && (!Number.isFinite(physical) || physical < 0)) return res.status(400).json({ error: 'physical_qty must be >= 0' });
    const reason = body.reason !== undefined ? String(body.reason).trim() : line.reason;
    if (reason && !STOCKTAKE_REASONS.includes(reason)) return res.status(400).json({ error: `reason must be one of ${STOCKTAKE_REASONS.join(', ')}` });
    const note = body.note !== undefined ? String(body.note).trim() : line.note;
    const t = new Date().toISOString();
    const variance = physical !== null ? Math.round((physical - line.expected_qty) * 1e6) / 1e6 : null;
    d.prepare(
      `UPDATE stocktake_lines SET physical_qty = ?, variance = ?, reason = ?, note = ?, counted_by = ?, counted_at = ? WHERE id = ?`
    ).run(physical, variance, reason || '', note || '', req.user.id, t, line.id);
    res.json({ ok: true, variance, physical_qty: physical });
  });

  // Recount a line (second count by different person, for blind verification)
  app.post('/api/stocktakes/:id/recount/:lineId', me, can('stocktake.manage'), (req, res) => {
    const st = d.prepare('SELECT * FROM stocktakes WHERE id = ?').get(numOrNull(req.params.id));
    if (!st) return res.status(404).json({ error: 'not found' });
    if (st.status !== 'draft') return res.status(400).json({ error: 'stocktake is not a draft' });
    const line = d.prepare('SELECT * FROM stocktake_lines WHERE id = ? AND stocktake_id = ?').get(numOrNull(req.params.lineId), st.id);
    if (!line) return res.status(404).json({ error: 'line not found' });
    const body = req.body || {};
    const recountQty = Number(body.recount_qty);
    if (!Number.isFinite(recountQty) || recountQty < 0) return res.status(400).json({ error: 'recount_qty must be >= 0' });
    const reason = body.reason !== undefined ? String(body.reason).trim() : line.reason;
    if (reason && !STOCKTAKE_REASONS.includes(reason)) return res.status(400).json({ error: `reason must be one of ${STOCKTAKE_REASONS.join(', ')}` });
    const note = body.note !== undefined ? String(body.note).trim() : line.note;
    const t = new Date().toISOString();
    const recountVariance = Math.round((recountQty - line.expected_qty) * 1e6) / 1e6;
    d.prepare(
      `UPDATE stocktake_lines SET recount_qty = ?, recount_variance = ?, reason = ?, note = ?, recount_by = ?, recount_at = ? WHERE id = ?`
    ).run(recountQty, recountVariance, reason || '', note || '', req.user.id, t, line.id);
    res.json({ ok: true, recount_variance: recountVariance });
  });

  app.post('/api/stocktakes/:id/approve', me, can('stocktake.approve'), (req, res) => {
    const st = d.prepare('SELECT * FROM stocktakes WHERE id = ?').get(numOrNull(req.params.id));
    if (!st) return res.status(404).json({ error: 'not found' });
    if (st.status !== 'draft') return res.status(400).json({ error: 'stocktake is not a draft' });
    // Use recount if present, else physical
    const linesRaw = d.prepare('SELECT * FROM stocktake_lines WHERE stocktake_id = ?').all(st.id);
    const lines = linesRaw
      .map((l) => ({
        ...l,
        final_qty: l.recount_qty !== null && l.recount_qty !== undefined ? l.recount_qty : l.physical_qty,
        final_variance: l.recount_variance !== null && l.recount_variance !== undefined ? l.recount_variance : l.variance
      }))
      .filter((l) => l.final_qty !== null && Math.abs(l.final_variance) > 1e-9);
    if (!lines.length) {
      // No variance: still approve as clean
      d.prepare("UPDATE stocktakes SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(req.user.id, new Date().toISOString(), st.id);
      dbm.audit(d, { userId: req.user.id, branchId: st.branch_id, action: 'stocktake/approve_clean', entity: 'stocktake', entityId: String(st.id), detail: { lines: 0 } });
      return res.json({ ok: true, lines: 0, clean: true });
    }
    const t = new Date().toISOString();
    try {
      d.transaction(() => {
        for (const l of lines) {
          const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(l.variant_id);
          const product = productRow(d, variant.product_id);
          const reason = l.reason && STOCKTAKE_REASONS.includes(l.reason) ? l.reason : 'stocktake';
          // Map detailed reason to move reason (must be in MOVE_REASONS.stocktake)
          const moveReason = ['damage', 'expired', 'theft', 'lost', 'found', 'correction', 'other', 'stocktake', 'integrity'].includes(reason) ? reason : 'stocktake';
          writeMove(d, {
            product, variant, branchId: st.branch_id, locationId: st.location_id, qty: l.final_variance,
            type: 'stocktake', reason: moveReason, ref: 'ST:' + st.id, batchId: l.batch_id,
            userId: l.recount_by || l.counted_by || req.user.id,
            note: `${l.reason ? l.reason + ': ' : ''}${l.note || ''}${(req.body || {}).note ? ' — ' + (req.body || {}).note : ''}`.trim()
          });
        }
        d.prepare("UPDATE stocktakes SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(req.user.id, t, st.id);
      })();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, { userId: req.user.id, branchId: st.branch_id, action: 'stocktake/approve', entity: 'stocktake', entityId: String(st.id), detail: { lines: lines.length, count_type: st.count_type, is_blind: st.is_blind } });
    res.json({ ok: true, lines: lines.length });
  });

  app.delete('/api/stocktakes/:id', me, can('stocktake.manage'), (req, res) => {
    const st = d.prepare('SELECT * FROM stocktakes WHERE id = ?').get(numOrNull(req.params.id));
    if (!st) return res.status(404).json({ error: 'not found' });
    if (st.status !== 'draft') return res.status(400).json({ error: 'only drafts can be deleted' });
    d.prepare('DELETE FROM stocktake_lines WHERE stocktake_id = ?').run(st.id);
    d.prepare('DELETE FROM stocktakes WHERE id = ?').run(st.id);
    res.json({ ok: true });
  });

  // ---- Phase 13 Day 18: shrinkage analysis (by branch/location/variant/reason) ----
  app.get('/api/reports/shrinkage', me, can('reports.view'), (req, res) => {
    const user = req.user;
    const vis = visibleBranches(d, user).map((b) => b.id);
    if (!vis.length) return res.json({ branches: [], by_variant: [], by_reason: [], by_location: [] });
    const branchId = numOrNull(req.query.branch_id);
    if (branchId && !vis.includes(branchId)) return res.status(404).json({ error: 'branch not found' });
    const branchesFilter = branchId ? [branchId] : vis;
    const from = req.query.from ? new Date(req.query.from).toISOString() : new Date(Date.now() - 30 * 86400e3).toISOString();
    const to = req.query.to ? new Date(req.query.to).toISOString() : new Date().toISOString();
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
    const groupBy = String(req.query.group_by || 'variant');

    // Shrinkage moves: negative qty in damage, expiry_writeoff, stocktake negative, adjustment negative
    const ph = branchesFilter.map(() => '?').join(',');
    const shrinkageMoves = d.prepare(
      `SELECT m.*, p.name AS product_name, v.name AS variant_name, l.name AS location_name, b.name AS branch_name,
              COALESCE(v.cost, p.cost, 0) AS unit_cost
         FROM stock_moves m
         JOIN variants v ON v.id = m.variant_id
         JOIN products p ON p.id = v.product_id
         LEFT JOIN locations l ON l.id = m.location_id
         LEFT JOIN branches b ON b.id = m.branch_id
        WHERE m.branch_id IN (${ph}) AND m.created_at >= ? AND m.created_at <= ?
          AND m.qty < 0 AND m.type IN ('damage','expiry_writeoff','stocktake','adjustment')
        ORDER BY m.created_at DESC`
    ).all(...branchesFilter, from, to);

    // Also pull stocktake_lines variance negative for reason attribution (more accurate reason)
    const stLines = d.prepare(
      `SELECT ln.*, p.name AS product_name, v.name AS variant_name, l.name AS location_name, b.name AS branch_name,
              COALESCE(v.cost, p.cost, 0) AS unit_cost,
              COALESCE(ln.recount_variance, ln.variance, 0) AS final_variance
         FROM stocktake_lines ln
         JOIN stocktakes st ON st.id = ln.stocktake_id
         JOIN variants v ON v.id = ln.variant_id
         JOIN products p ON p.id = v.product_id
         LEFT JOIN locations l ON l.id = st.location_id
         LEFT JOIN branches b ON b.id = st.branch_id
        WHERE st.branch_id IN (${ph}) AND st.created_at >= ? AND st.created_at <= ? AND st.status = 'approved'
          AND COALESCE(ln.recount_variance, ln.variance, 0) < 0`
    ).all(...branchesFilter, from, to);

    // Aggregate by variant (top disappearing SKUs)
    const byVariantMap = new Map();
    for (const m of shrinkageMoves) {
      const key = `${m.product_id}:${m.variant_id}`;
      if (!byVariantMap.has(key)) byVariantMap.set(key, { product_id: m.product_id, variant_id: m.variant_id, product_name: m.product_name, variant_name: m.variant_name, qty_lost: 0, value_lost: 0, occurrences: 0, branches: new Set(), reasons: new Set() });
      const agg = byVariantMap.get(key);
      agg.qty_lost += Math.abs(m.qty);
      agg.value_lost += Math.abs(m.qty) * m.unit_cost;
      agg.occurrences += 1;
      agg.branches.add(m.branch_id);
      if (m.reason) agg.reasons.add(m.reason);
    }
    // Enhance with stocktake_lines (more precise)
    for (const ln of stLines) {
      const key = `${ln.product_id}:${ln.variant_id}`;
      if (!byVariantMap.has(key)) byVariantMap.set(key, { product_id: ln.product_id, variant_id: ln.variant_id, product_name: ln.product_name, variant_name: ln.variant_name, qty_lost: 0, value_lost: 0, occurrences: 0, branches: new Set(), reasons: new Set() });
      const agg = byVariantMap.get(key);
      const q = Math.abs(ln.final_variance);
      agg.qty_lost += q;
      agg.value_lost += q * ln.unit_cost;
      agg.occurrences += 1;
      agg.branches.add(ln.branch_id);
      if (ln.reason) agg.reasons.add(ln.reason);
    }

    const byVariant = [...byVariantMap.values()]
      .map((v) => ({ ...v, branches: [...v.branches], reasons: [...v.reasons] }))
      .sort((a, b) => b.value_lost - a.value_lost || b.qty_lost - a.qty_lost)
      .slice(0, limit);

    // By reason
    const byReasonMap = new Map();
    for (const m of shrinkageMoves) {
      const r = m.reason || 'other';
      if (!byReasonMap.has(r)) byReasonMap.set(r, { reason: r, qty_lost: 0, value_lost: 0, occurrences: 0 });
      const agg = byReasonMap.get(r);
      agg.qty_lost += Math.abs(m.qty);
      agg.value_lost += Math.abs(m.qty) * m.unit_cost;
      agg.occurrences += 1;
    }
    for (const ln of stLines) {
      const r = ln.reason || 'stocktake';
      if (!byReasonMap.has(r)) byReasonMap.set(r, { reason: r, qty_lost: 0, value_lost: 0, occurrences: 0 });
      const agg = byReasonMap.get(r);
      const q = Math.abs(ln.final_variance);
      agg.qty_lost += q;
      agg.value_lost += q * ln.unit_cost;
      agg.occurrences += 1;
    }
    const byReason = [...byReasonMap.values()].sort((a, b) => b.value_lost - a.value_lost);

    // By branch
    const byBranchMap = new Map();
    for (const m of shrinkageMoves) {
      if (!byBranchMap.has(m.branch_id)) byBranchMap.set(m.branch_id, { branch_id: m.branch_id, branch_name: m.branch_name, qty_lost: 0, value_lost: 0, occurrences: 0 });
      const agg = byBranchMap.get(m.branch_id);
      agg.qty_lost += Math.abs(m.qty);
      agg.value_lost += Math.abs(m.qty) * m.unit_cost;
      agg.occurrences += 1;
    }
    for (const ln of stLines) {
      if (!byBranchMap.has(ln.branch_id)) byBranchMap.set(ln.branch_id, { branch_id: ln.branch_id, branch_name: ln.branch_name, qty_lost: 0, value_lost: 0, occurrences: 0 });
      const agg = byBranchMap.get(ln.branch_id);
      const q = Math.abs(ln.final_variance);
      agg.qty_lost += q;
      agg.value_lost += q * ln.unit_cost;
      agg.occurrences += 1;
    }
    const byBranch = [...byBranchMap.values()].sort((a, b) => b.value_lost - a.value_lost);

    // By location
    const byLocationMap = new Map();
    for (const m of shrinkageMoves) {
      const key = m.location_id || 0;
      if (!byLocationMap.has(key)) byLocationMap.set(key, { location_id: m.location_id, location_name: m.location_name || 'unknown', branch_id: m.branch_id, branch_name: m.branch_name, qty_lost: 0, value_lost: 0, occurrences: 0 });
      const agg = byLocationMap.get(key);
      agg.qty_lost += Math.abs(m.qty);
      agg.value_lost += Math.abs(m.qty) * m.unit_cost;
      agg.occurrences += 1;
    }
    const byLocation = [...byLocationMap.values()].sort((a, b) => b.value_lost - a.value_lost);

    // Top 10 disappearing per branch (for acceptance)
    const perBranchTop = {};
    for (const bid of branchesFilter) {
      const movesInBranch = shrinkageMoves.filter((m) => m.branch_id === bid);
      const linesInBranch = stLines.filter((l) => l.branch_id === bid);
      const map = new Map();
      for (const m of movesInBranch) {
        const key = `${m.product_id}:${m.variant_id}`;
        if (!map.has(key)) map.set(key, { product_id: m.product_id, variant_id: m.variant_id, product_name: m.product_name, variant_name: m.variant_name, qty_lost: 0, value_lost: 0 });
        const a = map.get(key);
        a.qty_lost += Math.abs(m.qty);
        a.value_lost += Math.abs(m.qty) * m.unit_cost;
      }
      for (const ln of linesInBranch) {
        const key = `${ln.product_id}:${ln.variant_id}`;
        if (!map.has(key)) map.set(key, { product_id: ln.product_id, variant_id: ln.variant_id, product_name: ln.product_name, variant_name: ln.variant_name, qty_lost: 0, value_lost: 0 });
        const a = map.get(key);
        const q = Math.abs(ln.final_variance);
        a.qty_lost += q;
        a.value_lost += q * ln.unit_cost;
      }
      perBranchTop[bid] = [...map.values()].sort((a, b) => b.value_lost - a.value_lost).slice(0, 10);
    }

    res.json({
      from, to,
      branches: branchesFilter,
      totals: {
        qty_lost: shrinkageMoves.reduce((s, m) => s + Math.abs(m.qty), 0) + stLines.reduce((s, l) => s + Math.abs(l.final_variance), 0),
        value_lost: shrinkageMoves.reduce((s, m) => s + Math.abs(m.qty) * m.unit_cost, 0) + stLines.reduce((s, l) => s + Math.abs(l.final_variance) * l.unit_cost, 0),
        occurrences: shrinkageMoves.length + stLines.length
      },
      by_variant: byVariant,
      by_reason: byReason,
      by_branch: byBranch,
      by_location: byLocation,
      per_branch_top: perBranchTop,
      recent_moves: shrinkageMoves.slice(0, 50)
    });
  });

  // Batch expiry write-off (chemist/supermarket FEFO hygiene)
  app.post('/api/batches/:id/writeoff', me, can('stock.adjust'), (req, res) => {
    const bRow = d.prepare('SELECT * FROM batches WHERE id = ?').get(numOrNull(req.params.id));
    if (!bRow) return res.status(404).json({ error: 'not found' });
    if (req.user.role !== 'owner' && !visibleBranches(d, req.user).map((b) => b.id).includes(bRow.branch_id)) {
      return res.status(404).json({ error: 'not found' });
    }
    const qty = (req.body || {}).qty === undefined ? bRow.qty : Number(req.body.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > bRow.qty + 1e-9) return res.status(400).json({ error: `qty must be between 0 and ${bRow.qty}` });
    const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(bRow.variant_id);
    const product = productRow(d, variant.product_id);
    if (!product) return res.status(400).json({ error: 'unknown product' });
    try {
      const out = d.transaction(() =>
        writeMove(d, {
          product, variant, branchId: bRow.branch_id, locationId: bRow.location_id, qty: -qty,
          type: 'expiry_writeoff', reason: 'expired', ref: 'BATCH:' + bRow.id,
          batchId: bRow.id, userId: req.user.id, note: String((req.body || {}).note || '')
        })
      )();
      dbm.audit(d, { userId: req.user.id, branchId: bRow.branch_id, action: 'batch/writeoff', entity: 'batch', entityId: String(bRow.id), detail: { product: product.name, batchNo: bRow.batch_no, qty, newQty: out.newQty } });
      res.json({ ok: true, newQty: out.newQty });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ---- variants (Phase 3 — R-P) --------------------------------------------------------------
  function variantPayload(v) {
    const product = productRow(d, v.product_id);
    return {
      ...v,
      axes: safeJson(v.axes),
      meta: safeJson(v.meta),
      product: product ? { id: product.id, name: product.name, unit: product.unit, price: product.price, cost: product.cost } : null,
      price: eff(product, v, 'price'),
      cost: Number(eff(product, v, 'cost') || 0),
      barcodes: barcodesOfVariant(d, v.id),
      packs: packsOfVariant(d, v.id),
      stock_in_stock: d.prepare('SELECT COUNT(*) AS q FROM serials WHERE variant_id = ? AND status = \'in_stock\'').get(v.id).q
    };
  }

  app.get('/api/products/:id/variants', me, (req, res) => {
    const product = productRow(d, numOrNull(req.params.id));
    if (!product) return res.status(404).json({ error: 'not found' });
    const rows = d.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY id').all(product.id);
    res.json(rows.map(variantPayload));
  });

  app.post('/api/products/:id/variants', me, can('products.manage'), (req, res) => {
    const product = productRow(d, numOrNull(req.params.id));
    if (!product) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const cleaned = cleanVariant(b, product);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });
    const axes = parseAxesInput(b.axes);
    const axesKey = canonicalAxes(axes);
    if (axesKey === '{}') return res.status(400).json({ error: 'a variant needs at least one attribute (e.g. "size: M")' });
    if (d.prepare('SELECT id FROM variants WHERE product_id = ? AND axes_key = ?').get(product.id, axesKey)) {
      return res.status(409).json({ error: 'this variant already exists' });
    }
    const barcode = String(b.barcode || '').trim();
    if (barcode && d.prepare('SELECT id FROM variant_barcodes WHERE barcode = ? AND active = 1').get(barcode)) {
      return res.status(409).json({ error: 'barcode already in use' });
    }
    const now = new Date().toISOString();
    const run = d.transaction(() => {
      const vid = d
        .prepare(
          `INSERT INTO variants (product_id, name, axes, axes_key, sku, price, cost, wholesale_price,
            member_price, tax_type, kra_item_code, meta, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          product.id, cleaned.name, JSON.stringify(axes), axesKey, cleaned.sku,
          cleaned.price, cleaned.cost, cleaned.wholesalePrice, cleaned.memberPrice,
          cleaned.taxType, cleaned.kraCode, cleaned.meta || '{}', now, now
        ).lastInsertRowid;
      if (barcode) {
        d.prepare(`INSERT INTO variant_barcodes (variant_id, barcode, kind, active) VALUES (?, ?, 'unit', 1)`)
          .run(vid, barcode);
      }
      return vid;
    });
    const vid = run();
    dbm.audit(d, { userId: req.user.id, action: 'variant/create', entity: 'variant', entityId: String(vid), detail: { product: product.name, name: cleaned.name, axes: axesKey } });
    res.json({ ok: true, id: vid });
  });

  app.put('/api/variants/:id', me, can('products.manage'), (req, res) => {
    const v = d.prepare('SELECT * FROM variants WHERE id = ?').get(numOrNull(req.params.id));
    if (!v) return res.status(404).json({ error: 'not found' });
    const product = productRow(d, v.product_id);
    const b = req.body || {};
    const cleaned = cleanVariant(b, product);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });
    const patch = {
      name: b.name !== undefined ? String(b.name).trim() : v.name,
      sku: b.sku !== undefined ? String(b.sku).trim() : v.sku,
      price: b.price !== undefined ? (b.price === '' ? null : intShillings(b.price)) : v.price,
      cost: b.cost !== undefined ? (b.cost === '' ? null : intShillings(b.cost)) : v.cost,
      wholesale_price: b.wholesale_price !== undefined ? (b.wholesale_price === '' ? null : intShillings(b.wholesale_price)) : v.wholesale_price,
      member_price: b.member_price !== undefined ? (b.member_price === '' ? null : intShillings(b.member_price)) : v.member_price,
      tax_type: b.tax_type !== undefined ? (b.tax_type || null) : v.tax_type,
      kra_item_code: b.kra_item_code !== undefined ? String(b.kra_item_code || '').trim() : v.kra_item_code,
      meta: b.meta !== undefined ? (typeof b.meta === 'object' && b.meta ? JSON.stringify(b.meta) : (b.meta || v.meta)) : v.meta,
      active: b.active !== undefined ? (b.active ? 1 : 0) : v.active
    };
    if (patch.price === null && b.price !== undefined && b.price !== '') return res.status(400).json({ error: 'variant price must be a whole number of shillings' });
    // R-PR1 + R-PR3: guard and history for the variant's concrete prices (NULL = inherit, not a price)
    const vPriceChanges = [
      ['price', v.price, patch.price],
      ['wholesale_price', v.wholesale_price, patch.wholesale_price],
      ['member_price', v.member_price, patch.member_price]
    ].filter(([, o, n]) => o !== n && n !== null);
    const vCost = (patch.cost !== v.cost && patch.cost != null) ? patch.cost : (v.cost != null ? v.cost : product.cost);
    let approver = null;
    for (const [field, , newPrice] of vPriceChanges) {
      const g = marginGuard(req, product, null, newPrice, vCost);
      if (g && g.status) return res.status(g.status).json({ code: g.code, error: g.error });
      if (g && g.approver) approver = g.approver;
    }
    d.prepare(
      `UPDATE variants SET name = ?, sku = ?, price = ?, cost = ?, wholesale_price = ?, member_price = ?,
        tax_type = ?, kra_item_code = ?, meta = ?, active = ?, updated_at = ? WHERE id = ?`
    ).run(patch.name, patch.sku, patch.price, patch.cost, patch.wholesale_price, patch.member_price,
      patch.tax_type, patch.kra_item_code, patch.meta, patch.active, new Date().toISOString(), v.id);
    for (const [field, oldPrice, newPrice] of vPriceChanges) {
      priceHist(product, { variantId: v.id, scope: 'variant', field, oldPrice, newPrice, user: req.user, approver });
    }
    if (patch.active === 0) {
      d.prepare('UPDATE variant_barcodes SET active = 0 WHERE variant_id = ?').run(v.id);
      d.prepare('UPDATE packs SET active = 0 WHERE variant_id = ?').run(v.id);
    }
    dbm.audit(d, { userId: req.user.id, action: 'variant/update', entity: 'variant', entityId: String(v.id), detail: { keys: Object.keys(b), active: patch.active } });
    res.json({ ok: true });
  });

  app.delete('/api/variants/:id', me, can('products.manage'), (req, res) => {
    const v = d.prepare('SELECT * FROM variants WHERE id = ?').get(numOrNull(req.params.id));
    if (!v) return res.status(404).json({ error: 'not found' });
    if (v.axes_key === '{}' && activeVariantsOf(d, v.product_id).length === 1) {
      return res.status(400).json({ error: 'cannot remove the base variant — deactivate it instead' });
    }
    const now = new Date().toISOString();
    d.prepare('UPDATE variants SET active = 0, updated_at = ? WHERE id = ?').run(now, v.id);
    d.prepare('UPDATE variant_barcodes SET active = 0 WHERE variant_id = ?').run(v.id);
    d.prepare('UPDATE packs SET active = 0 WHERE variant_id = ?').run(v.id);
    dbm.audit(d, { userId: req.user.id, action: 'variant/delete', entity: 'variant', entityId: String(v.id), detail: { name: v.name } });
    res.json({ ok: true });
  });

  // ---- variant barcodes (1..N per variant; globally unique while active) -------------------------
  app.post('/api/variants/:id/barcodes', me, can('products.manage'), (req, res) => {
    const v = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(req.params.id));
    if (!v) return res.status(404).json({ error: 'variant not found' });
    const b = req.body || {};
    const barcode = String(b.barcode || '').trim();
    if (!barcode) return res.status(400).json({ error: 'barcode required' });
    if (d.prepare('SELECT id FROM variant_barcodes WHERE barcode = ? AND active = 1').get(barcode)) {
      return res.status(409).json({ error: 'barcode already in use' });
    }
    const kind = b.kind === 'pack' ? 'pack' : 'unit';
    const d2 = d.prepare(`INSERT INTO variant_barcodes (variant_id, barcode, kind, pack_id, label, active) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(v.id, barcode, kind, b.pack_id || null, String(b.label || '').trim());
    dbm.audit(d, { userId: req.user.id, action: 'barcode/add', entity: 'variant', entityId: String(v.id), detail: { barcode, kind } });
    res.json({ ok: true, id: d2.lastInsertRowid });
  });

  app.delete('/api/variant-barcodes/:id', me, can('products.manage'), (req, res) => {
    const row = d.prepare('SELECT * FROM variant_barcodes WHERE id = ?').get(numOrNull(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    d.prepare('UPDATE variant_barcodes SET active = 0 WHERE id = ?').run(row.id);
    dbm.audit(d, { userId: req.user.id, action: 'barcode/remove', entity: 'variant', entityId: String(row.variant_id), detail: { barcode: row.barcode } });
    res.json({ ok: true });
  });

  // ---- packs (named multiples of the base unit; own barcode + price, same stock) -----------------
  app.post('/api/variants/:id/packs', me, can('products.manage'), (req, res) => {
    const v = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(req.params.id));
    if (!v) return res.status(404).json({ error: 'variant not found' });
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const multiple = Math.trunc(Number(b.multiple));
    const price = intShillings(b.price);
    if (!name) return res.status(400).json({ error: 'pack name required' });
    if (!Number.isInteger(multiple) || multiple < 1) return res.status(400).json({ error: 'multiple must be a positive integer' });
    if (price === null) return res.status(400).json({ error: 'pack price must be a whole number of shillings' });
    if (d.prepare('SELECT id FROM packs WHERE variant_id = ? AND name = ?').get(v.id, name)) {
      return res.status(409).json({ error: 'a pack with this name already exists' });
    }
    const barcode = String(b.barcode || '').trim();
    if (barcode && d.prepare('SELECT id FROM variant_barcodes WHERE barcode = ? AND active = 1').get(barcode)) {
      return res.status(409).json({ error: 'barcode already in use' });
    }
    const product = productRow(d, v.product_id);
    const packCost = intShillings(b.cost) || 0;
    const g = marginGuard(req, product, null, price, packCost > 0 ? packCost : Number(v.cost != null ? v.cost : product.cost || 0) * multiple);
    if (g && g.status) return res.status(g.status).json({ code: g.code, error: g.error });
    const run = d.transaction(() => {
      const pid = d
        .prepare(`INSERT INTO packs (variant_id, name, multiple, unit, price, cost, description, active, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(v.id, name, multiple, String(b.unit || '').trim(), price, packCost, String(b.description || '').trim(), new Date().toISOString())
        .lastInsertRowid;
      if (barcode) {
        d.prepare(`INSERT INTO variant_barcodes (variant_id, barcode, kind, pack_id, label, active) VALUES (?, ?, 'pack', ?, ?, 1)`)
          .run(v.id, barcode, pid, name);
      }
      priceHist(product, { variantId: v.id, packId: pid, scope: 'pack', oldPrice: null, newPrice: price, user: req.user, approver: g && g.approver });
      return pid;
    });
    const pid = run();
    dbm.audit(d, { userId: req.user.id, action: 'pack/create', entity: 'pack', entityId: String(pid), detail: { variant: v.id, name, multiple, price } });
    res.json({ ok: true, id: pid });
  });

  app.put('/api/packs/:id', me, can('products.manage'), (req, res) => {
    const p = d.prepare('SELECT * FROM packs WHERE id = ?').get(numOrNull(req.params.id));
    if (!p) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const price = b.price !== undefined ? intShillings(b.price) : null;
    if (b.price !== undefined && price === null) return res.status(400).json({ error: 'pack price must be a whole number of shillings' });
    let approver = null;
    if (b.price !== undefined) {
      const v = d.prepare('SELECT * FROM variants WHERE id = ?').get(p.variant_id);
      const product = productRow(d, v.product_id);
      const newCost = b.cost !== undefined ? (intShillings(b.cost) || 0) : p.cost;
      const g = marginGuard(req, product, null, price, newCost > 0 ? newCost : Number(v.cost != null ? v.cost : product.cost || 0) * p.multiple);
      if (g && g.status) return res.status(g.status).json({ code: g.code, error: g.error });
      approver = g && g.approver;
      priceHist(product, { variantId: v.id, packId: p.id, scope: 'pack', field: 'price', oldPrice: p.price, newPrice: price, user: req.user, approver });
    }
    d.prepare(
      `UPDATE packs SET name = ?, multiple = ?, unit = ?, price = ?, cost = ?, description = ?, active = ? WHERE id = ?`
    ).run(
      b.name !== undefined ? String(b.name).trim() : p.name,
      b.multiple !== undefined ? Math.max(1, Math.trunc(Number(b.multiple) || p.multiple)) : p.multiple,
      b.unit !== undefined ? String(b.unit).trim() : p.unit,
      price === null ? p.price : price,
      b.cost !== undefined ? (intShillings(b.cost) || 0) : p.cost,
      b.description !== undefined ? String(b.description).trim() : p.description,
      b.active !== undefined ? (b.active ? 1 : 0) : p.active,
      p.id
    );
    dbm.audit(d, { userId: req.user.id, action: 'pack/update', entity: 'pack', entityId: String(p.id), detail: { keys: Object.keys(b) } });
    res.json({ ok: true });
  });

  app.delete('/api/packs/:id', me, can('products.manage'), (req, res) => {
    const p = d.prepare('SELECT * FROM packs WHERE id = ?').get(numOrNull(req.params.id));
    if (!p) return res.status(404).json({ error: 'not found' });
    d.prepare('UPDATE packs SET active = 0 WHERE id = ?').run(p.id);
    d.prepare('UPDATE variant_barcodes SET active = 0 WHERE pack_id = ? AND kind = \'pack\'').run(p.id);
    dbm.audit(d, { userId: req.user.id, action: 'pack/delete', entity: 'pack', entityId: String(p.id), detail: { name: p.name } });
    res.json({ ok: true });
  });

  // ---- barcode scan resolution (R-P3: one server call) --------------------------------------------
  app.get('/api/scan/:barcode', me, (req, res) => {
    const out = resolveBarcode(d, req.user, req.params.barcode);
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });

  // ---- batches (FEFO foundation; immutable lots — qty only changes via moves) ---------------------
  app.get('/api/batches', me, (req, res) => {
    const q = req.query;
    const where = [];
    const args = [];
    // R-2: batches are branch stock
    if (req.user.role !== 'owner') {
      const vis = visibleBranches(d, req.user).map((b) => b.id);
      where.push(`b.branch_id IN (${vis.map(() => '?').join(',')})`);
      args.push(...vis);
    }
    if (q.variant_id) { where.push('b.variant_id = ?'); args.push(numOrNull(q.variant_id)); }
    else if (q.product_id) { where.push('b.product_id = ?'); args.push(numOrNull(q.product_id)); }
    else if (q.location_id) { where.push('b.location_id = ?'); args.push(numOrNull(q.location_id)); }
    if (q.expiring) {
      where.push("b.qty > 0 AND b.expiry_date IS NOT NULL AND date(b.expiry_date) <= date('now', '+' || ? || ' days')");
      args.push(Math.min(Math.max(Number(q.expiring) || 30, 1), 3650));
    } else if (q.open) {
      where.push('b.qty > 0');
    }
    const sql = `
      SELECT b.*, p.name AS product_name, v.name AS variant_name
        FROM batches b
        JOIN products p ON p.id = b.product_id
        LEFT JOIN variants v ON v.id = b.variant_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY b.expiry_date IS NULL, b.expiry_date ASC, b.id ASC
       LIMIT 500`;
    res.json(d.prepare(sql).all(...args));
  });

  app.post('/api/batches', me, can('stock.adjust'), (req, res) => {
    const b = req.body || {};
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be positive' });
    let variant = numOrNull(b.variant_id)
      ? d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(b.variant_id))
      : null;
    if (!variant && b.product_id) {
      const vs = activeVariantsOf(d, numOrNull(b.product_id));
      if (vs.length !== 1) return res.status(400).json({ error: 'specify variant_id' });
      variant = vs[0];
    }
    if (!variant) return res.status(400).json({ error: 'variant_id or product_id required' });
    const product = productRow(d, variant.product_id);
    if (!product || !product.active) return res.status(400).json({ error: 'unknown product' });
    if (!product.track_batches) return res.status(400).json({ error: 'product does not track batches' });
    const { branchId, locationId, error: scopeError } = stockScope(req.user, b);
    if (scopeError) return res.status(400).json({ error: scopeError });
    const run = d.transaction(() => {
      const bid = d
        .prepare(`INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(product.id, variant.id, branchId, locationId, String(b.batch_no || '').trim(), b.expiry_date || null, qty, intShillings(b.cost) || 0, new Date().toISOString())
        .lastInsertRowid;
      upsertStock(d, variant.id, locationId, qty);
      addStockMove(d, { product, variant, branchId, locationId, qty, type: 'opening', reason: 'opening', ref: 'BATCH', userId: req.user.id, note: `batch ${b.batch_no || ''}`.trim(), batchId: bid });
      return bid;
    });
    const bid = run();
    dbm.audit(d, { userId: req.user.id, branchId, action: 'batch/create', entity: 'batch', entityId: String(bid), detail: { product: product.name, batchNo: b.batch_no, qty, expiry: b.expiry_date || null } });
    res.json({ ok: true, id: bid });
  });

  // ---- serials (IMEI-style unit tracking) ----------------------------------------------------------
  app.get('/api/serials', me, (req, res) => {
    const q = req.query;
    const where = [];
    const args = [];
    if (q.variant_id) { where.push('s.variant_id = ?'); args.push(numOrNull(q.variant_id)); }
    if (q.product_id) { where.push('s.variant_id IN (SELECT id FROM variants WHERE product_id = ?)'); args.push(numOrNull(q.product_id)); }
    if (q.status) { where.push('s.status = ?'); args.push(q.status); }
    const sql = `
      SELECT s.*, p.name AS product_name, v.name AS variant_name
        FROM serials s
        JOIN variants v ON v.id = s.variant_id
        JOIN products p ON p.id = v.product_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.id DESC LIMIT 500`;
    res.json(d.prepare(sql).all(...args));
  });

  app.post('/api/serials', me, can('stock.adjust'), (req, res) => {
    const b = req.body || {};
    const serialNo = String(b.serial_no || '').trim();
    if (!serialNo) return res.status(400).json({ error: 'serial_no required' });
    let variant = numOrNull(b.variant_id)
      ? d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(b.variant_id))
      : null;
    if (!variant && b.product_id) {
      const vs = activeVariantsOf(d, numOrNull(b.product_id));
      if (vs.length !== 1) return res.status(400).json({ error: 'specify variant_id' });
      variant = vs[0];
    }
    if (!variant) return res.status(400).json({ error: 'variant_id or product_id required' });
    const product = productRow(d, variant.product_id);
    if (!product || !product.active) return res.status(400).json({ error: 'unknown product' });
    if (!product.track_serials) return res.status(400).json({ error: 'product does not track serials' });
    if (d.prepare('SELECT id FROM serials WHERE variant_id = ? AND serial_no = ?').get(variant.id, serialNo)) {
      return res.status(409).json({ error: 'serial already registered for this product' });
    }
    const { branchId, locationId, error: scopeError } = stockScope(req.user, b);
    if (scopeError) return res.status(400).json({ error: scopeError });
    const run = d.transaction(() => {
      const sid = d
        .prepare(`INSERT INTO serials (variant_id, serial_no, location_id, status, note, created_at)
                  VALUES (?, ?, ?, 'in_stock', ?, ?)`)
        .run(variant.id, serialNo, locationId, String(b.note || ''), new Date().toISOString())
        .lastInsertRowid;
      upsertStock(d, variant.id, locationId, 1);
      addStockMove(d, { product, variant, branchId, locationId, qty: 1, type: 'opening', reason: 'opening', ref: 'SERIAL', userId: req.user.id, note: serialNo });
      return sid;
    });
    const sid = run();
    dbm.audit(d, { userId: req.user.id, branchId, action: 'serial/register', entity: 'serial', entityId: String(sid), detail: { product: product.name, serialNo } });
    res.json({ ok: true, id: sid });
  });

  app.post('/api/serials/:id/writeoff', me, can('stock.adjust'), (req, res) => {
    const s = d.prepare('SELECT * FROM serials WHERE id = ?').get(numOrNull(req.params.id));
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.status !== 'in_stock') return res.status(400).json({ error: `serial is ${s.status}, cannot write off` });
    const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(s.variant_id);
    const product = productRow(d, variant.product_id);
    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    if (!s.location_id) return res.status(400).json({ error: 'serial has no location' });
    try {
      d.transaction(() => {
        d.prepare("UPDATE serials SET status = 'writeoff' WHERE id = ?").run(s.id);
        writeMove(d, {
          product, variant, branchId, locationId: s.location_id, qty: -1,
          type: 'adjustment', reason: 'other', ref: 'SERIAL:' + s.id,
          serialId: s.id, userId: req.user.id, note: `serial writeoff ${s.serial_no}`
        });
      })();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, { userId: req.user.id, branchId, action: 'serial/writeoff', entity: 'serial', entityId: String(s.id), detail: { product: product.name, serialNo: s.serial_no, note: String((req.body || {}).note || '') } });
    res.json({ ok: true });
  });

  // ---- custom attribute definitions (module hooks land on these, Phase 18) -------------------------
  app.get('/api/attribute-defs', me, (req, res) => {
    res.json(d.prepare('SELECT * FROM attribute_defs WHERE active = 1 ORDER BY key').all());
  });

  app.post('/api/attribute-defs', me, can('products.manage'), (req, res) => {
    const p = req.body || {};
    const key = String(p.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    const label = String(p.label || '').trim() || key;
    if (!key) return res.status(400).json({ error: 'key required' });
    const type = ['text', 'number', 'select', 'boolean'].includes(p.type) ? p.type : 'text';
    const applies = p.applies_to === 'product' ? 'product' : 'variant';
    if (d.prepare('SELECT id FROM attribute_defs WHERE business_id = 1 AND key = ?').get(key)) {
      return res.status(409).json({ error: 'attribute key already exists' });
    }
    const id = d
      .prepare(`INSERT INTO attribute_defs (key, label, label_sw, type, options, applies_to, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(key, label, String(p.label_sw || '').trim(), type, String(p.options || '').trim(), applies, new Date().toISOString())
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'attribute/create', entity: 'attribute', entityId: String(id), detail: { key, type } });
    res.json({ ok: true, id });
  });

  app.put('/api/attribute-defs/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM attribute_defs WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    d.prepare(
      `UPDATE attribute_defs SET label = ?, label_sw = ?, type = ?, options = ?, applies_to = ?, active = ? WHERE id = ?`
    ).run(
      b.label !== undefined ? String(b.label).trim() : cur.label,
      b.label_sw !== undefined ? String(b.label_sw).trim() : cur.label_sw,
      b.type !== undefined && ['text', 'number', 'select', 'boolean'].includes(b.type) ? b.type : cur.type,
      b.options !== undefined ? String(b.options).trim() : cur.options,
      b.applies_to === 'product' ? 'product' : (b.applies_to === 'variant' ? 'variant' : cur.applies_to),
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
      cur.id
    );
    res.json({ ok: true });
  });

  app.delete('/api/attribute-defs/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM attribute_defs WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    d.prepare('UPDATE attribute_defs SET active = 0 WHERE id = ?').run(cur.id);
    dbm.audit(d, { userId: req.user.id, action: 'attribute/delete', entity: 'attribute', entityId: String(cur.id), detail: { key: cur.key } });
    res.json({ ok: true });
  });

  // ---- suppliers (minimal; the full purchasing system lands in Phase 5) ----------------------------
  // ---- suppliers + purchasing (Phase 5) ---------------------------------------------------
  const supplierBalance = (supplierId, branchId) => {
    const branchFilter = branchId ? ' AND branch_id = ?' : '';
    const bArgs = branchId ? [branchId] : [];
    const inv = d.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(CASE WHEN status = 'paid' THEN 0 ELSE amount END), 0) AS open_total
         FROM supplier_invoices WHERE supplier_id = ?${branchFilter}`
    ).get(supplierId, ...bArgs);
    const paid = d.prepare(
      `SELECT COALESCE(SUM(ip.amount), 0) AS p FROM invoice_payments ip
        JOIN supplier_invoices si ON si.id = ip.invoice_id
       WHERE si.supplier_id = ?${branchFilter ? ' AND si.branch_id = ?' : ''}`
    ).get(supplierId, ...bArgs).p;
    const pos = d.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS v FROM purchase_orders
        WHERE supplier_id = ? AND status IN ('sent','partial')${branchFilter}`
    ).get(supplierId, ...bArgs);
    // net owed = Σ(all invoice amounts) − Σ(all payments); settled invoices net to zero
    return {
      invoices_total: inv.total, invoices_open: inv.open_total, paid: Number(paid),
      outstanding: Number(inv.total - paid), open_pos: pos.n, open_po_value: pos.v,
      branch_id: branchId || null
    };
  };

  // Enhanced: ?branch_id= filters supplier balances to that branch (Day 17)
  app.get('/api/suppliers', me, (req, res) => {
    const branchId = numOrNull(req.query.branch_id);
    const rows = d.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all();
    res.json(rows.map((s) => ({ ...s, balance: supplierBalance(s.id, branchId) })));
  });

  app.post('/api/suppliers', me, can('products.manage'), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'supplier name required' });
    const lead = b.lead_days === undefined ? 7 : Math.max(0, Math.trunc(Number(b.lead_days) || 0));
    const id = d
      .prepare(`INSERT INTO suppliers (name, phone, kra_pin, address, terms, lead_days, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(name, String(b.phone || '').trim(), String(b.kraPin || '').trim(), String(b.address || '').trim(), String(b.terms || '').trim(), lead, new Date().toISOString())
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'supplier/create', entity: 'supplier', entityId: String(id), detail: { name } });
    res.json({ ok: true, id });
  });

  app.put('/api/suppliers/:id', me, can('products.manage'), (req, res) => {
    const s = d.prepare('SELECT * FROM suppliers WHERE id = ?').get(numOrNull(req.params.id));
    if (!s) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    d.prepare(
      `UPDATE suppliers SET name = ?, phone = ?, kra_pin = ?, address = ?, terms = ?, lead_days = ?, active = ? WHERE id = ?`
    ).run(
      String(b.name ?? s.name).trim(), String(b.phone ?? s.phone).trim(), String(b.kraPin ?? s.kra_pin).trim(),
      String(b.address ?? s.address).trim(), String(b.terms ?? s.terms).trim(),
      b.lead_days === undefined ? s.lead_days : Math.max(0, Math.trunc(Number(b.lead_days) || 0)),
      b.active === undefined ? s.active : (b.active ? 1 : 0), s.id
    );
    res.json({ ok: true });
  });

  app.delete('/api/suppliers/:id', me, can('products.manage'), (req, res) => {
    const s = d.prepare('SELECT * FROM suppliers WHERE id = ?').get(numOrNull(req.params.id));
    if (!s) return res.status(404).json({ error: 'not found' });
    const bal = supplierBalance(s.id);
    if (bal.open_pos > 0) return res.status(400).json({ error: 'supplier has open purchase orders' });
    if (bal.outstanding > 0) return res.status(400).json({ error: 'supplier has outstanding invoices' });
    d.prepare('UPDATE suppliers SET active = 0 WHERE id = ?').run(s.id);
    res.json({ ok: true });
  });

  app.get('/api/suppliers/:id', me, (req, res) => {
    const s = d.prepare('SELECT * FROM suppliers WHERE id = ?').get(numOrNull(req.params.id));
    if (!s) return res.status(404).json({ error: 'not found' });
    const products = d.prepare('SELECT COUNT(*) AS n FROM products WHERE supplier_id = ? AND active = 1').get(s.id).n;
    res.json({ ...s, balance: supplierBalance(s.id), products });
  });

  // Purchasing is a capability (R-C): a solo shop that hasn't enabled it gets a hint, not a wall of features.
  const needPurchasing = (req, res) => {
    if (!caps.getCapabilityMap(d).purchasing) {
      res.status(403).json({ error: 'enable the Purchasing feature first (Settings → Features)' });
      return false;
    }
    return true;
  };

  // ---- suggested orders: velocity × (lead + cover) − stock ---------------------------------
  app.get('/api/purchase/suggestions', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const cover = Math.min(Math.max(Number(req.query.cover ?? 14), 0), 365);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    const rows = d
      .prepare(
        `SELECT p.id AS product_id, p.name AS product_name, p.unit, p.cost AS current_cost, s.id AS supplier_id,
                s.name AS supplier_name, COALESCE(s.lead_days, 7) AS lead_days,
                (SELECT COALESCE(SUM(st.qty), 0) FROM variants v JOIN stock st ON st.variant_id = v.id
                  WHERE v.product_id = p.id AND v.active = 1) AS stock,
                (SELECT COALESCE(SUM(m.qty), 0) FROM variants v JOIN stock_moves m ON m.variant_id = v.id
                  WHERE v.product_id = p.id AND m.type = 'sale' AND m.created_at >= ?) AS sold
           FROM products p
           JOIN suppliers s ON s.id = p.supplier_id AND s.active = 1
          WHERE p.active = 1
          ORDER BY p.name`
      )
      .all(since);
    const out = [];
    for (const r of rows) {
      const velocity = r.sold / days;
      if (velocity <= 0) continue; // nothing has moved → nothing to suggest
      const daysCover = r.stock / velocity;
      const suggestQty = Math.ceil(velocity * (r.lead_days + cover) - r.stock);
      if (suggestQty <= 0) continue;
      out.push({
        product_id: r.product_id, product_name: r.product_name, unit: r.unit, current_cost: r.current_cost,
        supplier_id: r.supplier_id, supplier_name: r.supplier_name, lead_days: r.lead_days,
        stock: r.stock, sold_days: days, sold: r.sold,
        velocity_per_day: Math.round(velocity * 100) / 100,
        days_cover: Math.round(daysCover * 10) / 10,
        cover_days: cover, suggest_qty: suggestQty
      });
    }
    out.sort((a, b) => a.days_cover - b.days_cover); // most urgent first
    res.json(out.slice(0, limit));
  });

  // ---- purchase orders ---------------------------------------------------------------------
  app.post('/api/purchase-orders', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const b = req.body || {};
    const supplier = d.prepare('SELECT * FROM suppliers WHERE id = ? AND active = 1').get(numOrNull(b.supplier_id));
    if (!supplier) return res.status(400).json({ error: 'supplier_id required (active)' });
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return res.status(400).json({ error: 'items required' });
    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    const t = new Date().toISOString();
    let created;
    try {
      created = d.transaction(() => {
        const poRef = dbm.nextCounter(d, 'po', 'PO-');
        const poId = d
          .prepare(`INSERT INTO purchase_orders (ref, branch_id, supplier_id, status, expected_date, note, total, created_by, created_at)
                    VALUES (?, ?, ?, 'sent', ?, ?, 0, ?, ?)`)
          .run(poRef, branchId, supplier.id, b.expected_date || null, String(b.note || ''), req.user.id, t)
          .lastInsertRowid;
        let total = 0;
        for (const it of items) {
          let variant = numOrNull(it.variant_id)
            ? d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(it.variant_id))
            : null;
          let productId = numOrNull(it.product_id);
          if (variant) productId = variant.product_id;
          if (!variant && productId) {
            const vs = activeVariantsOf(d, productId);
            if (vs.length !== 1) throw httpError(400, 'product has multiple variants — specify variant_id');
            variant = vs[0];
          }
          if (!variant) throw httpError(400, 'unknown variant/product in items');
          const product = productRow(d, productId);
          if (!product || !product.active) throw httpError(400, 'unknown product in items');
          const qty = Number(it.qty);
          if (!Number.isFinite(qty) || qty <= 0) throw httpError(400, 'item qty must be > 0');
          const unitCost = intShillings(it.unit_cost) ?? Number(product.cost || 0);
          d.prepare('INSERT INTO po_items (po_id, product_id, variant_id, qty, unit_cost) VALUES (?, ?, ?, ?, ?)')
            .run(poId, productId, variant.id, qty, unitCost);
          total += Math.round(qty * unitCost);
        }
        d.prepare('UPDATE purchase_orders SET total = ? WHERE id = ?').run(total, poId);
        return d.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
      })();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, { userId: req.user.id, branchId, action: 'po/create', entity: 'purchase_order', entityId: created.ref, detail: { supplier: supplier.name, items: items.length, total: created.total } });
    res.json({ ok: true, id: created.id, ref: created.ref, total: created.total });
  });

  app.get('/api/purchase-orders', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const q = req.query;
    const where = [];
    const args = [];
    if (q.status) { where.push('po.status = ?'); args.push(String(q.status)); }
    if (q.supplier_id) { where.push('po.supplier_id = ?'); args.push(numOrNull(q.supplier_id)); }
    res.json(
      d.prepare(
        `SELECT po.*, s.name AS supplier_name,
                (SELECT COUNT(*) FROM po_items pi WHERE pi.po_id = po.id) AS items,
                (SELECT COALESCE(SUM(pi.received_qty), 0) FROM po_items pi WHERE pi.po_id = po.id) AS received,
                (SELECT COALESCE(SUM(pi.qty), 0) FROM po_items pi WHERE pi.po_id = po.id) AS ordered
           FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY po.id DESC LIMIT 100`
      ).all(...args)
    );
  });

  app.get('/api/purchase-orders/:id', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const po = d.prepare('SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?').get(numOrNull(req.params.id));
    if (!po) return res.status(404).json({ error: 'not found' });
    const items = d
      .prepare(
        `SELECT pi.*, p.name AS product_name, v.name AS variant_name, p.unit
           FROM po_items pi
           JOIN products p ON p.id = pi.product_id
           LEFT JOIN variants v ON v.id = pi.variant_id
          WHERE pi.po_id = ? ORDER BY pi.id`
      )
      .all(po.id);
    const grs = d.prepare(
      `SELECT gr.*, (SELECT COALESCE(SUM(gi.qty), 0) FROM gr_items gi WHERE gi.gr_id = gr.id) AS total_qty
         FROM goods_receipts gr WHERE gr.po_id = ? ORDER BY gr.id`
    ).all(po.id);
    res.json({ ...po, items, receipts: grs });
  });

  app.post('/api/purchase-orders/:id/cancel', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const po = d.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(numOrNull(req.params.id));
    if (!po) return res.status(404).json({ error: 'not found' });
    if (!['sent', 'partial'].includes(po.status)) return res.status(400).json({ error: `cannot cancel a ${po.status} PO` });
    const received = d.prepare('SELECT COALESCE(SUM(received_qty), 0) AS q FROM po_items WHERE po_id = ?').get(po.id).q;
    if (received > 0) return res.status(400).json({ error: 'goods already received — use supplier returns, not cancel' });
    d.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(po.id);
    dbm.audit(d, { userId: req.user.id, action: 'po/cancel', entity: 'purchase_order', entityId: po.ref });
    res.json({ ok: true });
  });

  // Goods received against a PO: partial ok, batch/serial capture, cost recorded per lot.
  app.post('/api/purchase-orders/:id/receive', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const po = d.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(numOrNull(req.params.id));
    if (!po) return res.status(404).json({ error: 'not found' });
    if (!['sent', 'partial'].includes(po.status)) return res.status(400).json({ error: `PO is ${po.status}` });
    const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items required' });
    const loc = defaultLocation(d, po.branch_id);
    if (!loc) return res.status(400).json({ error: 'branch has no location' });
    const t = new Date().toISOString();
    let result;
    try {
      result = d.transaction(() => {
        const grRef = dbm.nextCounter(d, 'gr', 'GR-');
        const grId = d
          .prepare('INSERT INTO goods_receipts (ref, po_id, branch_id, supplier_id, total, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
          .run(grRef, po.id, po.branch_id, po.supplier_id, req.user.id, t)
          .lastInsertRowid;
        let grTotal = 0;
        const discrepancies = [];
        for (const it of items) {
          const pi = d.prepare('SELECT * FROM po_items WHERE id = ? AND po_id = ?').get(numOrNull(it.po_item_id), po.id);
          if (!pi) throw httpError(400, `po_item ${it.po_item_id} not on this PO`);
          const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(pi.variant_id);
          const product = productRow(d, pi.product_id);
          const qty = Number(it.qty);
          if (!Number.isFinite(qty) || qty <= 0) throw httpError(400, 'item qty must be > 0');
          const remaining = pi.qty - pi.received_qty;
          const over = qty > remaining + 1e-9;
          const cost = intShillings(it.cost) ?? pi.unit_cost;
          const priceDisc = cost > pi.unit_cost;
          let batchId = null;
          if (product.track_batches) {
            // lot is opened at 0 — writeMove adds the received qty (single writer of batch balances)
            const batchNo = String(it.batch_no || `${po.ref}-I${pi.id}`).trim();
            const expiry = it.expiry_date || null;
            batchId = d
              .prepare(`INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
              .run(product.id, variant.id, po.branch_id, loc.id, batchNo, expiry, cost, t)
              .lastInsertRowid;
          }
          // serials: each unit arrives with its number (one move per unit)
          const serials = it.serial_no ? [it.serial_no] : (Array.isArray(it.serials) ? it.serials : []);
          if (product.track_serials && (!Number.isInteger(qty) || serials.length !== qty)) {
            throw httpError(400, 'serial-tracked items need one serial number per whole unit');
          }
          if (serials.length) {
            for (const sn of serials) {
              const serialId = d
                .prepare(`INSERT INTO serials (variant_id, serial_no, location_id, status, note, created_at)
                          VALUES (?, ?, ?, 'in_stock', ?, ?)`)
                .run(variant.id, String(sn).trim(), loc.id, po.ref, t)
                .lastInsertRowid;
              writeMove(d, {
                product, variant, branchId: po.branch_id, locationId: loc.id, qty: 1,
                type: 'purchase', reason: 'purchase', ref: po.ref, serialId,
                unitCost: cost, userId: req.user.id, note: 'goods received'
              });
            }
          } else {
            writeMove(d, {
              product, variant, branchId: po.branch_id, locationId: loc.id, qty,
              type: 'purchase', reason: 'purchase', ref: po.ref, batchId,
              unitCost: cost, userId: req.user.id, note: 'goods received'
            });
          }
          const writeQty = qty;
          d.prepare('INSERT INTO gr_items (gr_id, po_id, product_id, variant_id, qty, unit_cost, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(grId, po.id, pi.product_id, pi.variant_id, writeQty, cost, batchId);
          d.prepare('UPDATE po_items SET received_qty = received_qty + ? WHERE id = ?').run(writeQty, pi.id);
          if (over || priceDisc) {
            d.prepare("UPDATE po_items SET discrepancy = ?, discrepancy_status = 'pending' WHERE id = ?")
              .run(over ? 'over_qty' : 'price', pi.id);
            discrepancies.push({ po_item_id: pi.id, product: product.name, kind: over ? 'over_qty' : 'price', detail: over ? `received ${writeQty} of ${remaining} remaining` : `cost ${cost} > PO ${pi.unit_cost}` });
          }
          grTotal += Math.round(writeQty * cost);
        }
        d.prepare('UPDATE goods_receipts SET total = ? WHERE id = ?').run(grTotal, grId);
        const done = d.prepare('SELECT COUNT(*) AS n FROM po_items WHERE po_id = ? AND received_qty < qty - 0.0000001').get(po.id).n;
        d.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?").run(done ? 'partial' : 'received', po.id);
        return { grRef, discrepancies };
      })();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, { userId: req.user.id, action: 'po/receive', entity: 'purchase_order', entityId: po.ref, detail: { gr: result.grRef, discrepancies: result.discrepancies.length } });
    res.json({ ok: true, ref: result.grRef, discrepancies: result.discrepancies });
  });

  // Discrepancy resolution (R-S5-ish honesty): approve accepts it; rejecting an
  // over-receipt sends the excess back to the supplier as a return.
  app.post('/api/po-items/:id/discrepancy', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const pi = d.prepare('SELECT * FROM po_items WHERE id = ?').get(numOrNull(req.params.id));
    if (!pi) return res.status(404).json({ error: 'not found' });
    if (!pi.discrepancy || pi.discrepancy_status !== 'pending') return res.status(400).json({ error: 'no pending discrepancy' });
    const decision = (req.body || {}).decision;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
    const po = d.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(pi.po_id);
    if (decision === 'approve') {
      d.prepare("UPDATE po_items SET discrepancy_status = 'approved' WHERE id = ?").run(pi.id);
      dbm.audit(d, { userId: req.user.id, action: 'po/discrepancy_approve', entity: 'purchase_order', entityId: po.ref, detail: { po_item_id: pi.id, kind: pi.discrepancy } });
      return res.json({ ok: true, decision: 'approved' });
    }
    // reject
    const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(pi.variant_id);
    const product = productRow(d, pi.product_id);
    const t = new Date().toISOString();
    try {
      d.transaction(() => {
        if (pi.discrepancy === 'over_qty') {
          const over = Math.round((pi.received_qty - pi.qty) * 1e6) / 1e6;
          const srRef = dbm.nextCounter(d, 'sr', 'SR-');
          d.prepare('INSERT INTO supplier_returns (ref, supplier_id, po_id, variant_id, product_id, qty, unit_cost, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(srRef, po.supplier_id, po.id, pi.variant_id, pi.product_id, over, pi.unit_cost, 'over-receipt rejected', req.user.id, t);
          const loc = defaultLocation(d, po.branch_id);
          writeMove(d, {
            product, variant, branchId: po.branch_id, locationId: loc.id, qty: -over,
            type: 'return_out', reason: 'return_out', ref: srRef,
            userId: req.user.id, note: 'over-receipt returned to supplier'
          });
          d.prepare('UPDATE po_items SET received_qty = qty WHERE id = ?').run(pi.id);
        }
        d.prepare("UPDATE po_items SET discrepancy_status = 'rejected' WHERE id = ?").run(pi.id);
      })();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, { userId: req.user.id, action: 'po/discrepancy_reject', entity: 'purchase_order', entityId: po.ref, detail: { po_item_id: pi.id, kind: pi.discrepancy } });
    res.json({ ok: true, decision: 'rejected' });
  });

  // ---- supplier invoices & payments ----------------------------------------------------------
  app.post('/api/supplier-invoices', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const b = req.body || {};
    const supplier = d.prepare('SELECT id FROM suppliers WHERE id = ? AND active = 1').get(numOrNull(b.supplier_id));
    if (!supplier) return res.status(400).json({ error: 'supplier_id required (active)' });
    const amount = intShillings(b.amount);
    if (amount === null || amount <= 0) return res.status(400).json({ error: 'amount required (whole shillings, > 0)' });
    let poId = null;
    if (b.po_id) {
      const po = d.prepare('SELECT id FROM purchase_orders WHERE id = ? AND supplier_id = ?').get(numOrNull(b.po_id), supplier.id);
      if (!po) return res.status(400).json({ error: 'po_id does not belong to this supplier' });
      poId = po.id;
    }
    const vat = intShillings(b.vat) || 0;
    const ref = dbm.nextCounter(d, 'inv', 'INV-');
    const t = new Date().toISOString();
    const id = d
      .prepare(`INSERT INTO supplier_invoices (ref, supplier_ref, supplier_id, po_id, amount, vat, paid, outstanding, status, due_date, note, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'open', ?, ?, ?, ?)`)
      .run(ref, String(b.supplier_ref || '').trim(), supplier.id, poId, amount, vat, amount, b.due_date || null, String(b.note || ''), req.user.id, t)
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'invoice/create', entity: 'supplier_invoice', entityId: ref, detail: { supplier: supplier.id, amount, po: poId } });
    res.json({ ok: true, id, ref });
  });

  app.get('/api/supplier-invoices', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const q = req.query;
    const where = [];
    const args = [];
    if (q.supplier_id) { where.push('si.supplier_id = ?'); args.push(numOrNull(q.supplier_id)); }
    if (q.status) { where.push('si.status = ?'); args.push(String(q.status)); }
    res.json(
      d.prepare(
        `SELECT si.*, s.name AS supplier_name, po.ref AS po_ref,
                (SELECT COALESCE(SUM(ip.amount), 0) FROM invoice_payments ip WHERE ip.invoice_id = si.id) AS paid
           FROM supplier_invoices si
           JOIN suppliers s ON s.id = si.supplier_id
           LEFT JOIN purchase_orders po ON po.id = si.po_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY si.id DESC LIMIT 100`
      ).all(...args)
    );
  });

  app.get('/api/supplier-invoices/:id', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const inv = d.prepare(
      `SELECT si.*, s.name AS supplier_name FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id WHERE si.id = ?`
    ).get(numOrNull(req.params.id));
    if (!inv) return res.status(404).json({ error: 'not found' });
    const payments = d.prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY id').all(inv.id);
    res.json({ ...inv, paid: payments.reduce((s, p) => s + p.amount, 0), payments });
  });

  app.put('/api/supplier-invoices/:id', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const inv = d.prepare('SELECT * FROM supplier_invoices WHERE id = ?').get(numOrNull(req.params.id));
    if (!inv) return res.status(404).json({ error: 'not found' });
    const status = (req.body || {}).status;
    if (status === undefined) return res.status(400).json({ error: 'status required' });
    if (!['open', 'partial', 'disputed', 'paid'].includes(status)) return res.status(400).json({ error: 'unknown status' });
    if (status === 'disputed' && !['open', 'partial'].includes(inv.status)) return res.status(400).json({ error: 'cannot dispute a paid invoice' });
    if (status === 'paid') return res.status(400).json({ error: 'use a payment to settle an invoice' });
    d.prepare('UPDATE supplier_invoices SET status = ? WHERE id = ?').run(status, inv.id);
    dbm.audit(d, { userId: req.user.id, action: 'invoice/status', entity: 'supplier_invoice', entityId: inv.ref, detail: { from: inv.status, to: status } });
    res.json({ ok: true });
  });

  app.post('/api/supplier-invoices/:id/payments', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const inv = d.prepare('SELECT * FROM supplier_invoices WHERE id = ?').get(numOrNull(req.params.id));
    if (!inv) return res.status(404).json({ error: 'not found' });
    if (inv.status === 'paid') return res.status(400).json({ error: 'invoice already paid' });
    if (inv.status === 'disputed') return res.status(400).json({ error: 'resolve the dispute before paying' });
    const b = req.body || {};
    const amount = intShillings(b.amount);
    if (amount === null || amount <= 0) return res.status(400).json({ error: 'amount required (whole shillings, > 0)' });
    const method = ['bank', 'mpesa', 'cash', 'cheque', 'other'].includes(b.method) ? b.method : null;
    if (!method) return res.status(400).json({ error: 'method required (bank/mpesa/cash/cheque/other)' });
    const channelRef = String(b.channel_ref || '').trim();
    if (!channelRef) return res.status(400).json({ error: 'channel_ref required — every payment leaves evidence' });
    if (amount > inv.outstanding) return res.status(400).json({ error: `overpayment: ${inv.outstanding} outstanding` });
    const t = new Date().toISOString();
    const run = d.transaction(() => {
      d.prepare('INSERT INTO invoice_payments (invoice_id, supplier_id, amount, method, channel_ref, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(inv.id, inv.supplier_id, amount, method, channelRef, String(b.note || ''), req.user.id, t);
      const done = inv.outstanding - amount <= 0.0000001;
      d.prepare('UPDATE supplier_invoices SET paid = paid + ?, outstanding = ?, status = ?, paid_at = ? WHERE id = ?')
        .run(amount, Math.max(0, inv.outstanding - amount), done ? 'paid' : 'partial', inv.paid_at || (done ? t : null), inv.id);
      return done;
    });
    const done = run();
    dbm.audit(d, { userId: req.user.id, action: 'invoice/payment', entity: 'supplier_invoice', entityId: inv.ref, detail: { amount, method, channel_ref: channelRef, settled: done } });
    res.json({ ok: true, settled: done });
  });

  // ---- supplier returns (standalone, e.g. defects / returns outside a PO) ----------------------
  app.post('/api/supplier-returns', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const b = req.body || {};
    const supplier = d.prepare('SELECT id FROM suppliers WHERE id = ? AND active = 1').get(numOrNull(b.supplier_id));
    if (!supplier) return res.status(400).json({ error: 'supplier_id required (active)' });
    let variant = numOrNull(b.variant_id)
      ? d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(numOrNull(b.variant_id))
      : null;
    let productId = numOrNull(b.product_id);
    if (variant) productId = variant.product_id;
    if (!variant && productId) {
      const vs = activeVariantsOf(d, productId);
      if (vs.length !== 1) return res.status(400).json({ error: 'product has multiple variants — specify variant_id' });
      variant = vs[0];
    }
    if (!variant) return res.status(400).json({ error: 'variant_id or product_id required' });
    const product = productRow(d, productId);
    if (!product || !product.active) return res.status(400).json({ error: 'unknown product' });
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be > 0' });
    const cost = intShillings(b.cost) ?? Number(product.cost || 0);
    const reason = String(b.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    const locs = branchId ? locationsOf(d, branchId) : [];
    const locationId = numOrNull(b.location_id) && locs.some((l) => l.id === b.location_id) ? b.location_id : (locs[0] && locs[0].id);
    if (!locationId) return res.status(400).json({ error: 'no location' });
    const t = new Date().toISOString();
    const ref = dbm.nextCounter(d, 'sr', 'SR-');
    try {
      d.transaction(() => {
        d.prepare('INSERT INTO supplier_returns (ref, supplier_id, po_id, variant_id, product_id, qty, unit_cost, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ref, supplier.id, numOrNull(b.po_id), variant.id, productId, qty, cost, reason, req.user.id, t);
        writeMove(d, {
          product, variant, branchId, locationId, qty: -qty,
          type: 'return_out', reason: 'return_out', ref, unitCost: cost,
          userId: req.user.id, note: `returned to supplier: ${reason}`
        });
      })();
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    dbm.audit(d, { userId: req.user.id, action: 'supplier/return', entity: 'supplier_return', entityId: ref, detail: { product: product.name, qty, reason } });
    res.json({ ok: true, ref });
  });

  app.get('/api/supplier-returns', me, can('purchases.manage'), (req, res) => {
    if (!needPurchasing(req, res)) return;
    const q = req.query;
    const where = [];
    const args = [];
    if (q.supplier_id) { where.push('sr.supplier_id = ?'); args.push(numOrNull(q.supplier_id)); }
    res.json(
      d.prepare(
        `SELECT sr.*, s.name AS supplier_name, p.name AS product_name
           FROM supplier_returns sr
           JOIN suppliers s ON s.id = sr.supplier_id
           JOIN products p ON p.id = sr.product_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY sr.id DESC LIMIT 100`
      ).all(...args)
    );
  });

  // ---- purchase price history (evidence: every purchase move carries its cost) -------------------
  app.get('/api/products/:id/purchase-history', me, can('stock.view'), (req, res) => {
    const product = productRow(d, numOrNull(req.params.id));
    if (!product) return res.status(404).json({ error: 'not found' });
    const moves = d
      .prepare(
        `SELECT m.created_at AS at, m.ref, m.qty, m.unit_cost, m.batch_id, b.batch_no
           FROM stock_moves m LEFT JOIN batches b ON b.id = m.batch_id
          WHERE m.product_id = ? AND m.type = 'purchase' AND m.qty > 0
          ORDER BY m.id DESC LIMIT 200`
      )
      .all(product.id);
    res.json({ product: product.name, current_cost: product.cost, purchases: moves });
  });

  // ============================================================================
  // ---- Phase 6: pricing engine (R-PR) -------------------------------------------
  // Resolution chain, first match wins: promo/time → customer → branch → pack →
  // level → default. Computed server-side at line add, re-validated at payment,
  // frozen onto the sale line (sale_items.unit_price) — later changes never touch it.
  // ============================================================================
  const TIERS = ['retail', 'wholesale', 'member'];

  const marginPct = (price, cost) => {
    const p = Number(price || 0);
    if (p <= 0) return null;
    return Math.round(((p - Number(cost || 0)) / p) * 1000) / 10;
  };

  const pricingSettings = (d) => {
    const s = dbm.getSettings(d).pricing || {};
    const f = Number(s.min_margin_pct);
    return {
      min_margin_pct: Number.isFinite(f) && f >= 0 ? f : null,
      margin_policy: s.margin_policy === 'block' ? 'block' : 'pin'
    };
  };

  // R-PR1 floor, most specific wins: product → branch (branches.settings) → global.
  function marginFloor(d, product, branchId) {
    if (product && product.min_margin_pct != null) return Number(product.min_margin_pct) || 0;
    if (branchId) {
      const b = d.prepare('SELECT settings FROM branches WHERE id = ?').get(branchId);
      if (b) {
        try {
          const s = JSON.parse(b.settings || '{}');
          if (s.min_margin_pct != null) return Number(s.min_margin_pct) || 0;
        } catch { /* fall through */ }
      }
    }
    return pricingSettings(d).min_margin_pct || 0;
  }

  const hasWindow = (r) => !!(r.valid_from || r.valid_to || r.time_start || r.time_end);

  function ruleWindowActive(r, t) {
    const iso = t.toISOString();
    if (r.valid_from && iso.slice(0, 10) < r.valid_from) return false;
    if (r.valid_to && iso.slice(0, 10) > r.valid_to) return false;
    if (r.time_start && r.time_end) {
      const hm = iso.slice(11, 16);
      if (r.time_start <= r.time_end) {
        if (hm < r.time_start || hm > r.time_end) return false;
      } else if (!(hm >= r.time_start || hm <= r.time_end)) return false; // overnight wrap
    }
    return true;
  }

  function resolvePrice(d, { variantId, branchId = null, customerId = null, packId = null, promoCode = null, now = null }) {
    const variant = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(variantId);
    if (!variant) return { error: 'unknown variant', status: 404 };
    const product = d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(variant.product_id);
    if (!product) return { error: 'unknown product', status: 404 };
    const customer = customerId ? d.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null;
    const pack = packId ? d.prepare('SELECT * FROM packs WHERE id = ? AND active = 1').get(packId) : null;
    if (packId && (!pack || pack.variant_id !== variant.id)) return { error: 'pack does not belong to this variant', status: 400 };
    const t = now ? new Date(now) : new Date();
    if (now && Number.isNaN(t.getTime())) return { error: 'bad now timestamp', status: 400 };
    const bId = branchId || null;
    const cId = customer ? customer.id : null;
    const tier = customer ? (TIERS.includes(customer.tier) ? customer.tier : 'retail') : 'retail';

    const candidates = (extra, args) =>
      d.prepare(
        `SELECT * FROM price_rules
          WHERE variant_id = ? AND active = 1
            AND (branch_id IS NULL OR branch_id = ?)
            AND (customer_id IS NULL OR customer_id = ?)
            AND (tier IS NULL OR tier = ?)
            ${extra}
          ORDER BY (customer_id IS NOT NULL) DESC, (branch_id IS NOT NULL) DESC, id`
      ).all(variant.id, bId, cId, tier, ...args);

    const baseCost = variant.cost != null ? variant.cost : product.cost;
    const finish = (price, source, sourceRef, ruleId, cost) => {
      const p = Number(price || 0);
      const m = marginPct(p, cost);
      const floor = marginFloor(d, product, bId);
      return {
        variant_id: variant.id, product_id: product.id, product_name: product.name,
        price: p, cost: Number(cost || 0), margin_pct: m, floor_pct: floor,
        below_margin: m !== null && floor > 0 && m < floor - 1e-9,
        source, source_ref: sourceRef || '', rule_id: ruleId
      };
    };

    // 1 — active promo / time-based price (applies to variant + customer + branch)
    for (const r of candidates('AND ((promo_code IS NOT NULL AND promo_code = ?) OR (promo_code IS NULL AND (valid_from IS NOT NULL OR valid_to IS NOT NULL OR time_start IS NOT NULL)))', [promoCode || ''])) {
      if (ruleWindowActive(r, t)) return finish(r.price, r.promo_code ? 'promo' : 'time', r.promo_code || 'time-based', r.id);
    }
    // 2 — customer-specific price (deni / VIP agreement)
    for (const r of candidates('AND customer_id IS NOT NULL AND promo_code IS NULL', [])) {
      if (ruleWindowActive(r, t)) return finish(r.price, 'customer', `customer #${r.customer_id}`, r.id);
    }
    // 3 — branch price override
    for (const r of candidates('AND branch_id IS NOT NULL AND customer_id IS NULL AND promo_code IS NULL', [])) {
      if (ruleWindowActive(r, t)) return finish(r.price, 'branch', `branch #${r.branch_id}`, r.id);
    }
    // 4 — pack price (R-PR4: a case is 12× the bottle price *or less*)
    if (pack) {
      const packCost = pack.cost > 0 ? pack.cost : Number(baseCost || 0) * pack.multiple;
      const out = finish(pack.price, 'pack', pack.name, null, packCost);
      out.multiple = pack.multiple;
      out.price_per_unit = Math.round(pack.price / pack.multiple);
      return out;
    }
    // 5 — price level (customer's tier: wholesale / member)
    if (customer && tier !== 'retail') {
      for (const r of candidates('AND tier IS NOT NULL AND customer_id IS NULL AND promo_code IS NULL', [])) {
        if (ruleWindowActive(r, t)) return finish(r.price, 'level', `tier ${tier}`, r.id);
      }
      const lvl = effPrice(product, variant, tier);
      if (lvl > 0) return finish(lvl, 'level', `tier ${tier}`, null);
    }
    // 6 — default selling price
    return finish(effPrice(product, variant, 'retail'), 'default', '', null, baseCost);
  }

  // ---- R-PR1: minimum-margin guard on manual price changes ---------------------------------
  function findManagerByPin(pin) {
    if (!pin || !/^\d{4,8}$/.test(String(pin))) return null;
    const cands = d.prepare("SELECT * FROM users WHERE active = 1 AND role IN ('manager','owner')").all();
    for (const u of cands) {
      try { if (auth.verifyPin(String(pin), u.salt, u.pin_hash)) return u; } catch { /* next */ }
    }
    return null;
  }

  // null = ok · { status, code, error } = refuse · { approver } = PIN-verified override
  function marginGuard(req, product, branchId, price, cost) {
    if (price == null || price <= 0) return null;
    if (cost == null || Number(cost) < 0) return null;
    const floor = marginFloor(d, product, branchId);
    if (!floor) return null;
    const m = marginPct(price, cost);
    if (m === null || m >= floor - 1e-9) return null;
    if (pricingSettings(d).margin_policy === 'block') {
      return { status: 403, code: 'margin_blocked', error: `${price} gives ${m}% margin, below the ${floor}% floor — overrides are blocked` };
    }
    const mgr = findManagerByPin((req.body && (req.body.pin || req.body.override_pin)) || '');
    if (!mgr) return { status: 403, code: 'margin_pin', error: `${price} gives ${m}% margin, below the ${floor}% floor — a manager/owner PIN is required` };
    return { approver: mgr, margin: m, floor };
  }

  function priceHist(product, { variantId = null, packId = null, scope, field = 'price', oldPrice = null, newPrice = null, user, approver = null, note = '' }) {
    d.prepare(
      `INSERT INTO price_history (product_id, variant_id, pack_id, scope, field, old_price, new_price, note, user_id, approved_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(product.id, variantId, packId, scope, field, oldPrice, newPrice, note, user ? user.id : null, approver ? approver.id : null, new Date().toISOString());
  }

  const ruleLabel = (p) => [p.promo ? `promo ${p.promo}` : null, p.branchId ? `branch ${p.branchId}` : null,
    p.customerId ? `customer ${p.customerId}` : null, p.tier ? `tier ${p.tier}` : null,
    (p.validFrom || p.validTo || p.timeStart) ? 'time-bound' : null].filter(Boolean).join(' · ') || 'time-bound';

  // ---- pricing surface ------------------------------------------------------------------------
  app.get('/api/pricing/resolve', me, (req, res) => {
    const out = resolvePrice(d, {
      variantId: numOrNull(req.query.variant_id),
      branchId: numOrNull(req.query.branch_id),
      customerId: numOrNull(req.query.customer_id),
      packId: numOrNull(req.query.pack_id),
      promoCode: req.query.promo_code ? String(req.query.promo_code).trim() : null,
      now: req.query.now || null
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out);
  });

  function rulePayload(b) {
    const variantId = numOrNull(b.variant_id);
    const price = intShillings(b.price);
    const branchId = numOrNull(b.branch_id);
    const customerId = numOrNull(b.customer_id);
    const tier = b.tier ? (TIERS.includes(b.tier) ? b.tier : null) : null;
    const promo = String(b.promo_code || '').trim();
    const validFrom = String(b.valid_from || '').trim();
    const validTo = String(b.valid_to || '').trim();
    const timeStart = String(b.time_start || '').trim();
    const timeEnd = String(b.time_end || '').trim();
    if (b.tier && !tier) return { error: 'tier must be retail, wholesale or member' };
    if (validFrom && !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return { error: 'valid_from must be YYYY-MM-DD' };
    if (validTo && !/^\d{4}-\d{2}-\d{2}$/.test(validTo)) return { error: 'valid_to must be YYYY-MM-DD' };
    if (timeStart && !/^\d{2}:\d{2}$/.test(timeStart)) return { error: 'time_start must be HH:MM' };
    if (timeEnd && !/^\d{2}:\d{2}$/.test(timeEnd)) return { error: 'time_end must be HH:MM' };
    if (!variantId) return { error: 'variant_id required' };
    if (price === null) return { error: 'price required (whole shillings)' };
    const primaries = [branchId ? 'branch' : null, customerId ? 'customer' : null, tier ? 'tier' : null].filter(Boolean);
    if (primaries.length > 1) return { error: 'one primary scope per rule (branch, customer or tier) — a promo code and time window may combine with any' };
    if (!primaries.length && !promo && !validFrom && !validTo && !timeStart && !timeEnd) {
      return { error: 'a rule needs a scope: promo code, time window, customer, branch or tier' };
    }
    return { variantId, price, branchId, customerId, tier, promo: promo || null, validFrom: validFrom || null, validTo: validTo || null, timeStart: timeStart || null, timeEnd: timeEnd || null, note: String(b.note || '').trim() };
  }

  app.get('/api/price-rules', me, can('products.view'), (req, res) => {
    const q = req.query;
    const where = ['pr.active = 1'];
    const args = [];
    // R-2: branch pricing is branch data — managers see global rules + their own branch
    if (req.user.role !== 'owner') {
      const vis = visibleBranches(d, req.user).map((b) => b.id);
      where.push(`(pr.branch_id IS NULL OR pr.branch_id IN (${vis.map(() => '?').join(',')}))`);
      args.push(...vis);
    }
    if (q.variant_id) { where.push('pr.variant_id = ?'); args.push(numOrNull(q.variant_id)); }
    if (q.product_id) { where.push('pr.variant_id IN (SELECT id FROM variants WHERE product_id = ?)'); args.push(numOrNull(q.product_id)); }
    res.json(
      d.prepare(
        `SELECT pr.*, p.name AS product_name, v.name AS variant_name, b.name AS branch_name, c.name AS customer_name
           FROM price_rules pr
           JOIN variants v ON v.id = pr.variant_id
           JOIN products p ON p.id = v.product_id
           LEFT JOIN branches b ON b.id = pr.branch_id
           LEFT JOIN customers c ON c.id = pr.customer_id
          ${where.length > 1 ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY pr.id DESC LIMIT 200`
      ).all(...args)
    );
  });

  app.post('/api/price-rules', me, can('products.manage'), (req, res) => {
    const payload = rulePayload(req.body || {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    const variant = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(payload.variantId);
    if (!variant) return res.status(404).json({ error: 'unknown variant' });
    const product = productRow(d, variant.product_id);
    const guard = marginGuard(req, product, payload.branchId, payload.price, variant.cost != null ? variant.cost : product.cost);
    if (guard && guard.status) return res.status(guard.status).json({ code: guard.code, error: guard.error });
    const t = new Date().toISOString();
    const id = d
      .prepare(`INSERT INTO price_rules (variant_id, branch_id, customer_id, tier, promo_code, price, valid_from, valid_to, time_start, time_end, note, active, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(payload.variantId, payload.branchId, payload.customerId, payload.tier, payload.promo, payload.price,
        payload.validFrom, payload.validTo, payload.timeStart, payload.timeEnd, payload.note, req.user.id, t, t)
      .lastInsertRowid;
    priceHist(product, { variantId: variant.id, scope: 'rule', oldPrice: null, newPrice: payload.price, user: req.user, approver: guard && guard.approver, note: ruleLabel(payload) });
    dbm.audit(d, { userId: req.user.id, action: 'rule/create', entity: 'price_rule', entityId: String(id), detail: { ...payload, margin: guard && guard.margin } });
    res.json({ ok: true, id });
  });

  app.put('/api/price-rules/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM price_rules WHERE id = ? AND active = 1').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(cur.variant_id);
    const product = productRow(d, variant.product_id);
    const price = b.price !== undefined ? intShillings(b.price) : cur.price;
    if (b.price !== undefined && price === null) return res.status(400).json({ error: 'price must be whole shillings' });
    for (const [k, re] of [['valid_from', /^\d{4}-\d{2}-\d{2}$/], ['valid_to', /^\d{4}-\d{2}-\d{2}$/], ['time_start', /^\d{2}:\d{2}$/], ['time_end', /^\d{2}:\d{2}$/]]) {
      if (b[k] !== undefined && String(b[k]).trim() && !re.test(String(b[k]).trim())) return res.status(400).json({ error: `bad ${k} format` });
    }
    if (b.tier !== undefined && b.tier && !TIERS.includes(b.tier)) return res.status(400).json({ error: 'bad tier' });
    const guard = b.price !== undefined ? marginGuard(req, product, b.branch_id !== undefined ? numOrNull(b.branch_id) : cur.branch_id, price, variant.cost != null ? variant.cost : product.cost) : null;
    if (guard && guard.status) return res.status(guard.status).json({ code: guard.code, error: guard.error });
    d.prepare(
      `UPDATE price_rules SET branch_id = ?, customer_id = ?, tier = ?, promo_code = ?, price = ?,
         valid_from = ?, valid_to = ?, time_start = ?, time_end = ?, note = ?, active = ?, updated_at = ? WHERE id = ?`
    ).run(
      b.branch_id !== undefined ? numOrNull(b.branch_id) : cur.branch_id,
      b.customer_id !== undefined ? numOrNull(b.customer_id) : cur.customer_id,
      b.tier !== undefined ? (b.tier ? b.tier : null) : cur.tier,
      b.promo_code !== undefined ? (String(b.promo_code || '').trim() || null) : cur.promo_code,
      price,
      b.valid_from !== undefined ? (String(b.valid_from || '').trim() || null) : cur.valid_from,
      b.valid_to !== undefined ? (String(b.valid_to || '').trim() || null) : cur.valid_to,
      b.time_start !== undefined ? (String(b.time_start || '').trim() || null) : cur.time_start,
      b.time_end !== undefined ? (String(b.time_end || '').trim() || null) : cur.time_end,
      b.note !== undefined ? String(b.note).trim() : cur.note,
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
      new Date().toISOString(), cur.id
    );
    if (b.price !== undefined) priceHist(product, { variantId: variant.id, scope: 'rule', oldPrice: cur.price, newPrice: price, user: req.user, approver: guard && guard.approver, note: 'rule update' });
    dbm.audit(d, { userId: req.user.id, action: 'rule/update', entity: 'price_rule', entityId: String(cur.id), detail: { keys: Object.keys(b) } });
    res.json({ ok: true });
  });

  app.delete('/api/price-rules/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM price_rules WHERE id = ? AND active = 1').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(cur.variant_id);
    d.prepare('UPDATE price_rules SET active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), cur.id);
    priceHist(productRow(d, variant.product_id), { variantId: variant.id, scope: 'rule', oldPrice: cur.price, newPrice: null, user: req.user, note: 'rule removed' });
    dbm.audit(d, { userId: req.user.id, action: 'rule/delete', entity: 'price_rule', entityId: String(cur.id) });
    res.json({ ok: true });
  });

  // R-PR3 — append-only price history (who / when / from / to / scope). Evidence is readable by any signed-in user (dispute checks at the till).
  app.get('/api/pricing/history', me, (req, res) => {
    const q = req.query;
    const where = [];
    const args = [];
    if (q.product_id) { where.push('h.product_id = ?'); args.push(numOrNull(q.product_id)); }
    if (q.variant_id) { where.push('h.variant_id = ?'); args.push(numOrNull(q.variant_id)); }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    res.json(
      d.prepare(
        `SELECT h.*, p.name AS product_name, v.name AS variant_name, u.name AS user_name, a.name AS approver_name
           FROM price_history h
           JOIN products p ON p.id = h.product_id
           LEFT JOIN variants v ON v.id = h.variant_id
           LEFT JOIN users u ON u.id = h.user_id
           LEFT JOIN users a ON a.id = h.approved_by
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY h.id DESC LIMIT ?`
      ).all(...args, limit)
    );
  });

  // Read-only customer list (the full customer module lands in Phase 11).

  // ---- Phase 7 (Day 10): POS / sales engine --------------------------------------------------------
  // Prices are FROZEN at line add (R-PR chain: promo → customer → branch → pack → tier → default).
  // Stock moves exactly once, at payment, through the Phase-4 move engine (FEFO for batches).
  // Hold = 'suspended' sale (no stock, no payment); paying it is the single stock-mutating step.

  function saleContext(d, user) {
    // A cashier sells from their own register → location → branch. Unbound users: first visible branch.
    // Session users are camelCase (lib/auth.js): branchId / locationId / registerId.
    let register = null;
    if (user.registerId) register = d.prepare('SELECT * FROM registers WHERE id = ? AND active = 1').get(user.registerId) || null;
    const visible = visibleBranches(d, user);
    let branchId = (register && register.branch_id) || user.branchId || null;
    if (!branchId || !visible.some((b) => b.id === branchId)) branchId = (visible[0] && visible[0].id) || null;
    let locationId = (register && register.location_id) || user.locationId || null;
    const loc = branchId ? d.prepare('SELECT * FROM locations WHERE id = ? AND branch_id = ?').get(locationId, branchId) : null;
    if (!loc) locationId = (defaultLocation(d, branchId) || {}).id || null;
    const branch = branchId ? d.prepare('SELECT * FROM branches WHERE id = ?').get(branchId) : null;
    return { branchId, locationId, register, branch };
  }

  function nextOrderNo(d, branchId) {
    return d.prepare('SELECT COALESCE(MAX(order_no), 0) + 1 AS n FROM sales WHERE branch_id = ?').get(branchId).n;
  }

  function lineTax(net, taxType, vatRate) {
    if (taxType !== 'std' || !vatRate) return 0;
    return Math.round((net * vatRate) / (100 + vatRate));
  }

  // Validates + prices the cart. Throws httpError on any problem.
  function prepareSaleLines(d, { user, ctx, customerId, promoCode, items, approver, allowOversell }) {
    if (!Array.isArray(items) || !items.length) throw httpError(400, 'no items');
    if (items.length > 200) throw httpError(400, 'too many items (max 200)');
    if (allowOversell && !['owner', 'manager'].includes(user.role)) {
      throw httpError(403, 'overselling stock is a manager/owner act (R-S8)');
    }
    const customer = customerId ? d.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null;
    if (customerId && !customer) throw httpError(404, 'unknown customer');
    const vatRate = Number((dbm.getSetting(d, 'tax', {}) || {}).vatRate) || 0;
    const discountAllowed = perms.userHasPerm(d, user, 'sales.discount') || !!approver;
    const lines = [];
    for (const it of items) {
      const variantId = numOrNull(it.variant_id);
      const qty = Number(it.qty);
      if (!variantId) throw httpError(400, 'variant_id required on each item');
      if (!Number.isFinite(qty) || qty <= 0) throw httpError(400, 'qty must be positive');
      const variant = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(variantId);
      if (!variant) throw httpError(404, `unknown variant ${variantId}`);
      const product = d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(variant.product_id);
      if (!product) throw httpError(404, 'unknown product');
      if (product.requires_rx) throw httpError(403, `${product.name} requires a prescription (pharmacy workflow)`);
      if (product.is_controlled) throw httpError(403, `${product.name} is controlled — licensed workflow required`);
      if (product.age_min && !it.age_verified) {
        throw httpError(400, `${product.name}: age verification required (${product.age_min}+)`);
      }
      if (product.track_serials && !Number.isInteger(qty)) throw httpError(400, 'serial-tracked items must be whole units');
      // R-PR: freeze the price the moment the line is added.
      const res = resolvePrice(d, { variantId, branchId: ctx.branchId, customerId: customer ? customer.id : null, promoCode });
      if (res.error) throw httpError(res.status || 400, res.error);
      const disc = Math.max(0, Math.round(Number(it.line_discount) || 0));
      if (disc > 0) {
        if (!discountAllowed) throw httpError(403, 'discounts need the sales.discount permission or a supervisor PIN');
        if (disc > res.price * qty) throw httpError(400, `discount ${disc} exceeds the line total`);
      }
      const taxType = eff(product, variant, 'tax_type') || 'std';
      const grossLine = Math.round(res.price * qty);
      const net = grossLine - disc;
      const tax = lineTax(net, taxType, vatRate);
      lines.push({
        variant, product, qty, unitPrice: res.price, source: res.source, disc, net, tax, gross: net + tax,
        taxType, kra: eff(product, variant, 'kra_item_code') || '',
        age: product.age_min ? 1 : 0, batchId: null, note: String(it.line_note || '').trim()
      });
    }
    return { lines, customer };
  }

  function saleTotals(lines) {
    const t = { subtotal: 0, discount: 0, net: 0, tax: 0, gross: 0 };
    for (const L of lines) {
      t.subtotal += Math.round(L.unitPrice * L.qty);
      t.discount += L.disc; t.net += L.net; t.tax += L.tax; t.gross += L.gross;
    }
    return t;
  }

  // The single stock-mutating step of a sale: FEFO per line, ref = invoice no (R-S2 trace).
  function moveStockForSale(d, { user, ctx, lines, ref, allowOversell }) {
    for (const L of lines) {
      const out = writeMove(d, {
        product: L.product, variant: L.variant, branchId: ctx.branchId, locationId: ctx.locationId,
        qty: -L.qty, type: 'sale', reason: 'sale', ref, userId: user.id,
        allowOversell, note: L.product.name + (L.variant.name ? ` — ${L.variant.name}` : '')
      });
      if (out.moveIds.length) {
        const first = d.prepare('SELECT batch_id FROM stock_moves WHERE id = ?').get(out.moveIds[0]);
        L.batchId = first ? first.batch_id : null;
      }
    }
  }

  // Phase 8: payments go through the engine (lib/payments.js) — method
  // validation, state machine, idempotency, evidence, balance recompute.
  // M-Pesa comes back 'pending'; lib/mpesa.js (the only file that knows
  // Daraja) is what initiates the collection for it.
  function applyPayment(d, { user, saleId, sale, payment, discountBy, allowQuote }) {
    if (!payment) throw httpError(400, 'payment required');
    if (discountBy) d.prepare('UPDATE sales SET discount_by = ? WHERE id = ?').run(discountBy, saleId);
    const r = pme.addPayment(d, {
      user, sale,
      method: String(payment.method || '').trim(),
      amount: payment.amount, ref: payment.ref, phone: payment.phone,
      tendered: payment.tendered !== undefined ? payment.tendered : payment.amount,
      allowQuote
    });
    if (payment.method === 'mpesa' && r.payment.status === 'pending') {
      r.mpesa = mpesa.initiate(d, { payment: r.payment, sale: r.sale, phone: String(payment.phone || '').trim(), amount: r.payment.amount });
    }
    return r;
  }

  function buildSalePayload(d, saleId) {
    const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    const items = d.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId);
    const payments = d.prepare('SELECT * FROM payments WHERE sale_id = ? ORDER BY id').all(saleId);
    const users = d.prepare('SELECT id, name FROM users').all();
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const customer = sale.customer_id ? d.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id) : null;
    const biz = dbm.getSetting(d, 'business', {}) || {};
    const tax = dbm.getSetting(d, 'tax', {}) || {};
    return {
      sale: {
        ...sale,
        cashier: names[sale.user_id] || `#${sale.user_id}`,
        discount_by: sale.discount_by ? names[sale.discount_by] : null
      },
      items, payments,
      returns_total: d.prepare('SELECT COALESCE(SUM(total), 0) AS t FROM returns WHERE sale_id = ?').get(saleId).t,
      returns: d.prepare(
        'SELECT id, return_no, total, reason, refund_as, note, created_at FROM returns WHERE sale_id = ? ORDER BY id'
      ).all(saleId),
      customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone } : null,
      receipt: {
        business: { name: biz.name || '', phone: biz.phone || '', kraPin: biz.kraPin || '', address: biz.address || '' },
        currency: biz.currency || 'KES', symbol: biz.symbol || 'Ksh',
        vatRegistered: !!tax.vatRegistered, vatRate: tax.vatRate || 0,
        footer: (dbm.getSetting(d, 'receipt', {}) || {}).footer || ''
      }
    };
  }

  function supervisorFromPin(pin) {
    const mgr = findManagerByPin(String(pin || ''));
    if (!mgr) throw httpError(403, 'invalid supervisor PIN');
    return mgr;
  }

  // One call = scan-to-receipt: validate → freeze prices → (stock + pay) or hold.
  app.post('/api/sales', me, (req, res) => {
    try {
      requireOpenShift(d, req.user);
      const b = req.body || {};
      const kind = b.kind === 'quote' ? 'quote' : 'sale';
      if (kind === 'quote' && b.payment) {
        return res.status(400).json({ error: 'quotes are held, not paid — convert the quote when the customer is ready' });
      }
      const hold = b.hold === true || kind === 'quote';
      const approver = b.override_pin ? supervisorFromPin(b.override_pin) : null;
      if (b.oversell && !['owner', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ error: 'overselling stock is a manager/owner act (R-S8)' });
      }
      const ctx = saleContext(d, req.user);
      if (!ctx.branchId || !ctx.locationId) {
        return res.status(400).json({ error: 'no selling location for this user — assign a branch or register first' });
      }
      const { lines, customer } = prepareSaleLines(d, {
        user: req.user, ctx, customerId: numOrNull(b.customer_id),
        promoCode: b.promo_code ? String(b.promo_code).trim() : null,
        items: b.items, approver, allowOversell: b.oversell === true
      });
      const totals = saleTotals(lines);
      const t = new Date().toISOString();
      const biz = dbm.getSetting(d, 'business', {}) || {};
      const orderNo = nextOrderNo(d, ctx.branchId);
      const invoiceNo = `${ctx.branch.code || 'BR'}-${String(orderNo).padStart(6, '0')}`;
      const discountBy = approver ? approver.id : null;
      let payRes = null;
      const run = d.transaction(() => {
        const id = d
          .prepare(
            `INSERT INTO sales (branch_id, location_id, register_id, terminal, order_no, invoice_no, customer_id, user_id, status,
               subtotal, discount, net, tax, gross, tender, note, etims_status, discount_by, kind, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`
          )
          .run(ctx.branchId, ctx.locationId, ctx.register ? ctx.register.id : null, ctx.register ? ctx.register.name : '',
            orderNo, invoiceNo, customer ? customer.id : null, req.user.id, hold ? 'suspended' : 'open',
            totals.subtotal, totals.discount, totals.net, totals.tax, totals.gross,
            String(b.note || '').trim(), biz.kraPin ? 'pending' : 'exempt', discountBy, kind, t)
          .lastInsertRowid;
        if (!hold) {
          moveStockForSale(d, { user: req.user, ctx, lines, ref: invoiceNo, allowOversell: b.oversell === true });
          const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(id);
          payRes = applyPayment(d, { user: req.user, saleId: id, sale, payment: b.payment, discountBy });
        }
        const ins = d.prepare(
          `INSERT INTO sale_items (sale_id, product_id, variant_id, name, qty, unit, line_discount, net, tax, gross, tax_type, kra_item_code, batch_id, line_note, age_verified, unit_price)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const L of lines) {
          ins.run(id, L.product.id, L.variant.id, L.product.name + (L.variant.name ? ` — ${L.variant.name}` : ''),
            L.qty, L.disc, L.net, L.tax, L.gross, L.taxType, L.kra, hold ? null : L.batchId, L.note, L.age, L.unitPrice);
        }
        return id;
      });
      const id = run();
      dbm.audit(d, {
        userId: req.user.id, branchId: ctx.branchId, action: hold ? 'sale/hold' : 'sale/create',
        entity: 'sale', entityId: String(id),
        detail: {
          invoice: invoiceNo, items: lines.length, gross: totals.gross, discount: totals.discount,
          hold, method: b.payment ? b.payment.method : null, pending: payRes ? payRes.payment.status === 'pending' : undefined,
          oversell: b.oversell === true || undefined,
          discountApprover: discountBy ? 'PIN' : undefined, promo: b.promo_code || undefined
        }
      });
      res.json({ ok: true, ...buildSalePayload(d, id), ...(payRes && payRes.mpesa ? { mpesa: payRes.mpesa } : {}) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/sales:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Shared resume step: re-validate (variant/product still active) → the single
  // stock-mutating step (FEFO at the paying register) → payment, one transaction.
  function resumeHeldSale(d, { sale, user, b, approver, markInvoice = false }) {
    if (b.oversell && !['owner', 'manager'].includes(user.role)) {
      throw httpError(403, 'overselling stock is a manager/owner act (R-S8)');
    }
    const rows = d.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.id);
    const lines = rows.map((row) => {
      const variant = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(row.variant_id);
      if (!variant) throw httpError(409, `held item no longer available (variant ${row.variant_id} deactivated)`);
      const product = d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(variant.product_id);
      if (!product) throw httpError(409, `held item no longer available (${row.name} deactivated)`);
      return {
        variant, product, qty: row.qty, unitPrice: row.unit_price || 0, source: 'frozen',
        disc: row.line_discount, net: row.net, tax: row.tax, gross: row.gross,
        taxType: row.tax_type, kra: row.kra_item_code, age: row.age_verified, batchId: null, note: row.line_note, _rowId: row.id
      };
    });
    const ctx = saleContext(d, user);
    if (!ctx.branchId || !ctx.locationId) throw httpError(400, 'no selling location for this user');
    if (ctx.branchId !== sale.branch_id) throw httpError(400, 'held sales can only be paid at the same branch');
    let payRes = null;
    const run = d.transaction(() => {
      moveStockForSale(d, { user, ctx, lines, ref: sale.invoice_no, allowOversell: b.oversell === true });
      const fresh = d.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
      payRes = applyPayment(d, { user, saleId: sale.id, sale: fresh, payment: b.payment, discountBy: approver ? approver.id : null, allowQuote: markInvoice === true });
      if (markInvoice) d.prepare("UPDATE sales SET kind = 'invoice' WHERE id = ?").run(sale.id);
      const upd = d.prepare('UPDATE sale_items SET batch_id = ? WHERE id = ?');
      for (const L of lines) upd.run(L.batchId, L._rowId);
    });
    run();
    return payRes;
  }

  // When a sale goes back to "never started" (its only money was cancelled or
  // failed), the stock step must be reversed — same lots, audited, R-S1.
  function restoreSaleStock(d, { sale, userId, note }) {
    const items = d.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
    for (const row of items) {
      const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(row.variant_id);
      const product = d.prepare('SELECT * FROM products WHERE id = ?').get(row.product_id);
      if (!variant || !product) continue;
      const taken = d.prepare(
        `SELECT * FROM stock_moves WHERE ref = ? AND type = 'sale' AND variant_id = ? AND qty < 0 AND note NOT LIKE 'void:%'`
      ).all(sale.invoice_no, row.variant_id);
      for (const m of taken) {
        addStockMove(d, {
          product, variant, branchId: sale.branch_id, locationId: m.location_id,
          qty: -m.qty, type: 'sale', reason: 'sale', ref: sale.invoice_no,
          batchId: m.batch_id, userId, note: `void: ${note}`
        });
        if (m.batch_id) d.prepare('UPDATE batches SET qty = qty + ? WHERE id = ?').run(-m.qty, m.batch_id);
        upsertStock(d, row.variant_id, m.location_id, -m.qty);
      }
    }
  }

  // True when a sale has no money left in it (confirmed or pending).
  function saleHasMoney(d, saleId) {
    return !!d.prepare("SELECT 1 FROM payments WHERE sale_id = ? AND status IN ('confirmed','pending') LIMIT 1").get(saleId);
  }

  // If the sale is now money-less, unwind its stock step and park it as suspended.
  function maybeUnwindSale(d, { saleId, userId, note }) {
    const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale || sale.status === 'voided') return;
    if (saleHasMoney(d, saleId)) return;
    restoreSaleStock(d, { sale, userId, note });
    d.prepare("UPDATE sales SET status = 'suspended', paid_at = NULL WHERE id = ?").run(saleId);
  }

  // Resume a held sale (kind 'sale'): stock moves exactly once, here.
  app.post('/api/sales/:id/pay', me, (req, res) => {
    try {
      requireOpenShift(d, req.user);
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(numOrNull(req.params.id));
      if (!sale) return res.status(404).json({ error: 'not found' });
      if (sale.status !== 'suspended') return res.status(400).json({ error: `sale is ${sale.status}, not held` });
      if (sale.kind === 'quote') return res.status(400).json({ error: 'quotes convert via POST /api/sales/:id/convert' });
      const b = req.body || {};
      const approver = b.override_pin ? supervisorFromPin(b.override_pin) : null;
      const payRes = resumeHeldSale(d, { sale, user: req.user, b, approver });
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'sale/pay',
        entity: 'sale', entityId: String(sale.id),
        detail: { invoice: sale.invoice_no, method: b.payment ? b.payment.method : null, gross: sale.gross, oversell: b.oversell === true || undefined }
      });
      res.json({ ok: true, ...buildSalePayload(d, sale.id), ...(payRes && payRes.mpesa ? { mpesa: payRes.mpesa } : {}) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/sales/:id/pay:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Quote → invoice (Phase 7 acceptance): the quote converts with a payment,
  // re-validates its lines, and moves stock exactly once — then it is an invoice.
  app.post('/api/sales/:id/convert', me, (req, res) => {
    try {
      requireOpenShift(d, req.user);
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(numOrNull(req.params.id));
      if (!sale) return res.status(404).json({ error: 'not found' });
      if (sale.kind !== 'quote') return res.status(400).json({ error: 'only quotes can be converted' });
      if (sale.status !== 'suspended') return res.status(400).json({ error: `quote is ${sale.status}, not pending` });
      const b = req.body || {};
      const approver = b.override_pin ? supervisorFromPin(b.override_pin) : null;
      const payRes = resumeHeldSale(d, { sale, user: req.user, b, approver, markInvoice: true });
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'sale/convert',
        entity: 'sale', entityId: String(sale.id),
        detail: { invoice: sale.invoice_no, method: b.payment ? b.payment.method : null, gross: sale.gross, oversell: b.oversell === true || undefined }
      });
      res.json({ ok: true, ...buildSalePayload(d, sale.id), ...(payRes && payRes.mpesa ? { mpesa: payRes.mpesa } : {}) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/sales/:id/convert:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/sales', me, (req, res) => {
    const q = req.query;
    const branches = visibleBranches(d, req.user);
    if (!branches.length) return res.json([]);
    const where = ['b.id IN (' + branches.map((x) => x.id).join(',') + ')'];
    const args = [];
    if (q.status) { where.push('s.status = ?'); args.push(String(q.status)); }
    if (q.invoice) { where.push('s.invoice_no = ?'); args.push(String(q.invoice).trim().toUpperCase()); }
    if (q.mine === '1') { where.push('s.user_id = ?'); args.push(req.user.id); }
    if (q.from) { where.push('s.created_at >= ?'); args.push(String(q.from)); }
    if (q.to) { where.push('s.created_at < ?'); args.push(String(q.to)); }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const users = d.prepare('SELECT id, name FROM users').all();
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const rows = d
      .prepare(
        `SELECT s.*, b.name AS branch_name, r.name AS register_name,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
           (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.sale_id = s.id AND p.status = 'confirmed') AS paid
           FROM sales s JOIN branches b ON b.id = s.branch_id
           LEFT JOIN registers r ON r.id = s.register_id
          WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT ?`
      )
      .all(...args, limit);
    res.json(rows.map((r) => ({ ...r, cashier: names[r.user_id] || `#${r.user_id}` })));
  });

  app.get('/api/sales/:id', me, (req, res) => {
    const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(numOrNull(req.params.id));
    if (!sale) return res.status(404).json({ error: 'not found' });
    res.json(buildSalePayload(d, sale.id));
  });

  // Void = supervisor act: stock moves back (audited), sale marked voided, payments flagged refunded.
  app.post('/api/sales/:id/void', me, can('sales.void'), (req, res) => {
    try {
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(numOrNull(req.params.id));
      if (!sale) return res.status(404).json({ error: 'not found' });
      if (!['paid', 'partial', 'open'].includes(sale.status)) return res.status(400).json({ error: `cannot void a ${sale.status} sale` });
      const b = req.body || {};
      const note = String(b.note || 'voided').trim();
      const items = d.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
      const hadStock = ['paid', 'partial', 'open'].includes(sale.status);
      const ctx = { branchId: sale.branch_id, locationId: sale.location_id };
      const run = d.transaction(() => {
        for (const row of items) {
          if (!hadStock) continue;
          const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(row.variant_id);
          const product = d.prepare('SELECT * FROM products WHERE id = ?').get(row.product_id);
          if (!variant || !product) continue;
          // Reverse exactly what the sale took — same lots (FEFO included), from the ledger.
          const taken = d
            .prepare(
              `SELECT * FROM stock_moves WHERE ref = ? AND type = 'sale' AND variant_id = ? AND qty < 0 AND note NOT LIKE 'void:%'`
            )
            .all(sale.invoice_no, row.variant_id);
          for (const m of taken) {
            addStockMove(d, {
              product, variant, branchId: sale.branch_id, locationId: m.location_id,
              qty: -m.qty, type: 'sale', reason: 'sale', ref: sale.invoice_no,
              batchId: m.batch_id, userId: req.user.id, note: `void: ${note}`
            });
            if (m.batch_id) d.prepare('UPDATE batches SET qty = qty + ? WHERE id = ?').run(-m.qty, m.batch_id);
            upsertStock(d, row.variant_id, m.location_id, -m.qty);
          }
        }
        d.prepare("UPDATE sales SET status = 'voided' WHERE id = ?").run(sale.id);
        if (hadStock) {
          d.prepare("UPDATE payments SET status = 'refunded', refunded = amount WHERE sale_id = ? AND status = 'confirmed'").run(sale.id);
          d.prepare("UPDATE payments SET status = 'cancelled', note = 'voided' WHERE sale_id = ? AND status = 'pending'").run(sale.id);
        }
      });
      run();
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'sale/void',
        entity: 'sale', entityId: String(sale.id), detail: { invoice: sale.invoice_no, note, items: items.length }
      });
      res.json({ ok: true, ...buildSalePayload(d, sale.id) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/sales/:id/void:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- Phase 8: payment engine routes --------------------------------------
  // The till talks to these; it never talks to a provider.

  // Enabled payment methods (what the till shows) + non-secret M-Pesa config.
  app.get('/api/payments/methods', me, (req, res) => {
    const cfg = pme.paymentConfig(d);
    res.json({
      methods: pme.enabledMethods(d).map((m) => ({ ...m, ref: !!pme.METHODS[m.key].ref, needsCustomer: !!pme.METHODS[m.key].needsCustomer })),
      mpesa: { mode: cfg.mpesa.mode, shortcode: cfg.mpesa.shortcode, paybill: cfg.mpesa.paybill, phone: cfg.mpesa.phone }
    });
  });

  // Add a payment line to a sale (split / partial payments). A suspended sale
  // takes its stock step here — exactly once, on the first money in.
  app.post('/api/sales/:id/payments', me, (req, res) => {
    try {
      requireOpenShift(d, req.user);
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(numOrNull(req.params.id));
      if (!sale) return res.status(404).json({ error: 'not found' });
      if (['voided', 'refunded', 'paid'].includes(sale.status)) {
        return res.status(400).json({ error: `cannot add a payment to a ${sale.status} sale` });
      }
      if (sale.kind === 'quote') return res.status(400).json({ error: 'quotes convert via POST /api/sales/:id/convert' });
      const b = req.body || {};
      const ctx = saleContext(d, req.user);
      const visible = visibleBranches(d, req.user);
      if (!visible.some((x) => x.id === sale.branch_id)) {
        return res.status(403).json({ error: 'that sale belongs to another branch' });
      }
      let payRes = null;
      const run = d.transaction(() => {
        const fresh = d.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
        if (fresh.status === 'suspended') {
          // first money in: the single stock-moving step (FEFO at this register)
          const rows = d.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.id);
          const lines = rows.map((row) => {
            const variant = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(row.variant_id);
            if (!variant) throw httpError(409, `held item no longer available (variant ${row.variant_id} deactivated)`);
            const product = d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(variant.product_id);
            if (!product) throw httpError(409, `held item no longer available (${row.name} deactivated)`);
            return {
              variant, product, qty: row.qty, unitPrice: row.unit_price || 0, source: 'frozen',
              disc: row.line_discount, net: row.net, tax: row.tax, gross: row.gross,
              taxType: row.tax_type, kra: row.kra_item_code, age: row.age_verified, batchId: null, note: row.line_note, _rowId: row.id
            };
          });
          if (!ctx.branchId || !ctx.locationId) throw httpError(400, 'no selling location for this user');
          if (ctx.branchId !== sale.branch_id) throw httpError(400, 'held sales can only be paid at the same branch');
          moveStockForSale(d, { user: req.user, ctx, lines, ref: fresh.invoice_no, allowOversell: false });
          const upd = d.prepare('UPDATE sale_items SET batch_id = ? WHERE id = ?');
          for (const L of lines) upd.run(L.batchId, L._rowId);
        }
        const after = d.prepare('SELECT * FROM sales WHERE id = ?').get(sale.id);
        payRes = pme.addPayment(d, {
          user: req.user, sale: after,
          method: String(b.method || '').trim(),
          amount: b.amount, ref: b.ref, phone: b.phone,
          tendered: b.tendered !== undefined ? b.tendered : b.amount
        });
        if (b.method === 'mpesa' && payRes.payment.status === 'pending') {
          payRes.mpesa = mpesa.initiate(d, { payment: payRes.payment, sale: payRes.sale, phone: String(b.phone || '').trim(), amount: payRes.payment.amount });
        }
      });
      run();
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'payment/add',
        entity: 'payment', entityId: String(payRes.payment.id),
        detail: { invoice: sale.invoice_no, method: b.method, amount: payRes.payment.amount, status: payRes.payment.status, pending: payRes.payment.status === 'pending' || undefined }
      });
      res.json({ ok: true, ...buildSalePayload(d, sale.id), ...(payRes.mpesa ? { mpesa: payRes.mpesa } : {}) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/sales/:id/payments:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Confirm a pending payment (manual code, or the provider callback shape).
  app.post('/api/payments/:id/confirm', me, (req, res) => {
    try {
      const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(numOrNull(req.params.id));
      if (!p) return res.status(404).json({ error: 'payment not found' });
      const b = req.body || {};
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(p.sale_id);
      const visible = visibleBranches(d, req.user);
      if (!visible.some((x) => x.id === sale.branch_id)) return res.status(403).json({ error: 'that sale belongs to another branch' });
      const origRef = p.ref; // '' for manual-mode payments; the checkout id otherwise
      const run = d.transaction(() => {
        const r = pme.confirmPayment(d, {
          paymentId: p.id, user: req.user, code: b.code, externalRef: b.external_ref, via: b.via || 'manual'
        });
        if (p.method === 'mpesa') {
          const mref = r.payment.external_ref || r.payment.ref || '';
          const row = origRef
            ? d.prepare('SELECT id FROM mpesa_log WHERE checkout_request_id = ? ORDER BY id DESC LIMIT 1').get(origRef)
            : d.prepare(`SELECT id FROM mpesa_log WHERE sale_id = ? AND checkout_request_id = '' ORDER BY id DESC LIMIT 1`).get(p.sale_id);
          if (row) d.prepare(`UPDATE mpesa_log SET status = 'confirmed', mpesa_ref = ?, updated_at = ? WHERE id = ?`)
            .run(mref, new Date().toISOString(), row.id);
        }
        return r;
      });
      const r = run();
      if (!r.already) {
        dbm.audit(d, {
          userId: req.user.id, branchId: sale.branch_id, action: 'payment/confirm',
          entity: 'payment', entityId: String(p.id),
          detail: { invoice: sale.invoice_no, method: p.method, amount: p.amount, code: b.code ? 'entered' : undefined, via: b.via || 'manual' }
        });
      }
      res.json({ ok: true, already: !!r.already, ...buildSalePayload(d, p.sale_id), ...(r.mpesa ? { mpesa: r.mpesa } : {}) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/payments/:id/confirm:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Cancel a pending payment (customer declined / prompt timed out).
  app.post('/api/payments/:id/cancel', me, (req, res) => {
    try {
      const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(numOrNull(req.params.id));
      if (!p) return res.status(404).json({ error: 'payment not found' });
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(p.sale_id);
      const visible = visibleBranches(d, req.user);
      if (!visible.some((x) => x.id === sale.branch_id)) return res.status(403).json({ error: 'that sale belongs to another branch' });
      const run = d.transaction(() => {
        const r = pme.cancelPayment(d, { paymentId: p.id, user: req.user, note: (req.body || {}).note });
        if (p.method === 'mpesa') {
          const row = d.prepare(`SELECT id FROM mpesa_log WHERE sale_id = ? ORDER BY id DESC LIMIT 1`).get(p.sale_id);
          if (row) d.prepare(`UPDATE mpesa_log SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
        }
        maybeUnwindSale(d, { saleId: p.sale_id, userId: req.user.id, note: 'payment cancelled' });
        return r;
      });
      run();
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'payment/cancel',
        entity: 'payment', entityId: String(p.id),
        detail: { invoice: sale.invoice_no, method: p.method, amount: p.amount }
      });
      res.json({ ok: true, ...buildSalePayload(d, p.sale_id) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/payments/:id/cancel:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Refund a CONFIRMED payment to its original method (sales.refund = manager+).
  app.post('/api/payments/:id/refund', me, can('sales.refund'), (req, res) => {
    try {
      const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(numOrNull(req.params.id));
      if (!p) return res.status(404).json({ error: 'payment not found' });
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(p.sale_id);
      const run = d.transaction(() =>
        pme.refundPayment(d, { paymentId: p.id, user: req.user, note: (req.body || {}).note }));
      run();
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'payment/refund',
        entity: 'payment', entityId: String(p.id),
        detail: { invoice: sale.invoice_no, method: p.method, amount: p.amount, note: (req.body || {}).note || undefined }
      });
      res.json({ ok: true, ...buildSalePayload(d, p.sale_id) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/payments/:id/refund:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Payment ledger (evidence for every shilling).
  app.get('/api/payments', me, (req, res) => {
    const q = req.query;
    const branches = visibleBranches(d, req.user);
    if (!branches.length) return res.json([]);
    const where = ['s.branch_id IN (' + branches.map((x) => x.id).join(',') + ')'];
    const args = [];
    if (q.method) { where.push('p.method = ?'); args.push(String(q.method)); }
    if (q.status) { where.push('p.status = ?'); args.push(String(q.status)); }
    if (q.sale_id) { where.push('p.sale_id = ?'); args.push(String(q.sale_id)); }
    if (q.from) { where.push('p.created_at >= ?'); args.push(String(q.from)); }
    if (q.to) { where.push('p.created_at < ?'); args.push(String(q.to)); }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const users = d.prepare('SELECT id, name FROM users').all();
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const rows = d.prepare(
      `SELECT p.*, s.invoice_no, b.name AS branch_name,
         (SELECT c.name FROM customers c WHERE c.id = s.customer_id) AS customer_name
        FROM payments p JOIN sales s ON s.id = p.sale_id JOIN branches b ON b.id = s.branch_id
        WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ?`
    ).all(...args, limit);
    res.json(rows.map((r) => ({ ...r, cashier: names[r.user_id] || `#${r.user_id}` })));
  });

  // Per-method reconcile for a date (default: today) — the end-of-day number.
  app.get('/api/payments/reconcile', me, (req, res) => {
    const q = req.query;
    const branches = visibleBranches(d, req.user);
    if (!branches.length) return res.json({ date: q.date || null, by_method: [], total: {} });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || '')) ? String(q.date) : new Date().toISOString().slice(0, 10);
    const rows = d.prepare(
      `SELECT p.method, p.status, COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.branch_id IN (${branches.map((x) => x.id).join(',')})
         AND substr(p.created_at, 1, 10) = ?
       GROUP BY p.method, p.status`
    ).all(date);
    const byMethod = {};
    for (const r of rows) {
      byMethod[r.method] = byMethod[r.method] || { method: r.method, pending: 0, confirmed: 0, refunded: 0, failed: 0, cancelled: 0, pending_n: 0, confirmed_n: 0, refunded_n: 0 };
      byMethod[r.method][r.status] = r.amount;
      byMethod[r.method][`${r.status}_n`] = r.n;
    }
    const by_method = Object.values(byMethod);
    const total = by_method.reduce((a, m) => ({
      pending: a.pending + m.pending, confirmed: a.confirmed + m.confirmed,
      refunded: a.refunded + m.refunded, failed: a.failed + m.failed, cancelled: a.cancelled + m.cancelled
    }), { pending: 0, confirmed: 0, refunded: 0, failed: 0, cancelled: 0 });
    res.json({ date, by_method, total });
  });

  // Deposits: till cash handed to the bank (manager act, evidence kept).
  app.post('/api/deposits', me, can('settings.manage'), (req, res) => {
    const b = req.body || {};
    const amount = intShillings(b.amount);
    if (amount === null || amount <= 0) return res.status(400).json({ error: 'deposit amount must be whole shillings > 0' });
    const registerId = numOrNull(b.register_id);
    let branchId = null;
    if (registerId) {
      const reg = d.prepare('SELECT * FROM registers WHERE id = ?').get(registerId);
      if (!reg) return res.status(404).json({ error: 'register not found' });
      branchId = reg.branch_id;
    }
    const id = d.prepare(
      `INSERT INTO deposits (branch_id, register_id, amount, ref, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(branchId, registerId, amount, String(b.ref || '').trim(), String(b.note || '').trim(), req.user.id, new Date().toISOString()).lastInsertRowid;
    dbm.audit(d, {
      userId: req.user.id, branchId, action: 'deposit/create',
      entity: 'deposit', entityId: String(id), detail: { amount, ref: b.ref || undefined, register: registerId || undefined }
    });
    res.json({ ok: true, deposit: d.prepare('SELECT * FROM deposits WHERE id = ?').get(id) });
  });

  app.get('/api/deposits', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    if (!branches.length) return res.json([]);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const users = d.prepare('SELECT id, name FROM users').all();
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const rows = d.prepare(
      `SELECT dep.*, b.name AS branch_name, reg.name AS register_name
       FROM deposits dep LEFT JOIN branches b ON b.id = dep.branch_id LEFT JOIN registers reg ON reg.id = dep.register_id
       WHERE dep.branch_id IN (${branches.map((x) => x.id).join(',')}) OR dep.branch_id IS NULL
       ORDER BY dep.id DESC LIMIT ?`
    ).all(limit);
    res.json(rows.map((r) => ({ ...r, user: names[r.user_id] || `#${r.user_id}` })));
  });

  // Provider webhook (Daraja posts here in live mode; the sandbox simulate hook
  // exercises the exact same path). No auth — the idempotency guarantee means
  // a retry storm is harmless.
  app.post('/api/webhooks/mpesa', (req, res) => {
    const b = req.body || {};
    const Body = b.Body && b.Body.stkCallback ? b.Body.stkCallback : b;
    const r = d.transaction(() => {
      const out = mpesa.onCallback(d, {
        checkoutRequestId: Body.CheckoutRequestID || Body.MerchantRequestID || b.checkout_request_id,
        mpesaRef: Body.MpesaReceiptRef || b.mpesa_ref,
        result: Body.ResultCode !== undefined ? Body.ResultCode : b.result,
        description: Body.ResultDesc || b.description
      });
      if (out.payment && out.payment.status === 'failed') {
        maybeUnwindSale(d, { saleId: out.payment.sale_id, userId: null, note: 'provider failure' });
      }
      return out;
    })();
    res.json({ ok: true, ...r });
  });

  // Sandbox-only test hook: replay the provider callback for a pending payment.
  app.post('/api/payments/:id/simulate-callback', me, can('settings.manage'), (req, res) => {
    const cfg = pme.paymentConfig(d);
    if (cfg.mpesa.mode !== 'sandbox') return res.status(400).json({ error: 'simulate-callback is available in M-Pesa sandbox mode only' });
    const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(numOrNull(req.params.id));
    if (!p) return res.status(404).json({ error: 'payment not found' });
    if (p.method !== 'mpesa') return res.status(400).json({ error: 'payment is not M-Pesa' });
    const b = req.body || {};
    const r = d.transaction(() => mpesa.onCallback(d, {
      checkoutRequestId: p.ref,
      mpesaRef: String(b.mpesa_ref || 'SIM' + Date.now().toString().slice(-9)),
      result: b.result !== undefined ? b.result : 0,
      description: b.description
    }))();
    dbm.audit(d, {
      userId: req.user.id, branchId: (d.prepare('SELECT branch_id FROM sales WHERE id = ?').get(p.sale_id) || {}).branch_id,
      action: 'payment/simulate-callback', entity: 'payment', entityId: String(p.id),
      detail: { ref: p.ref, result: b.result !== undefined ? b.result : 0 }
    });
    res.json({ ok: true, ...r });
  });

  // Payment settings (owner): method toggles + M-Pesa adapter config.
  app.get('/api/settings/payments', me, (req, res) => {
    const cfg = pme.paymentConfig(d);
    const out = { methods: cfg.methods, mpesa: { ...cfg.mpesa } };
    out.mpesa.consumer_secret = cfg.mpesa.consumer_secret ? '••••' : '';
    res.json(out);
  });

  app.put('/api/settings/payments', me, can('settings.manage'), (req, res) => {
    const b = req.body || {};
    if (b.mpesa && b.mpesa.consumer_secret && b.mpesa.consumer_secret !== '••••') {
      b.mpesa = { ...b.mpesa };
    } else if (b.mpesa) {
      delete b.mpesa.consumer_secret; // never overwrite the secret with a mask
    }
    const next = d.transaction(() => pme.setPaymentConfig(d, b))();
    dbm.audit(d, {
      userId: req.user.id, action: 'settings/payments', entity: 'setting', entityId: 'payments',
      detail: { mpesa_mode: next.mpesa.mode, methods: next.methods }
    });
    res.json({ ok: true });
  });


  // ---- Phase 9: shifts & till control ---------------------------------------
  // A shift = one cashier's session at one till, starting with a known float.
  // The drawer is tracked from the payment engine: expected cash =
  //   float + cash collected − cash refunded − payouts − deposits
  // Closing records the count; the variance is the only number that matters.

  function shiftsConfig(d) {
    return dbm.getSetting(d, 'shifts', { enforced: false }) || { enforced: false };
  }

  function openShiftForUser(d, userId) {
    return d.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open'`).get(userId) || null;
  }

  function shiftCashState(d, shift) {
    const end = shift.closed_at || new Date().toISOString();
    const [reg, uid] = [shift.register_id, shift.user_id];
    // Cash ever collected for this till+cashier in the window (still in, or later
    // refunded — the refund is subtracted below exactly once).
    const cashIn = d.prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS s FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE p.method = 'cash' AND p.status IN ('confirmed', 'refunded')
         AND s.register_id = ? AND s.user_id = ? AND s.created_at >= ? AND s.created_at < ?`
    ).get(reg, uid, shift.opened_at, end).s;
    // Cash that physically left the drawer while this shift was running —
    // whoever made the sale, the money came out of THIS drawer.
    const cashOut = d.prepare(
      `SELECT COALESCE(SUM(p.refunded), 0) AS s FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE p.method = 'cash' AND p.refunded > 0
         AND s.register_id = ? AND s.user_id = ? AND p.updated_at IS NOT NULL
         AND p.updated_at >= ? AND p.updated_at < ?`
    ).get(reg, uid, shift.opened_at, end).s;
    const payouts = reg || uid
      ? d.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM shift_payouts WHERE shift_id = ?`).get(shift.id).s
      : 0;
    const deposits = reg
      ? d.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM deposits WHERE register_id = ? AND created_at >= ? AND created_at < ?`).get(reg, shift.opened_at, end).s
      : 0;
    const expected = shift.float_open + cashIn - cashOut - payouts - deposits;
    return { cashIn, cashOut, payouts, deposits, expected };
  }

  function shiftPayload(d, shift) {
    const cash = shiftCashState(d, shift);
    const user = shift.user_id ? d.prepare('SELECT name FROM users WHERE id = ?').get(shift.user_id) : null;
    const reg = shift.register_id ? d.prepare('SELECT name FROM registers WHERE id = ?').get(shift.register_id) : null;
    const branch = d.prepare('SELECT name FROM branches WHERE id = ?').get(shift.branch_id);
    return {
      ...shift,
      cashier: user ? user.name : `#${shift.user_id}`,
      register_name: reg ? reg.name : (shift.terminal || ''),
      branch_name: branch ? branch.name : '',
      cash_in: cash.cashIn, cash_refunded: cash.cashOut,
      payouts: cash.payouts, deposits: cash.deposits,
      expected_cash: cash.expected,
      payout_rows: d.prepare('SELECT * FROM shift_payouts WHERE shift_id = ? ORDER BY id').all(shift.id)
    };
  }

  function requireOpenShift(d, user) {
    if (!shiftsConfig(d).enforced) return;
    if (user.role !== 'cashier') return; // owner/manager are not till-bound
    if (openShiftForUser(d, user.id)) return;
    throw httpError(403, 'open a shift before selling (till control is enforced for this business)');
  }

  // Open a shift: one open shift per cashier, at a real till, with a float.
  app.post('/api/shifts', me, (req, res) => {
    try {
      const b = req.body || {};
      const ctx = saleContext(d, req.user);
      let register = null;
      if (b.register_id) {
        const rid = numOrNull(b.register_id);
        const visible = visibleBranches(d, req.user);
        register = rid ? d.prepare('SELECT * FROM registers WHERE id = ? AND active = 1').get(rid) : null;
        if (!register || !visible.some((x) => x.id === register.branch_id)) throw httpError(400, 'register not found for this user');
      } else {
        register = ctx.register;
      }
      if (!register) throw httpError(400, 'no till for this user — assign a register first (or pass register_id)');
      if (openShiftForUser(d, req.user.id)) throw httpError(409, 'you already have an open shift — close it first');
      const float = intShillings(b.float_open);
      if (float === null) throw httpError(400, 'float_open must be whole shillings (0 is allowed)');
      const t = new Date().toISOString();
      const id = d.prepare(
        `INSERT INTO shifts (branch_id, terminal, register_id, user_id, status, opened_at, float_open, expected_cash, note)
         VALUES (?, ?, ?, ?, 'open', ?, ?, 0, ?)`
      ).run(register.branch_id, register.name, register.id, req.user.id, t, float, String(b.note || '').trim()).lastInsertRowid;
      d.prepare(`INSERT INTO timeclock (user_id, branch_id, event, at) VALUES (?, ?, 'in', ?)`).run(req.user.id, register.branch_id, t);
      dbm.audit(d, {
        userId: req.user.id, branchId: register.branch_id, action: 'shift/open',
        entity: 'shift', entityId: String(id), detail: { float: float, register: register.name }
      });
      res.json({ ok: true, shift: shiftPayload(d, d.prepare('SELECT * FROM shifts WHERE id = ?').get(id)) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/shifts:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/shifts', me, (req, res) => {
    const q = req.query;
    const branches = visibleBranches(d, req.user);
    if (!branches.length) return res.json([]);
    const where = ['b.id IN (' + branches.map((x) => x.id).join(',') + ')'];
    const args = [];
    if (q.status) { where.push('sh.status = ?'); args.push(String(q.status)); }
    if (q.register_id) { where.push('sh.register_id = ?'); args.push(String(q.register_id)); }
    if (q.from) { where.push('sh.opened_at >= ?'); args.push(String(q.from)); }
    if (q.to) { where.push('sh.opened_at < ?'); args.push(String(q.to)); }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const rows = d.prepare(
      `SELECT sh.*, b.name AS branch_name FROM shifts sh JOIN branches b ON b.id = sh.branch_id
       WHERE ${where.join(' AND ')} ORDER BY sh.id DESC LIMIT ?`
    ).all(...args, limit);
    res.json(rows.map((sh) => shiftPayload(d, sh)));
  });

  // The till header: my current shift (or none) + whether selling is gated.
  app.get('/api/shifts/mine', me, (req, res) => {
    const shift = openShiftForUser(d, req.user.id);
    res.json({ shift: shift ? shiftPayload(d, shift) : null, enforced: !!shiftsConfig(d).enforced });
  });

  // Payout = cash leaving the drawer during the shift (audited, on the close report).
  app.post('/api/shifts/:id/payouts', me, (req, res) => {
    try {
      const shift = d.prepare('SELECT * FROM shifts WHERE id = ?').get(numOrNull(req.params.id));
      if (!shift) return res.status(404).json({ error: 'shift not found' });
      if (shift.status !== 'open') return res.status(400).json({ error: 'shift is closed' });
      if (shift.user_id !== req.user.id) return res.status(403).json({ error: 'cashiers can only make payouts on their own shift' });
      const b = req.body || {};
      const amount = intShillings(b.amount);
      if (amount === null || amount <= 0) return res.status(400).json({ error: 'payout must be whole shillings > 0' });
      const run = d.transaction(() => {
        d.prepare('INSERT INTO shift_payouts (shift_id, amount, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(shift.id, amount, String(b.reason || '').trim(), req.user.id, new Date().toISOString());
      });
      run();
      dbm.audit(d, {
        userId: req.user.id, branchId: shift.branch_id, action: 'shift/payout',
        entity: 'shift', entityId: String(shift.id), detail: { amount, reason: b.reason || undefined }
      });
      res.json({ ok: true, shift: shiftPayload(d, d.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id)) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/shifts/:id/payouts:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Close a shift: record the count, compute expected + variance, no double-close.
  app.post('/api/shifts/:id/close', me, (req, res) => {
    try {
      const shift = d.prepare('SELECT * FROM shifts WHERE id = ?').get(numOrNull(req.params.id));
      if (!shift) return res.status(404).json({ error: 'shift not found' });
      if (shift.status !== 'open') return res.status(409).json({ error: 'shift is already closed' });
      const isSelf = shift.user_id === req.user.id;
      if (!isSelf && !['owner', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ error: 'only the shift cashier (or a manager/owner) can close this shift' });
      }
      const b = req.body || {};
      const counted = intShillings(b.counted_cash);
      if (counted === null || counted < 0) return res.status(400).json({ error: 'counted_cash must be whole shillings >= 0' });
      const cash = shiftCashState(d, shift);
      const variance = counted - cash.expected;
      const t = new Date().toISOString();
      const run = d.transaction(() => {
        d.prepare(`UPDATE shifts SET status = 'closed', closed_at = ?, expected_cash = ?, counted_cash = ?, variance = ?, note = ? WHERE id = ?`)
          .run(t, cash.expected, counted, variance, String(b.note || '').trim() || shift.note, shift.id);
        d.prepare(`INSERT INTO timeclock (user_id, branch_id, event, at) VALUES (?, ?, 'out', ?)`).run(shift.user_id, shift.branch_id, t);
      });
      run();
      dbm.audit(d, {
        userId: req.user.id, branchId: shift.branch_id, action: 'shift/close',
        entity: 'shift', entityId: String(shift.id),
        detail: { float: shift.float_open, cash_in: cash.cashIn, cash_refunded: cash.cashOut, payouts: cash.payouts,
          deposits: cash.deposits, expected: cash.expected, counted, variance, bySelf: isSelf, note: b.note || undefined }
      });
      res.json({ ok: true, shift: shiftPayload(d, d.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id)) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/shifts/:id/close:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Till control switch (owner): when enforced, cashiers cannot sell without an open shift.
  app.get('/api/settings/shifts', me, (req, res) => {
    res.json(shiftsConfig(d));
  });

  app.put('/api/settings/shifts', me, can('settings.manage'), (req, res) => {
    const b = req.body || {};
    const cur = shiftsConfig(d);
    const next = { enforced: !!cur.enforced };
    if (typeof b.enforced === 'boolean') next.enforced = b.enforced;
    dbm.setSetting(d, 'shifts', next);
    dbm.audit(d, { userId: req.user.id, action: 'settings/shifts', entity: 'setting', entityId: 'shifts', detail: next });
    res.json({ ok: true, ...next });
  });

  // ---- Phase 10: returns & exchanges ------------------------------------------
  // Nothing is edited in place: a return is its own document (RET-#) whose
  // lines point at the exact sale_items it undoes, the batch the goods land
  // in, and whether they came back into stock. The money goes back through
  // the payment engine — partial refunds to the ORIGINAL method, newest
  // payment first — or into the customer's store credit. An exchange is a
  // return + a replacement sale carrying an "exchange credit" discount worth
  // the returned value; the price diff settles exactly (pay more, or the
  // difference is refunded). Every correction references its original.
  const RETURN_REASONS = ['wrong_item', 'damaged', 'defective', 'customer_changed_mind', 'other'];

  function returnsConfig(d) {
    const s = d.prepare('SELECT value FROM settings WHERE key = ?').get('returns');
    const cur = s ? JSON.parse(s.value) : {};
    return { cashier_limit: Number(cur.cashier_limit) || 5000 };
  }

  function returnPayload(d, retId) {
    const r = d.prepare(
      `SELECT rt.*, s.invoice_no AS sale_invoice, u.name AS cashier, b.name AS branch_name
       FROM returns rt
       JOIN sales s ON s.id = rt.sale_id
       JOIN branches b ON b.id = rt.branch_id
       LEFT JOIN users u ON u.id = rt.user_id
       WHERE rt.id = ?`
    ).get(retId);
    if (!r) return null;
    const items = d.prepare(
      `SELECT ri.*, si.batch_id AS sale_item_batch
       FROM return_items ri JOIN sale_items si ON si.id = ri.sale_item_id
       WHERE ri.return_id = ?`
    ).all(retId);
    const ex = d.prepare(`SELECT * FROM exchanges WHERE return_id = ?`).get(retId);
    const cust = r.customer_id ? d.prepare('SELECT id, name, store_credit FROM customers WHERE id = ?').get(r.customer_id) : null;
    return { ...r, items, exchange: ex || null, customer: cust };
  }

  // Push `amount` back out of the sale's confirmed payments, newest first,
  // to the original method (partial refunds supported). Throws 409 when the
  // sale has no money left to refund.
  function refundAcrossPayments(d, { sale, amount, user, note }) {
    const pays = d.prepare(
      `SELECT id, amount, refunded FROM payments
       WHERE sale_id = ? AND status = 'confirmed' AND refunded < amount ORDER BY id DESC`
    ).all(sale.id);
    const rows = [];
    let left = amount;
    for (const p of pays) {
      if (left <= 0) break;
      const amt = Math.min(left, p.amount - (p.refunded || 0));
      const r = pme.refundPayment(d, { paymentId: p.id, user, note, amount: amt });
      rows.push(r.payment);
      left -= r.amount;
    }
    if (left > 0) throw httpError(409, `only ${amount - left} is left to refund on ${sale.invoice_no} (short ${left})`);
    return rows;
  }

  // Validate return lines against a sale. Returns { plan, total } where each
  // plan row carries the sale_item, qty, proration amount and restock flag.
  function planReturnLines(d, sale, linesBody) {
    if (!Array.isArray(linesBody) || !linesBody.length) {
      throw httpError(400, 'lines required: [{sale_item_id, qty, restock}]');
    }
    const items = d.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.id);
    const perItem = new Map(items.map((i) => [i.id, i]));
    const used = d.prepare(
      `SELECT ri.sale_item_id, COALESCE(SUM(ri.qty), 0) AS q FROM return_items ri
       JOIN returns rt ON rt.id = ri.return_id WHERE rt.sale_id = ? GROUP BY ri.sale_item_id`
    ).all(sale.id);
    const usedMap = new Map(used.map((u) => [u.sale_item_id, u.q]));
    const plan = [];
    let total = 0;
    for (const ln of linesBody) {
      const si = perItem.get(numOrNull(ln.sale_item_id));
      if (!si) throw httpError(400, `unknown sale_item ${ln.sale_item_id}`);
      const qty = Number(ln.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw httpError(400, 'qty must be positive');
      const avail = si.qty - (usedMap.get(si.id) || 0);
      if (qty > avail + 1e-9) throw httpError(400, `only ${avail} of "${si.name}" left to return`);
      const amount = Math.round((si.gross * qty) / si.qty);
      const restock = ln.restock === false ? 0 : 1;
      plan.push({ si, qty, amount, restock });
      total += amount;
    }
    if (total <= 0) throw httpError(400, 'nothing to return');
    return { plan, total };
  }

  // Write one return document (header + items + restock stock moves).
  // Call inside a transaction.
  function insertReturn(d, { sale, plan, total, reason, refundAs, note, user, t }) {
    const returnNo = dbm.nextCounter(d, 'ret', 'RET-');
    const rid = d.prepare(
      `INSERT INTO returns (branch_id, sale_id, return_no, user_id, customer_id, total, reason, refund_as, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sale.branch_id, sale.id, returnNo, user.id, sale.customer_id || null, total, reason, refundAs,
      String(note || '').trim(), t).lastInsertRowid;
    const insItem = d.prepare(
      `INSERT INTO return_items (return_id, sale_item_id, sale_item_batch_id, variant_id, name, qty, unit, net, tax, gross, restock)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    );
    for (const p of plan) {
      insItem.run(rid, p.si.id, p.si.batch_id, p.si.variant_id, p.si.name, p.qty,
        Math.round((p.si.net * p.qty) / p.si.qty), Math.round((p.si.tax * p.qty) / p.si.qty), p.amount, p.restock);
      if (p.restock) {
        const variant = d.prepare('SELECT * FROM variants WHERE id = ?').get(p.si.variant_id);
        const product = d.prepare('SELECT * FROM products WHERE id = ?').get(p.si.product_id);
        if (variant && product) {
          addStockMove(d, {
            product, variant, branchId: sale.branch_id, locationId: sale.location_id,
            qty: p.qty, type: 'return_in', reason: 'return_in', ref: returnNo,
            batchId: p.si.batch_id, userId: user.id,
            note: `return ${returnNo} of ${sale.invoice_no}`
          });
          if (p.si.batch_id) d.prepare('UPDATE batches SET qty = qty + ? WHERE id = ?').run(p.qty, p.si.batch_id);
          upsertStock(d, p.si.variant_id, sale.location_id, p.qty);
        }
      }
    }
    return { rid, returnNo };
  }

  // ---- returns ---------------------------------------------------------------

  app.post('/api/returns', me, (req, res) => {
    try {
      const b = req.body || {};
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(numOrNull(b.sale_id));
      if (!sale || !visibleBranches(d, req.user).some((x) => x.id === sale.branch_id)) {
        return res.status(404).json({ error: 'sale not found' });
      }
      if (['voided', 'refunded', 'suspended'].includes(sale.status)) {
        return res.status(409).json({ error: `cannot return a ${sale.status} sale` });
      }
      const reason = String(b.reason || 'other').trim();
      if (!RETURN_REASONS.includes(reason)) {
        return res.status(400).json({ error: `reason must be one of: ${RETURN_REASONS.join(', ')}` });
      }
      const refundAs = b.refund_as === 'store_credit' ? 'store_credit' : 'money';
      if (refundAs === 'store_credit' && !sale.customer_id) {
        return res.status(400).json({ error: 'store credit needs a customer attached to the sale' });
      }
      const { plan, total } = planReturnLines(d, sale, b.lines);
      // Approval rule: cashiers up to their limit, managers/owners unlimited.
      const cfg = returnsConfig(d);
      if (req.user.role === 'cashier' && total > cfg.cashier_limit) {
        return res.status(403).json({ error: `return of ${total} exceeds your limit of ${cfg.cashier_limit} — ask a manager` });
      }
      const t = new Date().toISOString();
      const run = d.transaction(() => {
        const { rid, returnNo } = insertReturn(d, { sale, plan, total, reason, refundAs, note: b.note, user: req.user, t });
        let refundRows = [];
        let creditAdded = 0;
        if (refundAs === 'money') {
          refundRows = refundAcrossPayments(d, { sale, amount: total, user: req.user, note: `return ${returnNo}` });
        } else {
          d.prepare('UPDATE customers SET store_credit = store_credit + ? WHERE id = ?').run(total, sale.customer_id);
          d.prepare(
            `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
             VALUES (?, 'adjustment', ?, ?, ?, ?, ?)`
          ).run(sale.customer_id, total, returnNo, req.user.id, `store credit for return ${returnNo} (${sale.invoice_no})`, t);
          creditAdded = total;
        }
        return { rid, returnNo, refundRows, creditAdded };
      });
      const out = run();
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'sale/return',
        entity: 'return', entityId: String(out.rid),
        detail: {
          return_no: out.returnNo, sale: sale.invoice_no, total, reason, refund_as: refundAs,
          lines: plan.map((p) => ({ item: p.si.id, qty: p.qty, restock: !!p.restock })),
          refunded: out.refundRows.length ? out.refundRows.map((r) => `${r.method}:${r.amount}`) : undefined,
          store_credit: out.creditAdded || undefined
        }
      });
      res.json({
        ok: true,
        return: returnPayload(d, out.rid),
        refund_rows: out.refundRows,
        store_credit_added: out.creditAdded,
        sale: buildSalePayload(d, sale.id)
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/returns:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/returns', me, (req, res) => {
    const q = req.query;
    const branches = visibleBranches(d, req.user);
    const where = ['b.id IN (' + branches.map((x) => x.id).join(',') + ')'];
    const args = [];
    if (q.sale_id) { where.push('rt.sale_id = ?'); args.push(numOrNull(q.sale_id)); }
    if (q.reason) { where.push('rt.reason = ?'); args.push(String(q.reason)); }
    if (q.from) { where.push('rt.created_at >= ?'); args.push(String(q.from)); }
    if (q.to) { where.push('rt.created_at < ?'); args.push(String(q.to)); }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const rows = d.prepare(
      `SELECT rt.*, s.invoice_no AS sale_invoice, u.name AS cashier, b.name AS branch_name,
              (SELECT COUNT(*) FROM exchanges ex WHERE ex.return_id = rt.id) AS exchanged
       FROM returns rt
       JOIN sales s ON s.id = rt.sale_id
       JOIN branches b ON b.id = rt.branch_id
       LEFT JOIN users u ON u.id = rt.user_id
       WHERE ${where.join(' AND ')} ORDER BY rt.id DESC LIMIT ?`
    ).all(...args, limit);
    res.json(rows.map((r) => ({ ...r, items: d.prepare('SELECT * FROM return_items WHERE return_id = ?').all(r.id) })));
  });

  // ---- exchanges ---------------------------------------------------------------

  app.post('/api/exchanges', me, (req, res) => {
    try {
      const b = req.body || {};
      const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(numOrNull(b.sale_id));
      if (!sale || !visibleBranches(d, req.user).some((x) => x.id === sale.branch_id)) {
        return res.status(404).json({ error: 'sale not found' });
      }
      if (['voided', 'refunded', 'suspended'].includes(sale.status)) {
        return res.status(409).json({ error: `cannot exchange items from a ${sale.status} sale` });
      }
      const reason = String(b.reason || 'other').trim();
      if (!RETURN_REASONS.includes(reason)) {
        return res.status(400).json({ error: `reason must be one of: ${RETURN_REASONS.join(', ')}` });
      }
      const { plan, total: returnedTotal } = planReturnLines(d, sale, b.lines);
      const cfg = returnsConfig(d);
      if (req.user.role === 'cashier' && returnedTotal > cfg.cashier_limit) {
        return res.status(403).json({ error: `exchange of ${returnedTotal} exceeds your limit of ${cfg.cashier_limit} — ask a manager` });
      }
      const ctx = saleContext(d, req.user);
      if (!ctx.branchId || !ctx.locationId) return res.status(400).json({ error: 'no selling location for this user' });
      if (ctx.branchId !== sale.branch_id) {
        return res.status(400).json({ error: 'exchange must happen at the same branch as the sale' });
      }
      const approver = b.override_pin ? supervisorFromPin(b.override_pin)
        : (perms.userHasPerm(d, req.user, 'sales.discount') ? req.user : null);
      if (!approver) {
        return res.status(403).json({ error: 'exchange credit needs the sales.discount permission or a supervisor PIN' });
      }
      const vatRate = Number((dbm.getSetting(d, 'tax', {}) || {}).vatRate) || 0;
      // Price the replacement lines (full price, frozen). The exchange credit
      // - worth the returned value, tax-inclusive - is spread across them as
      // PRE-TAX line discounts, largest line first. The sale's actual
      // tax-inclusive balance is then the exact amount the customer owes
      // (pay the diff) or, when the credit covers everything, what we refund.
      const resolved = [];
      for (const it of (Array.isArray(b.items) ? b.items : [])) {
        const variantId = numOrNull(it.variant_id);
        const qty = Number(it.qty);
        if (!variantId) return res.status(400).json({ error: 'variant_id required on each exchange item' });
        if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be positive' });
        const variant = d.prepare('SELECT * FROM variants WHERE id = ? AND active = 1').get(variantId);
        if (!variant) return res.status(404).json({ error: `unknown variant ${variantId}` });
        const product = d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(variant.product_id);
        if (!product) return res.status(404).json({ error: 'unknown product' });
        if (product.requires_rx) return res.status(403).json({ error: `${product.name} requires a prescription` });
        if (product.is_controlled) return res.status(403).json({ error: `${product.name} is controlled — licensed workflow required` });
        if (product.age_min && !it.age_verified) {
          return res.status(400).json({ error: `${product.name}: age verification required (${product.age_min}+)` });
        }
        const px = resolvePrice(d, { variantId, branchId: ctx.branchId, customerId: sale.customer_id, promoCode: null });
        if (px.error) return res.status(px.status || 400).json({ error: px.error });
        resolved.push({ it, variant, product, qty, unitPrice: px.price, lineTotal: Math.round(px.price * qty) });
      }
      if (!resolved.length) return res.status(400).json({ error: 'items required (the replacement lines)' });
      const ttOf = (L) => eff(L.product, L.variant, 'tax_type') || 'std';
      const grossOf = (L, disc) => {
        const tt = ttOf(L);
        const net = L.lineTotal - disc;
        return net + lineTax(net, tt, vatRate);
      };
      const W_full = resolved.reduce((s2, L) => s2 + grossOf(L, 0), 0);
      // Pass 1: best-effort pre-tax discount for the tax-inclusive target.
      let creditLeft = returnedTotal;
      for (const L of [...resolved].sort((a, z) => z.lineTotal - a.lineTotal)) {
        if (creditLeft <= 0) { L.disc = 0; continue; }
        const fullGross = grossOf(L, 0);
        const take = Math.min(fullGross, creditLeft);
        L.disc = (take >= fullGross)
          ? L.lineTotal
          : (ttOf(L) === 'std' && vatRate ? Math.round((take * (100 + vatRate)) / (100 + 2 * vatRate)) : take);
        creditLeft -= fullGross - grossOf(L, L.disc);
        if (creditLeft < 0) creditLeft = 0;
      }
      // Pass 2: absorb VAT rounding (+/-1-2 per line) on a partial line so the
      // tax-inclusive credit used equals min(returned, W_full) to the shilling.
      const target = Math.min(returnedTotal, W_full);
      const usedCredit = () => resolved.reduce((s2, L) => s2 + (grossOf(L, 0) - grossOf(L, L.disc)), 0);
      let used = usedCredit();
      for (let i = 0; i < 8 && used !== target; i++) {
        const partial = resolved.filter((L) => L.disc > 0 && L.disc < L.lineTotal);
        if (!partial.length) break;
        const tried = new Set();
        let hit = false;
        for (let off = 0; off < 2 * partial.length && !hit; off++) {
          const L = partial[off % partial.length];
          const delta = (off < partial.length ? 1 : 2) * (used < target ? 1 : -1);
          const d2 = L.disc + delta;
          if (d2 < 0 || d2 > L.lineTotal || tried.has(L.variant.id + ':' + d2)) continue;
          tried.add(L.variant.id + ':' + d2);
          const prev = L.disc;
          L.disc = d2;
          if (usedCredit() === target) { hit = true; used = usedCredit(); break; }
          L.disc = prev;
        }
        if (!hit) break;
      }
      const prepared = prepareSaleLines(d, {
        user: req.user, ctx, customerId: sale.customer_id, promoCode: null,
        items: resolved.map((L) => ({
          variant_id: L.variant.id, qty: L.qty, line_discount: L.disc,
          line_note: String(L.it.line_note || '').trim(), age_verified: L.it.age_verified
        })),
        approver, allowOversell: false
      });
      const totals = saleTotals(prepared.lines);
      const diff = W_full - returnedTotal; // nominal price diff, VAT-inclusive
      const owed = totals.gross;           // actual balance after the credit
      const settle = b.settle || {};
      const t = new Date().toISOString();
      const biz = dbm.getSetting(d, 'business', {}) || {};
      const run = d.transaction(() => {
        const { rid, returnNo } = insertReturn(d, { sale, plan, total: returnedTotal, reason, refundAs: 'money', note: `exchange ${String(b.note || '').trim()}`, user: req.user, t });
        const orderNo = nextOrderNo(d, ctx.branchId);
        const invoiceNo = `${ctx.branch.code || 'BR'}-${String(orderNo).padStart(6, '0')}`;
        const newSaleId = d.prepare(
          `INSERT INTO sales (branch_id, location_id, register_id, terminal, order_no, invoice_no, customer_id, user_id, status,
             subtotal, discount, net, tax, gross, tender, note, etims_status, discount_by, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, '[]', ?, ?, ?, 'sale', ?)`
        ).run(ctx.branchId, ctx.locationId, ctx.register ? ctx.register.id : null, ctx.register ? ctx.register.name : '',
          orderNo, invoiceNo, prepared.customer ? prepared.customer.id : null, req.user.id,
          totals.subtotal, totals.discount, totals.net, totals.tax, totals.gross,
          `exchange for return ${returnNo}`, biz.kraPin ? 'pending' : 'exempt', approver.id, t).lastInsertRowid;
        moveStockForSale(d, { user: req.user, ctx, lines: prepared.lines, ref: invoiceNo, allowOversell: false });
        const newSale = d.prepare('SELECT * FROM sales WHERE id = ?').get(newSaleId);
        const ins = d.prepare(
          `INSERT INTO sale_items (sale_id, product_id, variant_id, name, qty, unit, line_discount, net, tax, gross, tax_type, kra_item_code, batch_id, line_note, age_verified, unit_price)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const L of prepared.lines) {
          ins.run(newSaleId, L.product.id, L.variant.id, L.product.name + (L.variant.name ? ` — ${L.variant.name}` : ''),
            L.qty, L.disc, L.net, L.tax, L.gross, L.taxType, L.kra, L.batchId, L.note, L.age, L.unitPrice);
        }
        let payRes = null;
        let refundRows = [];
        if (owed > 0) {
          // Pay the ACTUAL balance (credit already shrank the sale).
          payRes = applyPayment(d, {
            user: req.user, saleId: newSaleId, sale: newSale, discountBy: approver.id,
            payment: {
              method: String(settle.method || 'cash').trim(), amount: owed,
              ref: settle.ref, phone: settle.phone,
              tendered: settle.tendered !== undefined ? settle.tendered : owed
            }
          });
        } else if (diff < 0) {
          // Credit covered the new items and then some: refund the excess
          // to the ORIGINAL sale's payments (exact: credit == W_full here).
          refundRows = refundAcrossPayments(d, { sale, amount: -diff, user: req.user, note: `exchange ${returnNo}` });
          pme.recomputeSale(d, newSaleId); // fully-credited sale: gross 0, paid
        }
        const exNo = dbm.nextCounter(d, 'exch', 'EX-');
        const exId = d.prepare(
          `INSERT INTO exchanges (branch_id, exchange_no, return_id, new_sale_id, user_id, customer_id,
             returned_total, new_total, diff, settled_by, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(sale.branch_id, exNo, rid, newSaleId, req.user.id, sale.customer_id || null,
          returnedTotal, W_full, diff, owed > 0 ? 'payment' : (diff < 0 ? 'refund' : 'none'),
          String(b.note || '').trim(), t).lastInsertRowid;
        const insExItem = d.prepare(
          `INSERT INTO exchange_items (exchange_id, variant_id, name, qty, unit, net, tax, gross)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
        );
        for (const L of prepared.lines) {
          insExItem.run(exId, L.variant.id, L.product.name + (L.variant.name ? ` — ${L.variant.name}` : ''), L.qty, L.net, L.tax, L.gross);
        }
        return { rid, returnNo, exId, exNo, newSaleId, invoiceNo, payRes, refundRows };
      });
      const out = run();
      dbm.audit(d, {
        userId: req.user.id, branchId: sale.branch_id, action: 'sale/exchange',
        entity: 'exchange', entityId: String(out.exId),
        detail: {
          exchange_no: out.exNo, return_no: out.returnNo, sale: sale.invoice_no, new_sale: out.invoiceNo,
          returned: returnedTotal, new_total: W_full, diff,
          settled_by: owed > 0 ? 'payment' : (diff < 0 ? 'refund' : 'none'),
          refund_rows: out.refundRows.length ? out.refundRows.map((r) => `${r.method}:${r.amount}`) : undefined,
          pending: out.payRes && out.payRes.payment.status === 'pending'
        }
      });
      res.json({
        ok: true,
        exchange: d.prepare(`SELECT * FROM exchanges WHERE id = ?`).get(out.exId),
        return: returnPayload(d, out.rid),
        sale: buildSalePayload(d, out.newSaleId),
        refund_rows: out.refundRows
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/exchanges:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/exchanges', me, (req, res) => {
    const q = req.query;
    const branches = visibleBranches(d, req.user);
    const where = ['b.id IN (' + branches.map((x) => x.id).join(',') + ')'];
    const args = [];
    if (q.from) { where.push('ex.created_at >= ?'); args.push(String(q.from)); }
    if (q.to) { where.push('ex.created_at < ?'); args.push(String(q.to)); }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const rows = d.prepare(
      `SELECT ex.*, rt.return_no, rt.reason, s.invoice_no AS sale_invoice, ns.invoice_no AS new_invoice,
              u.name AS cashier, b.name AS branch_name
       FROM exchanges ex
       JOIN returns rt ON rt.id = ex.return_id
       JOIN sales s ON s.id = rt.sale_id
       LEFT JOIN sales ns ON ns.id = ex.new_sale_id
       JOIN branches b ON b.id = ex.branch_id
       LEFT JOIN users u ON u.id = ex.user_id
       WHERE ${where.join(' AND ')} ORDER BY ex.id DESC LIMIT ?`
    ).all(...args, limit);
    res.json(rows.map((r) => ({ ...r, items: d.prepare('SELECT * FROM exchange_items WHERE exchange_id = ?').all(r.id) })));
  });

  // ---- returns settings (approval limit) ---------------------------------------

  app.get('/api/settings/returns', me, (req, res) => {
    res.json({ returns: returnsConfig(d) });
  });

  app.put('/api/settings/returns', me, can('settings.manage'), (req, res) => {
    const r = req.body || {};
    const next = { cashier_limit: Number.isInteger(r.cashier_limit) && r.cashier_limit >= 0 ? r.cashier_limit : null };
    if (next.cashier_limit === null) return res.status(400).json({ error: 'cashier_limit must be a whole number ≥ 0' });
    d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('returns', JSON.stringify({ cashier_limit: next.cashier_limit }));
    dbm.audit(d, { userId: req.user.id, action: 'settings/returns', entity: 'setting', entityId: 'returns', detail: next });
    res.json({ ok: true, returns: next });
  });

  // ---- Phase 11: customers & deni ----------------------------------------------
  // Phone-first profiles: the duka knows the number before the name. A
  // repayment is money the customer hands back for their deni — it leaves
  // ledger evidence (customer_ledger 'repayment'), a till deposit when the
  // money is cash, and an audit row. The statement is the ledger itself,
  // so a printed statement can never drift from what the books say.
  function deniOutstanding(d, customerId) {
    return d.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount WHEN type = 'repayment' THEN -amount ELSE 0 END), 0) AS b
       FROM customer_ledger WHERE customer_id = ?`
    ).get(customerId).b;
  }

  function customerRow(d, id) {
    return d.prepare(
      `SELECT c.*,
         (SELECT COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount WHEN type = 'repayment' THEN -amount ELSE 0 END), 0)
          FROM customer_ledger WHERE customer_id = c.id) AS deni_outstanding,
         (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id) AS last_purchase,
         (SELECT COALESCE(SUM(s.gross), 0) FROM sales s WHERE s.customer_id = c.id AND s.status IN ('paid', 'partial')) AS total_purchases
       FROM customers c WHERE c.id = ?`
    ).get(id);
  }

  // Branch visibility (R-2): non-owners only see customers of their own
  // branches plus customers not tied to a branch (shared/central records).
  function customerVisible(user, c) {
    if (!c) return false;
    if (user.role === 'owner') return true;
    const vis = visibleBranches(d, user).map((b) => b.id);
    return c.branch_id == null || vis.includes(c.branch_id);
  }

  app.get('/api/customers', me, can('customers.view'), (req, res) => {
    const q = String(req.query.q || '').trim();
    const args = [];
    const parts = [];
    if (req.user.role !== 'owner') {
      const vis = visibleBranches(d, req.user).map((b) => b.id);
      parts.push(`(c.branch_id IS NULL OR c.branch_id IN (${vis.map(() => '?').join(',')}))`);
      args.push(...vis);
    }
    if (q) { parts.push('(c.name LIKE ? OR c.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const where = parts.length ? parts.join(' AND ') : '1=1';
    const rows = d.prepare(
      `SELECT c.*,
         (SELECT COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount WHEN type = 'repayment' THEN -amount ELSE 0 END), 0)
          FROM customer_ledger WHERE customer_id = c.id) AS deni_outstanding,
         (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id) AS last_purchase,
         (SELECT COALESCE(SUM(s.gross), 0) FROM sales s WHERE s.customer_id = c.id AND s.status IN ('paid', 'partial')) AS total_purchases
       FROM customers c WHERE ${where} ORDER BY c.name LIMIT 500`
    ).all(...args);
    res.json(rows);
  });

  app.post('/api/customers', me, can('customers.manage'), (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      const phone = String(b.phone || '').trim();
      const email = String(b.email || '').trim();
      const kraPin = String(b.kra_pin || '').trim();
      const tier = TIERS.includes(b.tier) ? b.tier : 'standard';
      const creditLimit = Number.isInteger(b.credit_limit) && b.credit_limit >= 0 ? b.credit_limit : 0;
      const note = String(b.note || '').trim();
      const birthday = b.birthday ? String(b.birthday).trim() : null;
      const branches = visibleBranches(d, req.user);
      const branchId = numOrNull(b.branch_id) && branches.some((x) => x.id === b.branch_id) ? b.branch_id : null;
      const t = new Date().toISOString();
      // Phone-first: same number = same customer (update, never duplicate).
      const existing = phone ? d.prepare('SELECT * FROM customers WHERE phone = ?').get(phone) : null;
      let id = existing ? existing.id : null;
      const run = d.transaction(() => {
        if (existing) {
          d.prepare(
            `UPDATE customers SET name = ?, email = ?, kra_pin = ?, credit_limit = ?, tier = ?, birthday = ?, note = ?, branch_id = ? WHERE id = ?`
          ).run(name, email, kraPin, creditLimit, tier, birthday, note, branchId, existing.id);
        } else {
          id = d.prepare(
            `INSERT INTO customers (business_id, branch_id, name, phone, email, kra_pin, credit_limit, tier, birthday, note, created_at)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(branchId, name, phone, email, kraPin, creditLimit, tier, birthday, note, t).lastInsertRowid;
        }
        return id;
      });
      id = run();
      dbm.audit(d, {
        userId: req.user.id, branchId: branchId, action: existing ? 'customer/update' : 'customer/create',
        entity: 'customer', entityId: String(id),
        detail: { name, phone, credit_limit: creditLimit, existed: !!existing }
      });
      res.json({ ok: true, existed: !!existing, customer: customerRow(d, id) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/customers:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/customers/:id', me, can('customers.view'), (req, res) => {
    const id = numOrNull(req.params.id);
    const c = customerRow(d, id);
    if (!customerVisible(req.user, c)) return res.status(404).json({ error: 'customer not found' });
    const ledger = d.prepare(
      `SELECT id, type, amount, ref, note, created_at FROM customer_ledger WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`
    ).all(id);
    // running balance (deni) over the full ledger, oldest first
    const all = d.prepare(
      `SELECT id, type, amount FROM customer_ledger WHERE customer_id = ? ORDER BY created_at ASC, id ASC`
    ).all(id);
    const balById = {};
    let bal = 0;
    for (const r of all) {
      bal += r.type === 'credit_sale' ? r.amount : (r.type === 'repayment' ? -r.amount : 0);
      balById[r.id] = bal;
    }
    const sales = d.prepare(
      `SELECT s.id, s.invoice_no, s.gross, s.status, s.created_at, u.name AS cashier
       FROM sales s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.customer_id = ? ORDER BY s.id DESC LIMIT 20`
    ).all(id);
    const priceRules = d.prepare(
      `SELECT id, variant_id, price, valid_from, valid_to, active FROM price_rules WHERE customer_id = ? ORDER BY id`
    ).all(id);
    const names = Object.fromEntries(d.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    res.json({
      customer: c,
      ledger: ledger.map((r) => ({ ...r, balance: balById[r.id] ?? null })),
      sales, price_rules: priceRules,
      business: dbm.getSetting(d, 'business', {})
    });
  });

  app.put('/api/customers/:id', me, can('customers.manage'), (req, res) => {
    try {
      const id = numOrNull(req.params.id);
      const c = d.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!customerVisible(req.user, c)) return res.status(404).json({ error: 'customer not found' });
      const b = req.body || {};
      const name = b.name !== undefined ? String(b.name).trim() : c.name;
      if (!name) return res.status(400).json({ error: 'name required' });
      const phone = b.phone !== undefined ? String(b.phone).trim() : c.phone;
      const dup = phone ? d.prepare('SELECT id FROM customers WHERE phone = ? AND id != ?').get(phone, id) : null;
      if (dup) return res.status(409).json({ error: `that phone already belongs to customer #${dup.id}` });
      const email = b.email !== undefined ? String(b.email).trim() : c.email;
      const kraPin = b.kra_pin !== undefined ? String(b.kra_pin).trim() : c.kra_pin;
      const tier = b.tier !== undefined ? (TIERS.includes(b.tier) ? b.tier : 'standard') : c.tier;
      const creditLimit = b.credit_limit !== undefined
        ? (Number.isInteger(b.credit_limit) && b.credit_limit >= 0 ? b.credit_limit : null)
        : c.credit_limit;
      if (creditLimit === null) return res.status(400).json({ error: 'credit_limit must be a whole number ≥ 0' });
      const note = b.note !== undefined ? String(b.note).trim() : c.note;
      const birthday = b.birthday !== undefined ? (b.birthday ? String(b.birthday).trim() : null) : c.birthday;
      const branches = visibleBranches(d, req.user);
      const branchId = b.branch_id !== undefined
        ? (numOrNull(b.branch_id) && branches.some((x) => x.id === b.branch_id) ? b.branch_id : null)
        : c.branch_id;
      d.prepare(
        `UPDATE customers SET name = ?, phone = ?, email = ?, kra_pin = ?, credit_limit = ?, tier = ?, birthday = ?, note = ?, branch_id = ? WHERE id = ?`
      ).run(name, phone, email, kraPin, creditLimit, tier, birthday, note, branchId, id);
      dbm.audit(d, { userId: req.user.id, action: 'customer/update', entity: 'customer', entityId: String(id), detail: { changed: Object.keys(b) } });
      res.json({ ok: true, customer: customerRow(d, id) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] PUT /api/customers/:id:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Deni repayment: ledger evidence + till deposit when cash + overpayment
  // becomes store credit (the duka practice: you paid more than you owed).
  app.post('/api/customers/:id/repayments', me, (req, res) => {
    try {
      const id = numOrNull(req.params.id);
      const c = d.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!customerVisible(req.user, c)) return res.status(404).json({ error: 'customer not found' });
      const amt = Number((req.body || {}).amount);
      if (!Number.isInteger(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be whole shillings > 0' });
      const method = String((req.body || {}).method || 'cash').trim();
      if (!['cash', 'mpesa', 'card', 'bank', 'other'].includes(method)) return res.status(400).json({ error: `unknown method '${method}'` });
      const phone = String((req.body || {}).phone || '').trim();
      if (method === 'mpesa' && !phone) return res.status(400).json({ error: 'M-Pesa repayment needs the phone number' });
      const outstanding = deniOutstanding(d, id);
      if (outstanding <= 0) return res.status(400).json({ error: 'no deni outstanding for this customer' });
      const repay = Math.min(amt, outstanding);
      const excess = amt - repay;
      const ctx = saleContext(d, req.user);
      const registerId = numOrNull((req.body || {}).register_id) || (ctx.register && ctx.register.id) || null;
      const t = new Date().toISOString();
      const run = d.transaction(() => {
        d.prepare(
          `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
           VALUES (?, 'repayment', ?, ?, ?, ?, ?)`
        ).run(id, repay, `deni ${c.name}`, req.user.id,
          `${method} repayment${phone ? ` from ${phone}` : ''} (by ${req.user.name})`, t);
        let excessCredit = 0;
        if (excess > 0) {
          d.prepare('UPDATE customers SET store_credit = store_credit + ? WHERE id = ?').run(excess, id);
          d.prepare(
            `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
             VALUES (?, 'adjustment', ?, ?, ?, ?, ?)`
          ).run(id, excess, `deni ${c.name}`, req.user.id, `overpayment ${excess} → store credit (by ${req.user.name})`, t);
          excessCredit = excess;
        }
        if (method === 'cash' && registerId) {
          d.prepare(
            `INSERT INTO deposits (business_id, branch_id, register_id, amount, ref, note, user_id, created_at)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
          ).run(c.branch_id || ctx.branchId, registerId, amt, 'DENI', `deni repayment ${c.name} (by ${req.user.name})`, req.user.id, t);
        }
        return excessCredit;
      });
      const excessCredit = run();
      dbm.audit(d, {
        userId: req.user.id, branchId: c.branch_id, action: 'deni/repay',
        entity: 'customer', entityId: String(id),
        detail: { customer: c.name, amount: amt, method, repayment: repay, excess_to_credit: excessCredit || undefined, phone: phone || undefined }
      });
      res.json({ ok: true, customer: customerRow(d, id), repayment: repay, store_credit_excess: excessCredit, method });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/customers/:id/repayments:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Customer deposit: money in advance → store credit (+ till deposit if cash).
  app.post('/api/customers/:id/deposits', me, (req, res) => {
    try {
      const id = numOrNull(req.params.id);
      const c = d.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!customerVisible(req.user, c)) return res.status(404).json({ error: 'customer not found' });
      const amt = Number((req.body || {}).amount);
      if (!Number.isInteger(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be whole shillings > 0' });
      const method = String((req.body || {}).method || 'cash').trim();
      if (!['cash', 'mpesa', 'card', 'bank', 'other'].includes(method)) return res.status(400).json({ error: `unknown method '${method}'` });
      const note = String((req.body || {}).note || '').trim();
      const ctx = saleContext(d, req.user);
      const registerId = numOrNull((req.body || {}).register_id) || (ctx.register && ctx.register.id) || null;
      const t = new Date().toISOString();
      d.transaction(() => {
        d.prepare('UPDATE customers SET store_credit = store_credit + ? WHERE id = ?').run(amt, id);
        d.prepare(
          `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
           VALUES (?, 'adjustment', ?, ?, ?, ?, ?)`
        ).run(id, amt, `dep ${c.name}`, req.user.id, `deposit ${amt} → store credit${note ? ` (${note})` : ''} (by ${req.user.name})`, t);
        if (method === 'cash' && registerId) {
          d.prepare(
            `INSERT INTO deposits (business_id, branch_id, register_id, amount, ref, note, user_id, created_at)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
          ).run(c.branch_id || ctx.branchId, registerId, amt, 'DEP', `customer deposit ${c.name}${note ? ` (${note})` : ''} (by ${req.user.name})`, req.user.id, t);
        }
      })();
      dbm.audit(d, {
        userId: req.user.id, branchId: c.branch_id, action: 'customer/deposit',
        entity: 'customer', entityId: String(id),
        detail: { customer: c.name, amount: amt, method }
      });
      res.json({ ok: true, customer: customerRow(d, id), deposited: amt, method });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/customers/:id/deposits:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Direct store-credit adjustment (owner/manager judgement, ledger-evidenced).
  app.post('/api/customers/:id/store-credit', me, can('customers.manage'), (req, res) => {
    try {
      const id = numOrNull(req.params.id);
      const c = d.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!customerVisible(req.user, c)) return res.status(404).json({ error: 'customer not found' });
      const delta = Number((req.body || {}).delta);
      if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: 'delta must be a non-zero whole number of shillings' });
      const newBal = (c.store_credit || 0) + delta;
      if (newBal < 0) return res.status(400).json({ error: `insufficient store credit (balance ${c.store_credit || 0})` });
      const note = String((req.body || {}).note || '').trim();
      const t = new Date().toISOString();
      d.transaction(() => {
        d.prepare('UPDATE customers SET store_credit = ? WHERE id = ?').run(newBal, id);
        d.prepare(
          `INSERT INTO customer_ledger (customer_id, type, amount, ref, user_id, note, created_at)
           VALUES (?, 'adjustment', ?, ?, ?, ?, ?)`
        ).run(id, delta, `sc ${c.name}`, req.user.id, `store credit ${delta > 0 ? '+' : ''}${delta}${note ? ` (${note})` : ''} (by ${req.user.name})`, t);
      })();
      dbm.audit(d, {
        userId: req.user.id, branchId: c.branch_id, action: 'customer/store_credit',
        entity: 'customer', entityId: String(id),
        detail: { customer: c.name, delta, new_balance: newBal }
      });
      res.json({ ok: true, customer: customerRow(d, id), delta, balance: newBal });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('[error] POST /api/customers/:id/store-credit:', e.message);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // Deni statement: the ledger itself, with a running balance.
  app.get('/api/customers/:id/statement', me, can('customers.view'), (req, res) => {
    const id = numOrNull(req.params.id);
    const c = d.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!customerVisible(req.user, c)) return res.status(404).json({ error: 'customer not found' });
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const opening = from
      ? d.prepare(
          `SELECT COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount WHEN type = 'repayment' THEN -amount ELSE 0 END), 0) AS b
           FROM customer_ledger WHERE customer_id = ? AND created_at < ?`
        ).get(id, from).b
      : 0;
    const where = ['customer_id = ?', "type IN ('credit_sale', 'repayment')"];
    const args = [id];
    if (from) { where.push('created_at >= ?'); args.push(from); }
    if (to) { where.push('created_at < ?'); args.push(to); }
    const rows = d.prepare(
      `SELECT id, type, amount, ref, note, created_at FROM customer_ledger
       WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`
    ).all(...args);
    let bal = opening;
    let salesTotal = 0, repayTotal = 0;
    const out = rows.map((r) => {
      if (r.type === 'credit_sale') { bal += r.amount; salesTotal += r.amount; }
      else { bal -= r.amount; repayTotal += r.amount; }
      return { date: r.created_at, type: r.type, amount: r.amount, ref: r.ref, note: r.note, balance: bal };
    });
    res.json({
      customer: { id: c.id, name: c.name, phone: c.phone, kra_pin: c.kra_pin, credit_limit: c.credit_limit, store_credit: c.store_credit || 0 },
      business: dbm.getSetting(d, 'business', {}),
      from, to, opening,
      closing: bal,
      totals: { credit_sales: salesTotal, repayments: repayTotal },
      rows: out
    });
  });

  // ==================== Phase 12 — inter-branch & inter-location transfers (R-3) ====================
  // Lifecycle: requested → approved → shipped → received (cancel before ship).
  // Stock: transfer_out at SHIP from the source location (batch-tracked lines
  // must name the batch that physically moves); transfer_in at RECEIVE into the
  // destination location with received_qty. Discrepancy per line = qty −
  // received_qty, kept on the transfer line and in the audit trail.
  // Visibility: owner sees every transfer; a manager sees transfers touching a
  // branch they can see; approve/receive additionally requires seeing the
  // RECEIVING branch (the receiving side controls what enters its books).

  function transferVisible(d, user, t) {
    if (user.role === 'owner') return true;
    const vis = visibleBranches(d, user).map((b) => b.id);
    return vis.includes(t.from_branch) || vis.includes(t.to_branch);
  }

  function transferItemNames(d, li) {
    const v = li.variant_id
      ? d.prepare('SELECT * FROM variants WHERE id = ?').get(li.variant_id)
      : d.prepare("SELECT * FROM variants WHERE product_id = ? AND axes_key = '{}'").get(li.product_id);
    const p = d.prepare('SELECT * FROM products WHERE id = ?').get(li.product_id);
    const b = li.batch_id ? d.prepare('SELECT batch_no FROM batches WHERE id = ?').get(li.batch_id) : null;
    return {
      product_name: p ? p.name : `product ${li.product_id}`,
      variant_name: v ? v.name : '',
      batch_no: b ? b.batch_no : null,
      unit_cost: v ? (v.cost || p.cost || 0) : 0,
      line_value: v ? (v.cost || p.cost || 0) * li.qty : 0
    };
  }

  function transferPayload(d, t) {
    const fromB = d.prepare('SELECT name FROM branches WHERE id = ?').get(t.from_branch);
    const toB = d.prepare('SELECT name FROM branches WHERE id = ?').get(t.to_branch);
    const fromL = t.from_location ? d.prepare('SELECT name FROM locations WHERE id = ?').get(t.from_location) : null;
    const toL = t.to_location ? d.prepare('SELECT name FROM locations WHERE id = ?').get(t.to_location) : null;
    const by = d.prepare('SELECT name FROM users WHERE id = ?').get(t.created_by);
    const items = d.prepare('SELECT * FROM transfer_items WHERE transfer_id = ? ORDER BY id').all(t.id);
    const full = items.map((li) => Object.assign({}, li, transferItemNames(d, li), {
      discrepancy: li.qty - (li.received_qty || 0)
    }));
    const totalValue = full.reduce((s, li) => s + (li.line_value || 0), 0);
    return Object.assign({}, t, {
      from_branch_name: fromB ? fromB.name : '',
      to_branch_name: toB ? toB.name : '',
      from_location_name: fromL ? fromL.name : '',
      to_location_name: toL ? toL.name : '',
      created_by_name: by ? by.name : '',
      item_count: items.length,
      total_units: items.reduce((sum, li) => sum + li.qty, 0),
      total_value: totalValue,
      total_cost: (totalValue + (t.cost || 0)),
      discrepancies: full.filter((li) => li.discrepancy).length,
      items: full
    });
  }

  const TRANSFER_STATUSES = ['requested', 'approved', 'shipped', 'received', 'cancelled', 'scheduled'];

  app.get('/api/transfers', me, (req, res) => {
    const user = req.user;
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !TRANSFER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `unknown status '${status}'` });
    }
    const vis = user.role === 'owner' ? null : visibleBranches(d, user).map((b) => b.id);
    const ph = vis ? vis.map(() => '?').join(',') : '';
    const where = user.role === 'owner' ? '1=1' : `t.from_branch IN (${ph}) OR t.to_branch IN (${ph})`;
    const sql = `SELECT t.* FROM transfers t WHERE ${where}` + (status ? ' AND t.status = ?' : '') + ' ORDER BY t.id DESC LIMIT 200';
    const p = vis ? [...vis, ...vis] : [];
    if (status) p.push(status);
    const rows = d.prepare(sql).all(...p);
    res.json(rows.map((t) => {
      const base = transferPayload(d, t);
      delete base.items;
      return base;
    }));
  });

  app.get('/api/transfers/:id', me, (req, res) => {
    const user = req.user;
    const t = d.prepare('SELECT * FROM transfers WHERE id = ?').get(numOrNull(req.params.id));
    if (!t || !transferVisible(d, user, t)) return res.status(404).json({ error: 'transfer not found' });
    res.json({ transfer: transferPayload(d, t) });
  });

  app.post('/api/transfers', me, can('stock.adjust'), (req, res) => {
    try {
      const b = req.body || {};
      const fromLoc = numOrNull(b.from_location);
      const toLoc = numOrNull(b.to_location);
      const items = Array.isArray(b.items) ? b.items : [];
      if (!fromLoc || !toLoc) return res.status(400).json({ error: 'from_location and to_location are required' });
      if (fromLoc === toLoc) return res.status(400).json({ error: 'a transfer needs two different locations' });
      if (!items.length) return res.status(400).json({ error: 'items[] is required' });
      const user = req.user;
      const note = String(b.note || '').trim();
      const cost = intShillings(b.cost) ?? 0;
      const costNote = String(b.cost_note || '').trim();
      const scheduledFor = b.scheduled_for ? String(b.scheduled_for).trim() : null;
      const isRecurring = b.is_recurring ? 1 : 0;
      const recurringInterval = b.recurring_interval ? String(b.recurring_interval).trim() : null;
      const templateId = numOrNull(b.template_id);
      const status = scheduledFor ? 'scheduled' : 'requested';
      if (scheduledFor && isNaN(Date.parse(scheduledFor))) return res.status(400).json({ error: 'scheduled_for must be ISO date' });
      if (isRecurring && !['daily', 'weekly', 'biweekly', 'monthly'].includes(recurringInterval)) {
        return res.status(400).json({ error: 'recurring_interval must be daily/weekly/biweekly/monthly' });
      }
      const id = d.transaction(() => {
        const fl = d.prepare('SELECT * FROM locations WHERE id = ?').get(fromLoc);
        const tl = d.prepare('SELECT * FROM locations WHERE id = ?').get(toLoc);
        if (!fl || !tl) throw httpError(400, 'location not found');
        if (user.role !== 'owner') {
          const vis = visibleBranches(d, user).map((b) => b.id);
          if (!vis.includes(fl.branch_id) || !vis.includes(tl.branch_id)) {
            throw httpError(403, 'you can only transfer stock within branches you can see');
          }
        }
        // Validate + resolve every line up front (all-or-nothing).
        const resolved = items.map((it) => {
          const qty = Number(it.qty);
          if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, 'item qty must be a whole number > 0');
          let v = null;
          if (it.variant_id) v = d.prepare('SELECT * FROM variants WHERE id = ?').get(Number(it.variant_id));
          else if (it.product_id) v = d.prepare("SELECT * FROM variants WHERE product_id = ? AND axes_key = '{}'").get(Number(it.product_id));
          if (!v) throw httpError(400, 'an item must reference a known product or variant');
          const p = d.prepare('SELECT * FROM products WHERE id = ?').get(v.product_id);
          if (!p) throw httpError(400, 'unknown product');
          // For scheduled transfers, skip stock check now — check at ship time
          if (status !== 'scheduled') {
            const onHand = stockQty(d, v.id, fromLoc);
            if (onHand + 1e-9 < qty) throw httpError(400, `insufficient stock for ${p.name}: ${onHand} at source location`);
          }
          let batchId = null;
          if (p.track_batches) {
            batchId = numOrNull(it.batch_id);
            if (!batchId && status !== 'scheduled') throw httpError(400, `${p.name} is batch-tracked — each line needs a batch_id`);
            if (batchId) {
              const batch = d.prepare('SELECT * FROM batches WHERE id = ? AND variant_id = ? AND location_id = ?').get(batchId, v.id, fromLoc);
              if (!batch && status !== 'scheduled') throw httpError(400, `batch not found for ${p.name} at the source location`);
              if (batch && batch.qty + 1e-9 < qty && status !== 'scheduled') throw httpError(400, `batch ${batch.batch_no} holds ${batch.qty}, need ${qty}`);
            }
          } else if (it.batch_id) {
            throw httpError(400, `${p.name} is not batch-tracked — batch_id not allowed`);
          }
          return { v, p, qty, batchId };
        });
        const ref = dbm.nextCounter(d, 'trf', 'TR-');
        const row = d.prepare(
          `INSERT INTO transfers (ref, from_branch, to_branch, from_location, to_location, status, created_by, created_at, note, cost, cost_note, scheduled_for, is_recurring, recurring_interval, template_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(ref, fl.branch_id, tl.branch_id, fromLoc, toLoc, status, user.id, new Date().toISOString(), note, cost, costNote, scheduledFor, isRecurring, recurringInterval, templateId);
        for (const r of resolved) {
          d.prepare('INSERT INTO transfer_items (transfer_id, product_id, variant_id, qty, batch_id) VALUES (?, ?, ?, ?, ?)')
            .run(row.lastInsertRowid, r.v.product_id, r.v.id, r.qty, r.batchId);
        }
        dbm.audit(d, {
          userId: user.id, branchId: fl.branch_id, action: status === 'scheduled' ? 'transfer/schedule' : 'transfer/request',
          entity: 'transfer', entityId: String(row.lastInsertRowid),
          detail: { ref, from: fl.name, to: tl.name, lines: resolved.length, cost, scheduled_for: scheduledFor || undefined }
        });
        return row.lastInsertRowid;
      })();
      res.json({ transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  app.post('/api/transfers/:id/approve', me, can('transfers.approve'), (req, res) => {
    try {
      const user = req.user;
      const t = d.prepare('SELECT * FROM transfers WHERE id = ?').get(numOrNull(req.params.id));
      if (!t || !transferVisible(d, user, t)) return res.status(404).json({ error: 'transfer not found' });
      // Day 17: scheduled transfers can be activated (scheduled -> requested) or approved directly
      if (t.status === 'scheduled') {
        // Check if due: allow owner/manager to activate early
        d.prepare("UPDATE transfers SET status = 'requested', scheduled_for = NULL WHERE id = ?").run(t.id);
        dbm.audit(d, { userId: user.id, branchId: t.from_branch, action: 'transfer/activate', entity: 'transfer', entityId: String(t.id), detail: { ref: t.ref, was_scheduled: t.scheduled_for } });
        // Then approve in same call if requested
        if ((req.body || {}).and_approve) {
          d.prepare("UPDATE transfers SET status = 'approved' WHERE id = ?").run(t.id);
          dbm.audit(d, { userId: user.id, branchId: t.to_branch, action: 'transfer/approve', entity: 'transfer', entityId: String(t.id), detail: { ref: t.ref, from_scheduled: true } });
        }
        return res.json({ transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(t.id)) });
      }
      if (t.status !== 'requested') return res.status(400).json({ error: `only requested transfers can be approved (currently ${t.status})` });
      if (user.role !== 'owner' && !visibleBranches(d, user).map((b) => b.id).includes(t.to_branch)) {
        return res.status(403).json({ error: 'the receiving branch must be one you can see' });
      }
      d.prepare("UPDATE transfers SET status = 'approved' WHERE id = ?").run(t.id);
      dbm.audit(d, { userId: user.id, branchId: t.to_branch, action: 'transfer/approve', entity: 'transfer', entityId: String(t.id), detail: { ref: t.ref } });
      res.json({ transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(t.id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  // Day 17: activate a scheduled transfer when due (owner/manager)
  app.post('/api/transfers/:id/activate', me, can('stock.adjust'), (req, res) => {
    try {
      const user = req.user;
      const t = d.prepare('SELECT * FROM transfers WHERE id = ?').get(numOrNull(req.params.id));
      if (!t || !transferVisible(d, user, t)) return res.status(404).json({ error: 'transfer not found' });
      if (t.status !== 'scheduled') return res.status(400).json({ error: `only scheduled transfers can be activated (currently ${t.status})` });
      d.prepare("UPDATE transfers SET status = 'requested' WHERE id = ?").run(t.id);
      dbm.audit(d, { userId: user.id, branchId: t.from_branch, action: 'transfer/activate', entity: 'transfer', entityId: String(t.id), detail: { ref: t.ref } });
      res.json({ transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(t.id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  app.post('/api/transfers/:id/ship', me, can('stock.adjust'), (req, res) => {
    try {
      const user = req.user;
      const t = d.prepare('SELECT * FROM transfers WHERE id = ?').get(numOrNull(req.params.id));
      if (!t || !transferVisible(d, user, t)) return res.status(404).json({ error: 'transfer not found' });
      if (t.status !== 'approved') return res.status(400).json({ error: `only approved transfers can be shipped (currently ${t.status})` });
      const now = new Date().toISOString();
      d.transaction(() => {
        const lines = d.prepare('SELECT * FROM transfer_items WHERE transfer_id = ? ORDER BY id').all(t.id);
        for (const li of lines) {
          const v = d.prepare('SELECT * FROM variants WHERE id = ?').get(li.variant_id || (
            d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(li.product_id) || { id: null }).id);
          const p = d.prepare('SELECT * FROM products WHERE id = ?').get(li.product_id);
          if (!v || !p) throw httpError(400, `transfer line ${li.id} references missing product data`);
          if (stockQty(d, v.id, t.from_location) + 1e-9 < li.qty) {
            throw httpError(400, `cannot ship: ${p.name} stock at source dropped to ${stockQty(d, v.id, t.from_location)}, need ${li.qty}`);
          }
          writeMove(d, {
            product: p, variant: v, branchId: t.from_branch, locationId: t.from_location,
            qty: -li.qty, type: 'transfer_out', reason: 'transfer_out', ref: t.ref,
            batchId: li.batch_id || undefined, unitCost: v.cost || p.cost || 0, userId: user.id, note: `to ${t.to_location}`
          });
        }
        d.prepare("UPDATE transfers SET status = 'shipped', shipped_at = ? WHERE id = ?").run(now, t.id);
        dbm.audit(d, {
          userId: user.id, branchId: t.from_branch, action: 'transfer/ship',
          entity: 'transfer', entityId: String(t.id), detail: { ref: t.ref, lines: lines.length, cost: t.cost || 0 }
        });
      })();
      res.json({ transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(t.id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  app.post('/api/transfers/:id/receive', me, can('transfers.approve'), (req, res) => {
    try {
      const user = req.user;
      const t = d.prepare('SELECT * FROM transfers WHERE id = ?').get(numOrNull(req.params.id));
      if (!t || !transferVisible(d, user, t)) return res.status(404).json({ error: 'transfer not found' });
      if (t.status !== 'shipped') return res.status(400).json({ error: `only shipped transfers can be received (currently ${t.status})` });
      if (user.role !== 'owner' && !visibleBranches(d, user).map((b) => b.id).includes(t.to_branch)) {
        return res.status(403).json({ error: 'the receiving branch must be one you can see' });
      }
      const lines = Array.isArray((req.body || {}).items) ? req.body.items : [];
      if (!lines.length) return res.status(400).json({ error: 'items[] with item_id + received_qty is required' });
      const note = String((req.body || {}).note || '').trim();
      const now = new Date().toISOString();
      d.transaction(() => {
        let discrepancies = 0;
        for (const ln of lines) {
          const ti = d.prepare('SELECT * FROM transfer_items WHERE id = ? AND transfer_id = ?').get(numOrNull(ln.item_id), t.id);
          if (!ti) throw httpError(400, 'unknown item_id for this transfer');
          if (ti.received_at) throw httpError(400, `line ${ti.id} was already received`);
          const rq = Number(ln.received_qty);
          if (!Number.isInteger(rq) || rq < 0 || rq > ti.qty + 1e-9) {
            throw httpError(400, `received_qty for line ${ti.id} must be a whole number between 0 and ${ti.qty}`);
          }
          if (rq > 0) {
            const v = d.prepare('SELECT * FROM variants WHERE id = ?').get(ti.variant_id || (
              d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(ti.product_id) || { id: null }).id);
            const p = d.prepare('SELECT * FROM products WHERE id = ?').get(ti.product_id);
            if (!v || !p) throw httpError(400, `transfer line ${ti.id} references missing product data`);
            writeMove(d, {
              product: p, variant: v, branchId: t.to_branch, locationId: t.to_location,
              qty: rq, type: 'transfer_in', reason: 'transfer_in', ref: t.ref,
              batchId: ti.batch_id || undefined, unitCost: v.cost || p.cost || 0, userId: user.id, note: `from ${t.from_location}${note ? ' — ' + note : ''}`
            });
            if (ti.batch_id) d.prepare('UPDATE batches SET location_id = ? WHERE id = ?').run(t.to_location, ti.batch_id);
          }
          discrepancies += ti.qty - rq;
          d.prepare('UPDATE transfer_items SET received_qty = ?, received_at = ? WHERE id = ?').run(rq, now, ti.id);
        }
        const remaining = d.prepare('SELECT COUNT(*) AS n FROM transfer_items WHERE transfer_id = ? AND received_at IS NULL').get(t.id).n;
        if (remaining === 0) d.prepare("UPDATE transfers SET status = 'received', received_at = ? WHERE id = ?").run(now, t.id);
        dbm.audit(d, {
          userId: user.id, branchId: t.to_branch, action: 'transfer/receive',
          entity: 'transfer', entityId: String(t.id),
          detail: { ref: t.ref, lines: lines.length, discrepancies, note, cost: t.cost || 0 }
        });
      })();
      res.json({ transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(t.id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  app.post('/api/transfers/:id/cancel', me, (req, res) => {
    try {
      const user = req.user;
      if (!perms.userHasPerm(d, user, 'stock.adjust') && !perms.userHasPerm(d, user, 'transfers.approve')) {
        return res.status(403).json({ error: 'stock.adjust or transfers.approve required' });
      }
      const t = d.prepare('SELECT * FROM transfers WHERE id = ?').get(numOrNull(req.params.id));
      if (!t || !transferVisible(d, user, t)) return res.status(404).json({ error: 'transfer not found' });
      if (!['requested', 'approved', 'scheduled'].includes(t.status)) return res.status(400).json({ error: `only requested/approved/scheduled transfers can be cancelled (currently ${t.status})` });
      d.prepare("UPDATE transfers SET status = 'cancelled' WHERE id = ?").run(t.id);
      dbm.audit(d, { userId: user.id, branchId: t.from_branch, action: 'transfer/cancel', entity: 'transfer', entityId: String(t.id), detail: { ref: t.ref } });
      res.json({ transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(t.id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  // ==================== Phase 12 Day 17 — transfer templates (periodic) ====================
  function templatePayload(d, t) {
    const fromB = d.prepare('SELECT name FROM branches WHERE id = ?').get(t.from_branch);
    const toB = d.prepare('SELECT name FROM branches WHERE id = ?').get(t.to_branch);
    const fromL = d.prepare('SELECT name FROM locations WHERE id = ?').get(t.from_location);
    const toL = d.prepare('SELECT name FROM locations WHERE id = ?').get(t.to_location);
    const by = t.created_by ? d.prepare('SELECT name FROM users WHERE id = ?').get(t.created_by) : null;
    let items = [];
    try { items = JSON.parse(t.items || '[]'); } catch { items = []; }
    // Enrich items with product names if possible
    const enriched = items.map((it) => {
      const p = it.product_id ? d.prepare('SELECT name FROM products WHERE id = ?').get(it.product_id) : null;
      const v = it.variant_id ? d.prepare('SELECT name FROM variants WHERE id = ?').get(it.variant_id) : null;
      return { ...it, product_name: p ? p.name : '', variant_name: v ? v.name : '' };
    });
    return {
      ...t,
      from_branch_name: fromB ? fromB.name : '',
      to_branch_name: toB ? toB.name : '',
      from_location_name: fromL ? fromL.name : '',
      to_location_name: toL ? toL.name : '',
      created_by_name: by ? by.name : '',
      items: enriched
    };
  }

  app.get('/api/transfer-templates', me, can('stock.view'), (req, res) => {
    const user = req.user;
    const vis = user.role === 'owner' ? null : visibleBranches(d, user).map((b) => b.id);
    const where = vis ? `WHERE from_branch IN (${vis.map(() => '?').join(',')}) OR to_branch IN (${vis.map(() => '?').join(',')})` : '';
    const rows = d.prepare(`SELECT * FROM transfer_templates ${where} ORDER BY id DESC`).all(...(vis ? [...vis, ...vis] : []));
    res.json(rows.map((r) => templatePayload(d, r)));
  });

  app.post('/api/transfer-templates', me, can('stock.adjust'), (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ error: 'template name required' });
      const fromLoc = numOrNull(b.from_location);
      const toLoc = numOrNull(b.to_location);
      if (!fromLoc || !toLoc) return res.status(400).json({ error: 'from_location and to_location required' });
      if (fromLoc === toLoc) return res.status(400).json({ error: 'need two different locations' });
      const fl = d.prepare('SELECT * FROM locations WHERE id = ?').get(fromLoc);
      const tl = d.prepare('SELECT * FROM locations WHERE id = ?').get(toLoc);
      if (!fl || !tl) return res.status(400).json({ error: 'location not found' });
      const user = req.user;
      if (user.role !== 'owner') {
        const vis = visibleBranches(d, user).map((x) => x.id);
        if (!vis.includes(fl.branch_id) || !vis.includes(tl.branch_id)) return res.status(403).json({ error: 'branch not visible' });
      }
      const interval = String(b.interval || 'weekly').trim();
      if (!['daily', 'weekly', 'biweekly', 'monthly', 'once'].includes(interval)) return res.status(400).json({ error: 'interval must be daily/weekly/biweekly/monthly/once' });
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) return res.status(400).json({ error: 'items[] required' });
      for (const it of items) {
        const qty = Number(it.qty);
        if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'item qty must be > 0 integer' });
      }
      const cost = intShillings(b.cost) ?? 0;
      const costNote = String(b.cost_note || '').trim();
      const nextDue = b.next_due ? String(b.next_due).trim() : new Date().toISOString();
      if (isNaN(Date.parse(nextDue))) return res.status(400).json({ error: 'next_due must be ISO date' });
      const id = d.prepare(
        `INSERT INTO transfer_templates (name, from_branch, to_branch, from_location, to_location, cost, cost_note, interval, next_due, active, items, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(name, fl.branch_id, tl.branch_id, fromLoc, toLoc, cost, costNote, interval, nextDue, JSON.stringify(items), user.id, new Date().toISOString()).lastInsertRowid;
      dbm.audit(d, { userId: user.id, branchId: fl.branch_id, action: 'transfer_template/create', entity: 'transfer_template', entityId: String(id), detail: { name, interval, items: items.length } });
      res.json({ ok: true, template: templatePayload(d, d.prepare('SELECT * FROM transfer_templates WHERE id = ?').get(id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  app.put('/api/transfer-templates/:id', me, can('stock.adjust'), (req, res) => {
    const t = d.prepare('SELECT * FROM transfer_templates WHERE id = ?').get(numOrNull(req.params.id));
    if (!t) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const patch = {
      name: b.name !== undefined ? String(b.name).trim() : t.name,
      cost: b.cost !== undefined ? (intShillings(b.cost) ?? t.cost) : t.cost,
      cost_note: b.cost_note !== undefined ? String(b.cost_note).trim() : t.cost_note,
      interval: b.interval !== undefined ? String(b.interval).trim() : t.interval,
      next_due: b.next_due !== undefined ? String(b.next_due).trim() : t.next_due,
      active: b.active !== undefined ? (b.active ? 1 : 0) : t.active,
      items: b.items !== undefined ? JSON.stringify(b.items) : t.items
    };
    if (patch.interval && !['daily', 'weekly', 'biweekly', 'monthly', 'once'].includes(patch.interval)) return res.status(400).json({ error: 'bad interval' });
    d.prepare(`UPDATE transfer_templates SET name = ?, cost = ?, cost_note = ?, interval = ?, next_due = ?, active = ?, items = ? WHERE id = ?`)
      .run(patch.name, patch.cost, patch.cost_note, patch.interval, patch.next_due, patch.active, patch.items, t.id);
    res.json({ ok: true, template: templatePayload(d, d.prepare('SELECT * FROM transfer_templates WHERE id = ?').get(t.id)) });
  });

  app.post('/api/transfer-templates/:id/run', me, can('stock.adjust'), (req, res) => {
    try {
      const user = req.user;
      const t = d.prepare('SELECT * FROM transfer_templates WHERE id = ?').get(numOrNull(req.params.id));
      if (!t) return res.status(404).json({ error: 'not found' });
      if (!t.active) return res.status(400).json({ error: 'template is inactive' });
      const fl = d.prepare('SELECT * FROM locations WHERE id = ?').get(t.from_location);
      const tl = d.prepare('SELECT * FROM locations WHERE id = ?').get(t.to_location);
      if (!fl || !tl) return res.status(400).json({ error: 'location not found' });
      let items = [];
      try { items = JSON.parse(t.items || '[]'); } catch { items = []; }
      if (!items.length) return res.status(400).json({ error: 'template has no items' });
      const ref = dbm.nextCounter(d, 'trf', 'TR-');
      const now = new Date().toISOString();
      const id = d.transaction(() => {
        const row = d.prepare(
          `INSERT INTO transfers (ref, from_branch, to_branch, from_location, to_location, status, created_by, created_at, note, cost, cost_note, template_id)
           VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?)`
        ).run(ref, fl.branch_id, tl.branch_id, t.from_location, t.to_location, user.id, now, `from template ${t.name}`, t.cost, t.cost_note, t.id).lastInsertRowid;
        for (const it of items) {
          const qty = Number(it.qty);
          const variantId = numOrNull(it.variant_id);
          const productId = numOrNull(it.product_id);
          let v = null;
          if (variantId) v = d.prepare('SELECT * FROM variants WHERE id = ?').get(variantId);
          else if (productId) v = d.prepare("SELECT * FROM variants WHERE product_id = ? AND axes_key = '{}'").get(productId);
          if (!v) throw httpError(400, 'template item references missing product');
          d.prepare('INSERT INTO transfer_items (transfer_id, product_id, variant_id, qty, batch_id) VALUES (?, ?, ?, ?, ?)')
            .run(row, v.product_id, v.id, qty, numOrNull(it.batch_id));
        }
        // compute next due
        let nextDue = null;
        if (t.interval !== 'once') {
          const base = new Date(t.next_due || now);
          if (t.interval === 'daily') base.setDate(base.getDate() + 1);
          else if (t.interval === 'weekly') base.setDate(base.getDate() + 7);
          else if (t.interval === 'biweekly') base.setDate(base.getDate() + 14);
          else if (t.interval === 'monthly') base.setMonth(base.getMonth() + 1);
          nextDue = base.toISOString();
          d.prepare('UPDATE transfer_templates SET next_due = ?, last_run_at = ? WHERE id = ?').run(nextDue, now, t.id);
        } else {
          d.prepare('UPDATE transfer_templates SET active = 0, last_run_at = ? WHERE id = ?').run(now, t.id);
        }
        dbm.audit(d, { userId: user.id, branchId: fl.branch_id, action: 'transfer_template/run', entity: 'transfer', entityId: String(row), detail: { ref, template: t.name, interval: t.interval } });
        return row;
      })();
      res.json({ ok: true, transfer: transferPayload(d, d.prepare('SELECT * FROM transfers WHERE id = ?').get(id)) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  // ==================== Phase 12 Day 17 — branch dashboard ====================
  app.get('/api/branches/:id/dashboard', me, (req, res) => {
    const user = req.user;
    const branchId = numOrNull(req.params.id);
    const b = branchRow(d, branchId);
    if (!b) return res.status(404).json({ error: 'branch not found' });
    if (!transferVisible(d, user, { from_branch: branchId, to_branch: branchId })) {
      // Reuse visibility: owner or branch in visible list
      const vis = visibleBranches(d, user).map((x) => x.id);
      if (!vis.includes(branchId)) return res.status(404).json({ error: 'branch not found' });
    }
    const todayIso = startOfTodayIso();
    const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString();

    const locs = locationsOf(d, branchId);
    const locIds = locs.map((l) => l.id);

    const salesToday = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(gross), 0) AS total FROM sales WHERE branch_id = ? AND status IN ('paid','partial') AND created_at >= ?`).get(branchId, todayIso);
    const salesWeek = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(gross), 0) AS total FROM sales WHERE branch_id = ? AND status IN ('paid','partial') AND created_at >= ?`).get(branchId, weekAgo);
    const salesMonth = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(gross), 0) AS total FROM sales WHERE branch_id = ? AND status IN ('paid','partial') AND created_at >= ?`).get(branchId, monthAgo);

    // Stock value: sum qty * cost across locations in branch
    let stockValue = 0, stockQtyTotal = 0;
    if (locIds.length) {
      const ph = locIds.map(() => '?').join(',');
      const rows = d.prepare(
        `SELECT s.qty, COALESCE(v.cost, p.cost, 0) AS cost FROM stock s
         JOIN variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE s.location_id IN (${ph}) AND s.qty > 0`
      ).all(...locIds);
      for (const r of rows) {
        stockValue += r.qty * r.cost;
        stockQtyTotal += r.qty;
      }
    }

    // Low stock: products where total stock in branch <= reorder_level
    const lowStock = d.prepare(`
      SELECT p.id, p.name, p.reorder_level,
             COALESCE((SELECT SUM(st.qty) FROM variants v JOIN stock st ON st.variant_id = v.id WHERE v.product_id = p.id AND st.location_id IN (${locIds.length ? locIds.map(() => '?').join(',') : 'SELECT 0 WHERE 0'} )), 0) AS stock
        FROM products p WHERE p.active = 1 AND p.reorder_level > 0
    `).all(...locIds);
    const lowCount = lowStock.filter((r) => r.stock <= r.reorder_level).length;

    const pendingTransfers = d.prepare(
      `SELECT COUNT(*) AS n FROM transfers WHERE (from_branch = ? OR to_branch = ?) AND status IN ('requested','approved','shipped','scheduled')`
    ).get(branchId, branchId).n;

    const staffCount = d.prepare(`SELECT COUNT(*) AS n FROM users WHERE branch_id = ? AND active = 1`).get(branchId).n;

    // Top products in branch last 30 days
    const topProducts = d.prepare(`
      SELECT p.name, SUM(si.qty) AS qty, SUM(si.gross) AS gross
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
       WHERE s.branch_id = ? AND s.status IN ('paid','partial') AND s.created_at >= ?
       GROUP BY p.id ORDER BY gross DESC LIMIT 10
    `).all(branchId, monthAgo);

    const recentTransfers = d.prepare(`
      SELECT * FROM transfers WHERE from_branch = ? OR to_branch = ? ORDER BY id DESC LIMIT 10
    `).all(branchId, branchId).map((t) => {
      const base = transferPayload(d, t);
      delete base.items;
      return base;
    });

    // Supplier balances filtered to this branch
    const suppliers = d.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all()
      .map((s) => ({ ...s, balance: supplierBalance(s.id, branchId) }))
      .filter((s) => s.balance.invoices_total > 0 || s.balance.open_pos > 0 || s.balance.outstanding !== 0)
      .slice(0, 20);

    // Shrinkage in branch last 30d (damage, expiry, negative adjustments)
    const shrinkage = d.prepare(
      `SELECT COALESCE(SUM(-qty * unit_cost), 0) AS total FROM stock_moves
       WHERE branch_id = ? AND (type = 'damage' OR type = 'expiry_writeoff' OR (type = 'adjustment' AND qty < 0)) AND created_at >= ?`
    ).get(branchId, monthAgo).total;

    // Expenses in branch (last 30 days)
    const expenses = d.prepare(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM expenses WHERE branch_id = ? AND expense_date >= ?`).get(branchId, monthAgo.slice(0, 10));
    const recentExpenses = d.prepare(`SELECT * FROM expenses WHERE branch_id = ? ORDER BY expense_date DESC, id DESC LIMIT 10`).all(branchId);

    res.json({
      branch: { ...b, settings: safeJson(b.settings || '{}') },
      locations: locs.map((l) => ({
        ...l,
        registers: d.prepare('SELECT COUNT(*) AS n FROM registers WHERE location_id = ? AND active = 1').get(l.id).n,
        stockLines: d.prepare('SELECT COUNT(*) AS n FROM stock WHERE location_id = ? AND qty != 0').get(l.id).n
      })),
      sales: { today: salesToday, week: salesWeek, month: salesMonth },
      stock: { value: stockValue, qty: stockQtyTotal, low_count: lowCount, low_items: lowStock.filter((r) => r.stock <= r.reorder_level).slice(0, 15), shrinkage },
      transfers: { pending: pendingTransfers, recent: recentTransfers },
      staff: { count: staffCount },
      top_products: topProducts,
      suppliers,
      expenses: { month: expenses, recent: recentExpenses },
      shrinkage
    });
  });

  // ==================== Day 17 — expenses (branch-scoped) ====================
  app.get('/api/expenses', me, (req, res) => {
    const user = req.user;
    const vis = visibleBranches(d, user).map((b) => b.id);
    if (!vis.length) return res.json([]);
    const branchId = numOrNull(req.query.branch_id);
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const where = [`branch_id IN (${vis.map(() => '?').join(',')})`];
    const args = [...vis];
    if (branchId) {
      if (!vis.includes(branchId)) return res.status(404).json({ error: 'branch not found' });
      where.push('branch_id = ?'); args.push(branchId);
    }
    if (from) { where.push('expense_date >= ?'); args.push(from); }
    if (to) { where.push('expense_date <= ?'); args.push(to); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = d.prepare(`SELECT * FROM expenses WHERE ${where.join(' AND ')} ORDER BY expense_date DESC, id DESC LIMIT ?`).all(...args, limit);
    res.json(rows);
  });

  app.post('/api/expenses', me, can('expenses.manage'), (req, res) => {
    try {
      const b = req.body || {};
      const amount = intShillings(b.amount);
      if (amount === null || amount <= 0) return res.status(400).json({ error: 'amount must be whole shillings > 0' });
      const branchId = numOrNull(b.branch_id);
      if (!branchId) return res.status(400).json({ error: 'branch_id required' });
      const vis = visibleBranches(d, req.user).map((x) => x.id);
      if (!vis.includes(branchId)) return res.status(404).json({ error: 'branch not found' });
      const cat = String(b.category || 'other').trim() || 'other';
      const note = String(b.note || '').trim();
      const expDate = b.expense_date ? String(b.expense_date).trim() : new Date().toISOString().slice(0, 10);
      if (isNaN(Date.parse(expDate))) return res.status(400).json({ error: 'expense_date must be ISO date' });
      const id = d.prepare(
        `INSERT INTO expenses (branch_id, category, amount, note, expense_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(branchId, cat, amount, note, expDate, req.user.id, new Date().toISOString()).lastInsertRowid;
      dbm.audit(d, { userId: req.user.id, branchId, action: 'expense/create', entity: 'expense', entityId: String(id), detail: { amount, category: cat } });
      res.json({ ok: true, id, expense: d.prepare('SELECT * FROM expenses WHERE id = ?').get(id) });
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.error(e);
      res.status(st).json({ error: e.message });
    }
  });

  // ---- Phase 12 — branch comparison (R-3): rank visible branches by sales ----
  // margin ≈ Σ(gross − cost×qty) over confirmed sale items; shrinkage = cost of
  // stock lost to damage / expiry write-off / negative adjustments in the window.
  app.get('/api/reports/branches', me, can('reports.view'), (req, res) => {
    const user = req.user;
    const vis = visibleBranches(d, user).map((b) => b.id);
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    const win = (col) => {
      const w = [];
      const p = [];
      if (from) { w.push(`${col} >= ?`); p.push(from); }
      if (to) { w.push(`${col} <= ?`); p.push(to); }
      return { sql: w.length ? 'AND ' + w.join(' AND ') : '', p };
    };
    const ws = win('created_at');
    const wsm = win('s.created_at');
    const wm = win('created_at');
    const branches = d.prepare(`SELECT id, name FROM branches WHERE id IN (${vis.map(() => '?').join(',')}) ORDER BY id`).all(...vis);
    const rows = branches.map((b) => {
      const sales = d.prepare(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(gross), 0) AS sales FROM sales WHERE branch_id = ? AND status IN ('paid', 'partial') ${ws.sql}`
      ).get(b.id, ...ws.p);
      const margin = d.prepare(
        `SELECT COALESCE(SUM(si.gross - COALESCE(COALESCE(v.cost, p.cost), 0) * si.qty), 0) AS margin
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         LEFT JOIN variants v ON v.id = si.variant_id
         LEFT JOIN products p ON p.id = si.product_id
         WHERE s.branch_id = ? AND s.status IN ('paid', 'partial') ${wsm.sql}`
      ).get(b.id, ...wsm.p).margin;
      const shrinkage = d.prepare(
        `SELECT COALESCE(SUM(-qty * unit_cost), 0) AS shrinkage FROM stock_moves
         WHERE branch_id = ? AND (type = 'damage' OR type = 'expiry_writeoff' OR (type = 'adjustment' AND qty < 0)) ${wm.sql}`
      ).get(b.id, ...wm.p).shrinkage;
      return {
        id: b.id, name: b.name,
        orders: sales.orders, sales: sales.sales,
        margin: Number(margin.toFixed(0)),
        shrinkage: Number(shrinkage.toFixed(0))
      };
    });
    rows.sort((a, b) => b.sales - a.sales || a.id - b.id);
    rows.forEach((r, i) => { r.rank = i + 1; });
    res.json({ branches: rows, from, to });
  });

  // ---- CSV import/export (products + variants + packs in one file) --------------------------------
  const CSV_COLUMNS = [
    'section', 'product_id', 'product_sku', 'product_name', 'product_name_sw', 'category', 'brand',
    'product_unit', 'product_cost', 'product_price', 'product_wholesale', 'product_member', 'product_tax',
    'product_kra', 'product_age_min', 'product_requires_rx', 'product_controlled', 'product_track_batches',
    'product_track_serials', 'product_open_priced', 'supplier', 'reorder_level',
    'variant_sku', 'variant_name', 'variant_axes', 'variant_barcode', 'variant_price', 'variant_cost',
    'variant_wholesale', 'variant_member', 'variant_tax', 'variant_kra',
    'pack_name', 'pack_multiple', 'pack_unit', 'pack_barcode', 'pack_price', 'pack_cost'
  ];

  app.get('/api/csv/export', me, can('products.manage'), (req, res) => {
    const rows = [];
    const cats = Object.fromEntries(d.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]));
    const sups = Object.fromEntries(d.prepare('SELECT id, name FROM suppliers').all().map((s) => [s.id, s.name]));
    for (const p of d.prepare('SELECT * FROM products ORDER BY id').all()) {
      rows.push({
        section: 'product', product_id: p.id, product_sku: p.sku, product_name: p.name, product_name_sw: p.name_sw,
        category: p.category_id ? cats[p.category_id] || '' : '', brand: p.brand, product_unit: p.unit,
        product_cost: p.cost, product_price: p.price, product_wholesale: p.wholesale_price, product_member: p.member_price,
        product_tax: p.tax_type, product_kra: p.kra_item_code, product_age_min: p.age_min ?? '',
        product_requires_rx: p.requires_rx, product_controlled: p.is_controlled, product_track_batches: p.track_batches,
        product_track_serials: p.track_serials, product_open_priced: p.open_priced,
        supplier: p.supplier_id ? sups[p.supplier_id] || '' : '', reorder_level: p.reorder_level
      });
      for (const v of d.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY id').all(p.id)) {
        const unitBc = d.prepare("SELECT barcode FROM variant_barcodes WHERE variant_id = ? AND kind = 'unit' AND active = 1 ORDER BY id LIMIT 1").get(v.id);
        rows.push({
          section: 'variant', product_name: p.name, product_sku: p.sku,
          variant_sku: v.sku, variant_name: v.name, variant_axes: v.axes === '{}' ? '' : v.axes,
          variant_barcode: unitBc ? unitBc.barcode : '', variant_price: v.price ?? '', variant_cost: v.cost ?? '',
          variant_wholesale: v.wholesale_price ?? '', variant_member: v.member_price ?? '',
          variant_tax: v.tax_type || '', variant_kra: v.kra_item_code || ''
        });
        for (const pk of d.prepare('SELECT * FROM packs WHERE variant_id = ? AND active = 1').all(v.id)) {
          const packBc = d.prepare("SELECT barcode FROM variant_barcodes WHERE pack_id = ? AND kind = 'pack' AND active = 1").get(pk.id);
          rows.push({
            section: 'pack', product_name: p.name, variant_axes: v.axes === '{}' ? '' : v.axes, variant_name: v.name,
            pack_name: pk.name, pack_multiple: pk.multiple, pack_unit: pk.unit,
            pack_barcode: packBc ? packBc.barcode : '', pack_price: pk.price, pack_cost: pk.cost
          });
        }
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="openpos-products.csv"');
    res.send(require('./lib/csv').toCsv(CSV_COLUMNS, rows));
  });

  app.post('/api/csv/import', me, can('products.manage'), (req, res) => {
    const text = String((req.body || {}).csv || '');
    const { rows } = require('./lib/csv').fromCsv(text);
    const now = new Date().toISOString();
    const summary = { products: 0, variants: 0, packs: 0, errors: [] };
    // CSV fields are strings: parse flags numerically ("0" must NOT be truthy)
    const yes = (v) => (Number(v) === 1 ? 1 : 0);
    const findProduct = (name, sku) =>
      sku ? d.prepare('SELECT * FROM products WHERE sku = ? ORDER BY active DESC LIMIT 1').get(sku)
        : d.prepare('SELECT * FROM products WHERE lower(name) = lower(?) ORDER BY active DESC LIMIT 1').get(name);
    const ensureBarcode = (variantId, barcode, kind, packId, label) => {
      if (!barcode) return;
      const existing = d.prepare('SELECT * FROM variant_barcodes WHERE barcode = ?').get(barcode);
      if (existing && existing.active && existing.variant_id !== variantId) {
        summary.errors.push(`barcode ${barcode} already used by another product`);
        return;
      }
      if (existing && !existing.active) {
        d.prepare('UPDATE variant_barcodes SET variant_id = ?, kind = ?, pack_id = ?, active = 1 WHERE id = ?')
          .run(variantId, kind, packId || null, existing.id);
        return;
      }
      if (!existing) {
        d.prepare('INSERT INTO variant_barcodes (variant_id, barcode, kind, pack_id, label, active) VALUES (?, ?, ?, ?, ?, 1)')
          .run(variantId, barcode, kind, packId || null, label || '');
      }
    };
    for (const r of rows) {
      try {
        if (r.section === 'product') {
          const cur = findProduct(r.product_name, r.product_sku);
          const cat = r.category ? d.prepare('SELECT id FROM categories WHERE lower(name) = lower(?)').get(r.category) : null;
          const sup = r.supplier ? d.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?)').get(r.supplier) : null;
          const body = {
            name: r.product_name, name_sw: r.product_name_sw, sku: r.product_sku,
            category_id: cat ? cat.id : (cur && cur.category_id) || null,
            brand: r.brand || '', unit: r.product_unit || 'pcs',
            cost: Number(r.product_cost) || 0, price: Number(r.product_price) || 0,
            wholesale_price: Number(r.product_wholesale) || 0, member_price: Number(r.product_member) || 0,
            tax_type: r.product_tax || 'std', kra_item_code: r.product_kra || '',
            age_min: r.product_age_min !== '' && r.product_age_min != null ? Number(r.product_age_min) : null,
            requires_rx: yes(r.product_requires_rx), is_controlled: yes(r.product_controlled),
            track_batches: yes(r.product_track_batches), track_serials: yes(r.product_track_serials),
            open_priced: yes(r.product_open_priced),
            supplier_id: sup ? sup.id : (cur && cur.supplier_id) || null,
            reorder_level: Number(r.reorder_level) || 0
          };
          if (Number(r.product_price) <= 0) throw new Error(`product "${r.product_name}": price must be > 0`);
          if (cur) {
            d.prepare(
              `UPDATE products SET sku = ?, name_sw = ?, category_id = ?, brand = ?, unit = ?, cost = ?, price = ?,
                 wholesale_price = ?, member_price = ?, tax_type = ?, kra_item_code = ?, age_min = ?, requires_rx = ?,
                 is_controlled = ?, track_batches = ?, track_serials = ?, open_priced = ?, supplier_id = ?, reorder_level = ?, active = 1, updated_at = ? WHERE id = ?`
            ).run(body.sku, body.name_sw, body.category_id, body.brand, body.unit, body.cost, body.price,
              body.wholesale_price, body.member_price, body.tax_type, body.kra_item_code, body.age_min, body.requires_rx,
              body.is_controlled, body.track_batches, body.track_serials, body.open_priced, body.supplier_id, body.reorder_level, now, cur.id);
          } else {
            const pid = d
              .prepare(
                `INSERT INTO products (branch_id, sku, barcode, name, name_sw, category_id, brand, unit, cost, price,
                   wholesale_price, member_price, tax_type, kra_item_code, age_min, requires_rx, is_controlled,
                   track_batches, track_serials, open_priced, supplier_id, reorder_level, active, created_at, updated_at)
                 VALUES (NULL, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
              )
              .run(body.sku, body.name, body.name_sw, body.category_id, body.brand, body.unit, body.cost, body.price,
                body.wholesale_price, body.member_price, body.tax_type, body.kra_item_code, body.age_min, body.requires_rx,
                body.is_controlled, body.track_batches, body.track_serials, body.open_priced, body.supplier_id, body.reorder_level, now, now)
              .lastInsertRowid;
            d.prepare(`INSERT INTO variants (product_id, name, axes, axes_key, sku, active, created_at, updated_at) VALUES (?, '', '{}', '{}', ?, 1, ?, ?)`)
              .run(pid, body.sku, now, now);
            summary.products++;
          }
        } else if (r.section === 'variant') {
          const prod = findProduct(r.product_name, r.product_sku);
          if (!prod) throw new Error(`variant "${r.variant_name}": product "${r.product_name}" not found`);
          const axesKey = canonicalAxes(parseAxesInput(r.variant_axes));
          let v = d.prepare('SELECT * FROM variants WHERE product_id = ? AND axes_key = ?').get(prod.id, axesKey);
          if (!v) {
            d.prepare(`INSERT INTO variants (product_id, name, axes, axes_key, sku, active, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
              .run(prod.id, r.variant_name || '', r.variant_axes || '{}', axesKey, r.variant_sku || '', now, now);
            v = d.prepare('SELECT * FROM variants WHERE product_id = ? AND axes_key = ?').get(prod.id, axesKey);
            summary.variants++;
          }
          const price = r.variant_price === '' || r.variant_price === undefined ? null : intShillings(r.variant_price);
          const cost = r.variant_cost === '' || r.variant_cost === undefined ? null : intShillings(r.variant_cost);
          d.prepare('UPDATE variants SET sku = ?, price = ?, cost = ?, active = 1, updated_at = ? WHERE id = ?')
            .run(r.variant_sku || v.sku, price, cost, now, v.id);
          ensureBarcode(v.id, r.variant_barcode, 'unit', null, 'import');
        } else if (r.section === 'pack') {
          const prod = findProduct(r.product_name, r.product_sku);
          if (!prod) throw new Error(`pack "${r.pack_name}": product "${r.product_name}" not found`);
          const axesKey = canonicalAxes(parseAxesInput(r.variant_axes));
          const v = d.prepare('SELECT * FROM variants WHERE product_id = ? AND axes_key = ? ORDER BY id LIMIT 1').get(prod.id, axesKey);
          if (!v) throw new Error(`pack "${r.pack_name}": variant not found`);
          const pk = d.prepare('SELECT * FROM packs WHERE variant_id = ? AND name = ?').get(v.id, r.pack_name);
          let pid = pk && pk.id;
          if (!pid) {
            const price = intShillings(r.pack_price);
            if (price === null) throw new Error(`pack "${r.pack_name}": price must be a whole number`);
            pid = d
              .prepare(`INSERT INTO packs (variant_id, name, multiple, unit, price, cost, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
              .run(v.id, r.pack_name, Math.max(1, Math.trunc(Number(r.pack_multiple) || 1)), r.pack_unit || '', price, intShillings(r.pack_cost) || 0, now)
              .lastInsertRowid;
            summary.packs++;
          }
          d.prepare('UPDATE packs SET multiple = ?, unit = ?, price = ?, cost = ?, active = 1 WHERE id = ?')
            .run(Math.max(1, Math.trunc(Number(r.pack_multiple) || 1)), r.pack_unit || '', intShillings(r.pack_price) || 0, intShillings(r.pack_cost) || 0, pid);
          ensureBarcode(v.id, r.pack_barcode, 'pack', pid, r.pack_name);
        } else if (r.section) {
          throw new Error(`unknown section "${r.section}"`);
        }
      } catch (e) {
        summary.errors.push(e.message);
      }
    }
    dbm.audit(d, { userId: req.user.id, action: 'csv/import', entity: 'product', detail: summary });
    res.json({ ok: true, ...summary });
  });

  // ---- settings -----------------------------------------------------------------------------------
  app.get('/api/settings', me, can('settings.manage'), (req, res) => {
    res.json(dbm.getSettings(d));
  });

  app.put('/api/settings', me, can('settings.manage'), (req, res) => {
    const cur = dbm.getSettings(d);
    const p = req.body || {};
    if (p.pricing && p.pricing.min_margin_pct !== undefined) {
      const f = Number(p.pricing.min_margin_pct);
      if (!Number.isFinite(f) || f < 0 || f > 99) return res.status(400).json({ error: 'min_margin_pct must be 0–99' });
      p.pricing = { ...p.pricing, min_margin_pct: f };
    }
    if (p.pricing && p.pricing.margin_policy !== undefined && !['pin', 'block'].includes(p.pricing.margin_policy)) {
      return res.status(400).json({ error: 'margin_policy must be pin or block' });
    }
    const next = {
      business: { ...cur.business, ...(p.business || {}) },
      tax: { ...cur.tax, ...(p.tax || {}) },
      receipt: { ...cur.receipt, ...(p.receipt || {}) },
      pricing: { ...cur.pricing, ...(p.pricing || {}) }
    };
    dbm.setSetting(d, 'business', next.business);
    dbm.setSetting(d, 'tax', next.tax);
    dbm.setSetting(d, 'receipt', next.receipt);
    dbm.setSetting(d, 'pricing', next.pricing);
    dbm.audit(d, { userId: req.user.id, action: 'settings/update', entity: 'settings', detail: { keys: Object.keys(p) } });
    res.json(next);
  });

  // ---- audit ----------------------------------------------------------------------------------------
  app.get('/api/audit', me, can('audit.view'), (req, res) => {
    const rows = dbm.auditRows(d, Math.min(Number(req.query.limit) || 200, 1000));
    const users = d.prepare('SELECT id, name FROM users').all();
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    res.json(rows.map((r) => ({
      ...r,
      userName: r.user_id ? names[r.user_id] || `#${r.user_id}` : 'system',
      detail: safeJson(r.detail)
    })));
  });

  app.get('/api/audit/verify', me, perms.requirePerm(d, 'audit.view'), (req, res) => {
    res.json(dbm.verifyAuditChain(d));
  });

  // ---- webhooks (Phase 16) -------------------------------------------------------------------------------
  app.post('/api/webhooks/mpesa', (req, res) => {
    res.status(501).json({ error: 'M-Pesa webhook arrives in Phase 16 (real Daraja, Days 22–23)' });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(`[error] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

function userName(d, userId) {
  if (!userId) return '';
  const u = d.prepare('SELECT name FROM users WHERE id = ?').get(userId);
  return u ? u.name : `#${userId}`;
}

const db = dbm.open();
const app = createApp(db);
const PORT = Number(process.env.PORT) || 3000;

if (require.main === module) {
  auth.pruneSessions(db);
  app.listen(PORT, '0.0.0.0', () => {
    const s = dbm.getSetting(db, 'business', {});
    console.log(`OpenPOS v2 (Phase 12 — multi-branch)  ·  ${s.name || 'fresh install — run onboarding'}  ·  http://0.0.0.0:${PORT}`);
  });
}

module.exports = { createApp };

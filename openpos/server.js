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
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'openpos-v2', phase: 3 }));

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
           (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.active = 1) AS variant_count
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
    const branchId = (branches[0] && branches[0].id) || null;
    const loc = branchId ? defaultLocation(d, branchId) : null;
    const rows = d
      .prepare(
        `SELECT p.*, c.name AS category_name, s.name AS supplier_name,
           (SELECT COALESCE(SUM(st.qty), 0) FROM variants v
             JOIN stock st ON st.variant_id = v.id AND st.location_id = ?
            WHERE v.product_id = p.id AND v.active = 1) AS stock_qty,
           (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.active = 1) AS variant_count
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
    const run = d.transaction(() => {
      const id = d
        .prepare(
          `INSERT INTO products
             (branch_id, sku, barcode, name, name_sw, category_id, brand, unit, pack_size, pack_name,
              cost, price, wholesale_price, member_price, tax_type, kra_item_code,
              age_min, requires_rx, is_controlled, track_batches, track_serials, open_priced,
              supplier_id, reorder_level, image, active, created_at, updated_at)
           VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          p.sku, p.barcode, p.name, p.name_sw, p.categoryId, p.brand, p.unit, p.packSize, p.packName,
          p.cost, p.price, p.wholesalePrice, p.memberPrice, p.taxType, p.kraCode,
          p.ageMin, p.requiresRx, p.isControlled, p.trackBatches, p.trackSerials, p.openPriced,
          p.supplierId, p.reorderLevel, p.image, now, now
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
    const run = d.transaction(() => {
      d.prepare(
        `UPDATE products SET sku = ?, barcode = ?, name = ?, name_sw = ?, category_id = ?, brand = ?,
          unit = ?, pack_size = ?, pack_name = ?, cost = ?, price = ?, wholesale_price = ?, member_price = ?,
          tax_type = ?, kra_item_code = ?, age_min = ?, requires_rx = ?, is_controlled = ?,
          track_batches = ?, track_serials = ?, open_priced = ?, supplier_id = ?, reorder_level = ?, image = ?,
          active = ?, updated_at = ? WHERE id = ?`
      ).run(
        merged.sku, merged.barcode, merged.name, merged.name_sw, merged.categoryId, merged.brand,
        merged.unit, merged.packSize, merged.packName, merged.cost, merged.price, merged.wholesalePrice,
        merged.memberPrice, merged.taxType, merged.kraCode, merged.ageMin, merged.requiresRx,
        merged.isControlled, merged.trackBatches, merged.trackSerials, merged.openPriced,
        merged.supplierId, merged.reorderLevel, merged.image,
        b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
        new Date().toISOString(),
        cur.id
      );
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

    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    const locs = locationsOf(d, branchId);
    const locationId = numOrNull(b.location_id) && locs.some((l) => l.id === b.location_id)
      ? b.location_id : (locs[0] && locs[0].id);
    if (!locationId) return res.status(400).json({ error: 'no location' });

    const run = d.transaction(() => {
      upsertStock(d, variant.id, locationId, qty);
      addStockMove(d, { product, variant, branchId, locationId, qty, type: 'adjustment', reason, ref: 'ADJ', userId: req.user.id, note: String(b.note || '') });
      return stockQty(d, variant.id, locationId);
    });
    const newQty = run();
    dbm.audit(d, {
      userId: req.user.id, branchId, action: 'stock/adjust', entity: 'product', entityId: String(productId),
      detail: { name: product.name, variant: variant.name || '(base)', qty, reason, newQty }
    });
    res.json({ ok: true, newQty, variant_id: variant.id });
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
    d.prepare(
      `UPDATE variants SET name = ?, sku = ?, price = ?, cost = ?, wholesale_price = ?, member_price = ?,
        tax_type = ?, kra_item_code = ?, meta = ?, active = ?, updated_at = ? WHERE id = ?`
    ).run(patch.name, patch.sku, patch.price, patch.cost, patch.wholesale_price, patch.member_price,
      patch.tax_type, patch.kra_item_code, patch.meta, patch.active, new Date().toISOString(), v.id);
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
    const run = d.transaction(() => {
      const pid = d
        .prepare(`INSERT INTO packs (variant_id, name, multiple, unit, price, cost, description, active, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(v.id, name, multiple, String(b.unit || '').trim(), price, intShillings(b.cost) || 0, String(b.description || '').trim(), new Date().toISOString())
        .lastInsertRowid;
      if (barcode) {
        d.prepare(`INSERT INTO variant_barcodes (variant_id, barcode, kind, pack_id, label, active) VALUES (?, ?, 'pack', ?, ?, 1)`)
          .run(v.id, barcode, pid, name);
      }
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
    if (q.variant_id) { where.push('b.variant_id = ?'); args.push(numOrNull(q.variant_id)); }
    else if (q.product_id) { where.push('b.product_id = ?'); args.push(numOrNull(q.product_id)); }
    else if (q.location_id) { where.push('b.location_id = ?'); args.push(numOrNull(q.location_id)); }
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
    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    const locs = locationsOf(d, branchId);
    const locationId = numOrNull(b.location_id) && locs.some((l) => l.id === b.location_id)
      ? b.location_id : (locs[0] && locs[0].id);
    if (!locationId) return res.status(400).json({ error: 'no location' });
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
    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    const locs = locationsOf(d, branchId);
    const locationId = numOrNull(b.location_id) && locs.some((l) => l.id === b.location_id)
      ? b.location_id : (locs[0] && locs[0].id);
    if (!locationId) return res.status(400).json({ error: 'no location' });
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
    const run = d.transaction(() => {
      d.prepare("UPDATE serials SET status = 'writeoff' WHERE id = ?").run(s.id);
      if (s.location_id) {
        upsertStock(d, variant.id, s.location_id, -1);
        addStockMove(d, { product, variant, branchId, locationId: s.location_id, qty: -1, type: 'adjustment', reason: 'other', ref: 'SERIAL', userId: req.user.id, note: `serial writeoff ${s.serial_no}` });
      }
    });
    run();
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
  app.get('/api/suppliers', me, (req, res) => {
    res.json(d.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all());
  });

  app.post('/api/suppliers', me, can('products.manage'), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'supplier name required' });
    const id = d
      .prepare(`INSERT INTO suppliers (name, phone, kra_pin, address, terms, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(name, String(b.phone || '').trim(), String(b.kraPin || '').trim(), String(b.address || '').trim(), String(b.terms || '').trim(), new Date().toISOString())
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'supplier/create', entity: 'supplier', entityId: String(id), detail: { name } });
    res.json({ ok: true, id });
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
            age_min: r.product_age_min ? Number(r.product_age_min) : null,
            requires_rx: r.product_requires_rx ? 1 : 0, is_controlled: r.product_controlled ? 1 : 0,
            track_batches: r.product_track_batches ? 1 : 0, track_serials: r.product_track_serials ? 1 : 0,
            open_priced: r.product_open_priced ? 1 : 0,
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
    const next = {
      business: { ...cur.business, ...(p.business || {}) },
      tax: { ...cur.tax, ...(p.tax || {}) },
      receipt: { ...cur.receipt, ...(p.receipt || {}) }
    };
    dbm.setSetting(d, 'business', next.business);
    dbm.setSetting(d, 'tax', next.tax);
    dbm.setSetting(d, 'receipt', next.receipt);
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
    console.log(`OpenPOS v2 (Phase 3)  ·  ${s.name || 'fresh install — run onboarding'}  ·  http://0.0.0.0:${PORT}`);
  });
}

module.exports = { createApp };

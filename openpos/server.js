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
    openPriced: p.open_priced ? 1 : 0
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
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'openpos-v2', phase: 2 }));

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
        const stock = d.prepare(
          `INSERT INTO stock (product_id, location_id, qty) VALUES (?, ?, ?)
           ON CONFLICT(product_id, location_id) DO UPDATE SET qty = qty + excluded.qty`
        );
        const move = d.prepare(
          `INSERT INTO stock_moves (product_id, branch_id, location_id, qty, type, reason, ref, user_id, note, created_at)
           VALUES (?, ?, ?, ?, 'initial', 'opening', 'SAMPLE', ?, '', ?)`
        );
        const insBatch = d.prepare(
          `INSERT INTO batches (product_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        sample.products.forEach((p, i) => {
          const cat = cats[p.categoryId - 1] || cats[0];
          const pid = insProd.run(
            p.sku, p.barcode, p.name, p.name_sw, cat ? cat.id : null, p.unit, p.cost, p.price,
            p.taxType, p.kraItemCode, p.ageMin, p.requiresRx, p.isControlled, p.trackBatches,
            p.openPriced, now, now
          ).lastInsertRowid;
          stock.run(pid, locId, 24);
          move.run(pid, brId, locId, 24, ownerId, now);
          if (p.trackBatches) {
            const exp = new Date(Date.now() + 540 * 86400e3).toISOString().slice(0, 10);
            insBatch.run(pid, brId, locId, `S-${p.sku}`, exp, 24, p.cost, now);
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
        `SELECT p.*, c.name AS category_name, COALESCE(st.qty, 0) AS stock_qty
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN stock st ON st.product_id = p.id AND st.location_id = ?
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
        `SELECT p.*, c.name AS category_name, COALESCE(st.qty, 0) AS stock_qty
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN stock st ON st.product_id = p.id AND st.location_id = ?
          ORDER BY c.name, p.name`
      )
      .all(loc ? loc.id : 0);
    res.json(rows.map(publicProduct));
  });

  app.post('/api/products', me, can('products.manage'), (req, res) => {
    const p = cleanProduct(req.body || {});
    if (p.error) return res.status(400).json({ error: p.error });
    const now = new Date().toISOString();
    const id = d
      .prepare(
        `INSERT INTO products
           (branch_id, sku, barcode, name, name_sw, category_id, brand, unit, pack_size, pack_name,
            cost, price, wholesale_price, member_price, tax_type, kra_item_code,
            age_min, requires_rx, is_controlled, track_batches, open_priced, active, created_at, updated_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        p.sku, p.barcode, p.name, p.name_sw, p.categoryId, p.brand, p.unit, p.packSize, p.packName,
        p.cost, p.price, p.wholesalePrice, p.memberPrice, p.taxType, p.kraCode,
        p.ageMin, p.requiresRx, p.isControlled, p.trackBatches, p.openPriced, 1, now, now
      ).lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'product/create', entity: 'product', entityId: String(id), detail: { name: p.name, price: p.price } });
    res.json({ ok: true, id });
  });

  app.put('/api/products/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM products WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    const merged = cleanProduct({ ...cur, ...(req.body || {}) });
    if (merged.error) return res.status(400).json({ error: merged.error });
    d.prepare(
      `UPDATE products SET sku = ?, barcode = ?, name = ?, name_sw = ?, category_id = ?, brand = ?,
        unit = ?, pack_size = ?, pack_name = ?, cost = ?, price = ?, wholesale_price = ?, member_price = ?,
        tax_type = ?, kra_item_code = ?, age_min = ?, requires_rx = ?, is_controlled = ?,
        track_batches = ?, open_priced = ?, active = ?, updated_at = ? WHERE id = ?`
    ).run(
      merged.sku, merged.barcode, merged.name, merged.name_sw, merged.categoryId, merged.brand,
      merged.unit, merged.packSize, merged.packName, merged.cost, merged.price, merged.wholesalePrice,
      merged.memberPrice, merged.taxType, merged.kraCode, merged.ageMin, merged.requiresRx,
      merged.isControlled, merged.trackBatches, merged.openPriced,
      (req.body || {}).active !== undefined ? ((req.body || {}).active ? 1 : 0) : cur.active,
      new Date().toISOString(),
      cur.id
    );
    dbm.audit(d, { userId: req.user.id, action: 'product/update', entity: 'product', entityId: String(cur.id), detail: { name: merged.name, price: merged.price } });
    res.json({ ok: true });
  });

  app.delete('/api/products/:id', me, can('products.manage'), (req, res) => {
    const cur = d.prepare('SELECT * FROM products WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    d.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), cur.id);
    dbm.audit(d, { userId: req.user.id, action: 'product/delete', entity: 'product', entityId: String(cur.id), detail: { name: cur.name } });
    res.json({ ok: true });
  });

  // ---- stock adjust (core housekeeping — not a capability) --------------------------------------
  const ADJUST_REASONS = ['stocktake', 'damage', 'expired', 'other'];
  app.post('/api/stock/adjust', me, can('stock.adjust'), (req, res) => {
    const b = req.body || {};
    const productId = numOrNull(b.product_id);
    const qty = Number(b.qty);
    const reason = ADJUST_REASONS.includes(b.reason) ? b.reason : null;
    const product = productId && d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
    if (!product) return res.status(400).json({ error: 'unknown product' });
    if (!Number.isFinite(qty) || qty === 0) return res.status(400).json({ error: 'qty must be non-zero' });
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const branches = visibleBranches(d, req.user);
    const branchId = (branches[0] && branches[0].id) || null;
    const locs = locationsOf(d, branchId);
    const locationId = numOrNull(b.location_id) && locs.some((l) => l.id === b.location_id)
      ? b.location_id : (locs[0] && locs[0].id);
    if (!locationId) return res.status(400).json({ error: 'no location' });

    const run = d.transaction(() => {
      const cur = d.prepare('SELECT qty FROM stock WHERE product_id = ? AND location_id = ?').get(productId, locationId) || { qty: 0 };
      d.prepare(
        `INSERT INTO stock (product_id, location_id, qty) VALUES (?, ?, ?)
         ON CONFLICT(product_id, location_id) DO UPDATE SET qty = qty + ?`
      ).run(productId, locationId, qty, qty);
      d.prepare(
        `INSERT INTO stock_moves (product_id, branch_id, location_id, qty, type, reason, ref, user_id, note, created_at)
         VALUES (?, ?, ?, ?, 'adjustment', ?, 'ADJ', ?, ?, ?)`
      ).run(productId, branchId, locationId, qty, reason, req.user.id, String(b.note || ''), new Date().toISOString());
      return cur.qty + qty;
    });
    const newQty = run();
    dbm.audit(d, {
      userId: req.user.id, branchId, action: 'stock/adjust', entity: 'product', entityId: String(productId),
      detail: { name: product.name, qty, reason, newQty }
    });
    res.json({ ok: true, newQty });
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
    console.log(`OpenPOS v2 (Phase 2)  ·  ${s.name || 'fresh install — run onboarding'}  ·  http://0.0.0.0:${PORT}`);
  });
}

module.exports = { createApp };

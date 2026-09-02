'use strict';
// ---------------------------------------------------------------------------
// OpenPOS v2 — server (Express + better-sqlite3, no build step).
// Day 1: skeleton, onboarding wizard, secure PIN auth, branches, catalog,
// categories, staff, settings, audit. (Till = Day 3, eTIMS/M-Pesa = Phase 2.)
// ---------------------------------------------------------------------------
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dbm = require('./db');
const auth = require('./lib/auth');
const { TRADES } = require('./lib/sample');

const ROLES = ['owner', 'manager', 'cashier', 'staff'];

function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, branchId: u.branch_id };
}

function branchRow(d, id) {
  return d.prepare('SELECT * FROM branches WHERE id = ?').get(id);
}

function activeBranches(d) {
  return d.prepare('SELECT * FROM branches WHERE active = 1 ORDER BY id').all();
}

function defaultBranch(d) {
  return d.prepare('SELECT * FROM branches WHERE is_default = 1 AND active = 1').get() || activeBranches(d)[0] || null;
}

function startOfTodayIso() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate()).toISOString();
}

function createApp(d) {
  const app = express();
  const mgr = (...extra) => auth.requireRole(d, 'owner', 'manager', ...extra);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- health / status ------------------------------------------------------
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'openpos-v2', day: 1 }));

  app.get('/api/setup/status', (req, res) => {
    res.json({
      initialized: dbm.isInitialized(d),
      trades: TRADES,
      businessName: dbm.getSetting(d, 'business', {}).name || null
    });
  });

  app.get('/api/trades', (req, res) => res.json(TRADES));

  // ---- first-run setup (only while no users exist) --------------------------
  app.post('/api/setup', (req, res) => {
    if (dbm.isInitialized(d)) return res.status(409).json({ error: 'already initialized' });
    const b = (req.body && req.body.business) || {};
    const owner = (req.body && req.body.owner) || {};
    const br = (req.body && req.body.branch) || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'business name required' });
    if (!owner.name || !String(owner.name).trim()) return res.status(400).json({ error: 'owner name required' });
    const pin = String(owner.pin || '');
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'owner PIN must be 4-8 digits' });
    const trade = TRADES[b.trade] ? b.trade : 'duka';
    const vatRate = Number(b.vatRate) > 0 ? Number(b.vatRate) : 16;
    const branchName = br.name && String(br.name).trim() ? String(br.name).trim() : 'Main Branch';

    const run = d.transaction(() => {
      dbm.setSetting(d, 'business', {
        name: String(b.name).trim(),
        address: b.address || '',
        phone: b.phone || '',
        kraPin: b.kraPin || '',
        kraPinType: b.kraPinType || 'pin',
        vatRegistered: b.vatRegistered ? 1 : 0,
        receiptFooter: b.receiptFooter || '',
        trade
      });
      dbm.setSetting(d, 'tax', { vatRate, currency: b.currency || 'KES', symbol: b.symbol || 'Ksh' });

      const brId = d.prepare(
        `INSERT INTO branches (code, name, address, phone, kra_pin, vat_registered, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(
        'BR01', branchName, br.address || b.address || '', br.phone || b.phone || '',
        b.kraPin || '', b.vatRegistered ? 1 : 0, new Date().toISOString()
      ).lastInsertRowid;

      d.prepare(
        'INSERT INTO terminals (branch_id, name, created_at) VALUES (?, ?, ?)'
      ).run(brId, 'Till 1', new Date().toISOString());

      const salt = crypto.randomBytes(16).toString('hex');
      const ownerId = d.prepare(
        `INSERT INTO users (name, role, branch_id, pin_hash, salt, active, created_at)
         VALUES (?, 'owner', NULL, ?, ?, 1, ?)`
      ).run(
        String(owner.name).trim(), auth.hashPin(pin, salt), salt, new Date().toISOString()
      ).lastInsertRowid;

      // optional sample data
      if (req.body.sample) {
        const { buildSample } = require('./lib/sample');
        const sample = buildSample(trade);
        const insCat = d.prepare(
          `INSERT INTO categories (branch_id, name, name_sw, active) VALUES (NULL, ?, ?, 1)`
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
        const now = new Date().toISOString();
        const stock = d.prepare(
          `INSERT INTO stock (product_id, branch_id, qty) VALUES (?, ?, ?)
           ON CONFLICT(product_id, branch_id) DO UPDATE SET qty = qty + excluded.qty`
        );
        const move = d.prepare(
          `INSERT INTO stock_moves (product_id, branch_id, qty, type, ref, user_id, note, created_at)
           VALUES (?, ?, ?, 'initial', 'SAMPLE', ?, '', ?)`
        );
        const insBatch = d.prepare(
          `INSERT INTO batches (product_id, branch_id, batch_no, expiry_date, qty, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        sample.products.forEach((p, i) => {
          const cat = cats.find((c) => c.name === (sample.categories[p.categoryId - 1] || {}).name) || cats[0];
          const pid = insProd.run(
            p.sku, p.barcode, p.name, p.name_sw, cat ? cat.id : null, p.unit, p.cost, p.price,
            p.taxType, p.kraItemCode, p.ageMin, p.requiresRx, p.isControlled, p.trackBatches,
            p.openPriced, now, now
          ).lastInsertRowid;
          stock.run(pid, brId, 24);
          move.run(pid, brId, 24, ownerId, now);
          if (p.trackBatches) {
            const exp = new Date(Date.now() + 540 * 86400e3).toISOString().slice(0, 10);
            insBatch.run(pid, brId, `S-${p.sku}`, exp, 24, p.cost, now);
          }
        });
      }

      dbm.audit(d, {
        userId: ownerId, branchId: brId, action: 'system/setup', entity: 'business',
        detail: { name: b.name, trade, branch: branchName, sample: !!req.body.sample }
      });
      return { brId, ownerId };
    });

    const { brId, ownerId } = run();
    const token = auth.createSession(d, ownerId);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, auth.SESSION_HOURS * 3600e3));
    const user = d.prepare('SELECT * FROM users WHERE id = ?').get(ownerId);
    res.json({ ok: true, user: publicUser(user), branchId: brId });
  });

  // ---- auth -------------------------------------------------------------------
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
    res.json({
      user: publicUser(user),
      branches: activeBranches(d).map((b) => ({ id: b.id, name: b.name, code: b.code }))
    });
  });

  app.post('/api/logout', (req, res) => {
    auth.destroySession(d, auth.getCookie(req, 'openpos_session'));
    res.setHeader('Set-Cookie', 'openpos_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  const me = auth.sessionPath(d);
  app.get('/api/me', me, (req, res) => {
    res.json({ user: req.user, branches: visibleBranches(d, req.user) });
  });

  // ---- bootstrap (everything the till/manager needs in one call) --------------
  app.get('/api/bootstrap', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    const branchId = numOrNull(req.query.branch_id) || (branches[0] && branches[0].id) || null;
    const settings = dbm.getSettings(d);
    const categories = d
      .prepare('SELECT * FROM categories WHERE active = 1 ORDER BY name')
      .all();
    const products = d
      .prepare(
        `SELECT p.*, c.name AS category_name,
                COALESCE(po.price, p.price) AS eff_price,
                COALESCE(st.qty, 0) AS stock_qty
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN price_overrides po ON po.product_id = p.id AND po.branch_id = ?
           LEFT JOIN stock st ON st.product_id = p.id AND st.branch_id = ?
          WHERE p.active = 1
          ORDER BY c.name, p.name`
      )
      .all(branchId || 0, branchId || 0);
    const openShift = branchId
      ? d.prepare(`SELECT * FROM shifts WHERE branch_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(branchId)
      : null;
    res.json({
      settings,
      me: req.user,
      branches,
      branchId,
      categories,
      products: products.map(publicProduct),
      openShift: openShift
        ? { id: openShift.id, openedAt: openShift.opened_at, float: openShift.float_open, userName: shiftUserName(d, openShift.user_id) }
        : null
    });
  });

  // ---- today (dashboard) -------------------------------------------------------
  app.get('/api/today', me, (req, res) => {
    const branches = visibleBranches(d, req.user);
    const branchId = numOrNull(req.query.branch_id);
    const scope = branchId && branches.some((b) => b.id === branchId) ? branchId : (branches[0] && branches[0].id);
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

  // ---- branches -----------------------------------------------------------------
  app.get('/api/branches', me, (req, res) => {
    const rows = activeBranches(d);
    res.json(rows.map((b) => ({
      ...b,
      salesToday: d
        .prepare('SELECT COALESCE(SUM(gross),0) AS t, COUNT(*) AS n FROM sales WHERE branch_id = ? AND status IN (\'paid\',\'partial\') AND created_at >= ?')
        .get(b.id, startOfTodayIso())
    })));
  });

  app.post('/api/branches', me, mgr(), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'branch name required' });
    if (activeBranches(d).length >= 500) return res.status(400).json({ error: 'branch limit reached' });
    const id = d
      .prepare('INSERT INTO branches (code, name, address, phone, kra_pin, vat_registered, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(
        nextBranchCode(d), name, b.address || '', b.phone || '',
        b.kraPin || dbm.getSetting(d, 'business', {}).kraPin || '', b.vatRegistered ? 1 : 0, new Date().toISOString()
      ).lastInsertRowid;
    d.prepare('INSERT INTO terminals (branch_id, name, created_at) VALUES (?, ?, ?)').run(id, 'Till 1', new Date().toISOString());
    dbm.audit(d, { userId: req.user.id, action: 'branch/create', entity: 'branch', entityId: String(id), detail: { name } });
    res.json({ ok: true, id });
  });

  app.put('/api/branches/:id', me, mgr(), (req, res) => {
    const b = branchRow(d, numOrNull(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    const patch = req.body || {};
    d.prepare(
      `UPDATE branches SET name = ?, address = ?, phone = ?, kra_pin = ?, vat_registered = ?, active = ? WHERE id = ?`
    ).run(
      String(patch.name || b.name).trim(),
      patch.address !== undefined ? patch.address : b.address,
      patch.phone !== undefined ? patch.phone : b.phone,
      patch.kraPin !== undefined ? patch.kraPin : b.kra_pin,
      patch.vatRegistered !== undefined ? (patch.vatRegistered ? 1 : 0) : b.vat_registered,
      patch.active !== undefined ? (patch.active ? 1 : 0) : b.active,
      b.id
    );
    if (patch.isDefault) {
      d.prepare('UPDATE branches SET is_default = 0').run();
      d.prepare('UPDATE branches SET is_default = 1 WHERE id = ?').run(b.id);
    }
    dbm.audit(d, { userId: req.user.id, branchId: b.id, action: 'branch/update', entity: 'branch', entityId: String(b.id), detail: patch });
    res.json({ ok: true });
  });

  app.delete('/api/branches/:id', me, mgr(), (req, res) => {
    const b = branchRow(d, numOrNull(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    if (b.is_default) return res.status(400).json({ error: 'cannot delete the default branch' });
    const sales = d.prepare('SELECT COUNT(*) AS n FROM sales WHERE branch_id = ?').get(b.id).n;
    if (sales > 0) return res.status(400).json({ error: 'branch has sales — deactivate it instead' });
    // remove child rows that reference the branch (FK-safe)
    d.prepare('DELETE FROM terminals WHERE branch_id = ?').run(b.id);
    d.prepare('DELETE FROM stock WHERE branch_id = ?').run(b.id);
    d.prepare('DELETE FROM stock_moves WHERE branch_id = ?').run(b.id);
    d.prepare('DELETE FROM price_overrides WHERE branch_id = ?').run(b.id);
    d.prepare('DELETE FROM branches WHERE id = ?').run(b.id);
    dbm.audit(d, { userId: req.user.id, action: 'branch/delete', entity: 'branch', entityId: String(b.id), detail: { name: b.name } });
    res.json({ ok: true });
  });

  // ---- staff ----------------------------------------------------------------------
  app.get('/api/staff', me, mgr(), (req, res) => {
    const rows = d.prepare(
      'SELECT u.id, u.name, u.role, u.branch_id, u.active, u.last_login_at, b.name AS branch_name FROM users u LEFT JOIN branches b ON b.id = u.branch_id ORDER BY u.name'
    ).all();
    res.json(rows);
  });

  app.post('/api/staff', me, mgr(), (req, res) => {
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
      .prepare('INSERT INTO users (name, role, branch_id, pin_hash, salt, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(name, role, branchId, auth.hashPin(pin, salt), salt, new Date().toISOString())
      .lastInsertRowid;
    dbm.audit(d, { userId: req.user.id, action: 'staff/create', entity: 'user', entityId: String(id), detail: { name, role, branchId } });
    res.json({ ok: true, id });
  });

  app.put('/api/staff/:id', me, mgr(), (req, res) => {
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
      `UPDATE users SET name = ?, role = ?, branch_id = ?, active = ?, pin_hash = ?, salt = ? WHERE id = ?`
    ).run(
      String(s.name || u.name).trim(),
      s.role || u.role,
      s.branch_id !== undefined ? numOrNull(s.branch_id) : u.branch_id,
      s.active !== undefined ? (s.active ? 1 : 0) : u.active,
      s.pin ? auth.hashPin(s.pin, salt) : u.pin_hash,
      salt,
      u.id
    );
    dbm.audit(d, { userId: req.user.id, action: 'staff/update', entity: 'user', entityId: String(u.id), detail: { name: s.name, role: s.role, active: s.active, pinChanged: !!s.pin } });
    res.json({ ok: true });
  });

  // ---- categories -------------------------------------------------------------------
  app.get('/api/categories', me, (req, res) => {
    res.json(d.prepare('SELECT * FROM categories ORDER BY name').all());
  });

  app.post('/api/categories', me, mgr(), (req, res) => {
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

  app.put('/api/categories/:id', me, mgr(), (req, res) => {
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

  app.delete('/api/categories/:id', me, mgr(), (req, res) => {
    const c = d.prepare('SELECT * FROM categories WHERE id = ?').get(numOrNull(req.params.id));
    if (!c) return res.status(404).json({ error: 'not found' });
    const used = d.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(c.id).n;
    if (used > 0) return d.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(c.id);
    d.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
    dbm.audit(d, { userId: req.user.id, action: 'category/delete', entity: 'category', entityId: String(c.id), detail: { name: c.name, detached: used } });
    res.json({ ok: true, detached: used });
  });

  // ---- products -----------------------------------------------------------------------
  app.get('/api/products', me, (req, res) => {
    const def = defaultBranch(d);
    const rows = d
      .prepare(
        `SELECT p.*, c.name AS category_name, COALESCE(st.qty, 0) AS stock_qty
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN stock st ON st.product_id = p.id AND st.branch_id = ?
          ORDER BY c.name, p.name`
      )
      .all(def ? def.id : 0);
    res.json(rows.map(publicProduct));
  });

  app.post('/api/products', me, mgr(), (req, res) => {
    const p = cleanProduct(req.body || {});
    const err = p.error;
    if (err) return res.status(400).json({ error: err });
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

  app.put('/api/products/:id', me, mgr(), (req, res) => {
    const cur = d.prepare('SELECT * FROM products WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    const merged = cleanProduct({ ...cur, ...(req.body || {}) });
    const err = merged.error;
    if (err) return res.status(400).json({ error: err });
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

  app.delete('/api/products/:id', me, mgr(), (req, res) => {
    const cur = d.prepare('SELECT * FROM products WHERE id = ?').get(numOrNull(req.params.id));
    if (!cur) return res.status(404).json({ error: 'not found' });
    d.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), cur.id);
    dbm.audit(d, { userId: req.user.id, action: 'product/delete', entity: 'product', entityId: String(cur.id), detail: { name: cur.name } });
    res.json({ ok: true });
  });

  // ---- settings -----------------------------------------------------------------------
  app.get('/api/settings', me, mgr(), (req, res) => {
    res.json(dbm.getSettings(d));
  });

  app.put('/api/settings', me, mgr(), (req, res) => {
    const cur = dbm.getSettings(d);
    const p = req.body || {};
    const next = {
      business: { ...cur.business, ...(p.business || {}) },
      tax: { ...cur.tax, ...(p.tax || {}) }
    };
    dbm.setSetting(d, 'business', next.business);
    dbm.setSetting(d, 'tax', next.tax);
    dbm.audit(d, { userId: req.user.id, action: 'settings/update', entity: 'settings', detail: { keys: Object.keys(p) } });
    res.json(next);
  });

  // ---- audit ------------------------------------------------------------------------------
  app.get('/api/audit', me, mgr(), (req, res) => {
    const rows = dbm.auditRows(d, Math.min(Number(req.query.limit) || 200, 1000));
    const users = d.prepare('SELECT id, name FROM users').all();
    const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
    res.json(rows.map((r) => ({
      ...r,
      userName: r.user_id ? names[r.user_id] || `#${r.user_id}` : 'system',
      detail: safeJson(r.detail)
    })));
  });

  app.get('/api/audit/verify', me, auth.requireRole(d, 'owner'), (req, res) => {
    res.json(dbm.verifyAuditChain(d));
  });

  // ---- webhooks (Phase 2) ------------------------------------------------------------------
  app.post('/api/webhooks/mpesa', (req, res) => {
    res.status(501).json({ error: 'M-Pesa webhook arrives on Day 7 (Phase 2)' });
  });

  // 404 for unknown API routes
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // JSON error handler (API)
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(`[error] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

// ---- helpers ----------------------------------------------------------------------
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function visibleBranches(d, user) {
  const all = activeBranches(d);
  if (user.branchId) return all.filter((b) => b.id === user.branchId);
  return all;
}

function shiftUserName(d, userId) {
  if (!userId) return '';
  const u = d.prepare('SELECT name FROM users WHERE id = ?').get(userId);
  return u ? u.name : `#${userId}`;
}

function nextBranchCode(d) {
  const n = d.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
  let code;
  do {
    code = `BR${String(n + 1).padStart(2, '0')}`;
  } while (d.prepare('SELECT id FROM branches WHERE code = ?').get(code));
  return code;
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
  const cost = num(p.cost);
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
    cost,
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

// ---- boot -----------------------------------------------------------------------------
const db = dbm.open();
const app = createApp(db);
const PORT = Number(process.env.PORT) || 3000;

if (require.main === module) {
  auth.pruneSessions(db);
  app.listen(PORT, '0.0.0.0', () => {
    const s = dbm.getSetting(db, 'business', {});
    console.log(`OpenPOS v2  ·  ${s.name || 'fresh install — run onboarding'}  ·  http://0.0.0.0:${PORT}`);
  });
}

module.exports = { createApp };

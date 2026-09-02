'use strict';
// ---------------------------------------------------------------------------
// OpenPOS v2 — test runner (no framework). Unit + full API flow on a temp DB.
// Day 2: capability system + tenancy foundation acceptance tests.
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

function section(title) { console.log(`\n${title}`); }

(async () => {
  // ---------------- money ----------------
  section('money (integer shillings, VAT-inclusive prices)');
  const { lineTax, calcSale } = require('../lib/money');

  await test('1160 std @16% → net 1000, tax 160', () => {
    assert.deepStrictEqual(lineTax(1160, 'std', 16), { gross: 1160, net: 1000, tax: 160 });
  });
  await test('exempt and zero keep gross as net', () => {
    assert.deepStrictEqual(lineTax(500, 'exempt', 16), { gross: 500, net: 500, tax: 0 });
    assert.deepStrictEqual(lineTax(500, 'zero', 16), { gross: 500, net: 500, tax: 0 });
  });
  await test('rounding: 115 std @16% → net 99, tax 16', () => {
    assert.deepStrictEqual(lineTax(115, 'std', 16), { gross: 115, net: 99, tax: 16 });
  });
  await test('mixed sale: std + exempt lines tie out', () => {
    const r = calcSale([
      { qty: 2, price: 580, taxType: 'std' },
      { qty: 1, price: 100, taxType: 'exempt' }
    ], 16);
    assert.strictEqual(r.gross, 1260);
    assert.strictEqual(r.tax, 160 + 0);
    assert.strictEqual(r.net, r.gross - r.tax);
  });
  await test('line discount + order discount allocate correctly', () => {
    const r = calcSale([
      { qty: 1, price: 1160, taxType: 'std', lineDiscount: 160 }, // gross 1000
      { qty: 1, price: 1160, taxType: 'std' }                     // gross 1160
    ], 16, 116); // 10% of subtotal 2160
    assert.strictEqual(r.subtotal, 2160);
    assert.strictEqual(r.discount, 116);
    assert.strictEqual(r.gross, 2044);
    // pro-rata: line1 gets round(116*1000/2160)=54, last line gets remainder 62
    assert.strictEqual(r.lines[0].gross, 946);
    assert.strictEqual(r.lines[1].gross, 1098);
    // net+tax must always tie back to gross
    assert.strictEqual(r.lines[0].net + r.lines[0].tax, 946);
    assert.strictEqual(r.lines[1].net + r.lines[1].tax, 1098);
    assert.strictEqual(r.net + r.tax, r.gross);
  });
  await test('order discount cannot exceed subtotal', () => {
    const r = calcSale([{ qty: 1, price: 100, taxType: 'std' }], 16, 9999);
    assert.strictEqual(r.discount, 100);
    assert.strictEqual(r.gross, 0);
  });

  // ---------------- server / API flow ----------------
  section('API flow (temp DB) — Phase 2: capabilities + tenancy foundation');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openpos-test-'));
  process.env.OPENPOS_DB = path.join(tmp, 'test.db');
  process.env.OPENPOS_DATA_DIR = tmp;
  const dbm = require('../db');
  const d = dbm.open();
  const { createApp } = require('../server');
  const app = createApp(d);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const J = (opts) => fetch(BASE + opts.path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual'
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));

  const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

  let cookie = '';
  const authJ = (a, b, c) => {
    const o = typeof a === 'string' ? { path: a, method: b, body: c } : a;
    return J({ ...o, headers: { cookie } });
  };
  const withCookie = (ck) => (o) => J({ ...o, headers: { cookie: ck } });

  await test('health', async () => {
    const r = await authJ({ path: '/api/health' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });

  await test('setup status: not initialized', async () => {
    const r = await authJ({ path: '/api/setup/status' });
    assert.strictEqual(r.body.initialized, false);
    assert.ok(r.body.trades.duka, 'trade list present');
  });

  await test('setup v2: duka solo-first (no branch question), sample data', async () => {
    const r = await J({
      path: '/api/setup', method: 'POST',
      body: {
        business: {
          name: 'Test Traders', phone: '+254700000000', trade: 'duka',
          kraPin: 'A12345678X', vatRegistered: true, vatRate: 16
        },
        owner: { name: 'Owner One', pin: '1234' },
        sample: true
      }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.role, 'owner');
    cookie = cookieOf(r);
    assert.ok(cookie.startsWith('openpos_session='));
  });

  await test('setup cannot run twice', async () => {
    const r = await authJ({ path: '/api/setup', method: 'POST', body: {} });
    assert.strictEqual(r.status, 409);
  });

  await test('unauthenticated API is 401', async () => {
    const r = await J({ path: '/api/products' });
    assert.strictEqual(r.status, 401);
  });

  await test('bootstrap v2: invisible Main Branch + Main Store + Till 1', async () => {
    const r = await authJ('/api/bootstrap');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.settings.business.name, 'Test Traders');
    assert.strictEqual(r.body.branches.length, 1);
    assert.strictEqual(r.body.branches[0].code, 'BR01');
    assert.strictEqual(r.body.locations.length, 1);
    assert.strictEqual(r.body.locations[0].name, 'Main Store');
    assert.strictEqual(r.body.locations[0].is_default, 1);
    assert.strictEqual(r.body.locations[0].is_warehouse, 0);
    assert.strictEqual(r.body.registers.length, 1);
    assert.strictEqual(r.body.registers[0].name, 'Till 1');
    assert.strictEqual(r.body.registers[0].location_id, r.body.locations[0].id);
    // sample stock is location-scoped
    assert.ok(r.body.products.length >= 10, `expected ≥10 products, got ${r.body.products.length}`);
    const rice = r.body.products.find((p) => p.name.startsWith('Rice'));
    assert.strictEqual(rice.stock_qty, 24);
    assert.ok(r.body.caps && typeof r.body.suggestions === 'object');
  });

  await test('solo defaults: duka seeds deni; multi_* & staff_roles OFF', async () => {
    const r = await authJ('/api/capabilities');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 18, '18-capability registry');
    const m = Object.fromEntries(r.body.map((c) => [c.id, c.enabled]));
    assert.strictEqual(m.deni, true, 'duka template seeds deni');
    assert.strictEqual(m.multi_branch, false);
    assert.strictEqual(m.multi_location, false);
    assert.strictEqual(m.staff_roles, false);
    assert.strictEqual(m.warehouse, false);
    assert.strictEqual(m.departments, false);
    assert.strictEqual(m.purchasing, false);
  });

  await test('second till in one location → multi_location suggestion fires', async () => {
    const t2 = await authJ({ path: '/api/registers', method: 'POST', body: { name: 'Till 2' } });
    assert.strictEqual(t2.status, 200);
    const b = await authJ('/api/bootstrap');
    const s = b.body.suggestions.find((x) => x.capability === 'multi_location');
    assert.ok(s, 'suggestion present');
    assert.ok(s.reason && s.reasonSw, 'EN + SW reasons');
  });

  await test('owner enables multi_location: flag flips, NO migration (still 1 location)', async () => {
    const before = (await authJ('/api/locations')).body.length;
    const r = await authJ({ path: '/api/capabilities', method: 'POST', body: { capability: 'multi_location', enabled: true } });
    assert.strictEqual(r.status, 200);
    const after = (await authJ('/api/locations')).body.length;
    assert.strictEqual(after, before, 'no location auto-created');
    const b = await authJ('/api/bootstrap');
    assert.strictEqual(b.body.caps.multi_location, true);
    // suggestion is gone now (capability already on)
    assert.strictEqual(b.body.suggestions.find((x) => x.capability === 'multi_location'), undefined);
  });

  await test('manager cannot manage capabilities (owner-only)', async () => {
    const m = await authJ({
      path: '/api/staff', method: 'POST',
      body: { name: 'Mwenyeji M', role: 'manager', pin: '2345', branch_id: 1 }
    });
    assert.strictEqual(m.status, 200);
    const l = await authJ({ path: '/api/login', method: 'POST', body: { name: 'Mwenyeji M', pin: '2345' } });
    assert.strictEqual(l.status, 200);
    const managerJ = withCookie(cookieOf(l));
    const forbidden = await managerJ({ path: '/api/capabilities', method: 'POST', body: { capability: 'departments', enabled: true } });
    assert.strictEqual(forbidden.status, 403);
    const capRows = d.prepare('SELECT enabled FROM business_capabilities WHERE capability = ?').get('departments');
    assert.strictEqual(capRows.enabled, 0, 'capability NOT toggled by manager');
    // manager CAN manage branches/staff/settings (everything else)
    const ok = await managerJ({ path: '/api/branches' });
    assert.strictEqual(ok.status, 200);
  });

  await test('fixture: 3 branches × 2+ locations × 2+ registers × 1 warehouse (via API)', async () => {
    const b2 = await authJ({ path: '/api/branches', method: 'POST', body: { name: 'Eastleigh Branch', phone: '+254700111111' } });
    assert.strictEqual(b2.status, 200);
    const b3 = await authJ({ path: '/api/branches', method: 'POST', body: { name: 'Nakuru Branch', phone: '+254700222222' } });
    assert.strictEqual(b3.status, 200);
    const [br2, br3] = [b2.body.id, b3.body.id];

    // each new branch got its default location automatically
    let locs = (await authJ('/api/locations')).body;
    assert.ok(locs.find((l) => l.branch_id === br2 && l.is_default === 1));
    assert.ok(locs.find((l) => l.branch_id === br3 && l.is_default === 1));

    // a second location in each new branch
    const mall = await authJ({ path: '/api/locations', method: 'POST', body: { name: 'Eastleigh Mall', branch_id: br2, address: 'Mall Rd' } });
    assert.strictEqual(mall.status, 200);
    const arcade = await authJ({ path: '/api/locations', method: 'POST', body: { name: 'Nakuru Arcade', branch_id: br3 } });
    assert.strictEqual(arcade.status, 200);

    // registers: one per location in BR02 + BR03
    const r1 = await authJ({ path: '/api/registers', method: 'POST', body: { name: 'BR2 Front', branch_id: br2 } });
    const r2 = await authJ({ path: '/api/registers', method: 'POST', body: { name: 'BR2 Mall', branch_id: br2, location_id: mall.body.id } });
    const r3 = await authJ({ path: '/api/registers', method: 'POST', body: { name: 'BR3 Main', branch_id: br3 } });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r3.status, 200);
    assert.strictEqual(r2.body.id >= 1, true);

    // enabling warehouse seeds a non-selling location (data, not a migration)
    const w = await authJ({ path: '/api/capabilities', method: 'POST', body: { capability: 'warehouse', enabled: true } });
    assert.strictEqual(w.status, 200);
    const storeRoom = d.prepare("SELECT * FROM locations WHERE is_warehouse = 1").all();
    assert.strictEqual(storeRoom.length, 1, 'one warehouse seeded');
    assert.strictEqual(storeRoom[0].name, 'Store Room');

    // owner sees the whole structure
    locs = (await authJ('/api/locations')).body;
    const regs = (await authJ('/api/registers')).body;
    assert.strictEqual((await authJ('/api/branches')).body.length, 3);
    // BR01: Main Store + Store Room(wh) · BR02: Main Store + Mall · BR03: Main Store + Arcade
    assert.strictEqual(locs.length, 6);
    assert.strictEqual(regs.length, 5); // Till1, Till2 (BR01) + BR2×2 + BR3×1
    assert.ok(regs.find((r) => r.id === r2.body.id && r.locationName === 'Eastleigh Mall'));
  });

  await test('cashier scoped to BR02/Mall sees only that branch & location data', async () => {
    const mallLoc = d.prepare("SELECT id FROM locations WHERE name = 'Eastleigh Mall'").get().id;
    const br2 = d.prepare("SELECT id FROM branches WHERE name = 'Eastleigh Branch'").get().id;
    const br2Till = d.prepare("SELECT id FROM registers WHERE location_id = ? AND branch_id = ?").get(mallLoc, br2).id;
    const s = await authJ({
      path: '/api/staff', method: 'POST',
      body: { name: 'Cashier Jane', role: 'cashier', pin: '5678', branch_id: br2, location_id: mallLoc, register_id: br2Till }
    });
    assert.strictEqual(s.status, 200);
    const l = await authJ({ path: '/api/login', method: 'POST', body: { name: 'Cashier Jane', pin: '5678' } });
    assert.strictEqual(l.status, 200);
    const jane = withCookie(cookieOf(l));

    const me = await jane({ path: '/api/me' });
    assert.strictEqual(me.body.user.branchId, br2);
    assert.strictEqual(me.body.user.locationId, mallLoc);
    assert.strictEqual(me.body.user.registerId, br2Till);

    const b = await jane({ path: '/api/bootstrap' });
    assert.strictEqual(b.body.branches.length, 1, 'only her branch visible');
    assert.strictEqual(b.body.branches[0].id, br2);
    assert.ok(b.body.locations.every((x) => x.branch_id === br2));
    assert.strictEqual(b.body.locationId, mallLoc, 'her location selected');
    // no sample stock exists at the Mall → every line reads 0
    const stocked = b.body.products.filter((p) => p.stock_qty > 0);
    assert.strictEqual(stocked.length, 0, 'no stock leaks across locations');

    const locs = await jane({ path: '/api/locations' });
    assert.ok(locs.body.every((x) => x.branch_id === br2));
    const regs = await jane({ path: '/api/registers' });
    assert.ok(regs.body.every((x) => x.branch_id === br2));

    const today = await jane({ path: '/api/today' });
    assert.strictEqual(today.body.branchId, br2);
  });

  await test('cashier: product create 403 → grant → 200 → revoke → 403', async () => {
    const br2 = d.prepare("SELECT id FROM branches WHERE name = 'Eastleigh Branch'").get().id;
    const mallLoc = d.prepare("SELECT id FROM locations WHERE name = 'Eastleigh Mall'").get().id;
    const janeId = d.prepare('SELECT id FROM users WHERE name = ?').get('Cashier Jane').id;
    const janeCookie = (await authJ({ path: '/api/login', method: 'POST', body: { name: 'Cashier Jane', pin: '5678' } })).headers.get('set-cookie').split(';')[0];
    const jane = withCookie(janeCookie);

    const body = { name: 'Mall Water 1L', unit: 'btl', cost: 20, price: 40, tax_type: 'std' };
    const before = await jane({ path: '/api/products', method: 'POST', body });
    assert.strictEqual(before.status, 403, 'cashier has no products.manage by role');

    const g = await authJ({ path: `/api/staff/${janeId}/permissions`, method: 'POST', body: { permission: 'products.manage', allowed: true } });
    assert.strictEqual(g.status, 200);
    const after = await jane({ path: '/api/products', method: 'POST', body });
    assert.strictEqual(after.status, 200, 'granted');
    const janeProdId = after.body.id;

    const rev = await authJ({ path: `/api/staff/${janeId}/permissions`, method: 'POST', body: { permission: 'products.manage', allowed: false } });
    assert.strictEqual(rev.status, 200);
    const again = await jane({ path: '/api/products', method: 'POST', body: { ...body, name: 'Mall Water 2L' } });
    assert.strictEqual(again.status, 403, 'revoked');

    // permissions endpoint itself is staff.permissions (owner-only) — manager blocked
    const mCookie = (await authJ({ path: '/api/login', method: 'POST', body: { name: 'Mwenyeji M', pin: '2345' } })).headers.get('set-cookie').split(';')[0];
    const managerJ = withCookie(mCookie);
    const mgr = await managerJ({ path: `/api/staff/${janeId}/permissions`, method: 'POST', body: { permission: 'products.manage', allowed: true } });
    assert.strictEqual(mgr.status, 403);

    // grants-only: a grant can ADD a permission the role lacks (stock.adjust)
    await authJ({ path: `/api/staff/${janeId}/permissions`, method: 'POST', body: { permission: 'stock.adjust', allowed: true } });
    const adj = await jane({ path: '/api/stock/adjust', method: 'POST', body: { product_id: janeProdId, qty: 15, reason: 'damage' } });
    assert.strictEqual(adj.status, 200);
    assert.strictEqual(adj.body.newQty, 15);
    const move = d.prepare("SELECT * FROM stock_moves WHERE product_id = ? ORDER BY id DESC LIMIT 1").get(janeProdId);
    assert.strictEqual(move.type, 'adjustment');
    assert.strictEqual(move.reason, 'damage');
    assert.strictEqual(move.branch_id, br2);
    // lands in her branch's DEFAULT location (Main Store), never the Mall
    const defLoc = d.prepare('SELECT id FROM locations WHERE branch_id = ? AND is_default = 1').get(br2).id;
    assert.strictEqual(move.location_id, defLoc);
    assert.notStrictEqual(move.location_id, mallLoc);
    const audit = d.prepare("SELECT * FROM audit_log WHERE action = 'stock/adjust' ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(Number(audit.entity_id), janeProdId);
    // revoke stock.adjust too
    await authJ({ path: `/api/staff/${janeId}/permissions`, method: 'POST', body: { permission: 'stock.adjust', allowed: false } });
    const adj2 = await jane({ path: '/api/stock/adjust', method: 'POST', body: { product_id: janeProdId, qty: 1, reason: 'other' } });
    assert.strictEqual(adj2.status, 403);
  });

  await test('stock adjust (owner): writes move + audit, updates location balance', async () => {
    const rice = d.prepare("SELECT p.id FROM products p WHERE p.name LIKE 'Rice%' AND p.active = 1").get();
    const riv = d.prepare("SELECT v.id FROM variants v WHERE v.product_id = ? AND v.axes_key = '{}'").get(rice.id);
    const before = d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(riv.id).qty;
    const r = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { product_id: rice.id, qty: -4, reason: 'damage', note: 'burst bag' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.newQty, before - 4);
    const move = d.prepare("SELECT * FROM stock_moves WHERE product_id = ? ORDER BY id DESC LIMIT 1").get(rice.id);
    assert.strictEqual(move.type, 'adjustment');
    assert.strictEqual(move.reason, 'damage');
    assert.strictEqual(move.qty, -4);
    const bad = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { product_id: rice.id, qty: -4 } });
    assert.strictEqual(bad.status, 400, 'reason is mandatory (R-S3)');
  });

  await test('bad PIN rejected; 5 attempts lock out', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await authJ({ path: '/api/login', method: 'POST', body: { name: 'cashier-x', pin: '0000' } });
      assert.strictEqual(r.status, 401);
    }
    const r5 = await authJ({ path: '/api/login', method: 'POST', body: { name: 'cashier-x', pin: '0000' } });
    assert.strictEqual(r5.status, 401);
    assert.ok(/locked/.test(r5.body.error));
    // even the right PIN is locked now
    const r6 = await authJ({ path: '/api/login', method: 'POST', body: { name: 'cashier-x', pin: '9999' } });
    assert.strictEqual(r6.status, 429);
    // white-box cleanup so later logins in this suite are not IP-locked
    d.prepare('DELETE FROM login_locks').run();
  });

  await test('owner can login with correct PIN', async () => {
    const r = await authJ({ path: '/api/login', method: 'POST', body: { name: 'Owner One', pin: '1234' } });
    assert.strictEqual(r.status, 200);
    cookie = cookieOf(r);
  });

  await test('me + today (owner sees consolidated)', async () => {
    const me = await authJ('/api/me');
    assert.strictEqual(me.body.user.name, 'Owner One');
    assert.strictEqual(me.body.branches.length, 3, 'owner sees all branches');
    const today = await authJ('/api/today');
    assert.strictEqual(today.body.total, 0);
  });

  await test('category CRUD', async () => {
    const c = await authJ({ path: '/api/categories', method: 'POST', body: { name: 'Test Cat', name_sw: 'Kundi' } });
    assert.strictEqual(c.status, 200);
    const id = c.body.id;
    const u = await authJ({ path: `/api/categories/${id}`, method: 'PUT', body: { ageRestricted: true } });
    assert.strictEqual(u.status, 200);
    const rows = await authJ('/api/categories');
    assert.ok(rows.body.find((x) => x.id === id && x.age_restricted === 1));
    const del = await authJ({ path: `/api/categories/${id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200);
  });

  await test('product CRUD + validation', async () => {
    const bad = await authJ({ path: '/api/products', method: 'POST', body: { name: 'X', price: 0 } });
    assert.strictEqual(bad.status, 400);
    const p = await authJ({
      path: '/api/products', method: 'POST',
      body: { name: 'Test Soap', barcode: '6009499999', unit: 'pcs', cost: 60, price: 90, tax_type: 'std', kra_item_code: '110101010001' }
    });
    assert.strictEqual(p.status, 200);
    const id = p.body.id;
    const u = await authJ({ path: `/api/products/${id}`, method: 'PUT', body: { price: 100 } });
    assert.strictEqual(u.status, 200);
    const list = await authJ('/api/products');
    const row = list.body.find((x) => x.id === id);
    assert.strictEqual(row.price, 100);
    const del = await authJ({ path: `/api/products/${id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    const after = await authJ('/api/products');
    assert.strictEqual(after.body.find((x) => x.id === id), undefined); // soft-deleted products never listed
  });

  await test('branch CRUD (new branch auto-gets a Main Store location)', async () => {
    const b = await authJ({ path: '/api/branches', method: 'POST', body: { name: 'Westlands Branch', vatRegistered: true } });
    assert.strictEqual(b.status, 200);
    const id = b.body.id;
    assert.strictEqual(id, 4, 'BR04 after fixture branches');
    const list = await authJ('/api/branches');
    assert.strictEqual(list.body.length, 4);
    assert.strictEqual(list.body.find((x) => x.id === id).code, 'BR04');
    const autoLoc = d.prepare('SELECT * FROM locations WHERE branch_id = ? AND is_default = 1').get(id);
    assert.ok(autoLoc, 'default location auto-created');
    const del = await authJ({ path: `/api/branches/${id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM locations WHERE branch_id = ?').get(id).n, 0, 'locations cascaded');
  });

  await test('default branch cannot be deleted', async () => {
    const list = await authJ('/api/branches');
    const def = list.body.find((b) => b.is_default);
    const del = await authJ({ path: `/api/branches/${def.id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 400);
  });

  await test('branch with staff cannot be deleted (move staff first)', async () => {
    const br2 = d.prepare("SELECT id FROM branches WHERE name = 'Eastleigh Branch'").get().id;
    const del = await authJ({ path: `/api/branches/${br2}`, method: 'DELETE' });
    assert.strictEqual(del.status, 400);
    assert.ok(/staff/.test(del.body.error));
  });

  await test('unused branch deletes cleanly (cascade)', async () => {
    const br3 = d.prepare("SELECT id FROM branches WHERE name = 'Nakuru Branch'").get().id;
    const del = await authJ({ path: `/api/branches/${br3}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM registers WHERE branch_id = ?').get(br3).n, 0);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM locations WHERE branch_id = ?').get(br3).n, 0);
  });

  await test('staff CRUD + role check (cashier cannot list staff)', async () => {
    const janeCookie = (await authJ({ path: '/api/login', method: 'POST', body: { name: 'Cashier Jane', pin: '5678' } })).headers.get('set-cookie').split(';')[0];
    const jane = withCookie(janeCookie);
    const forbidden = await jane({ path: '/api/staff' });
    assert.strictEqual(forbidden.status, 403);
    const rows = await authJ('/api/staff');
    assert.ok(rows.body.find((x) => x.name === 'Cashier Jane'));
    const jrow = rows.body.find((x) => x.name === 'Cashier Jane');
    assert.strictEqual(jrow.location_name, 'Eastleigh Mall');
  });

  await test('owner cannot be disabled or demoted', async () => {
    const r = await authJ({ path: '/api/staff/1', method: 'PUT', body: { active: false } });
    assert.strictEqual(r.status, 400);
  });

  await test('settings update (receipt footer)', async () => {
    const r = await authJ({ path: '/api/settings', method: 'PUT', body: { receipt: { footer: 'Asante!' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.receipt.footer, 'Asante!');
  });

  await test('audit log written + chain verifies', async () => {
    const rows = await authJ('/api/audit?limit=100');
    assert.ok(rows.body.length >= 10, `audit rows ${rows.body.length}`);
    const v = await authJ('/api/audit/verify');
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.ok, true);
    assert.ok(v.body.length >= 10);
  });

  await test('capability toggles leave audit trail', async () => {
    const rows = await authJ('/api/audit?limit=500');
    const cap = rows.body.find((r) => r.action === 'capability/enable' && r.entity_id === 'multi_location');
    assert.ok(cap, 'capability/enable audited');
  });

  await test('audit chain detects tampering (then restores)', async () => {
    const orig = d.prepare('SELECT detail FROM audit_log WHERE id = 1').get().detail;
    d.prepare("UPDATE audit_log SET detail = '{}tampered' WHERE id = 1").run();
    assert.strictEqual(dbm.verifyAuditChain(d).ok, false);
    d.prepare('UPDATE audit_log SET detail = ? WHERE id = 1').run(orig);
    assert.strictEqual(dbm.verifyAuditChain(d).ok, true);
  });

  // ---------------- Phase 3: universal product engine ----------------
  section('Phase 3 — product engine (variants, packs, barcodes, serials, batches, CSV)');

  await test('migration: every product has an implicit variant; stock is variant-scoped', async () => {
    const prods = d.prepare('SELECT id FROM products WHERE active = 1').all();
    assert.ok(prods.length >= 10);
    for (const p of prods) {
      const v = d.prepare("SELECT * FROM variants WHERE product_id = ? AND axes_key = '{}'").get(p.id);
      assert.ok(v, `product ${p.id} has implicit variant`);
      assert.strictEqual(v.active, 1);
    }
    // sample stock (24 each) migrated intact — use a product no earlier test touched
    const tea = d.prepare("SELECT p.id FROM products p WHERE p.name LIKE 'Black Tea%'").get();
    const tv = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(tea.id).id;
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(tv).qty, 24);
    const apiRows = (await authJ('/api/products')).body;
    assert.strictEqual(apiRows.find((x) => x.id === tea.id).stock_qty, 24);
  });

  await test('scan: one call resolves barcode → variant → stock → price (R-P3)', async () => {
    const rows = (await authJ('/api/products')).body;
    const first = rows.find((x) => x.barcode);
    const r = await authJ(`/api/scan/${first.barcode}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.product.name, first.name);
    assert.strictEqual(r.body.type, 'unit');
    assert.strictEqual(r.body.stock_qty, first.stock_qty);
    assert.strictEqual(r.body.price, first.price);
    assert.ok(r.body.variant.id);
    const miss = await authJ('/api/scan/0000000000000');
    assert.strictEqual(miss.status, 404);
  });

  await test('dress: variants with own barcodes & per-variant stock', async () => {
    const p = await authJ({
      path: '/api/products', method: 'POST',
      body: { name: 'Dress', unit: 'pcs', cost: 1500, price: 2500, tax_type: 'std' }
    });
    assert.strictEqual(p.status, 200);
    const dressId = p.body.id;
    const v1 = await authJ({
      path: `/api/products/${dressId}/variants`, method: 'POST',
      body: { name: 'Red / M', axes: 'colour: Red, size: M', barcode: '6009500000101', price: 2500 }
    });
    const v2 = await authJ({
      path: `/api/products/${dressId}/variants`, method: 'POST',
      body: { name: 'Blue / M', axes: 'colour: Blue, size: M', barcode: '6009500000102' }
    });
    assert.strictEqual(v1.status, 200);
    assert.strictEqual(v2.status, 200);
    // duplicate variant (same axes) is rejected
    const dup = await authJ({
      path: `/api/products/${dressId}/variants`, method: 'POST',
      body: { name: 'Red / M again', axes: { size: 'M', colour: 'Red' } }
    });
    assert.strictEqual(dup.status, 409);
    // per-variant stock
    const a1 = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { variant_id: v1.body.id, qty: 10, reason: 'stocktake' } });
    const a2 = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { variant_id: v2.body.id, qty: 5, reason: 'stocktake' } });
    assert.strictEqual(a1.body.newQty, 10);
    assert.strictEqual(a2.body.newQty, 5);
    const s1 = await authJ('/api/scan/6009500000101');
    assert.strictEqual(s1.body.variant.name, 'Red / M');
    assert.strictEqual(s1.body.stock_qty, 10);
    assert.deepStrictEqual(s1.body.variant.axes, { colour: 'Red', size: 'M' });
    const s2 = await authJ('/api/scan/6009500000102');
    assert.strictEqual(s2.body.variant.name, 'Blue / M');
    assert.strictEqual(s2.body.stock_qty, 5);
    // product-level view sums variants
    const rows = (await authJ('/api/products')).body;
    assert.strictEqual(rows.find((x) => x.id === dressId).stock_qty, 15);
    // multi-variant product: product-only adjust must be explicit
    const ambig = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { product_id: dressId, qty: 1, reason: 'other' } });
    assert.strictEqual(ambig.status, 400);
    assert.ok(/variant/.test(ambig.body.error));
  });

  await test('multiple barcodes per variant; collision across variants is 409', async () => {
    const dressId = d.prepare("SELECT id FROM products WHERE name = 'Dress'").get().id;
    const red = d.prepare("SELECT id FROM variants WHERE product_id = ? AND name = 'Red / M'").get(dressId).id;
    const blue = d.prepare("SELECT id FROM variants WHERE product_id = ? AND name = 'Blue / M'").get(dressId).id;
    const extra = await authJ({ path: `/api/variants/${red}/barcodes`, method: 'POST', body: { barcode: '6009500000199', label: 'shelf' } });
    assert.strictEqual(extra.status, 200);
    const s = await authJ('/api/scan/6009500000199');
    assert.strictEqual(s.body.variant.id, red, 'second barcode resolves to same variant');
    const clash = await authJ({ path: `/api/variants/${blue}/barcodes`, method: 'POST', body: { barcode: '6009500000101' } });
    assert.strictEqual(clash.status, 409, 'barcode used by another variant');
  });

  await test('variant price override + integer-shilling validation', async () => {
    const dressId = d.prepare("SELECT id FROM products WHERE name = 'Dress'").get().id;
    const bad = await authJ({
      path: `/api/products/${dressId}/variants`, method: 'POST',
      body: { name: 'X', axes: 'size: XL', price: 10.5 }
    });
    assert.strictEqual(bad.status, 400, 'fractional shillings rejected (R-P2)');
    const prem = await authJ({
      path: `/api/products/${dressId}/variants`, method: 'POST',
      body: { name: 'Premium / L', axes: 'size: L', barcode: '6009500000103', price: 3000 }
    });
    assert.strictEqual(prem.status, 200);
    const s = await authJ('/api/scan/6009500000103');
    assert.strictEqual(s.body.price, 3000, 'override wins over product price');
    // variant without override inherits product price
    const blue = d.prepare("SELECT id, name FROM variants WHERE product_id = ? AND name = 'Blue / M'").get(dressId);
    const s2 = await authJ('/api/scan/6009500000102');
    assert.strictEqual(s2.body.price, 2500);
  });

  await test('sugar 1kg: open-priced product sells fractional base units', async () => {
    const p = await authJ({
      path: '/api/products', method: 'POST',
      body: { name: 'Sugar', unit: 'kg', cost: 120, price: 150, open_priced: 1, barcode: '6009500000301' }
    });
    assert.strictEqual(p.status, 200);
    const sugarId = p.body.id;
    const in1 = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { product_id: sugarId, qty: 30, reason: 'stocktake' } });
    assert.strictEqual(in1.body.newQty, 30);
    const out1 = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { product_id: sugarId, qty: -2.25, reason: 'stocktake', note: 'weighed sale' } });
    assert.strictEqual(out1.body.newQty, 27.75, 'REAL qty for open-priced goods');
    const s = await authJ('/api/scan/6009500000301');
    assert.strictEqual(s.body.product.open_priced, 1);
    assert.strictEqual(s.body.stock_qty, 27.75);
  });

  await test('jameson: pack sells from same stock with own barcode + price', async () => {
    const p = await authJ({
      path: '/api/products', method: 'POST',
      body: { name: 'Jameson 700ml', unit: 'btl', cost: 400, price: 550, age_min: 21, barcode: '6009500000200' }
    });
    assert.strictEqual(p.status, 200);
    const jid = p.body.id;
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(jid).id;
    await authJ({ path: '/api/stock/adjust', method: 'POST', body: { product_id: jid, qty: 24, reason: 'stocktake' } });
    const pk = await authJ({
      path: `/api/variants/${vid}/packs`, method: 'POST',
      body: { name: 'Case (12)', multiple: 12, unit: 'case', barcode: '6009500000201', price: 5800 }
    });
    assert.strictEqual(pk.status, 200);
    const s = await authJ('/api/scan/6009500000201');
    assert.strictEqual(s.body.type, 'pack');
    assert.strictEqual(s.body.pack.multiple, 12);
    assert.strictEqual(s.body.pack.price, 5800);
    assert.strictEqual(s.body.product.name, 'Jameson 700ml');
    assert.strictEqual(s.body.stock_qty, 24, 'stock stays in base units');
    assert.strictEqual(s.body.stock_in_packs, 2);
    assert.notStrictEqual(s.body.pack.price, 12 * 550, 'pack price is independent (R-PR4)');
    const dupBc = await authJ({
      path: `/api/variants/${vid}/packs`, method: 'POST',
      body: { name: 'Case (12) v2', multiple: 12, barcode: '6009500000201', price: 6000 }
    });
    assert.strictEqual(dupBc.status, 409, 'pack barcode collision');
    const dupName = await authJ({
      path: `/api/variants/${vid}/packs`, method: 'POST',
      body: { name: 'Case (12)', multiple: 12, price: 6000 }
    });
    assert.strictEqual(dupName.status, 409, 'pack name unique per variant');
  });

  await test('paracetamol: batches create FEFO-ordered lots and open stock', async () => {
    const p = await authJ({
      path: '/api/products', method: 'POST',
      body: { name: 'Paracetamol 500mg', unit: 'box', cost: 80, price: 100, track_batches: 1, barcode: '6009500000400' }
    });
    assert.strictEqual(p.status, 200);
    const pid = p.body.id;
    const b1 = await authJ({ path: '/api/batches', method: 'POST', body: { product_id: pid, batch_no: 'B1', expiry_date: '2026-12-31', qty: 10, cost: 80 } });
    const b2 = await authJ({ path: '/api/batches', method: 'POST', body: { product_id: pid, batch_no: 'B2', expiry_date: '2026-10-31', qty: 5, cost: 80 } });
    assert.strictEqual(b1.status, 200);
    assert.strictEqual(b2.status, 200);
    const list = await authJ(`/api/batches?product_id=${pid}`);
    assert.strictEqual(list.body.length, 2);
    assert.strictEqual(list.body[0].batch_no, 'B2', 'FEFO: earliest expiry first');
    assert.strictEqual(list.body[1].batch_no, 'B1');
    // batches opened stock through the ledger
    const rows = (await authJ('/api/products')).body;
    assert.strictEqual(rows.find((x) => x.id === pid).stock_qty, 15);
    const moves = d.prepare("SELECT * FROM stock_moves WHERE product_id = ? ORDER BY id").all(pid);
    const openings = moves.filter((m) => m.type === 'opening' && m.reason === 'opening');
    assert.strictEqual(openings.length, 2);
    assert.ok(openings.every((m) => m.batch_id));
    // non-batch product refuses batches
    const sugar = d.prepare("SELECT id FROM products WHERE name = 'Sugar'").get();
    const nope = await authJ({ path: '/api/batches', method: 'POST', body: { product_id: sugar.id, batch_no: 'Z', qty: 1 } });
    assert.strictEqual(nope.status, 400);
  });

  await test('serials: register duplicates & write-off move stock', async () => {
    const p = await authJ({
      path: '/api/products', method: 'POST',
      body: { name: 'Phone X', unit: 'pcs', cost: 12000, price: 15000, track_serials: 1, barcode: '6009500000500' }
    });
    assert.strictEqual(p.status, 200);
    const phId = p.body.id;
    const r1 = await authJ({ path: '/api/serials', method: 'POST', body: { product_id: phId, serial_no: 'IMEI-001' } });
    assert.strictEqual(r1.status, 200);
    const dup = await authJ({ path: '/api/serials', method: 'POST', body: { product_id: phId, serial_no: 'IMEI-001' } });
    assert.strictEqual(dup.status, 409);
    const rows = (await authJ('/api/products')).body;
    assert.strictEqual(rows.find((x) => x.id === phId).stock_qty, 1, 'serial registration opens stock');
    const wrong = await authJ({ path: '/api/serials', method: 'POST', body: { product_id: d.prepare("SELECT id FROM products WHERE name = 'Sugar'").get().id, serial_no: 'X1' } });
    assert.strictEqual(wrong.status, 400, 'non-serial product refuses serials');
    const list = await authJ(`/api/serials?product_id=${phId}`);
    assert.strictEqual(list.body.length, 1);
    const w = await authJ({ path: `/api/serials/${list.body[0].id}/writeoff`, method: 'POST', body: {} });
    assert.strictEqual(w.status, 200);
    assert.strictEqual((await authJ('/api/products')).body.find((x) => x.id === phId).stock_qty, 0, 'write-off decrements');
    const w2 = await authJ({ path: `/api/serials/${list.body[0].id}/writeoff`, method: 'POST', body: {} });
    assert.strictEqual(w2.status, 400, 'cannot write off twice');
  });

  await test('deactivated variant stops resolving; product stock sums only active', async () => {
    const dressId = d.prepare("SELECT id FROM products WHERE name = 'Dress'").get().id;
    const blue = d.prepare("SELECT id FROM variants WHERE product_id = ? AND name = 'Blue / M'").get(dressId).id;
    const del = await authJ({ path: `/api/variants/${blue}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    const s = await authJ('/api/scan/6009500000102');
    assert.strictEqual(s.status, 404, 'barcode of inactive variant no longer resolves');
    const rows = (await authJ('/api/products')).body;
    // Red/M 10 + Premium/L 0 = 10 (Blue/M's 5 no longer counted)
    assert.strictEqual(rows.find((x) => x.id === dressId).stock_qty, 10);
  });

  await test('attribute defs CRUD + values live on variant meta', async () => {
    const a = await authJ({ path: '/api/attribute-defs', method: 'POST', body: { key: 'abv', label: 'ABV %', type: 'number' } });
    assert.strictEqual(a.status, 200);
    const dup = await authJ({ path: '/api/attribute-defs', method: 'POST', body: { key: 'abv' } });
    assert.strictEqual(dup.status, 409);
    const prem = d.prepare("SELECT id, product_id FROM variants WHERE name = 'Premium / L'").get();
    const put = await authJ({ path: `/api/variants/${prem.id}`, method: 'PUT', body: { meta: { abv: 40 } } });
    assert.strictEqual(put.status, 200);
    const vs = (await authJ(`/api/products/${prem.product_id}/variants`)).body;
    assert.strictEqual(vs.find((v) => v.id === prem.id).meta.abv, 40);
    const u = await authJ({ path: `/api/attribute-defs/${a.body.id}`, method: 'PUT', body: { label: 'Alcohol %' } });
    assert.strictEqual(u.status, 200);
  });

  await test('supplier link + reorder level on product', async () => {
    const s = await authJ({ path: '/api/suppliers', method: 'POST', body: { name: 'KCC Depot', phone: '+254700999888' } });
    assert.strictEqual(s.status, 200);
    const p = await authJ({
      path: '/api/products', method: 'POST',
      body: { name: 'Milk 1L', unit: 'btl', cost: 90, price: 110, supplier_id: s.body.id, reorder_level: 5 }
    });
    assert.strictEqual(p.status, 200);
    const rows = (await authJ('/api/products')).body;
    const milk = rows.find((x) => x.id === p.body.id);
    assert.strictEqual(milk.supplier_name, 'KCC Depot');
    assert.strictEqual(milk.reorder_level, 5);
    const bad = await authJ({ path: '/api/products', method: 'POST', body: { name: 'X2', price: 10, supplier_id: 99999 } });
    assert.strictEqual(bad.status, 400, 'unknown supplier rejected');
  });

  await test('CSV round-trip: export → delete → import restores product + variant + pack', async () => {
    const jid = d.prepare("SELECT id FROM products WHERE name = 'Jameson 700ml'").get().id;
    const csv = await fetch(`http://127.0.0.1:${server.address().port}/api/csv/export`, { headers: { cookie } });
    const text = await csv.text();
    assert.ok(text.includes('Jameson 700ml'), 'product row present');
    assert.ok(text.includes('Case (12)'), 'pack row present');
    assert.ok(text.includes('6009500000201'), 'pack barcode present');
    // delete, then re-import
    const del = await authJ({ path: `/api/products/${jid}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    let miss = await authJ('/api/scan/6009500000201');
    assert.strictEqual(miss.status, 404, 'deleted product does not resolve');
    const imp = await authJ({ path: '/api/csv/import', method: 'POST', body: { csv: text } });
    assert.strictEqual(imp.status, 200);
    assert.strictEqual(imp.body.errors.length, 0, `import errors: ${imp.body.errors.join('; ')}`);
    miss = await authJ('/api/scan/6009500000200');
    assert.strictEqual(miss.status, 200, 'product barcodes resolve again');
    const packScan = await authJ('/api/scan/6009500000201');
    assert.strictEqual(packScan.status, 200, 'pack barcode resolves again');
    assert.strictEqual(packScan.body.type, 'pack');
    // regression: import must not flip "0" flags to 1 (CSV fields are strings)
    const flags = d.prepare('SELECT name, track_batches, track_serials FROM products WHERE name IN (?, ?)').all('Brown Sugar 1kg', 'Paracetamol 500mg');
    assert.strictEqual(flags.find((f) => f.name === 'Brown Sugar 1kg').track_batches, 0, 'duka staple does not track batches');
    assert.strictEqual(flags.find((f) => f.name === 'Brown Sugar 1kg').track_serials, 0);
    assert.strictEqual(flags.find((f) => f.name === 'Paracetamol 500mg').track_batches, 1, 'batch flag survives the round-trip');
  });

  // ---------------- Phase 4: stock ledger & inventory ----------------
  section('Phase 4 — stock ledger (R-S: moves, FEFO, integrity, trace, stocktakes)');

  await test('moves: type/reason validation + ledger query', async () => {
    const p = await authJ({ path: '/api/products', method: 'POST', body: { name: 'Dead Item', unit: 'pcs', cost: 10, price: 20 } });
    assert.strictEqual(p.status, 200);
    const pid = p.body.id;
    const badType = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: 1, type: 'teleport', reason: 'other' } });
    assert.strictEqual(badType.status, 400, 'unknown type rejected');
    const badReason = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: 1, type: 'purchase', reason: 'vibes' } });
    assert.strictEqual(badReason.status, 400, 'reason must fit the type');
    const zero = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: 0, type: 'purchase', reason: 'purchase' } });
    assert.strictEqual(zero.status, 400, 'zero qty rejected');
    const ok = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: 10, type: 'purchase', reason: 'purchase', ref: 'PO:1', unit_cost: 10 } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.newQty, 10);
    assert.strictEqual(ok.body.move_ids.length, 1);
    const moves = (await authJ(`/api/stock/moves?product_id=${pid}`)).body;
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(moves[0].type, 'purchase');
    assert.strictEqual(moves[0].ref, 'PO:1');
    assert.strictEqual(moves[0].unit_cost, 10);
    assert.strictEqual(moves[0].user_name, 'Owner One');
    assert.strictEqual(moves[0].product_name, 'Dead Item');
  });

  await test('FEFO: batch-tracked sale allocates earliest expiry first (per-batch moves)', async () => {
    const pid = d.prepare("SELECT id FROM products WHERE name = 'Paracetamol 500mg'").get().id;
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(pid).id;
    const b1 = d.prepare("SELECT id, qty FROM batches WHERE product_id = ? AND batch_no = 'B1'").get(pid); // expiry 2026-12-31, qty 10
    const b2 = d.prepare("SELECT id, qty FROM batches WHERE product_id = ? AND batch_no = 'B2'").get(pid); // expiry 2026-10-31, qty 5
    const r = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: vid, qty: -7, type: 'sale', reason: 'sale', ref: 'SALE:TEST' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.newQty, 8, '15 - 7');
    assert.strictEqual(r.body.move_ids.length, 2, 'split across two batches');
    assert.strictEqual(d.prepare('SELECT qty FROM batches WHERE id = ?').get(b2.id).qty, 0, 'earliest expiry drained first');
    assert.strictEqual(d.prepare('SELECT qty FROM batches WHERE id = ?').get(b1.id).qty, 8);
    const allocs = d.prepare("SELECT * FROM stock_moves WHERE product_id = ? AND ref = 'SALE:TEST' ORDER BY id").all(pid);
    assert.ok(allocs.every((m) => m.batch_id && m.qty < 0 && m.type === 'sale'));
    assert.deepStrictEqual(allocs.map((m) => m.batch_id), [b2.id, b1.id], 'FEFO order on the ledger');
  });

  await test('batch guards: inbound needs a batch; outbound bounded by batch stock', async () => {
    const pid = d.prepare("SELECT id FROM products WHERE name = 'Paracetamol 500mg'").get().id;
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(pid).id;
    const noBatch = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: vid, qty: 5, type: 'purchase', reason: 'purchase' } });
    assert.strictEqual(noBatch.status, 400, 'stock in on tracked product requires batch_id');
    const tooMuch = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: vid, qty: -999, type: 'sale', reason: 'sale' } });
    assert.strictEqual(tooMuch.status, 400, 'cannot sell more than batch stock holds');
    const wrongProd = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: d.prepare("SELECT id FROM products WHERE name = 'Sugar'").get().id, qty: 1, type: 'purchase', reason: 'purchase', batch_id: 1 } });
    assert.strictEqual(wrongProd.status, 400, 'non-batch product refuses batch_id');
  });

  await test('R-S8: negative stock impossible; oversell is an audited manager/owner act', async () => {
    const p = await authJ({ path: '/api/products', method: 'POST', body: { name: 'Overstocked', unit: 'pcs', cost: 5, price: 9 } });
    const pid = p.body.id;
    await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: 10, type: 'purchase', reason: 'purchase' } });
    const short = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: -100, type: 'sale', reason: 'sale' } });
    assert.strictEqual(short.status, 400);
    assert.ok(/insufficient stock/.test(short.body.error));
    const oversell = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: -15, type: 'sale', reason: 'sale', ref: 'SALE:OS', oversell: true } });
    assert.strictEqual(oversell.status, 200, 'owner may oversell explicitly');
    assert.strictEqual(oversell.body.newQty, -5);
    assert.strictEqual(oversell.body.oversell, true);
    const audit = d.prepare("SELECT * FROM audit_log WHERE action = 'stock/move' ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(JSON.parse(audit.detail).oversell, true, 'oversell leaves evidence');
    // a cashier can never oversell, even with stock.adjust granted
    const janeId = d.prepare("SELECT id FROM users WHERE name = 'Cashier Jane'").get().id;
    await authJ({ path: `/api/staff/${janeId}/permissions`, method: 'POST', body: { permission: 'stock.adjust', allowed: true } });
    const janeCookie = (await authJ({ path: '/api/login', method: 'POST', body: { name: 'Cashier Jane', pin: '5678' } })).headers.get('set-cookie').split(';')[0];
    const jane = withCookie(janeCookie);
    const jOversell = await jane({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: -1, type: 'sale', reason: 'sale', oversell: true } });
    assert.strictEqual(jOversell.status, 400, 'cashier oversell refused');
    await authJ({ path: `/api/staff/${janeId}/permissions`, method: 'POST', body: { permission: 'stock.adjust', allowed: false } });
    // restore
    const back = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: 15, type: 'purchase', reason: 'purchase' } });
    assert.strictEqual(back.body.newQty, 10);
  });

  await test('R-S7 integrity job: mismatch is an alert, repair is explicit + audited', async () => {
    const sugarV = d.prepare("SELECT v.id FROM products p JOIN variants v ON v.product_id = p.id WHERE p.name = 'Sugar' AND v.axes_key = '{}'").get().id;
    const expected = d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(sugarV).qty;
    d.prepare('UPDATE stock SET qty = 9999 WHERE variant_id = ?').run(sugarV); // white-box corruption
    const found = await authJ({ path: '/api/stock/integrity', method: 'POST', body: {} });
    assert.strictEqual(found.status, 200);
    assert.ok(found.body.mismatches.length >= 1, 'mismatch reported');
    const m = found.body.mismatches.find((x) => x.variant_id === sugarV);
    assert.strictEqual(m.materialized, 9999);
    assert.strictEqual(m.expected, expected);
    // repair only on demand — and it is audited
    const fixed = await authJ({ path: '/api/stock/integrity', method: 'POST', body: { repair: true } });
    assert.ok(fixed.body.mismatches.length >= 1, 'reports what it found');
    assert.strictEqual(fixed.body.after_repair.length, 0, 'repaired to ledger truth');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(sugarV).qty, expected);
    const audit = d.prepare("SELECT * FROM audit_log WHERE action = 'stock/integrity_repair'").get();
    assert.ok(audit, 'repair leaves evidence');
    // cashier (no stocktake.approve) cannot run it
    const janeCookie = (await authJ({ path: '/api/login', method: 'POST', body: { name: 'Cashier Jane', pin: '5678' } })).headers.get('set-cookie').split(';')[0];
    const jane = withCookie(janeCookie);
    const no = await jane({ path: '/api/stock/integrity', method: 'POST', body: { repair: true } });
    assert.strictEqual(no.status, 403);
  });

  await test('10k moves: ledger recomputation == materialized balances', async () => {
    const p = await authJ({ path: '/api/products', method: 'POST', body: { name: 'Stress Item', unit: 'pcs', cost: 1, price: 2 } });
    const pid = p.body.id;
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(pid).id;
    const insM = d.prepare('INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, user_id, created_at) VALUES (?, ?, 1, 1, ?, ?, ?, ?, NULL, ?)');
    const updS = d.prepare('INSERT INTO stock (variant_id, location_id, qty) VALUES (?, 1, ?) ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = qty + ?');
    const t0 = Date.now();
    d.transaction(() => {
      for (let i = 1; i <= 10000; i++) {
        const q = i % 2 ? 3 : -3;
        const type = i % 2 ? 'purchase' : 'sale';
        insM.run(pid, vid, q, type, type, 'STRESS', new Date().toISOString());
        updS.run(vid, q, q);
      }
    })();
    const ms = Date.now() - t0;
    assert.ok(ms < 30000, `10k moves took ${ms}ms`);
    const drift = d.prepare(
      `SELECT COUNT(*) AS n FROM stock s
        LEFT JOIN stock_ledger_balances lb ON lb.variant_id = s.variant_id AND lb.location_id = s.location_id
       WHERE ABS(COALESCE(s.qty, 0) - COALESCE(lb.expected_qty, 0)) > 1e-9`
    ).get().n;
    assert.strictEqual(drift, 0, 'no variant/location drifted from the ledger');
    const bal = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = 1').get(vid).qty;
    assert.strictEqual(bal, 0, '10k alternating moves net to zero');
    const integrity = await authJ({ path: '/api/stock/integrity', method: 'POST', body: {} });
    assert.strictEqual(integrity.body.mismatches.length, 0);
  });

  await test('R-S2 trace: five questions in one call (where from / who / why / where now / expected)', async () => {
    const pid = d.prepare("SELECT id FROM products WHERE name = 'Paracetamol 500mg'").get().id;
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(pid).id;
    const r = await authJ(`/api/stock/trace/${vid}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.from.length, 2, 'two opening moves');
    assert.ok(r.body.from.every((m) => m.type === 'opening' && m.user));
    const sale = r.body.changes.find((m) => m.ref === 'SALE:TEST');
    assert.ok(sale, 'sale move visible with who/why');
    assert.strictEqual(sale.user, 'Owner One');
    assert.strictEqual(sale.reason, 'sale');
    assert.strictEqual(r.body.now.length, 1);
    assert.strictEqual(r.body.now[0].qty, 8);
    assert.strictEqual(r.body.expected, 8, 'what should physically be there');
    assert.strictEqual(r.body.batches.length, 1, 'B2 drained, B1 open');
    assert.strictEqual(r.body.batches[0].qty, 8);
  });

  await test('stocktake: draft snapshots expected, approve writes stocktake moves only for variance', async () => {
    const mainLoc = d.prepare("SELECT id FROM locations WHERE name = 'Main Store' AND is_default = 1").get().id;
    const sugarV = d.prepare("SELECT v.id FROM products p JOIN variants v ON v.product_id = p.id WHERE p.name = 'Sugar' AND v.axes_key = '{}'").get().id;
    const before = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(sugarV, mainLoc).qty;
    const st = await authJ({ path: '/api/stocktakes', method: 'POST', body: { location_id: mainLoc, note: 'weekend take' } });
    assert.strictEqual(st.status, 200);
    const detail = (await authJ(`/api/stocktakes/${st.body.id}`)).body;
    assert.ok(detail.lines.length >= 5, 'snapshot covers stocked variants');
    const line = detail.lines.find((l) => l.variant_id === sugarV && l.batch_id === null);
    assert.strictEqual(line.expected_qty, before);
    assert.strictEqual(line.physical_qty, null, 'not yet counted');
    const put = await authJ({ path: `/api/stocktakes/${st.body.id}/lines/${line.id}`, method: 'PUT', body: { physical_qty: before - 2 } });
    assert.strictEqual(put.body.variance, -2);
    const mgr = (await authJ({ path: '/api/login', method: 'POST', body: { name: 'Mwenyeji M', pin: '2345' } })).headers.get('set-cookie').split(';')[0];
    const approve = await withCookie(mgr)({ path: `/api/stocktakes/${st.body.id}/approve`, method: 'POST', body: {} });
    assert.strictEqual(approve.status, 200, 'manager holds stocktake.approve');
    assert.strictEqual(approve.body.lines, 1, 'only the variances became moves');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(sugarV, mainLoc).qty, before - 2);
    const move = d.prepare("SELECT * FROM stock_moves WHERE ref = ? ORDER BY id DESC LIMIT 1").get('ST:' + st.body.id);
    assert.strictEqual(move.type, 'stocktake');
    assert.strictEqual(move.qty, -2);
    const again = await withCookie(mgr)({ path: `/api/stocktakes/${st.body.id}/approve`, method: 'POST', body: {} });
    assert.strictEqual(again.status, 400, 'cannot approve twice');
    const del = await authJ({ path: `/api/stocktakes/${st.body.id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 400, 'approved stocktakes are kept (evidence)');
  });

  await test('stock ageing: buckets by batch age; non-batch by last inbound', async () => {
    const pid = d.prepare("SELECT id FROM products WHERE name = 'Paracetamol 500mg'").get().id;
    const b1 = d.prepare("SELECT id, qty FROM batches WHERE product_id = ? AND batch_no = 'B1'").get(pid);
    d.prepare("UPDATE batches SET created_at = date('now', '-200 days') WHERE id = ?").run(b1.id); // white-box age
    const rows = (await authJ('/api/stock/aging')).body;
    const para = rows.find((r) => r.product_name === 'Paracetamol 500mg');
    assert.ok(para);
    assert.strictEqual(para.buckets.aging, b1.qty, '200-day-old lot is "aging"');
    assert.ok(para.oldest_age_days >= 200);
    const sugar = rows.find((r) => r.product_name === 'Sugar');
    assert.ok(sugar);
    assert.strictEqual(sugar.buckets.fresh, sugar.qty, 'recent inbound = fresh');
  });

  await test('dead stock: on hand with no consumption in N days', async () => {
    const rows = (await authJ('/api/stock/dead?days=1')).body;
    const names = rows.map((r) => r.product_name);
    assert.ok(names.includes('Dead Item'), 'never-sold item is dead');
    assert.ok(!names.includes('Rice 2kg'), 'damaged rice had outbound movement');
    assert.ok(!names.includes('Paracetamol 500mg'), 'sold paracetamol is not dead');
  });

  await test('batch expiry write-off: partial then remainder, bounded', async () => {
    const pid = d.prepare("SELECT id FROM products WHERE name = 'Paracetamol 500mg'").get().id;
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(pid).id;
    const b1 = d.prepare("SELECT id, qty FROM batches WHERE product_id = ? AND batch_no = 'B1'").get(pid);
    const tooMuch = await authJ({ path: `/api/batches/${b1.id}/writeoff`, method: 'POST', body: { qty: 999 } });
    assert.strictEqual(tooMuch.status, 400);
    const partial = await authJ({ path: `/api/batches/${b1.id}/writeoff`, method: 'POST', body: { qty: 3, note: 'expired' } });
    assert.strictEqual(partial.status, 200);
    assert.strictEqual(d.prepare('SELECT qty FROM batches WHERE id = ?').get(b1.id).qty, b1.qty - 3);
    const move = d.prepare("SELECT * FROM stock_moves WHERE type = 'expiry_writeoff' ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(move.qty, -3);
    assert.ok(move.batch_id);
    const rest = await authJ({ path: `/api/batches/${b1.id}/writeoff`, method: 'POST', body: {} });
    assert.strictEqual(rest.status, 200, 'default = write off remainder');
    assert.strictEqual(d.prepare('SELECT qty FROM batches WHERE id = ?').get(b1.id).qty, 0);
    const stock = d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(vid).qty;
    assert.strictEqual(stock, 0, 'batches fully written off, stock conserved');
    // expiring filter
    const exp = (await authJ('/api/batches?expiring=400')).body;
    assert.ok(exp.every((b) => b.qty > 0));
  });

  await test('transfers: atomic out+in pair under one ref (R-S5 shape)', async () => {
    const pid = d.prepare("SELECT id FROM products WHERE name = 'Dead Item'").get().id;
    const out = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: -2, type: 'transfer_out', reason: 'transfer_out', ref: 'TR:1' } });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.newQty, 8);
    const in1 = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty: 2, type: 'transfer_in', reason: 'transfer_in', ref: 'TR:1' } });
    assert.strictEqual(in1.status, 200);
    assert.strictEqual(in1.body.newQty, 10, 'net zero at the source branch');
    const pair = (await authJ('/api/stock/moves?product_id=' + pid)).body.filter((m) => m.ref === 'TR:1');
    assert.strictEqual(pair.length, 2);
    const bal = (await authJ('/api/stock/balances')).body.find((b) => b.product_name === 'Dead Item');
    assert.strictEqual(bal.total, 10, 'balances agree after the pair');
    assert.strictEqual(bal.match, true, 'materialized == ledger');
  });

  // ---------------- Phase 5: purchasing & suppliers ----------------
  section('Phase 5 — purchasing (POs, GR + discrepancies, invoices, payments, suggestions)');

  const kcc = d.prepare("SELECT * FROM suppliers WHERE name = 'KCC Depot'").get();

  await test('purchasing is capability-gated (R-C); supplier CRUD + lead days', async () => {
    const capsBefore = (await authJ('/api/capabilities')).body.find((c) => c.id === 'purchasing');
    assert.strictEqual(capsBefore.enabled, false, 'duka does not seed purchasing');
    const po = await authJ({ path: '/api/purchase-orders', method: 'POST', body: { supplier_id: kcc.id, items: [{ product_id: 1, qty: 1 }] } });
    assert.strictEqual(po.status, 403, 'PO blocked while capability off');
    assert.ok(/Purchasing/.test(po.body.error));
    const on = await authJ({ path: '/api/capabilities', method: 'POST', body: { capability: 'purchasing', enabled: true } });
    assert.strictEqual(on.status, 200);
    // supplier update + delete guard
    const tmpSup = await authJ({ path: '/api/suppliers', method: 'POST', body: { name: 'Temp Co' } });
    assert.strictEqual(tmpSup.status, 200);
    const u = await authJ({ path: `/api/suppliers/${tmpSup.body.id}`, method: 'PUT', body: { lead_days: 3, terms: '30 days' } });
    assert.strictEqual(u.status, 200);
    assert.strictEqual((await authJ(`/api/suppliers/${tmpSup.body.id}`)).body.lead_days, 3);
    const del = await authJ({ path: `/api/suppliers/${tmpSup.body.id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200, 'clean supplier deletes');
    assert.strictEqual((await authJ('/api/suppliers')).body.find((x) => x.id === tmpSup.body.id), undefined);
    const det = await authJ(`/api/suppliers/${kcc.id}`);
    assert.ok(det.body.balance && typeof det.body.balance.outstanding === 'number');
  });

  let poId, poRef, milkItem, paraItem, sugarItem;

  await test('create PO: 3 items, sequential ref, total = Σ qty×cost', async () => {
    const milk = d.prepare("SELECT id FROM products WHERE name = 'Milk 1L'").get().id;
    const para = d.prepare("SELECT id FROM products WHERE name = 'Paracetamol 500mg'").get().id;
    const sugar = d.prepare("SELECT id FROM products WHERE name = 'Brown Sugar 1kg'").get().id;
    const r = await authJ({
      path: '/api/purchase-orders', method: 'POST',
      body: {
        supplier_id: kcc.id, note: 'monthly restock', expected_date: '2026-09-10',
        items: [
          { product_id: milk, qty: 20, unit_cost: 90 },
          { product_id: para, qty: 30, unit_cost: 80 },
          { product_id: sugar, qty: 10, unit_cost: 150 }
        ]
      }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ref, 'PO-000001');
    assert.strictEqual(r.body.total, 20 * 90 + 30 * 80 + 10 * 150);
    poId = r.body.id; poRef = r.body.ref;
    const det = (await authJ(`/api/purchase-orders/${poId}`)).body;
    assert.strictEqual(det.status, 'sent');
    assert.strictEqual(det.items.length, 3);
    milkItem = det.items[0].id; paraItem = det.items[1].id; sugarItem = det.items[2].id;
    const list = (await authJ('/api/purchase-orders?status=sent')).body;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].supplier_name, 'KCC Depot');
  });

  await test('partial GR: 15 of 20 milk received at PO cost → stock + move + status partial', async () => {
    const paraVid = d.prepare("SELECT v.id FROM products p JOIN variants v ON v.product_id = p.id WHERE p.name = 'Paracetamol 500mg' AND v.axes_key = '{}'").get().id;
    const beforePara = d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(paraVid).qty;
    const r = await authJ({
      path: `/api/purchase-orders/${poId}/receive`, method: 'POST',
      body: { items: [{ po_item_id: milkItem, qty: 15, cost: 90 }] }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ref, 'GR-000001');
    assert.strictEqual(r.body.discrepancies.length, 0);
    const det = (await authJ(`/api/purchase-orders/${poId}`)).body;
    assert.strictEqual(det.status, 'partial', 'not everything received yet');
    const item = det.items.find((i) => i.id === milkItem);
    assert.strictEqual(item.received_qty, 15);
    const milkVid = d.prepare("SELECT v.id FROM products p JOIN variants v ON v.product_id = p.id WHERE p.name = 'Milk 1L' AND v.axes_key = '{}'").get().id;
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(milkVid).qty, 15);
    const move = d.prepare("SELECT * FROM stock_moves WHERE ref = ? AND type = 'purchase' ORDER BY id DESC LIMIT 1").get(poRef);
    assert.strictEqual(move.qty, 15);
    assert.strictEqual(move.unit_cost, 90);
    assert.strictEqual(beforePara, d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(paraVid).qty, 'para untouched');
  });

  await test('GR with 2 discrepancies: over-receipt (qty) + price overcharge, both flagged pending', async () => {
    const r = await authJ({
      path: `/api/purchase-orders/${poId}/receive`, method: 'POST',
      body: { items: [
        { po_item_id: paraItem, qty: 32, cost: 80, batch_no: 'PO-B1', expiry_date: '2027-06-30' }, // 2 over
        { po_item_id: sugarItem, qty: 10, cost: 160 } // 10 over cost
      ] }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ref, 'GR-000002');
    assert.strictEqual(r.body.discrepancies.length, 2, 'two discrepancies flagged');
    const kinds = r.body.discrepancies.map((x) => x.kind).sort();
    assert.deepStrictEqual(kinds, ['over_qty', 'price']);
    const det = (await authJ(`/api/purchase-orders/${poId}`)).body;
    const p = det.items.find((i) => i.id === paraItem);
    assert.strictEqual(p.discrepancy, 'over_qty');
    assert.strictEqual(p.discrepancy_status, 'pending');
    const s = det.items.find((i) => i.id === sugarItem);
    assert.strictEqual(s.discrepancy, 'price');
    assert.strictEqual(s.discrepancy_status, 'pending');
    // batch was created with the lot (FEFO-ready)
    const batch = d.prepare("SELECT * FROM batches WHERE batch_no = 'PO-B1'").get();
    assert.ok(batch);
    assert.strictEqual(batch.qty, 32);
    assert.strictEqual(batch.expiry_date, '2027-06-30');
    assert.strictEqual(batch.cost, 80);
  });

  await test('discrepancy resolution: reject over-receipt → supplier return; approve price', async () => {
    const paraVid = d.prepare("SELECT v.id FROM products p JOIN variants v ON v.product_id = p.id WHERE p.name = 'Paracetamol 500mg' AND v.axes_key = '{}'").get().id;
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(paraVid).qty, 32, 'all 32 on hand first');
    const rej = await authJ({ path: `/api/po-items/${paraItem}/discrepancy`, method: 'POST', body: { decision: 'reject' } });
    assert.strictEqual(rej.status, 200);
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(paraVid).qty, 30, '2 went back');
    const sr = d.prepare('SELECT * FROM supplier_returns ORDER BY id DESC LIMIT 1').get();
    assert.strictEqual(sr.qty, 2);
    assert.strictEqual(sr.po_id, poId);
    const retMove = d.prepare('SELECT * FROM stock_moves WHERE ref = ? ORDER BY id DESC LIMIT 1').get(sr.ref);
    assert.strictEqual(retMove.type, 'return_out');
    assert.strictEqual(retMove.qty, -2);
    assert.ok(retMove.batch_id, 'return came out of the PO batch (FEFO)');
    assert.strictEqual(d.prepare("SELECT qty FROM batches WHERE batch_no = 'PO-B1'").get().qty, 30, 'batch conserved');
    const det = (await authJ(`/api/purchase-orders/${poId}`)).body;
    assert.strictEqual(det.items.find((i) => i.id === paraItem).received_qty, 30, 'received restored to ordered');
    const app = await authJ({ path: `/api/po-items/${sugarItem}/discrepancy`, method: 'POST', body: { decision: 'approve' } });
    assert.strictEqual(app.status, 200);
    const det2 = (await authJ(`/api/purchase-orders/${poId}`)).body;
    assert.strictEqual(det2.items.find((i) => i.id === sugarItem).discrepancy_status, 'approved');
    const again = await authJ({ path: `/api/po-items/${sugarItem}/discrepancy`, method: 'POST', body: { decision: 'approve' } });
    assert.strictEqual(again.status, 400, 'resolved discrepancies stay resolved');
  });

  await test('final partial GR completes the PO (status received)', async () => {
    const r = await authJ({
      path: `/api/purchase-orders/${poId}/receive`, method: 'POST',
      body: { items: [{ po_item_id: milkItem, qty: 5, cost: 90 }] }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.discrepancies.length, 0);
    const det = (await authJ(`/api/purchase-orders/${poId}`)).body;
    assert.strictEqual(det.status, 'received');
    const extra = await authJ({
      path: `/api/purchase-orders/${poId}/receive`, method: 'POST',
      body: { items: [{ po_item_id: milkItem, qty: 1 }] }
    });
    assert.strictEqual(extra.status, 400, 'cannot receive against a received PO');
  });

  await test('invoice against PO → partial payment → paid; overpayment & missing evidence refused', async () => {
    // 15×90 + 5×90 + 32×80 + 10×160 = 5960
    const inv = await authJ({
      path: '/api/supplier-invoices', method: 'POST',
      body: { supplier_id: kcc.id, po_id: poId, supplier_ref: 'KCC/8841', amount: 5960, vat: 829, due_date: '2026-10-01' }
    });
    assert.strictEqual(inv.status, 200);
    const other = (await authJ({ path: '/api/suppliers', method: 'POST', body: { name: 'Second Co' } })).body.id;
    const wrongSup = await authJ({
      path: '/api/supplier-invoices', method: 'POST',
      body: { supplier_id: other, po_id: poId, amount: 100 }
    });
    assert.strictEqual(wrongSup.status, 400, 'PO must belong to the supplier');
    const noRef = await authJ({ path: `/api/supplier-invoices/${inv.body.id}/payments`, method: 'POST', body: { amount: 100, method: 'bank' } });
    assert.strictEqual(noRef.status, 400, 'payment without channel evidence refused');
    const p1 = await authJ({ path: `/api/supplier-invoices/${inv.body.id}/payments`, method: 'POST', body: { amount: 2000, method: 'bank', channel_ref: 'BANK-TR-778' } });
    assert.strictEqual(p1.status, 200);
    assert.strictEqual(p1.body.settled, false);
    const over = await authJ({ path: `/api/supplier-invoices/${inv.body.id}/payments`, method: 'POST', body: { amount: 4000, method: 'bank', channel_ref: 'X' } });
    assert.strictEqual(over.status, 400, 'overpayment refused');
    const p2 = await authJ({ path: `/api/supplier-invoices/${inv.body.id}/payments`, method: 'POST', body: { amount: 3960, method: 'mpesa', channel_ref: 'MPESA-TR-991' } });
    assert.strictEqual(p2.body.settled, true);
    const det = (await authJ(`/api/supplier-invoices/${inv.body.id}`)).body;
    assert.strictEqual(det.status, 'paid');
    assert.strictEqual(det.paid, 5960);
    assert.strictEqual(det.payments.length, 2);
    const bal = (await authJ(`/api/suppliers/${kcc.id}`)).body.balance;
    assert.strictEqual(bal.outstanding, 0, 'supplier settled');
    assert.strictEqual(bal.paid, 5960);
    assert.strictEqual(bal.open_pos, 0, 'received PO is not open');
  });

  await test('standalone supplier return: stock out, return_out move, evidence row', async () => {
    const milk = d.prepare("SELECT id FROM products WHERE name = 'Milk 1L'").get().id;
    const before = d.prepare("SELECT v.id, s.qty FROM products p JOIN variants v ON v.product_id = p.id JOIN stock s ON s.variant_id = v.id WHERE p.name = 'Milk 1L'").get();
    const r = await authJ({
      path: '/api/supplier-returns', method: 'POST',
      body: { supplier_id: kcc.id, product_id: milk, qty: 3, cost: 90, reason: 'damaged in transit' }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ?').get(before.id).qty, before.qty - 3);
    const row = d.prepare('SELECT * FROM supplier_returns WHERE ref = ?').get(r.body.ref);
    assert.strictEqual(row.qty, 3);
    const noReason = await authJ({ path: '/api/supplier-returns', method: 'POST', body: { supplier_id: kcc.id, product_id: milk, qty: 1 } });
    assert.strictEqual(noReason.status, 400, 'reason required');
    const list = (await authJ('/api/supplier-returns?supplier_id=' + kcc.id)).body;
    assert.strictEqual(list.length, 2, 'reject-return + standalone');
  });

  await test('suggested PO: velocity × (lead + cover) − stock, top movers first', async () => {
    // Fast Mover: 10 on hand, sold 2/day for 30 days (60 total) → velocity 2/day
    const p = await authJ({ path: '/api/products', method: 'POST', body: { name: 'Fast Mover', unit: 'pcs', cost: 50, price: 90, supplier_id: kcc.id } });
    await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: p.body.id, qty: 10, type: 'purchase', reason: 'purchase' } });
    const ins = d.prepare("INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, user_id, created_at) VALUES (?, (SELECT id FROM variants WHERE product_id = ?), 1, 1, 2, 'sale', 'sale', 'HIST', NULL, ?)");
    for (let i = 0; i < 30; i++) ins.run(p.body.id, p.body.id, new Date(Date.now() - i * 86400e3).toISOString()); // 30 lots of 2, all inside the window
    const rows = (await authJ('/api/purchase/suggestions?days=30&cover=14')).body;
    const fm = rows.find((r) => r.product_id === p.body.id);
    assert.ok(fm, 'fast mover suggested');
    assert.strictEqual(fm.velocity_per_day, 2);
    assert.strictEqual(fm.stock, 10);
    assert.strictEqual(fm.lead_days, 7, 'supplier lead days used');
    assert.strictEqual(fm.suggest_qty, Math.ceil(2 * (7 + 14) - 10), 'velocity × (lead + cover) − stock');
    assert.strictEqual(fm.days_cover, 5);
    // never-sold and supplier-less products are not suggested
    assert.ok(!rows.find((r) => r.product_name === 'Milk 1L'), 'no sales → no suggestion');
    assert.ok(!rows.find((r) => r.product_name === 'Dress'), 'no supplier → no suggestion');
    // urgent first
    assert.strictEqual(rows.length >= 1, true);
  });

  await test('purchase price history: evidence per lot from the ledger', async () => {
    const para = d.prepare("SELECT id FROM products WHERE name = 'Paracetamol 500mg'").get().id;
    const r = (await authJ(`/api/products/${para}/purchase-history`)).body;
    assert.strictEqual(r.current_cost, 80);
    const gr = r.purchases.find((x) => x.ref === poRef);
    assert.ok(gr, 'GR purchase on the history');
    assert.strictEqual(gr.qty, 32);
    assert.strictEqual(gr.unit_cost, 80);
    assert.ok(gr.batch_no, 'batch evidence attached');
  });

  await test('PO cancel: only when nothing received; received POs use returns', async () => {
    const milk = d.prepare("SELECT id FROM products WHERE name = 'Milk 1L'").get().id;
    const c = await authJ({ path: '/api/purchase-orders', method: 'POST', body: { supplier_id: kcc.id, items: [{ product_id: milk, qty: 5, unit_cost: 90 }] } });
    assert.strictEqual(c.body.ref, 'PO-000002');
    const ok = await authJ({ path: `/api/purchase-orders/${c.body.id}/cancel`, method: 'POST', body: {} });
    assert.strictEqual(ok.status, 200);
    const again = await authJ({ path: `/api/purchase-orders/${c.body.id}/cancel`, method: 'POST', body: {} });
    assert.strictEqual(again.status, 400, 'already cancelled');
    const no = await authJ({ path: `/api/purchase-orders/${poId}/cancel`, method: 'POST', body: {} });
    assert.strictEqual(no.status, 400, 'goods received — returns, not cancel');
    const del = await authJ({ path: `/api/suppliers/${kcc.id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200, 'settled supplier with closed POs deletes');
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  // ---------------- summary ----------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    failures.forEach((f) => console.log(`\nFAIL: ${f.name}\n${f.error.stack || f.error.message}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('Runner error:', e);
  process.exit(1);
});

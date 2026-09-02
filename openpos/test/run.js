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
    const before = d.prepare('SELECT qty FROM stock WHERE product_id = ?').get(rice.id).qty;
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
    assert.strictEqual(after.body.find((x) => x.id === id && x.active === 1), undefined);
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

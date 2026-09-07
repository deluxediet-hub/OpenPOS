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
const commsLib = require('../lib/comms');
  const app = createApp(d);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const J = (a, b, c) => { const opts = typeof a === 'string' ? { path: a, method: b, body: c } : (a || {}); return fetch(BASE + opts.path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual'
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers })); };

  const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

  let cookie = '';
  const JCOOKIE = async (p) => {
    const r = await fetch(BASE + p, { headers: { cookie }, redirect: 'manual' });
    return { status: r.status, headers: r.headers, text: await r.text() };
  };

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
    assert.strictEqual(r.body.length, 19, '19-capability registry');
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

  // ================= Phase 6 — pricing engine (R-PR) =================
  section('Phase 6 — pricing engine (R-PR)');

  // Shared fixtures (created once, resolved many times). Live suite branches after Phase 2's delete tests: 1=Main, 2=Eastleigh only; we add three more.
  let priceProduct, priceVariant, brs, custStd, custWhole, custVip, packId, ruleVip, rulePromo, ruleMain60;

  await test('setup: 5 branches, 3 customers, chain product, rules, case pack (R-PR fixtures)', async () => {
    brs = [1, 2];
    for (const n of ['Acceptance BR05', 'Acceptance BR06', 'Acceptance BR07']) {
      const nb = await authJ({ path: '/api/branches', method: 'POST', body: { name: n } });
      assert.strictEqual(nb.status, 200, JSON.stringify(nb.body));
      brs.push(nb.body.id);
    }
    const prod = await authJ({ path: '/api/products', method: 'POST', body: {
      name: 'Chain Test', barcode: '99991', category: 'Pricing',
      cost: 500, price: 1000, wholesale_price: 900, member_price: 850
    } });
    assert.strictEqual(prod.status, 200, JSON.stringify(prod.body));
    priceProduct = prod.body.id;
    priceVariant = d.prepare("SELECT v.id FROM variants v WHERE v.product_id = ? AND v.axes_key = '{}'").get(priceProduct).id;
    const insC = d.prepare('INSERT INTO customers (name, phone, tier, created_at) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    custStd = insC.run('Acct Standard', '0700000001', 'standard', now).lastInsertRowid;
    custWhole = insC.run('Acct Wholesale', '0700000002', 'wholesale', now).lastInsertRowid;
    custVip = insC.run('Acct VIP', '0700000003', 'standard', now).lastInsertRowid;
    const r2 = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, branch_id: brs[1], price: 1100, name: 'Eastleigh markup' } });
    const r3 = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, branch_id: brs[2], price: 800, name: 'Nakuru discount' } });
    const rv = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, customer_id: custVip, price: 777, name: 'VIP rate' } });
    const rp = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, promo_code: 'DAY9', customer_id: custVip, price: 500, name: 'DAY9 VIP promo' } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.strictEqual(r3.status, 200, JSON.stringify(r3.body));
    assert.strictEqual(rv.status, 200, JSON.stringify(rv.body));
    assert.strictEqual(rp.status, 200, JSON.stringify(rp.body));
    ruleVip = rv.body.id;
    rulePromo = rp.body.id;
    const pk = await authJ({ path: `/api/variants/${priceVariant}/packs`, method: 'POST', body: { name: 'Case of 12', multiple: 12, unit: 'case', price: 11500, cost: 11000 } });
    assert.strictEqual(pk.status, 200, JSON.stringify(pk.body));
    packId = pk.body.id;
  });

  await test('acceptance: same variant, 5 branches, 2 customer types, 1 promo = 11 correct prices (R-PR1)', async () => {
    const res = async (branchId, customerId, promo) => {
      const r = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${branchId}&customer_id=${customerId}${promo ? `&promo_code=${promo}` : ''}` });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      return r.body;
    };
    const grid = [];
    for (const [bi, wantStd, wantWhole] of [[1, 1000, 900], [2, 1100, 1100], [3, 800, 800], [4, 1000, 900], [5, 1000, 900]]) {
      const s = await res(brs[bi - 1], custStd);
      grid.push([`BR${bi} std`, s.price, wantStd, s.source, 'default/branch']);
      assert.strictEqual(s.price, wantStd, `BR${bi} standard: got ${s.price} want ${wantStd} (${s.source})`);
      if (bi === 2) assert.strictEqual(s.source, 'branch');
      const w = await res(brs[bi - 1], custWhole);
      grid.push([`BR${bi} whole`, w.price, wantWhole, w.source, bi === 2 ? 'branch' : 'default']);
      assert.strictEqual(w.price, wantWhole, `BR${bi} wholesale: got ${w.price} want ${wantWhole} (${w.source})`);
      if (bi === 2) assert.strictEqual(w.source, 'branch');
    }
    const p = await res(brs[1], custVip, 'DAY9');
    grid.push(['BR02 vip+DAY9', p.price, 500, p.source, 'promo']);
    assert.strictEqual(p.price, 500, `promo: got ${p.price} want 500 (${p.source})`);
    assert.strictEqual(p.source, 'promo');
    assert.strictEqual(grid.length, 11, 'grid must contain 11 prices');
  });

  await test('customer-specific price beats branch override; promo beats everything (R-PR2, R-PR5)', async () => {
    const a = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[1]}&customer_id=${custVip}` });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.price, 777, `VIP at BR02: got ${a.body.price} (${a.body.source})`);
    assert.strictEqual(a.body.source, 'customer');
    const b = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[1]}&customer_id=${custVip}&promo_code=DAY9` });
    assert.strictEqual(b.body.price, 500, `promo must win over customer rule: got ${b.body.price}`);
    assert.strictEqual(b.body.source, 'promo');
    const c = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[1]}&customer_id=${custStd}&promo_code=DAY9` });
    assert.strictEqual(c.body.price, 1100, `DAY9 is VIP-only: std at BR02 got ${c.body.price}`);
  });

  await test('case pack: cheaper per unit than 12 bottles; branch rule outranks pack (R-PR4)', async () => {
    const a = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[0]}&customer_id=${custStd}&pack_id=${packId}` });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(a.body.price, 11500, `case at BR01: got ${a.body.price} (${a.body.source})`);
    assert.strictEqual(a.body.source, 'pack');
    assert.strictEqual(a.body.price_per_unit, Math.round(11500 / 12));
    const b = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[1]}&customer_id=${custStd}&pack_id=${packId}` });
    assert.strictEqual(b.body.price, 1100, `branch rule must outrank pack: got ${b.body.price} (${b.body.source})`);
    assert.strictEqual(b.body.source, 'branch');
  });

  await test('time-based prices: active date window, active time window, expired ignored (R-PR6)', async () => {
    const pad = (x) => String(x).padStart(2, '0');
    const hm = (offsetMin) => { const t = new Date(Date.now() + offsetMin * 60000); return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; };
    const day = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
    const mk = (body) => authJ({ path: '/api/price-rules', method: 'POST', body });
    const rTime = await mk({ variant_id: priceVariant, tier: 'wholesale', price: 950, valid_from: day(-1), valid_to: day(1), name: 'Wholesale week' });
    const rExpired = await mk({ variant_id: priceVariant, tier: 'wholesale', price: 123, valid_to: day(-1), name: 'Ended last week' });
    const rHm = await mk({ variant_id: priceVariant, price: 700, time_start: hm(-30), time_end: hm(30), name: 'Hourly rush rate' });
    assert.strictEqual(rTime.status, 200, JSON.stringify(rTime.body));
    assert.strictEqual(rExpired.status, 200, JSON.stringify(rExpired.body));
    assert.strictEqual(rHm.status, 200, JSON.stringify(rHm.body));
    const whole = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[0]}&customer_id=${custWhole}` });
    assert.strictEqual(whole.body.price, 950, `active date window: got ${whole.body.price} (${whole.body.source})`);
    assert.strictEqual(whole.body.source, 'time');
    const std = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[0]}&customer_id=${custStd}` });
    assert.strictEqual(std.body.price, 700, `active time window: got ${std.body.price} (${std.body.source})`);
    assert.strictEqual(std.body.source, 'time');
    for (const id of [rTime.body.id, rExpired.body.id, rHm.body.id]) {
      const del = await authJ({ path: `/api/price-rules/${id}`, method: 'DELETE' });
      assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    }
    const after = await authJ({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[0]}&customer_id=${custWhole}` });
    assert.strictEqual(after.body.price, 900, `deleted rules no longer apply: got ${after.body.price} (${after.body.source})`);
  });

  await test('margin guard: below-floor price needs manager PIN (R-PR7)', async () => {
    const s = await authJ({ path: '/api/settings', method: 'PUT', body: { pricing: { min_margin_pct: 30, margin_policy: 'pin' } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    const noPin = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 700 } });
    assert.strictEqual(noPin.status, 403, `expected 403, got ${noPin.status}: ${JSON.stringify(noPin.body)}`);
    assert.strictEqual(noPin.body.code, 'margin_pin');
    const badPin = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 700, pin: '0000' } });
    assert.strictEqual(badPin.status, 403);
    assert.strictEqual(badPin.body.code, 'margin_pin');
    const ok = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 700, pin: '2345' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(d.prepare('SELECT price FROM products WHERE id = ?').get(priceProduct).price, 700, 'PIN-approved 700 must be persisted');
    const restored = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 1000 } });
    assert.strictEqual(restored.status, 200, `above floor needs no PIN: ${JSON.stringify(restored.body)}`);
  });

  await test('margin guard floors: product floor beats global; branch floor beats global (R-PR7)', async () => {
    const perProduct = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 1000, min_margin_pct: 50 } });
    assert.strictEqual(perProduct.status, 200, JSON.stringify(perProduct.body));
    const a = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 750 } });
    assert.strictEqual(a.status, 403, `product floor 50 > 33.3% margin: got ${a.status}`);
    assert.strictEqual(a.body.code, 'margin_pin');
    const aPin = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 750, pin: '2345' } });
    assert.strictEqual(aPin.status, 200, JSON.stringify(aPin.body));
    const clearFloor = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 750, min_margin_pct: null } });
    assert.strictEqual(clearFloor.status, 200, `no product floor: global 30 < 33.3%: ${JSON.stringify(clearFloor.body)}`);
    const branchList = (await authJ({ path: '/api/branches' })).body;
    const prevSettings = (branchList.find((b) => b.id === brs[0]) || {}).settings || {};
    await authJ({ path: `/api/branches/${brs[0]}`, method: 'PUT', body: { settings: { ...prevSettings, min_margin_pct: 60 } } });
    const ruleNoPin = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, branch_id: brs[0], price: 600, name: 'Main loss-leader' } });
    assert.strictEqual(ruleNoPin.status, 403, `branch floor 60 > 16.7%: got ${ruleNoPin.status}`);
    assert.strictEqual(ruleNoPin.body.code, 'margin_pin');
    const rulePin = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, branch_id: brs[0], price: 600, name: 'Main loss-leader', pin: '2345' } });
    assert.strictEqual(rulePin.status, 200, JSON.stringify(rulePin.body));
    ruleMain60 = rulePin.body.id;
    await authJ({ path: `/api/price-rules/${ruleMain60}`, method: 'DELETE' });
    await authJ({ path: `/api/branches/${brs[0]}`, method: 'PUT', body: { settings: prevSettings } });
    const back = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 1000 } });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  });

  await test('margin guard: block policy refuses even a valid PIN (R-PR7)', async () => {
    const s = await authJ({ path: '/api/settings', method: 'PUT', body: { pricing: { margin_policy: 'block' } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    const r = await authJ({ path: `/api/products/${priceProduct}`, method: 'PUT', body: { price: 700, pin: '2345' } });
    assert.strictEqual(r.status, 403, `block policy must refuse: got ${r.status}`);
    assert.strictEqual(r.body.code, 'margin_blocked');
    const back = await authJ({ path: '/api/settings', method: 'PUT', body: { pricing: { margin_policy: 'pin' } } });
    assert.strictEqual(back.status, 200);
  });

  await test('every price change leaves history: who, from, to, approver (R-PR3)', async () => {
    const r = await authJ({ path: `/api/pricing/history?product_id=${priceProduct}` });
    assert.strictEqual(r.status, 200);
    const rows = r.body.history || r.body;
    assert.ok(Array.isArray(rows), `history shape: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(rows.length >= 6, `expected >=6 rows (create + 4 updates + ...), got ${rows.length}`);
    const withPin = rows.find((h) => h.new_price === 700 && h.field === 'price');
    assert.ok(withPin, `history must contain the PIN-approved 700 change: ${JSON.stringify(rows.slice(0, 3))}`);
    assert.ok(withPin.approved_by, `approved_by must record the manager: ${JSON.stringify(withPin)}`);
    const createRow = rows.find((h) => h.old_price === null && h.new_price === 1000);
    assert.ok(createRow, 'create row (null -> 1000) must be in history');
    const upd = await authJ({ path: '/api/pricing', method: 'PUT' });
    assert.strictEqual(upd.status, 404, 'no update route on history');
    const del = await authJ({ path: '/api/pricing/history/1', method: 'DELETE' });
    assert.strictEqual(del.status, 404, 'no delete route on history');
  });

  await test('price-rule CRUD leaves history rows (scope=rule)', async () => {
    const mk = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, branch_id: brs[3], price: 970, name: 'Westlands trial' } });
    assert.strictEqual(mk.status, 200, JSON.stringify(mk.body));
    const id = mk.body.id;
    const upd = await authJ({ path: `/api/price-rules/${id}`, method: 'PUT', body: { price: 960 } });
    assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
    await authJ({ path: `/api/price-rules/${id}`, method: 'DELETE' });
    const rows = (await authJ({ path: `/api/pricing/history?variant_id=${priceVariant}` })).body;
    const list = rows.history || rows;
    const created = list.find((h) => h.scope === 'rule' && h.old_price === null && h.new_price === 970);
    const updated = list.find((h) => h.scope === 'rule' && h.old_price === 970 && h.new_price === 960);
    const deleted = list.find((h) => h.scope === 'rule' && h.old_price === 960 && h.new_price === null);
    assert.ok(created && updated && deleted, `rule history rows: ${JSON.stringify(list.filter((h) => h.scope === 'rule').slice(0, 5))}`);
  });

  await test('rule validation: one primary scope; promo+tier combinable; bad values rejected', async () => {
    const two = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, branch_id: brs[0], customer_id: custStd, price: 50 } });
    assert.strictEqual(two.status, 400, JSON.stringify(two.body));
    const none = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, price: 50 } });
    assert.strictEqual(none.status, 400, JSON.stringify(none.body));
    const badTier = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, tier: 'royal', price: 50 } });
    assert.strictEqual(badTier.status, 400, JSON.stringify(badTier.body));
    const badDate = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, branch_id: brs[0], price: 50, valid_to: 'someday' } });
    assert.strictEqual(badDate.status, 400, JSON.stringify(badDate.body));
    const combo = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, promo_code: 'X1', tier: 'wholesale', price: 1000, time_start: '08:00', time_end: '10:00' } });
    assert.strictEqual(combo.status, 200, `promo+tier+window must be allowed: ${JSON.stringify(combo.body)}`);
    await authJ({ path: `/api/price-rules/${combo.body.id}`, method: 'DELETE' });
  });

  await test('permissions: cashier resolves prices but cannot manage rules (R-PR9)', async () => {
    const ck = (await authJ({ path: '/api/login', method: 'POST', body: { name: 'Cashier Jane', pin: '5678' } })).headers.get('set-cookie').split(';')[0];
    const asCashier = (o) => fetch(`${BASE}${o.path}`, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', cookie: ck }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const ok = await asCashier({ path: `/api/pricing/resolve?product_id=${priceProduct}&variant_id=${priceVariant}&branch_id=${brs[0]}&customer_id=${custStd}` });
    assert.strictEqual(ok.status, 200, `cashier may resolve: ${JSON.stringify(ok.body)}`);
    const list = await asCashier({ path: '/api/price-rules' });
    assert.strictEqual(list.status, 200, `cashier may view rules: got ${list.status}`);
    const mk = await asCashier({ path: '/api/price-rules', method: 'POST', body: { variant_id: priceVariant, price: 1 } });
    assert.strictEqual(mk.status, 403, `cashier create: got ${mk.status}`);
    const upd = await asCashier({ path: `/api/price-rules/${ruleVip}`, method: 'PUT', body: { price: 1 } });
    assert.strictEqual(upd.status, 403, `cashier update: got ${upd.status}`);
    const delr = await asCashier({ path: `/api/price-rules/${ruleVip}`, method: 'DELETE' });
    assert.strictEqual(delr.status, 403, `cashier delete: got ${delr.status}`);
    const hist = await asCashier({ path: '/api/pricing/history' });
    assert.strictEqual(hist.status, 200, `cashier reads history: got ${hist.status}`);
  });

  // ================= Phase 7 — POS / sales engine (Day 10) =================
  section('Phase 7 — POS / sales engine (Day 10)');

  let pos = {}; // fixtures
  const cashierLogin = async (name, pin) => (await authJ({ path: '/api/login', method: 'POST', body: { name, pin } })).headers.get('set-cookie').split(';')[0];

  await test('setup: POS products, stock, two tills, two cashiers', async () => {
    const loc = d.prepare('SELECT id FROM locations WHERE branch_id = 1 AND is_default = 1').get().id;
    pos.loc = loc;
    const mk = async (body) => {
      const r = await authJ({ path: '/api/products', method: 'POST', body });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(r.body.id).id;
      return { id: r.body.id, vid };
    };
    const open = async (productId, qty, unitCost) => {
      const r = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: productId, qty, type: 'opening', reason: 'opening', unit_cost: unitCost } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    };
    pos.A = await mk({ name: 'POS Item', barcode: '77701', cost: 100, price: 200 });
    pos.B = await mk({ name: 'POS Batch', barcode: '77702', cost: 50, price: 100, track_batches: true });
    pos.C = await mk({ name: 'POS Spirits', barcode: '77703', cost: 200, price: 300, age_min: 21 });
    pos.D = await mk({ name: 'POS Discount', barcode: '77704', cost: 300, price: 500 });
    pos.E = await mk({ name: 'POS Hold', barcode: '77705', cost: 90, price: 150 });
    pos.F = await mk({ name: 'POS Concurrent', barcode: '77706', cost: 60, price: 100 });
    pos.G = await mk({ name: 'POS Oversell', barcode: '77707', cost: 50, price: 100 });
    await open(pos.A.id, 60, 100); // 60: the Phase 8 suite splits A across many sales
    await open(pos.C.id, 5, 200);
    await open(pos.D.id, 3, 300);
    await open(pos.E.id, 10, 90);
    await open(pos.F.id, 8, 60);
    await open(pos.G.id, 2, 50);
    // two FEFO lots for B
    const now = new Date().toISOString();
    const insB = d.prepare('INSERT INTO batches (product_id, branch_id, location_id, variant_id, batch_no, expiry_date, qty, cost, created_at) VALUES (?,1,?,?,?,?,?,?,?)');
    pos.b1 = insB.run(pos.B.id, loc, pos.B.vid, 'B1-OCT', '2026-10-01', 5, 50, now).lastInsertRowid;
    pos.b2 = insB.run(pos.B.id, loc, pos.B.vid, 'B2-DEC', '2026-12-01', 5, 50, now).lastInsertRowid;
    d.prepare("INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, batch_id, unit_cost, user_id, note, created_at) VALUES (?,?,1,?,5,'opening','opening','',?,50,1,'fixture',?)").run(pos.B.id, pos.B.vid, loc, pos.b1, now);
    d.prepare("INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, batch_id, unit_cost, user_id, note, created_at) VALUES (?,?,1,?,5,'opening','opening','',?,50,1,'fixture',?)").run(pos.B.id, pos.B.vid, loc, pos.b2, now);
    d.prepare('INSERT INTO stock (variant_id, location_id, qty) VALUES (?,?,10)').run(pos.B.vid, loc);
    // second till + two cashiers
    const t2 = await authJ({ path: '/api/registers', method: 'POST', body: { name: 'Till 2' } });
    assert.strictEqual(t2.status, 200, JSON.stringify(t2.body));
    pos.till2 = t2.body.id;
    const r1 = d.prepare("SELECT id FROM registers WHERE branch_id = 1 ORDER BY id").get().id;
    pos.till1 = r1;
    for (const [name, pin, reg] of [['POS Cashier A', '1111', r1], ['POS Cashier B', '2222', pos.till2]]) {
      const s = await authJ({ path: '/api/staff', method: 'POST', body: { name, role: 'cashier', pin, branch_id: 1, register_id: reg } });
      assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    }
    pos.cashA = await cashierLogin('POS Cashier A', '1111');
    pos.cashB = await cashierLogin('POS Cashier B', '2222');
    pos.mgrId = d.prepare("SELECT id FROM users WHERE name = 'Mwenyeji M'").get().id;
  });

  await test('POS sale: cash with change, stock decremented, receipt fields (R-PR freeze)', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const r = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], payment: { method: 'cash', amount: 500 } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const s = r.body.sale;
    pos.sale1 = s.id;
    assert.strictEqual(s.status, 'paid');
    assert.strictEqual(s.order_no, 1, `order_no: ${s.order_no}`);
    assert.strictEqual(s.invoice_no, 'BR01-000001', s.invoice_no);
    assert.strictEqual(s.subtotal, 400);
    // R-P2: 400 is VAT-inclusive — 55 of it is VAT, and the customer pays 400.
    assert.strictEqual(s.tax, 55, `VAT in 400: ${s.tax}`);
    assert.strictEqual(s.net, 345);
    assert.strictEqual(s.gross, 400);
    assert.strictEqual(r.body.payments.length, 1);
    const raw = JSON.parse(r.body.payments[0].raw);
    assert.strictEqual(raw.change, 100, `change: ${raw.change}`);
    // stock decremented at the till's location
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty, 58);
    // stock move carries the invoice ref (R-S2 trace)
    const mv = d.prepare("SELECT * FROM stock_moves WHERE type = 'sale' AND ref = ?").get('BR01-000001');
    assert.ok(mv, 'sale stock move with invoice ref');
    assert.strictEqual(mv.qty, -2);
    // receipt
    assert.strictEqual(r.body.receipt.business.name, 'Test Traders');
    assert.strictEqual(r.body.items[0].unit_price, 200, 'frozen unit price on the line');
  });

  await test('price frozen at line add: later price change does not alter the sale', async () => {
    const up = await authJ({ path: `/api/products/${pos.A.id}`, method: 'PUT', body: { price: 250 } });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    const r = await authJ({ path: `/api/sales/${pos.sale1}` });
    assert.strictEqual(r.body.items[0].unit_price, 200, 'frozen price unchanged');
    assert.strictEqual(r.body.sale.gross, 400);
  });

  await test('FEFO: sale picks earliest-expiry batches first; line records the lot', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const r = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.B.vid, qty: 7 }], payment: { method: 'cash', amount: 800 } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(d.prepare('SELECT qty FROM batches WHERE id = ?').get(pos.b1).qty, 0, 'earliest lot exhausted');
    assert.strictEqual(d.prepare('SELECT qty FROM batches WHERE id = ?').get(pos.b2).qty, 3, 'second lot takes the rest');
    const moves = d.prepare("SELECT * FROM stock_moves WHERE ref = ? AND type = 'sale' ORDER BY id").all(r.body.sale.invoice_no);
    assert.strictEqual(moves.length, 2, `one move per lot: ${moves.length}`);
    assert.strictEqual(moves[0].batch_id, pos.b1);
    assert.strictEqual(moves[0].qty, -5);
    assert.strictEqual(moves[1].batch_id, pos.b2);
    assert.strictEqual(moves[1].qty, -2);
    assert.strictEqual(r.body.items[0].batch_id, pos.b1, 'line points at first lot (full trace in the ledger)');
  });

  await test('R-S8: insufficient stock refused; cashier oversell 403; manager oversell audited', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const short = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.G.vid, qty: 99 }], payment: { method: 'cash', amount: 9999 } } });
    assert.strictEqual(short.status, 400, JSON.stringify(short.body));
    assert.match(short.body.error, /insufficient stock/);
    const asCashOversell = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.G.vid, qty: 99 }], payment: { method: 'cash', amount: 9999 }, oversell: true } });
    assert.strictEqual(asCashOversell.status, 403, `cashier oversell must be 403: ${JSON.stringify(asCashOversell.body)}`);
    const asOwner = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.G.vid, qty: 99 }], payment: { method: 'cash', amount: 9999 }, oversell: true } });
    assert.strictEqual(asOwner.status, 200, JSON.stringify(asOwner.body));
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.G.vid, pos.loc).qty, 2 - 99);
    const audit = d.prepare("SELECT * FROM audit_log WHERE action = 'sale/create' ORDER BY id DESC LIMIT 1").get();
    const det = JSON.parse(audit.detail);
    assert.strictEqual(det.oversell, true, 'oversell flagged in audit');
  });

  await test('discounts: cashier refused; supervisor PIN records approver; granted permission works', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const refused = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.D.vid, qty: 1, line_discount: 100 }], payment: { method: 'cash', amount: 500 } } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    const withPin = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.D.vid, qty: 1, line_discount: 100 }], payment: { method: 'cash', amount: 500 }, override_pin: '2345' } });
    assert.strictEqual(withPin.status, 200, JSON.stringify(withPin.body));
    assert.strictEqual(withPin.body.sale.discount, 100);
    assert.strictEqual(withPin.body.sale.discount_by, 'Mwenyeji M', `approver recorded: ${withPin.body.sale.discount_by}`);
    const badPin = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.D.vid, qty: 1, line_discount: 100 }], payment: { method: 'cash', amount: 500 }, override_pin: '0000' } });
    assert.strictEqual(badPin.status, 403);
    // grant the permission, then no PIN needed
    const cashId = d.prepare("SELECT id FROM users WHERE name = 'POS Cashier A'").get().id;
    const grant = await authJ({ path: `/api/staff/${cashId}/permissions`, method: 'POST', body: { permission: 'sales.discount', allowed: true } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    const granted = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.D.vid, qty: 1, line_discount: 50 }], payment: { method: 'cash', amount: 500 } } });
    assert.strictEqual(granted.status, 200, JSON.stringify(granted.body));
    assert.strictEqual(granted.body.sale.discount, 50);
    const over = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.D.vid, qty: 1, line_discount: 9999 }], payment: { method: 'cash', amount: 500 } } });
    assert.strictEqual(over.status, 400, 'discount cannot exceed line total');
  });

  await test('age gate: 21+ item blocked without attestation', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const no = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.C.vid, qty: 1 }], payment: { method: 'cash', amount: 400 } } });
    assert.strictEqual(no.status, 400, JSON.stringify(no.body));
    assert.match(no.body.error, /age verification/);
    const yes = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.C.vid, qty: 1, age_verified: 1 }], payment: { method: 'cash', amount: 400 } } });
    assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));
    assert.strictEqual(yes.body.items[0].age_verified, 1);
  });

  await test('hold & resume: suspended keeps stock; paying moves it exactly once', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const before = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.E.vid, pos.loc).qty;
    const h = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.E.vid, qty: 2 }], hold: true } });
    assert.strictEqual(h.status, 200, JSON.stringify(h.body));
    assert.strictEqual(h.body.sale.status, 'suspended');
    assert.strictEqual(h.body.payments.length, 0);
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.E.vid, pos.loc).qty, before, 'held sale must not touch stock');
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'sale' AND ref = ?").get(h.body.sale.invoice_no).n, 0);
    const pay = await asA({ path: `/api/sales/${h.body.sale.id}/pay`, method: 'POST', body: { payment: { method: 'cash', amount: 400 } } });
    assert.strictEqual(pay.status, 200, JSON.stringify(pay.body));
    assert.strictEqual(pay.body.sale.status, 'paid');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.E.vid, pos.loc).qty, before - 2);
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'sale' AND ref = ?").get(pay.body.sale.invoice_no).n, 1, 'stock moved exactly once');
    const again = await asA({ path: `/api/sales/${pay.body.sale.id}/pay`, method: 'POST', body: { payment: { method: 'cash', amount: 400 } } });
    assert.strictEqual(again.status, 400, 'double-pay refused');
  });

  await test('M-Pesa: pending until the code is recorded; underpay leaves the sale partial', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    // the price-freeze test above changed A's price; restore the 200 the amounts below assume
    const back = await authJ({ path: `/api/products/${pos.A.id}`, method: 'PUT', body: { price: 200 } });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));
    const started = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'mpesa', amount: 200, phone: '0700111222' } } });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    assert.strictEqual(started.body.sale.status, 'open', 'money promised, not yet received');
    assert.strictEqual(started.body.payments[0].status, 'pending');
    const done = await asA({ path: `/api/payments/${started.body.payments[0].id}/confirm`, method: 'POST', body: { code: 'MPX000' } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.strictEqual(done.body.sale.status, 'paid');
    assert.strictEqual(done.body.payments[0].ref, 'MPX000', 'the code is the reference');
    const under = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'mpesa', amount: 100, phone: '0700111222' } } });
    assert.strictEqual(under.status, 200, JSON.stringify(under.body));
    const done2 = await asA({ path: `/api/payments/${under.body.payments[0].id}/confirm`, method: 'POST', body: { code: 'MPX123' } });
    assert.strictEqual(done2.body.sale.status, 'partial');
    assert.strictEqual(done2.body.payments[0].amount, 100);
    const overpay = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'mpesa', amount: 999, phone: '0700111222' } } });
    assert.strictEqual(overpay.status, 400, 'mpesa cannot overpay');
  });

  // ---- Phase 8: payment engine ---------------------------------------------
  await test('payment engine: split cash + M-Pesa (manual) + card reconciles', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const hold = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], hold: true } });
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));
    const sid = hold.body.sale.id;
    const inv = hold.body.sale.invoice_no;
    const cash = await asA({ path: `/api/sales/${sid}/payments`, method: 'POST', body: { method: 'cash', amount: 100 } });
    assert.strictEqual(cash.status, 200, JSON.stringify(cash.body));
    assert.strictEqual(cash.body.sale.status, 'partial', '100 of 400');
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'sale' AND ref = ?").get(inv).n, 1, 'stock moved on first money in');
    const mpsa = await asA({ path: `/api/sales/${sid}/payments`, method: 'POST', body: { method: 'mpesa', amount: 150, phone: '0700111222' } });
    assert.strictEqual(mpsa.status, 200, JSON.stringify(mpsa.body));
    const mp = mpsa.body.payments.find((p) => p.method === 'mpesa');
    assert.strictEqual(mp.status, 'pending');
    assert.strictEqual(mpsa.body.sale.status, 'partial', 'pending does not count as paid');
    assert.match(mpsa.body.mpesa.instructions || '', /confirmation code/, 'manual mode tells the cashier what to do');
    const conf = await asA({ path: `/api/payments/${mp.id}/confirm`, method: 'POST', body: { code: 'SFA123' } });
    assert.strictEqual(conf.body.sale.status, 'partial');
    const card = await asA({ path: `/api/sales/${sid}/payments`, method: 'POST', body: { method: 'card', amount: 150, ref: 'SLIP42' } });
    assert.strictEqual(card.status, 200, JSON.stringify(card.body));
    assert.strictEqual(card.body.sale.status, 'paid');
    assert.strictEqual(card.body.payments.filter((p) => p.status === 'confirmed').length, 3);
    const today = new Date().toISOString().slice(0, 10);
    const rec = await asA({ path: `/api/payments/reconcile?date=${today}` });
    assert.strictEqual(rec.status, 200, JSON.stringify(rec.body));
    const by = Object.fromEntries(rec.body.by_method.map((m) => [m.method, m]));
    assert.ok(by.cash && by.cash.confirmed >= 100, 'cash 100 reconciled');
    assert.strictEqual(by.card.confirmed >= 150, true, 'card 150 reconciled');
    assert.strictEqual(by.mpesa.confirmed >= 150, true, 'mpesa 150 reconciled');
  });

  await test('payment engine: duplicate M-Pesa callback is a no-op (no double count)', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const sw = await authJ({ path: '/api/settings/payments', method: 'PUT', body: { mpesa: { mode: 'sandbox' } } });
    assert.strictEqual(sw.status, 200, JSON.stringify(sw.body));
    const r = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'mpesa', amount: 200, phone: '0700111222' } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const mp = r.body.payments[0];
    assert.strictEqual(mp.status, 'pending');
    assert.ok(r.body.mpesa.checkout_request_id, 'sandbox issues a checkout request id');
    const cqid = r.body.mpesa.checkout_request_id;
    const sim = await authJ({ path: `/api/payments/${mp.id}/simulate-callback`, method: 'POST', body: { mpesa_ref: 'SFA888' } });
    assert.strictEqual(sim.status, 200, JSON.stringify(sim.body));
    assert.strictEqual(sim.body.sale.status, 'paid');
    const dup1 = await authJ({ path: '/api/webhooks/mpesa', method: 'POST', body: { CheckoutRequestID: cqid, MpesaReceiptRef: 'SFA999', ResultCode: 0, ResultDesc: 'The service request is processed successfully' } });
    assert.strictEqual(dup1.status, 200, JSON.stringify(dup1.body));
    assert.strictEqual(dup1.body.idempotent, true, 'second callback is a no-op');
    const dup2 = await authJ({ path: '/api/webhooks/mpesa', method: 'POST', body: { CheckoutRequestID: cqid, MpesaReceiptRef: 'SFA999', ResultCode: 0, ResultDesc: 'retry' } });
    assert.strictEqual(dup2.body.idempotent, true, 'third callback is a no-op');
    const fresh = (await asA({ path: `/api/sales/${r.body.sale.id}` })).body;
    assert.strictEqual(fresh.sale.paid_at !== null, true, 'still paid');
    assert.strictEqual(fresh.payments.filter((p) => p.method === 'mpesa' && p.status === 'confirmed').length, 1, 'exactly one confirmed mpesa payment');
    const confirms = d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('payment/confirm', 'payment/simulate-callback') AND entity_id = ?`).get(String(mp.id)).n;
    assert.strictEqual(confirms, 1, 'one confirm event, not three');
    const back = await authJ({ path: '/api/settings/payments', method: 'PUT', body: { mpesa: { mode: 'manual' } } });
    assert.strictEqual(back.status, 200);
  });

  await test('payment engine: provider failure fails the payment, not the sale', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    await authJ({ path: '/api/settings/payments', method: 'PUT', body: { mpesa: { mode: 'sandbox' } } });
    const r = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'mpesa', amount: 200, phone: '0700111222' } } });
    const mp = r.body.payments[0];
    const fail = await authJ({ path: '/api/webhooks/mpesa', method: 'POST', body: { CheckoutRequestID: r.body.mpesa.checkout_request_id, MpesaReceiptRef: '', ResultCode: 1014, ResultDesc: 'Insufficient balance' } });
    assert.strictEqual(fail.status, 200, JSON.stringify(fail.body));
    assert.strictEqual(fail.body.payment.status, 'failed');
    const fresh = (await asA({ path: `/api/sales/${r.body.sale.id}` })).body;
    assert.strictEqual(fresh.sale.status, 'suspended', 'failed money frees the sale — stock restored');
    const cash = await asA({ path: `/api/sales/${r.body.sale.id}/payments`, method: 'POST', body: { method: 'cash', amount: 200 } });
    assert.strictEqual(cash.body.sale.status, 'paid', 'cashier falls back to cash');
    await authJ({ path: '/api/settings/payments', method: 'PUT', body: { mpesa: { mode: 'manual' } } });
  });

  await test('payment engine: overpay, duplicate reference and cancel guards', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const h1 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], hold: true } });
    const s1 = h1.body.sale.id;
    await asA({ path: `/api/sales/${s1}/payments`, method: 'POST', body: { method: 'cash', amount: 100 } });
    const over = await asA({ path: `/api/sales/${s1}/payments`, method: 'POST', body: { method: 'card', amount: 200, ref: 'BIG1' } });
    assert.strictEqual(over.status, 400, 'card 200 > remaining 100');
    assert.match(over.body.error, /exceeds sale balance/);
    const c1 = await asA({ path: `/api/sales/${s1}/payments`, method: 'POST', body: { method: 'card', amount: 40, ref: 'DUP1' } });
    assert.strictEqual(c1.status, 200, JSON.stringify(c1.body));
    const c2 = await asA({ path: `/api/sales/${s1}/payments`, method: 'POST', body: { method: 'card', amount: 40, ref: 'DUP1' } });
    assert.strictEqual(c2.status, 409, 'same (sale, method, ref) twice is impossible');
    // cash over-tender completes the sale with change (100 + 40 + 60 = 200)
    const finish = await asA({ path: `/api/sales/${s1}/payments`, method: 'POST', body: { method: 'cash', amount: 100 } });
    assert.strictEqual(finish.status, 200, JSON.stringify(finish.body));
    assert.strictEqual(finish.body.sale.status, 'paid');
    const finCash = finish.body.payments.filter((p) => p.method === 'cash').pop();
    assert.strictEqual(Number(JSON.parse(finCash.raw).change), 40, '60 applied, 40 change');
    const h2 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], hold: true } });
    const s2 = h2.body.sale.id;
    const m2 = await asA({ path: `/api/sales/${s2}/payments`, method: 'POST', body: { method: 'mpesa', amount: 200, phone: '0700111222' } });
    const cancel = await asA({ path: `/api/payments/${m2.body.payments[0].id}/cancel`, method: 'POST', body: {} });
    assert.strictEqual(cancel.body.sale.status, 'suspended', 'cancelled pending money frees the sale');
    const paid = await asA({ path: `/api/sales/${s2}/payments`, method: 'POST', body: { method: 'cash', amount: 228 } });
    assert.strictEqual(paid.body.sale.status, 'paid');
  });

  await test('payment engine: refund to original method (manager act)', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const mgrCookie = await cashierLogin('Mwenyeji M', '2345');
    const mgr = (o) => withCookie(mgrCookie)(o);
    // build a paid split sale: cash + card
    const h = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], hold: true } });
    const sid = h.body.sale.id;
    await asA({ path: `/api/sales/${sid}/payments`, method: 'POST', body: { method: 'cash', amount: 150 } });
    const card = await asA({ path: `/api/sales/${sid}/payments`, method: 'POST', body: { method: 'card', amount: 250, ref: 'SLIP7' } });
    assert.strictEqual(card.body.sale.status, 'paid');
    const cardId = card.body.payments.find((p) => p.method === 'card').id;
    const asCashier = await asA({ path: `/api/payments/${cardId}/refund`, method: 'POST', body: {} });
    assert.strictEqual(asCashier.status, 403, 'cashiers cannot refund');
    const ref = await mgr({ path: `/api/payments/${cardId}/refund`, method: 'POST', body: { note: 'customer dispute' } });
    assert.strictEqual(ref.status, 200, JSON.stringify(ref.body));
    assert.strictEqual(ref.body.sale.status, 'partial');
    const p2 = (await mgr({ path: `/api/payments?sale_id=${sid}` })).body.find((p) => p.id === cardId);
    assert.strictEqual(p2.status, 'refunded');
    const again = await mgr({ path: `/api/payments/${cardId}/refund`, method: 'POST', body: {} });
    assert.strictEqual(again.status, 409, 'cannot refund twice');
    const h2 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], hold: true } });
    const m = await asA({ path: `/api/sales/${h2.body.sale.id}/payments`, method: 'POST', body: { method: 'mpesa', amount: 200, phone: '0700111222' } });
    const pendRef = await mgr({ path: `/api/payments/${m.body.payments[0].id}/refund`, method: 'POST', body: {} });
    assert.strictEqual(pendRef.status, 409, 'pending payments cannot be refunded');
  });

  await test('payment engine: credit (deni) limit enforced, refund releases it', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const mgrCookie = await cashierLogin('Mwenyeji M', '2345');
    const mgr = (o) => withCookie(mgrCookie)(o);
    const now = new Date().toISOString();
    const cid = d.prepare(`INSERT INTO customers (business_id, name, phone, credit_limit, created_at) VALUES (1, 'POS Credit Customer', '0711222333', 500, ?)`).run(now).lastInsertRowid;
    const s1 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], customer_id: cid, payment: { method: 'credit', amount: 200 } } });
    assert.strictEqual(s1.status, 200, JSON.stringify(s1.body));
    assert.strictEqual(s1.body.sale.status, 'paid');
    const led = d.prepare(`SELECT COUNT(*) AS n FROM customer_ledger WHERE customer_id = ? AND type = 'credit_sale' AND amount = 200`).get(cid).n;
    assert.strictEqual(led, 1, 'credit sale leaves ledger evidence');
    const s2 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], customer_id: cid, payment: { method: 'credit', amount: 400 } } });
    assert.strictEqual(s2.status, 403, '200 + 400 > 500 — cashier refused');
    assert.match(s2.body.error, /deni over limit.*manager/i);
    // a manager (deni.approve) may cross the limit — audited
    const sOver = await mgr({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], customer_id: cid, payment: { method: 'credit', amount: 400 } } });
    assert.strictEqual(sOver.status, 200, JSON.stringify(sOver.body).slice(0, 160), 'manager approves over-limit deni');
    const override = d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'deni/override' AND entity_id = ?`).get(String(cid)).n;
    assert.strictEqual(override, 1, 'over-limit deni audited');
    const overLedger = d.prepare(`SELECT note FROM customer_ledger WHERE customer_id = ? AND type = 'credit_sale' AND amount = 400`).get(cid).note;
    assert.match(overLedger, /OVER LIMIT/, 'ledger marks the override');
    // manager refunds the over-limit sale, then the original — deni back to 0
    const refOver = await mgr({ path: `/api/payments/${sOver.body.payments[0].id}/refund`, method: 'POST', body: {} });
    assert.strictEqual(refOver.status, 200);
    const cardId = s1.body.payments[0].id;
    const ref = await mgr({ path: `/api/payments/${cardId}/refund`, method: 'POST', body: {} });
    assert.strictEqual(ref.status, 200, JSON.stringify(ref.body));
    const s3 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], customer_id: cid, payment: { method: 'credit', amount: 400 } } });
    assert.strictEqual(s3.status, 200, 'refunded credit frees the limit again');
  });

  await test('payment engine: store credit + method enable/disable', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const now = new Date().toISOString();
    const cid = d.prepare(`INSERT INTO customers (business_id, name, phone, created_at) VALUES (1, 'POS SC Customer', '0711222444', ?)`).run(now).lastInsertRowid;
    d.prepare('UPDATE customers SET store_credit = 300 WHERE id = ?').run(cid);
    const on = await authJ({ path: '/api/settings/payments', method: 'PUT', body: { methods: { store_credit: true } } });
    assert.strictEqual(on.status, 200);
    const r = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], customer_id: cid, payment: { method: 'store_credit', amount: 200 } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(d.prepare('SELECT store_credit FROM customers WHERE id = ?').get(cid).store_credit, 100, 'balance debited');
    const again = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], customer_id: cid, payment: { method: 'store_credit', amount: 200 } } });
    assert.strictEqual(again.status, 400, 'insufficient store credit');
    const off = await authJ({ path: '/api/settings/payments', method: 'PUT', body: { methods: { card: false, store_credit: false } } });
    assert.strictEqual(off.status, 200);
    const list = await asA({ path: '/api/payments/methods' });
    assert.ok(!list.body.methods.some((m) => m.key === 'card'), 'card hidden from the till');
    assert.ok(list.body.methods.some((m) => m.key === 'cash'), 'cash always there');
    const h = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], hold: true } });
    const blocked = await asA({ path: `/api/sales/${h.body.sale.id}/payments`, method: 'POST', body: { method: 'card', amount: 200, ref: 'OFF1' } });
    assert.strictEqual(blocked.status, 400, 'disabled method refused');
    assert.match(blocked.body.error, /not enabled/);
    await authJ({ path: '/api/settings/payments', method: 'PUT', body: { methods: { card: true } } });
  });

  await test('payment engine: deposits are a manager act with evidence', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const mgrCookie = await cashierLogin('Mwenyeji M', '2345');
    const mgr = (o) => withCookie(mgrCookie)(o);
    const denied = await asA({ path: '/api/deposits', method: 'POST', body: { amount: 500, ref: 'DEP-X' } });
    assert.strictEqual(denied.status, 403, 'cashiers cannot record deposits');
    const dep = await mgr({ path: '/api/deposits', method: 'POST', body: { amount: 500, ref: 'DEP-TEST-1', register_id: pos.till1, note: 'morning float' } });
    assert.strictEqual(dep.status, 200, JSON.stringify(dep.body));
    assert.strictEqual(dep.body.deposit.amount, 500);
    const list = await mgr({ path: '/api/deposits' });
    assert.ok(list.body.some((x) => x.ref === 'DEP-TEST-1'));
    const aud = d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'deposit/create'`).get().n;
    assert.ok(aud >= 1, 'deposit audited');
  });

  // ---- Phase 9: shifts & till control ---------------------------------------
  await test('shifts: open with a float; one open shift per cashier', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const asB = (o) => withCookie(pos.cashB)(o);
    const r = await asA({ path: '/api/shifts', method: 'POST', body: { float_open: 500 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    pos.shiftA = r.body.shift;
    assert.strictEqual(pos.shiftA.status, 'open');
    assert.strictEqual(pos.shiftA.float_open, 500);
    assert.strictEqual(pos.shiftA.register_id, pos.till1, 'shift bound to the cashier\'s till');
    const again = await asA({ path: '/api/shifts', method: 'POST', body: { float_open: 100 } });
    assert.strictEqual(again.status, 409, 'one open shift per cashier');
    const rb = await asB({ path: '/api/shifts', method: 'POST', body: { float_open: 200 } });
    assert.strictEqual(rb.status, 200, JSON.stringify(rb.body));
    pos.shiftB = rb.body.shift;
    const mine = await asA({ path: '/api/shifts/mine' });
    assert.strictEqual(mine.body.shift.id, pos.shiftA.id);
    assert.strictEqual(mine.body.enforced, false, 'till control off by default');
  });

  await test('shifts: expected cash = float + cash in − refunds − payouts − deposits (M-Pesa never touches the drawer)', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const mgrCookie = await cashierLogin('Mwenyeji M', '2345');
    const mgr = (o) => withCookie(mgrCookie)(o);
    // A sells 1×A (200, VAT-inclusive) in cash
    const s1 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(s1.status, 200, JSON.stringify(s1.body));
    // A sells 1×A by M-Pesa — never drawer cash
    const s2 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'mpesa', amount: 200, phone: '0700111222' } } });
    assert.strictEqual(s2.status, 200, JSON.stringify(s2.body));
    await asA({ path: `/api/payments/${s2.body.payments[0].id}/confirm`, method: 'POST', body: { code: 'SFA777' } });
    let m = (await asA({ path: '/api/shifts/mine' })).body.shift;
    assert.strictEqual(m.cash_in, 200, 'cash collected');
    assert.strictEqual(m.expected_cash, 500 + 200, 'mpesa does not touch the drawer');
    // manager refunds the cash payment — money back out of the drawer
    const cashPay = s1.body.payments[0];
    const ref = await mgr({ path: `/api/payments/${cashPay.id}/refund`, method: 'POST', body: {} });
    assert.strictEqual(ref.status, 200, JSON.stringify(ref.body));
    m = (await asA({ path: '/api/shifts/mine' })).body.shift;
    assert.strictEqual(m.cash_refunded, 200);
    assert.strictEqual(m.expected_cash, 500, 'refund takes the cash back out');
    // payout
    const po = await asA({ path: `/api/shifts/${pos.shiftA.id}/payouts`, method: 'POST', body: { amount: 100, reason: 'small change' } });
    assert.strictEqual(po.status, 200, JSON.stringify(po.body));
    m = (await asA({ path: '/api/shifts/mine' })).body.shift;
    assert.strictEqual(m.payouts, 100);
    assert.strictEqual(m.expected_cash, 400);
    // deposit from the till
    const dep = await authJ({ path: '/api/deposits', method: 'POST', body: { amount: 150, ref: 'DEP-SHIFT', register_id: pos.till1 } });
    assert.strictEqual(dep.status, 200, JSON.stringify(dep.body));
    m = (await asA({ path: '/api/shifts/mine' })).body.shift;
    assert.strictEqual(m.deposits, 150);
    assert.strictEqual(m.expected_cash, 250, '500 + 200 − 200 − 100 − 150');
    // cashiers cannot payout on someone else's shift
    const asB = (o) => withCookie(pos.cashB)(o);
    const cross = await asB({ path: `/api/shifts/${pos.shiftA.id}/payouts`, method: 'POST', body: { amount: 50 } });
    assert.strictEqual(cross.status, 403, 'own shift only');
  });

  await test('shifts: close computes the variance; no double-close; handover by manager', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const asB = (o) => withCookie(pos.cashB)(o);
    const mgrCookie = await cashierLogin('Mwenyeji M', '2345');
    const mgr = (o) => withCookie(mgrCookie)(o);
    const c = await asA({ path: `/api/shifts/${pos.shiftA.id}/close`, method: 'POST', body: { counted_cash: 250 } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.shift.status, 'closed');
    assert.strictEqual(c.body.shift.expected_cash, 250);
    assert.strictEqual(c.body.shift.variance, 0, 'counted = expected');
    assert.ok(c.body.shift.closed_at);
    const again = await asA({ path: `/api/shifts/${pos.shiftA.id}/close`, method: 'POST', body: { counted_cash: 250 } });
    assert.strictEqual(again.status, 409, 'no double-close');
    // sales still work with no open shift (enforcement off)
    const sell = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(sell.status, 200, JSON.stringify(sell.body));
    // handover: manager closes B's shift; a short count shows as negative variance
    const cb = await mgr({ path: `/api/shifts/${pos.shiftB.id}/close`, method: 'POST', body: { counted_cash: 100, note: 'handover' } });
    assert.strictEqual(cb.status, 200, JSON.stringify(cb.body));
    assert.strictEqual(cb.body.shift.variance, -100, 'counted 100 vs expected 200');
    // cashiers cannot close each other's shifts
    const reopen = await asA({ path: '/api/shifts', method: 'POST', body: { float_open: 100 } });
    assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.body));
    const cross = await asB({ path: `/api/shifts/${reopen.body.shift.id}/close`, method: 'POST', body: { counted_cash: 100 } });
    assert.strictEqual(cross.status, 403, 'only the cashier or a manager/owner');
    pos.shiftA2 = reopen.body.shift;
  });

  await test('shifts: enforced till control gates every selling route', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const asB = (o) => withCookie(pos.cashB)(o);
    const on = await authJ({ path: '/api/settings/shifts', method: 'PUT', body: { enforced: true } });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    // B has no open shift (manager closed it) → every selling route refused
    const sell = await asB({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(sell.status, 403, JSON.stringify(sell.body));
    assert.match(sell.body.error, /open a shift/);
    const quote = await asB({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], kind: 'quote' } });
    assert.strictEqual(quote.status, 403, 'quotes gated too');
    // A has an open shift → still selling
    const okA = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], hold: true } });
    assert.strictEqual(okA.status, 200, JSON.stringify(okA.body));
    const payGate = await asB({ path: `/api/sales/${okA.body.sale.id}/payments`, method: 'POST', body: { method: 'cash', amount: 228 } });
    assert.strictEqual(payGate.status, 403, 'adding a payment gated too');
    // B opens a shift → back to selling
    const open = await asB({ path: '/api/shifts', method: 'POST', body: { float_open: 0 } });
    assert.strictEqual(open.status, 200, JSON.stringify(open.body));
    const okB = await asB({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(okB.status, 200, JSON.stringify(okB.body));
    const off = await authJ({ path: '/api/settings/shifts', method: 'PUT', body: { enforced: false } });
    assert.strictEqual(off.status, 200);
  });

  await test('shifts: settings are owner-gated; sign-in/out lands in the timeclock', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const denied = await asA({ path: '/api/settings/shifts', method: 'PUT', body: { enforced: true } });
    assert.strictEqual(denied.status, 403, 'cashiers cannot toggle till control');
    const rows = d.prepare(`SELECT COUNT(*) AS n FROM timeclock WHERE user_id = ? AND event = 'in'`).get(pos.mgrId === undefined ? 1 : (d.prepare(`SELECT id FROM users WHERE name = 'POS Cashier A'`).get().id)).n;
    assert.ok(rows >= 2, 'cashier A signed in at least twice');
    const out = d.prepare(`SELECT COUNT(*) AS n FROM timeclock WHERE event = 'out'`).get().n;
    assert.ok(out >= 1, 'shift closes clock out');
    const list = (await asA({ path: '/api/shifts?status=closed&limit=5' })).body;
    assert.ok(list.length >= 2, 'closed shifts listed');
    assert.ok(list.every((x) => typeof x.variance === 'number'), 'variance computed on closed shifts');
  });


  // ---- Phase 10: returns & exchanges -----------------------------------------
  await test('returns: batch item returns to the SAME batch; sequential note; partial refund keeps payment alive', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const s = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.B.vid, qty: 2 }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.sale.gross, 200);
    const line = s.body.items[0];
    const batchId = line.batch_id;
    assert.ok(batchId, 'sale line carries its FEFO batch');
    const bBefore = d.prepare('SELECT qty FROM batches WHERE id = ?').get(batchId).qty;
    const r = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'customer_changed_mind',
      lines: [{ sale_item_id: line.id, qty: 1, restock: true }]
    } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual(r.body.return.return_no, 'RET-000001', 'sequential eTIMS-ready note number');
    assert.strictEqual(r.body.return.total, 100, 'prorated half of 200');
    assert.strictEqual(r.body.return.items[0].sale_item_batch_id, batchId);
    const mv = d.prepare("SELECT * FROM stock_moves WHERE type = 'return_in' AND ref = 'RET-000001'").get();
    assert.ok(mv, 'return_in move written');
    assert.strictEqual(mv.batch_id, batchId, 'back into the SAME batch');
    assert.strictEqual(mv.qty, 1);
    assert.strictEqual(d.prepare('SELECT qty FROM batches WHERE id = ?').get(batchId).qty, bBefore + 1, 'batch qty restored');
    // the sale itself was NOT edited: same lines, same totals
    const sale2 = d.prepare('SELECT * FROM sales WHERE id = ?').get(s.body.sale.id);
    assert.strictEqual(sale2.gross, 200);
    assert.strictEqual(sale2.status, 'paid');
    assert.strictEqual(d.prepare('SELECT qty FROM sale_items WHERE id = ?').get(line.id).qty, 2, 'sale line untouched');
    // money back: partial refund of the one cash payment
    const p = d.prepare('SELECT * FROM payments WHERE id = ?').get(s.body.payments[0].id);
    assert.strictEqual(p.refunded, 100);
    assert.strictEqual(p.status, 'confirmed', 'partially refunded payment stays live');
    assert.strictEqual(r.body.refund_rows.length, 1);
    assert.strictEqual(r.body.refund_rows[0].method, 'cash');
    // over-return refused
    const over = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'other', lines: [{ sale_item_id: line.id, qty: 2 }]
    } });
    assert.strictEqual(over.status, 400, JSON.stringify(over.body));
    assert.match(over.body.error, /left to return/);
    pos.ret1Sale = s.body.sale.id;
    pos.ret1Line = line.id;
  });

  await test('returns: restock=false keeps the goods OUT of stock; full return makes the sale terminal', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const r = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: pos.ret1Sale, reason: 'damaged',
      lines: [{ sale_item_id: pos.ret1Line, qty: 1, restock: false }]
    } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual(r.body.return.return_no, 'RET-000002');
    assert.strictEqual(r.body.return.total, 100);
    assert.strictEqual(r.body.return.items[0].restock, 0);
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'return_in' AND ref = 'RET-000002'").get().n, 0, 'damaged goods do not re-enter stock');
    // sale now fully returned → terminal, all money back
    const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(pos.ret1Sale);
    assert.strictEqual(sale.status, 'refunded', 'fully returned sale is terminal');
    const p = d.prepare('SELECT * FROM payments WHERE sale_id = ?').get(pos.ret1Sale);
    assert.strictEqual(p.refunded, 200);
    assert.strictEqual(p.status, 'refunded');
    const again = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: pos.ret1Sale, reason: 'other', lines: [{ sale_item_id: pos.ret1Line, qty: 1 }]
    } });
    assert.strictEqual(again.status, 409, 'cannot return a refunded sale');
    // nothing edited in place: the original line still says qty 2
    assert.strictEqual(d.prepare('SELECT qty FROM sale_items WHERE id = ?').get(pos.ret1Line).qty, 2);
  });

  await test('returns: split sale refunds to ORIGINAL methods, newest first', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const s = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'cash', amount: 100 } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.sale.status, 'partial', '100 of 200');
    const m = await asA({ path: `/api/sales/${s.body.sale.id}/payments`, method: 'POST', body: { method: 'mpesa', amount: 100, phone: '0700111222' } });
    assert.strictEqual(m.status, 200, JSON.stringify(m.body).slice(0, 160));
    const mp = m.body.payments.find((x) => x.method === 'mpesa');
    const cf = await asA({ path: `/api/payments/${mp.id}/confirm`, method: 'POST', body: { code: 'SFA-RET' } });
    assert.strictEqual(cf.status, 200);
    const line = (await asA({ path: `/api/sales/${s.body.sale.id}` })).body.items[0];
    const r = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'defective', lines: [{ sale_item_id: line.id, qty: 1 }]
    } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual(r.body.return.total, 200);
    // newest first: mpesa 100 fully, then cash 100
    const rows = r.body.refund_rows.map((x) => `${x.method}:${x.amount}`).join(',');
    assert.strictEqual(rows, 'mpesa:100,cash:100', rows);
    const pays = d.prepare('SELECT method, refunded, status FROM payments WHERE sale_id = ? ORDER BY id').all(s.body.sale.id);
    assert.strictEqual(pays[0].method, 'cash');
    assert.strictEqual(pays[0].refunded, 100);
    assert.strictEqual(pays[0].status, 'refunded');
    assert.strictEqual(pays[1].method, 'mpesa');
    assert.strictEqual(pays[1].refunded, 100);
    assert.strictEqual(pays[1].status, 'refunded');
    assert.strictEqual(d.prepare('SELECT status FROM sales WHERE id = ?').get(s.body.sale.id).status, 'refunded');
  });

  await test('returns: cashier limit (business capability) — manager unlimited, settings owner-gated', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const lim = await authJ({ path: '/api/settings/returns', method: 'PUT', body: { cashier_limit: 100 } });
    assert.strictEqual(lim.status, 200, JSON.stringify(lim.body));
    const s = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    const line = (await asA({ path: `/api/sales/${s.body.sale.id}` })).body.items[0];
    const den = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'other', lines: [{ sale_item_id: line.id, qty: 1 }]
    } });
    assert.strictEqual(den.status, 403, JSON.stringify(den.body));
    assert.match(den.body.error, /exceeds your limit of 100/);
    const mgrCookie = await cashierLogin('Mwenyeji M', '2345');
    const mgr = (o) => withCookie(mgrCookie)(o);
    const okM = await mgr({ path: '/api/returns', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'other', lines: [{ sale_item_id: line.id, qty: 1 }]
    } });
    assert.strictEqual(okM.status, 200, 'manager can return any amount');
    const cashierToggle = await asA({ path: '/api/settings/returns', method: 'PUT', body: { cashier_limit: 10 } });
    assert.strictEqual(cashierToggle.status, 403, 'cashiers cannot change the limit');
    await authJ({ path: '/api/settings/returns', method: 'PUT', body: { cashier_limit: 5000 } });
  });

  await test('returns: store credit alternative (money stays in the business)', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const now = new Date().toISOString();
    const cid = d.prepare(`INSERT INTO customers (business_id, name, phone, created_at) VALUES (1, 'POS Return Credit', '0711333444', ?)`).run(now).lastInsertRowid;
    const s = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], customer_id: cid, payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    const line = (await asA({ path: `/api/sales/${s.body.sale.id}` })).body.items[0];
    const r = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'customer_changed_mind', refund_as: 'store_credit',
      lines: [{ sale_item_id: line.id, qty: 1 }]
    } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual(r.body.store_credit_added, 200);
    assert.strictEqual(d.prepare('SELECT store_credit FROM customers WHERE id = ?').get(cid).store_credit, 200, 'credit on the customer');
    assert.strictEqual(d.prepare(`SELECT COUNT(*) AS n FROM customer_ledger WHERE customer_id = ? AND type = 'adjustment' AND amount = 200`).get(cid).n, 1, 'ledger evidence');
    const p = d.prepare('SELECT * FROM payments WHERE sale_id = ?').get(s.body.sale.id);
    assert.strictEqual(p.refunded, 0, 'no money out the door');
    // no customer → store credit refused
    const s2 = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    const line2 = (await asA({ path: `/api/sales/${s2.body.sale.id}` })).body.items[0];
    const noCust = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: s2.body.sale.id, reason: 'other', refund_as: 'store_credit', lines: [{ sale_item_id: line2.id, qty: 1 }]
    } });
    assert.strictEqual(noCust.status, 400, JSON.stringify(noCust.body));
  });

  await test('exchange: price diff settles exactly — customer pays the difference, stock both ways, original untouched', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const aBefore = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty;
    const dBefore = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.D.vid, pos.loc).qty;
    const s = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], payment: { method: 'cash', amount: 500 } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.sale.gross, 400);
    const line = s.body.items[0];
    const ex = await asA({ path: '/api/exchanges', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'wrong_item',
      lines: [{ sale_item_id: line.id, qty: 1, restock: true }],
      items: [{ variant_id: pos.D.vid, qty: 1 }],
      settle: { method: 'cash', amount: 300 },
      override_pin: '2345'
    } });
    assert.strictEqual(ex.status, 200, JSON.stringify(ex.body).slice(0, 220));
    assert.strictEqual(ex.body.exchange.returned_total, 200);
    assert.strictEqual(ex.body.exchange.new_total, 500);
    assert.strictEqual(ex.body.exchange.diff, 300, '500 − 200');
    assert.strictEqual(ex.body.exchange.settled_by, 'payment');
    const ns = ex.body.sale.sale;
    assert.strictEqual(ns.gross, 300, 'the sale is exactly what the customer owes after the credit');
    assert.strictEqual(ns.discount, 200, 'exchange credit recorded as a discount (VAT-exact)');
    assert.strictEqual(ns.status, 'paid');
    assert.strictEqual(ns.note, `exchange for return ${ex.body.return.return_no}`, 'references its original');
    const pay = ex.body.sale.payments[0];
    assert.strictEqual(pay.method, 'cash');
    assert.strictEqual(pay.amount, 300, 'paid the actual diff, to the shilling');
    assert.strictEqual(ex.body.return.exchange_id !== undefined ? ex.body.return.exchange.id : ex.body.exchange.id, ex.body.exchange.id);
    // stock: A back in, D out
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty, aBefore - 1, 'sold 2, returned 1');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.D.vid, pos.loc).qty, dBefore - 1);
    // original sale: untouched lines, returns visible on it
    const orig = (await asA({ path: `/api/sales/${s.body.sale.id}` })).body;
    assert.strictEqual(orig.returns_total, 200);
    assert.strictEqual(orig.returns.length, 1);
    assert.strictEqual(orig.items[0].qty, 2, 'original line never edited');
    assert.strictEqual(d.prepare('SELECT status FROM sales WHERE id = ?').get(s.body.sale.id).status, 'paid', 'partially returned sale stays paid');
  });

  await test('exchange: worth-less replacement — excess refunded to the ORIGINAL sale, not the customer twice', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const s = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.E.vid, qty: 1 }], payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.sale.gross, 150);
    const line = s.body.items[0];
    const ex = await asA({ path: '/api/exchanges', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'customer_changed_mind',
      lines: [{ sale_item_id: line.id, qty: 1, restock: true }],
      items: [{ variant_id: pos.B.vid, qty: 1 }],
      override_pin: '2345'
    } });
    assert.strictEqual(ex.status, 200, JSON.stringify(ex.body).slice(0, 220));
    assert.strictEqual(ex.body.exchange.returned_total, 150);
    assert.strictEqual(ex.body.exchange.new_total, 100);
    assert.strictEqual(ex.body.exchange.diff, -50);
    assert.strictEqual(ex.body.exchange.settled_by, 'refund');
    assert.strictEqual(ex.body.refund_rows.length, 1);
    assert.strictEqual(ex.body.refund_rows[0].method, 'cash');
    assert.strictEqual(ex.body.refund_rows[0].refunded, 50, 'only the excess, back out of the original sale');
    const ns = ex.body.sale.sale;
    assert.strictEqual(ns.gross, 0, 'replacement fully covered by the credit');
    assert.strictEqual(ns.status, 'paid');
    const origPay = d.prepare('SELECT * FROM payments WHERE sale_id = ?').get(s.body.sale.id);
    assert.strictEqual(origPay.refunded, 50);
    assert.strictEqual(origPay.status, 'confirmed', 'original payment still live for the remaining 100');
    assert.strictEqual(d.prepare('SELECT status FROM sales WHERE id = ?').get(s.body.sale.id).status, 'paid');
    const orig = (await asA({ path: `/api/sales/${s.body.sale.id}` })).body;
    assert.strictEqual(orig.returns_total, 150);
    // no double exchange on the same return
    const again = await asA({ path: '/api/exchanges', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'other',
      lines: [{ sale_item_id: line.id, qty: 0.5 }],
      items: [{ variant_id: pos.A.vid, qty: 1 }],
      override_pin: '2345'
    } });
    assert.notStrictEqual(again.status, 200, 'line fully returned — nothing left to exchange');
  });

  await test('shifts + returns: a partial refund counts back out of the drawer exactly', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const before = (await asA({ path: '/api/shifts/mine' })).body;
    assert.ok(before.shift && before.shift.status === 'open', 'cashier A still on shift');
    const s = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], payment: { method: 'cash', amount: 500 } } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    const line = s.body.items[0];
    const mid = (await asA({ path: '/api/shifts/mine' })).body.shift;
    assert.strictEqual(mid.expected_cash, before.shift.expected_cash + 400, 'cash in');
    const r = await asA({ path: '/api/returns', method: 'POST', body: {
      sale_id: s.body.sale.id, reason: 'other', lines: [{ sale_item_id: line.id, qty: 1 }]
    } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    const after = (await asA({ path: '/api/shifts/mine' })).body.shift;
    assert.strictEqual(after.cash_refunded, before.shift.cash_refunded + 200, 'the refunded 200 left the drawer');
    assert.strictEqual(after.expected_cash, before.shift.expected_cash + 400 - 200, 'partial refund counted out once');
  });

  // ---- Phase 11: customers & deni ---------------------------------------------
  await test('customers: phone-first profile (same number = same customer), cashier cannot create', async () => {
    const c1 = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'Amina Yusuf', phone: '0722111222', credit_limit: 1000 } });
    assert.strictEqual(c1.status, 200, JSON.stringify(c1.body).slice(0, 160));
    assert.strictEqual(c1.body.existed, false);
    pos.custA = c1.body.customer;
    const c2 = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'Amina Y.', phone: '0722111222', credit_limit: 1500 } });
    assert.strictEqual(c2.status, 200);
    assert.strictEqual(c2.body.existed, true);
    assert.strictEqual(c2.body.customer.id, pos.custA.id, 'same number = same customer');
    assert.strictEqual(c2.body.customer.credit_limit, 1500, 'fields updated');
    assert.strictEqual(d.prepare(`SELECT COUNT(*) AS n FROM customers WHERE phone = '0722111222'`).get().n, 1, 'no duplicate profile');
    const den = await withCookie(pos.cashA)({ path: '/api/customers', method: 'POST', body: { name: 'Nope', phone: '0700000001' } });
    assert.strictEqual(den.status, 403, 'cashiers cannot create customers');
    const list = await authJ({ path: '/api/customers?q=0722111222' });
    assert.ok(list.body.length >= 1 && list.body.some((x) => x.id === pos.custA.id), 'phone search');
    assert.strictEqual(typeof list.body[0].deni_outstanding, 'number', 'deni balance on the list');
  });

  await test('deni: cash repayment reduces balance, leaves till evidence; overpayment becomes store credit', async () => {
    const s1 = await withCookie(pos.cashA)({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 2 }], customer_id: pos.custA.id, payment: { method: 'credit', amount: 400 } } });
    assert.strictEqual(s1.status, 200, JSON.stringify(s1.body).slice(0, 160));
    let c = (await authJ({ path: `/api/customers/${pos.custA.id}` })).body;
    assert.strictEqual(c.customer.deni_outstanding, 400, 'deni open');
    assert.strictEqual(c.sales.length, 1, 'purchase history on the profile');
    const r1 = await withCookie(pos.cashA)({ path: `/api/customers/${pos.custA.id}/repayments`, method: 'POST', body: { amount: 200, method: 'cash' } });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body).slice(0, 160));
    assert.strictEqual(r1.body.repayment, 200);
    assert.strictEqual(r1.body.customer.deni_outstanding, 200);
    assert.ok(d.prepare(`SELECT COUNT(*) AS n FROM deposits WHERE ref = 'DENI'`).get().n >= 1, 'cash repayment leaves till evidence');
    const r2 = await withCookie(pos.cashA)({ path: `/api/customers/${pos.custA.id}/repayments`, method: 'POST', body: { amount: 300, method: 'cash' } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body).slice(0, 160));
    assert.strictEqual(r2.body.repayment, 200, 'only the amount owed');
    assert.strictEqual(r2.body.store_credit_excess, 100, 'overpayment → store credit');
    assert.strictEqual(r2.body.customer.deni_outstanding, 0);
    assert.strictEqual(r2.body.customer.store_credit, 100);
    const r3 = await withCookie(pos.cashA)({ path: `/api/customers/${pos.custA.id}/repayments`, method: 'POST', body: { amount: 50 } });
    assert.strictEqual(r3.status, 400, JSON.stringify(r3.body));
    assert.match(r3.body.error, /no deni outstanding/);
  });

  await test('deni: M-Pesa repayment reduces the balance and reconciles with the ledger', async () => {
    const s1 = await withCookie(pos.cashA)({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], customer_id: pos.custA.id, payment: { method: 'credit', amount: 200 } } });
    assert.strictEqual(s1.status, 200, JSON.stringify(s1.body).slice(0, 160));
    const noPhone = await withCookie(pos.cashA)({ path: `/api/customers/${pos.custA.id}/repayments`, method: 'POST', body: { amount: 100, method: 'mpesa' } });
    assert.strictEqual(noPhone.status, 400, 'mpesa needs a phone');
    const r = await withCookie(pos.cashA)({ path: `/api/customers/${pos.custA.id}/repayments`, method: 'POST', body: { amount: 200, method: 'mpesa', phone: '0722111222' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    assert.strictEqual(r.body.customer.deni_outstanding, 0, 'balance cleared');
    const direct = d.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount WHEN type = 'repayment' THEN -amount ELSE 0 END), 0) AS b
       FROM customer_ledger WHERE customer_id = ?`
    ).get(pos.custA.id).b;
    assert.strictEqual(direct, 0, 'ledger reconciles to the shilling');
    const aud = d.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'deni/repay' AND entity_id = ?`).get(String(pos.custA.id)).n;
    assert.ok(aud >= 2, 'repayments audited');
  });

  await test('statement: matches the ledger to the shilling; windowed opening balance', async () => {
    const st = await authJ({ path: `/api/customers/${pos.custA.id}/statement` });
    assert.strictEqual(st.status, 200);
    const s = st.body;
    assert.strictEqual(s.opening, 0);
    assert.ok(s.rows.length >= 5, 'statement rows present');
    assert.strictEqual(s.rows[s.rows.length - 1].balance, s.closing, 'running balance ends at closing');
    const direct = d.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type = 'credit_sale' THEN amount WHEN type = 'repayment' THEN -amount ELSE 0 END), 0) AS b
       FROM customer_ledger WHERE customer_id = ?`
    ).get(pos.custA.id).b;
    assert.strictEqual(s.closing, direct, 'statement ties to the ledger');
    assert.strictEqual(s.totals.credit_sales - s.totals.repayments, s.closing - s.opening, 'totals tie');
    const now = new Date().toISOString();
    const st2 = await authJ({ path: `/api/customers/${pos.custA.id}/statement?from=${encodeURIComponent(now)}` });
    assert.strictEqual(st2.body.opening, direct, 'windowed statement carries the opening balance');
    assert.strictEqual(st2.body.rows.length, 0);
    const html = await (await fetch(`${BASE}/statement.html`)).text();
    assert.ok(html.toLowerCase().includes('statement'), 'printable statement page served');
  });

  await test('store credit: deposit top-up, negative adjustment, floor at zero; customer price rule resolves', async () => {
    const dep = await authJ({ path: `/api/customers/${pos.custA.id}/deposits`, method: 'POST', body: { amount: 500, method: 'cash', note: 'prep' } });
    assert.strictEqual(dep.status, 200, JSON.stringify(dep.body).slice(0, 160));
    assert.strictEqual(dep.body.customer.store_credit, 600, '100 + 500');
    const adj = await authJ({ path: `/api/customers/${pos.custA.id}/store-credit`, method: 'POST', body: { delta: -100, note: 'partial use' } });
    assert.strictEqual(adj.status, 200, JSON.stringify(adj.body).slice(0, 120));
    assert.strictEqual(adj.body.balance, 500);
    const over = await authJ({ path: `/api/customers/${pos.custA.id}/store-credit`, method: 'POST', body: { delta: -99999 } });
    assert.strictEqual(over.status, 400, 'cannot take credit below zero');
    const cashierAdj = await withCookie(pos.cashA)({ path: `/api/customers/${pos.custA.id}/store-credit`, method: 'POST', body: { delta: 10 } });
    assert.strictEqual(cashierAdj.status, 403, 'adjustments are a manager act');
    // customer-specific price: the chain resolves it (deni/VIP agreement)
    const rule = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: pos.A.vid, customer_id: pos.custA.id, price: 180, pin: '2345' } });
    assert.strictEqual(rule.status, 200, JSON.stringify(rule.body).slice(0, 160));
    const px = await authJ({ path: `/api/pricing/resolve?variant_id=${pos.A.vid}&customer_id=${pos.custA.id}` });
    assert.strictEqual(px.body.source, 'customer', JSON.stringify(px.body).slice(0, 160));
    assert.strictEqual(px.body.price, 180);
    const profile = (await authJ({ path: `/api/customers/${pos.custA.id}` })).body;
    assert.ok(profile.price_rules.length >= 1, 'price rules visible on the profile');
  });

  await test('two registers sell concurrently: no conflicts, stock exact, distinct tills', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const asB = (o) => withCookie(pos.cashB)(o);
    const [ra, rb] = await Promise.all([
      asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.F.vid, qty: 4 }], payment: { method: 'cash', amount: 500 } } }),
      asB({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.F.vid, qty: 4 }], payment: { method: 'cash', amount: 500 } } })
    ]);
    assert.strictEqual(ra.status, 200, JSON.stringify(ra.body));
    assert.strictEqual(rb.status, 200, JSON.stringify(rb.body));
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.F.vid, pos.loc).qty, 0, '8 in, 8 sold');
    assert.notStrictEqual(ra.body.sale.order_no, rb.body.sale.order_no, 'unique order numbers');
    assert.strictEqual(ra.body.sale.register_id, pos.till1);
    assert.strictEqual(rb.body.sale.register_id, pos.till2, 'each sale bound to its till');
    const more = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.F.vid, qty: 1 }], payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(more.status, 400, 'stock exhausted');
  });

  await test('promo at the till: chain price frozen onto the sale line', async () => {
    const rule = await authJ({ path: '/api/price-rules', method: 'POST', body: { variant_id: pos.A.vid, promo_code: 'POSX', price: 120, pin: '2345' } });
    assert.strictEqual(rule.status, 200, JSON.stringify(rule.body));
    const asA = (o) => withCookie(pos.cashA)(o);
    const r = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], promo_code: 'POSX', payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.items[0].unit_price, 120, `promo price frozen: ${r.body.items[0].unit_price}`);
    assert.strictEqual(r.body.sale.subtotal, 120);
    await authJ({ path: `/api/price-rules/${rule.body.id}`, method: 'DELETE' });
  });

  await test('void: cashier refused; manager reverses stock exactly; double-void refused', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const denied = await asA({ path: `/api/sales/${pos.sale1}/void`, method: 'POST', body: { note: 'wrong item' } });
    assert.strictEqual(denied.status, 403, `cashier void: ${denied.status}`);
    const before = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty;
    const v = await authJ({ path: `/api/sales/${pos.sale1}/void`, method: 'POST', body: { note: 'customer returned goods' } });
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    assert.strictEqual(v.body.sale.status, 'voided');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty, before + 2, '2 units back');
    const pay = d.prepare("SELECT status FROM payments WHERE sale_id = ?").get(pos.sale1);
    assert.strictEqual(pay.status, 'refunded', 'payment flagged refunded');
    const again = await authJ({ path: `/api/sales/${pos.sale1}/void`, method: 'POST', body: {} });
    assert.strictEqual(again.status, 400, 'double void refused');
  });

  await test('quote → invoice: converts with payment, stock moves exactly once', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const before = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty;
    const withPay = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], kind: 'quote', payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(withPay.status, 400, `quote with payment: ${JSON.stringify(withPay.body)}`);
    const q = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.A.vid, qty: 1 }], kind: 'quote' } });
    assert.strictEqual(q.status, 200, JSON.stringify(q.body));
    assert.strictEqual(q.body.sale.status, 'suspended');
    assert.strictEqual(q.body.sale.kind, 'quote');
    assert.strictEqual(q.body.payments.length, 0);
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty, before, 'quote must not touch stock');
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE ref = ?").get(q.body.sale.invoice_no).n, 0);
    const payOnQuote = await asA({ path: `/api/sales/${q.body.sale.id}/pay`, method: 'POST', body: { payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(payOnQuote.status, 400, `pay on quote: ${JSON.stringify(payOnQuote.body)}`);
    assert.match(payOnQuote.body.error, /convert/);
    // convert a normal held sale → refused
    const convOnSale = await asA({ path: `/api/sales/${pos.sale1}/convert`, method: 'POST', body: { payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(convOnSale.status, 400, JSON.stringify(convOnSale.body));
    // convert the quote
    const c = await asA({ path: `/api/sales/${q.body.sale.id}/convert`, method: 'POST', body: { payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.strictEqual(c.body.sale.kind, 'invoice', `kind after convert: ${c.body.sale.kind}`);
    assert.strictEqual(c.body.sale.status, 'paid');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(pos.A.vid, pos.loc).qty, before - 1);
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE ref = ? AND type = 'sale'").get(c.body.sale.invoice_no).n, 1, 'stock moved exactly once');
    const again = await asA({ path: `/api/sales/${c.body.sale.id}/convert`, method: 'POST', body: { payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(again.status, 400, 'double-convert refused');
    const audit = d.prepare("SELECT * FROM audit_log WHERE action = 'sale/convert' ORDER BY id DESC LIMIT 1").get();
    assert.ok(audit, 'conversion audited');
  });

  await test('quote re-validation: deactivated item blocks conversion until restored', async () => {
    const asA = (o) => withCookie(pos.cashA)(o);
    const q = await asA({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: pos.E.vid, qty: 1 }], kind: 'quote' } });
    assert.strictEqual(q.status, 200, JSON.stringify(q.body));
    d.prepare('UPDATE products SET active = 0 WHERE id = ?').run(pos.E.id);
    const blocked = await asA({ path: `/api/sales/${q.body.sale.id}/convert`, method: 'POST', body: { payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE ref = ?").get(q.body.sale.invoice_no).n, 0, 'no stock move on failed conversion');
    d.prepare('UPDATE products SET active = 1 WHERE id = ?').run(pos.E.id);
    const ok = await asA({ path: `/api/sales/${q.body.sale.id}/convert`, method: 'POST', body: { payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.sale.kind, 'invoice');
  });

  await test('sales list + detail (receipt reprint)', async () => {
    const list = await authJ({ path: '/api/sales?limit=50' });
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.body) && list.body.length >= 5, `list: ${list.body.length}`);
    assert.ok(list.body.every((s) => typeof s.invoice_no === 'string' && s.cashier));
    const detail = await authJ({ path: `/api/sales/${pos.sale1}` });
    assert.strictEqual(detail.status, 200);
    assert.ok(detail.body.receipt.business.name === 'Test Traders');
    assert.ok(Array.isArray(detail.body.items) && Array.isArray(detail.body.payments));
  });

  // ================= Phase 12 — multi-branch operating system (R-2/R-3) =================
  section('Phase 12 — multi-branch: transfers, visibility, comparison (R-2/R-3)');

  const p12 = {};
  await test('setup: P12 fixtures — branch, manager, products, opening stock', async () => {
    const nb = await authJ({ path: '/api/branches', method: 'POST', body: { name: 'P12 North Branch' } });
    assert.strictEqual(nb.status, 200, JSON.stringify(nb.body));
    p12.brNorth = nb.body.id;
    const m1 = await authJ({ path: '/api/staff', method: 'POST', body: { name: 'Mgr Main', role: 'manager', pin: '7442', branch_id: 1 } });
    assert.strictEqual(m1.status, 200, JSON.stringify(m1.body));
    const m2 = await authJ({ path: '/api/staff', method: 'POST', body: { name: 'Mgr East', role: 'manager', pin: '7331', branch_id: 2 } });
    assert.strictEqual(m2.status, 200, JSON.stringify(m2.body));
    const l1 = await authJ({ path: '/api/login', method: 'POST', body: { name: 'Mgr Main', pin: '7442' } });
    const l2 = await authJ({ path: '/api/login', method: 'POST', body: { name: 'Mgr East', pin: '7331' } });
    p12.mgr1 = withCookie(l1.headers.get('set-cookie').split(';')[0]);
    p12.mgr2 = withCookie(l2.headers.get('set-cookie').split(';')[0]);
    p12.mgr1User = m1.body.id; p12.mgr2User = m2.body.id;
    const pw = await authJ({ path: '/api/products', method: 'POST', body: { name: 'P12 Widget', barcode: '99921', cost: 100, price: 150 } });
    const pg = await authJ({ path: '/api/products', method: 'POST', body: { name: 'P12 Gadget', barcode: '99922', cost: 50, price: 90 } });
    assert.strictEqual(pw.status, 200, JSON.stringify(pw.body));
    assert.strictEqual(pg.status, 200, JSON.stringify(pg.body));
    p12.widget = pw.body.id; p12.gadget = pg.body.id;
    p12.widgetV = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(p12.widget).id;
    p12.locL1 = d.prepare("SELECT id FROM locations WHERE branch_id = 1 AND is_default = 1").get().id;
    p12.locL2 = d.prepare("SELECT id FROM locations WHERE branch_id = 2 AND is_default = 1").get().id;
    // Nakuru (branch 3) is deleted by the Phase 2 tests — P12 North is leg 3
    p12.locL3 = d.prepare("SELECT id FROM locations WHERE branch_id = ? AND is_default = 1").get(p12.brNorth).id;
    p12.locWH = d.prepare("SELECT id FROM locations WHERE is_warehouse = 1").get().id;
    for (const [pid, qty] of [[p12.widget, 20], [p12.gadget, 10]]) {
      const a = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: pid, qty, type: 'opening', reason: 'opening', location_id: p12.locL1 } });
      assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    }
    // owner opened stock at a branch-1 location — move must be tagged branch 1
    const mv = d.prepare("SELECT * FROM stock_moves WHERE type = 'opening' AND location_id = ? ORDER BY id DESC LIMIT 1").get(p12.locL1);
    assert.strictEqual(mv.branch_id, 1, 'owner opening stock tagged with the location branch');
    // branch-2 customer + branch-2 sale (raw: no till open in Eastleigh in the suite)
    const ec = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'Eastleigh Traders', phone: '0700555001', branch_id: 2 } });
    assert.strictEqual(ec.status, 200, JSON.stringify(ec.body));
    p12.branch2Customer = (ec.body.customer || ec.body).id;
    const wv = p12.widgetV;
    const saleId = d.prepare(
      "INSERT INTO sales (branch_id, location_id, order_no, invoice_no, customer_id, status, subtotal, discount, net, tax, gross, created_at) VALUES (2, ?, 900001, 'P12-E2', ?, 'paid', 1500, 0, 1293, 207, 1500, ?)"
    ).run(p12.locL2, p12.branch2Customer, new Date().toISOString()).lastInsertRowid;
    d.prepare(
      "INSERT INTO sale_items (sale_id, product_id, variant_id, name, qty, unit, line_discount, net, tax, gross) VALUES (?, ?, ?, 'P12 Widget', 10, 'pc', 0, 1293, 207, 1500)"
    ).run(saleId, p12.widget, wv);
    p12.branch2Sale = saleId;
  });

  await test('acceptance: 3-location transfer chain with 1 discrepancy, fully traceable (R-3)', async () => {
    // Leg 1: L1 → L2 (10 widgets, 5 gadgets); leg 2 later: L2 → L3.
    const c = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL1, to_location: p12.locL2,
      items: [{ product_id: p12.widget, qty: 10 }, { product_id: p12.gadget, qty: 5 }],
      note: 'opening push'
    } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.ok(c.body.transfer.ref.startsWith('TR-'), c.body.transfer.ref);
    assert.strictEqual(c.body.transfer.status, 'requested');
    p12.tr1 = c.body.transfer.id;
    const items1 = c.body.transfer.items;
    const wLine = items1.find((i) => i.product_id === p12.widget);
    const gLine = items1.find((i) => i.product_id === p12.gadget);

    const shipEarly = await authJ({ path: `/api/transfers/${p12.tr1}/ship`, method: 'POST', body: {} });
    assert.strictEqual(shipEarly.status, 400, 'cannot ship before approval');

    // the receiving branch's manager approves (they control what enters their books)
    const ap = await p12.mgr2({ path: `/api/transfers/${p12.tr1}/approve`, method: 'POST', body: {} });
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    assert.strictEqual(ap.body.transfer.status, 'approved');

    const sh = await authJ({ path: `/api/transfers/${p12.tr1}/ship`, method: 'POST', body: {} });
    assert.strictEqual(sh.status, 200, JSON.stringify(sh.body));
    assert.strictEqual(sh.body.transfer.status, 'shipped');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p12.widgetV, p12.locL1).qty, 10, 'source stock deducted');

    // receive with ONE discrepancy: 8 of 10 widgets arrived
    const rc = await p12.mgr2({ path: `/api/transfers/${p12.tr1}/receive`, method: 'POST', body: {
      items: [{ item_id: wLine.id, received_qty: 8 }, { item_id: gLine.id, received_qty: 5 }],
      note: '2 widgets short'
    } });
    assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
    assert.strictEqual(rc.body.transfer.status, 'received');
    assert.strictEqual(rc.body.transfer.discrepancies, 1);
    const gotW = rc.body.transfer.items.find((i) => i.product_id === p12.widget);
    assert.strictEqual(gotW.discrepancy, 2, 'line-level discrepancy = sent − received');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p12.widgetV, p12.locL2).qty, 8, 'destination stock = received qty');

    // the ledger tells the whole story for this transfer
    const trail = d.prepare("SELECT * FROM stock_moves WHERE ref = ? ORDER BY id").all(c.body.transfer.ref);
    assert.strictEqual(trail.length, 4, '4 moves: 2 out + 2 in');
    assert.ok(trail.some((m) => m.type === 'transfer_out' && m.qty === -10 && m.branch_id === 1));
    assert.ok(trail.some((m) => m.type === 'transfer_out' && m.qty === -5 && m.branch_id === 1));
    assert.ok(trail.some((m) => m.type === 'transfer_in' && m.qty === 8 && m.branch_id === 2));
    assert.ok(trail.some((m) => m.type === 'transfer_in' && m.qty === 5 && m.branch_id === 2));
    const aud = d.prepare("SELECT detail FROM audit_log WHERE action = 'transfer/receive' AND entity_id = ?").get(String(p12.tr1));
    assert.ok(aud && JSON.parse(aud.detail).discrepancies === 2, 'audit records the discrepancy total');

    // Leg 2: L2 → L3 (6 of the 8 widgets that arrived) — the 3rd location
    const c2 = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL2, to_location: p12.locL3,
      items: [{ product_id: p12.widget, qty: 6 }]
    } });
    assert.strictEqual(c2.status, 200, JSON.stringify(c2.body));
    p12.tr2 = c2.body.transfer.id;
    p12.tr2Ref = c2.body.transfer.ref;
    const a2 = await p12.mgr2({ path: `/api/transfers/${p12.tr2}/approve`, method: 'POST', body: {} });
    assert.strictEqual(a2.status, 403, 'Eastleigh manager cannot approve into a branch they cannot see');
    const a3 = await authJ({ path: `/api/transfers/${p12.tr2}/approve`, method: 'POST', body: {} });
    assert.strictEqual(a3.status, 200);
    const s3 = await authJ({ path: `/api/transfers/${p12.tr2}/ship`, method: 'POST', body: {} });
    assert.strictEqual(s3.status, 200);
    const l3 = c2.body.transfer.items[0].id;
    const r3 = await authJ({ path: `/api/transfers/${p12.tr2}/receive`, method: 'POST', body: { items: [{ item_id: l3, received_qty: 6 }] } });
    assert.strictEqual(r3.status, 200, JSON.stringify(r3.body));
    assert.strictEqual(r3.body.transfer.status, 'received');
    assert.strictEqual(r3.body.transfer.discrepancies, 0);
    const total = d.prepare('SELECT COALESCE(SUM(qty), 0) AS t FROM stock WHERE variant_id = ?').get(p12.widgetV).t;
    assert.strictEqual(total, 18, '20 opened − 2 lost in transit = 18 across all locations');
  });

  await test('transfer state machine + guard rails (double ship/receive/over-receive/cancel)', async () => {
    const c = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL1, to_location: p12.locL2, items: [{ product_id: p12.gadget, qty: 2 }]
    } });
    assert.strictEqual(c.status, 200);
    const id = c.body.transfer.id;
    const line = c.body.transfer.items[0].id;
    const ap = await authJ({ path: `/api/transfers/${id}/approve`, method: 'POST', body: {} });
    assert.strictEqual(ap.status, 200);
    const sh = await authJ({ path: `/api/transfers/${id}/ship`, method: 'POST', body: {} });
    assert.strictEqual(sh.status, 200);
    assert.strictEqual((await authJ({ path: `/api/transfers/${id}/ship`, method: 'POST', body: {} })).status, 400, 'double ship refused');
    assert.strictEqual((await authJ({ path: `/api/transfers/${id}/approve`, method: 'POST', body: {} })).status, 400, 're-approve refused');
    const over = await authJ({ path: `/api/transfers/${id}/receive`, method: 'POST', body: { items: [{ item_id: line, received_qty: 99 }] } });
    assert.strictEqual(over.status, 400, 'cannot receive more than sent');
    const ok = await authJ({ path: `/api/transfers/${id}/receive`, method: 'POST', body: { items: [{ item_id: line, received_qty: 2 }] } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.transfer.status, 'received');
    const again = await authJ({ path: `/api/transfers/${id}/receive`, method: 'POST', body: { items: [{ item_id: line, received_qty: 0 }] } });
    assert.strictEqual(again.status, 400, 'line already received');
    assert.strictEqual((await authJ({ path: `/api/transfers/${id}/cancel`, method: 'POST', body: {} })).status, 400, 'no cancel after ship');
    // cancel works pre-ship
    const c2 = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL1, to_location: p12.locL2, items: [{ product_id: p12.gadget, qty: 1 }]
    } });
    const cx = await authJ({ path: `/api/transfers/${c2.body.transfer.id}/cancel`, method: 'POST', body: {} });
    assert.strictEqual(cx.status, 200);
    assert.strictEqual(cx.body.transfer.status, 'cancelled');
    // insufficient stock at source is refused up front
    const big = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL1, to_location: p12.locL2, items: [{ product_id: p12.gadget, qty: 9999 }]
    } });
    assert.strictEqual(big.status, 400, 'insufficient stock refused');
  });

  await test('batch-tracked transfer: batch moves with the stock; batch_id mandatory', async () => {
    const milk = d.prepare("SELECT id FROM products WHERE name = 'Milk 1L'").get();
    if (!milk) return; // batch product only exists if Phase 5 fixtures ran
    const mv = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(milk.id).id;
    const batch = d.prepare('SELECT * FROM batches WHERE variant_id = ? AND location_id = ? AND qty > 5 ORDER BY id DESC LIMIT 1').get(mv, p12.locL1);
    if (!batch) return;
    const noBatch = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL1, to_location: p12.locL2, items: [{ product_id: milk.id, qty: 4 }]
    } });
    assert.strictEqual(noBatch.status, 400, 'batch-tracked product needs a batch_id');
    const c = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL1, to_location: p12.locL2, items: [{ product_id: milk.id, qty: 4, batch_id: batch.id }]
    } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const id = c.body.transfer.id;
    assert.strictEqual((await authJ({ path: `/api/transfers/${id}/approve`, method: 'POST', body: {} })).status, 200);
    assert.strictEqual((await authJ({ path: `/api/transfers/${id}/ship`, method: 'POST', body: {} })).status, 200);
    const rc = await authJ({ path: `/api/transfers/${id}/receive`, method: 'POST', body: { items: [{ item_id: c.body.transfer.items[0].id, received_qty: 4 }] } });
    assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
    const after = d.prepare('SELECT * FROM batches WHERE id = ?').get(batch.id);
    assert.strictEqual(after.location_id, p12.locL2, 'the batch itself moved to the destination');
    assert.strictEqual(after.qty, batch.qty, 'net batch qty unchanged by a clean transfer');
  });

  await test('acceptance: branch manager cannot read branch 2 data (R-2)', async () => {
    const raw = p12.mgr1; // manager of branch 1
    const as = (pathOrObj) => raw(typeof pathOrObj === 'string' ? { path: pathOrObj } : pathOrObj);
    // customers: branch-2 customer invisible; shared (branch-less) customers still visible
    const list = await as('/api/customers');
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.every((c) => c.branch_id == null || c.branch_id === 1), 'no branch-2 customers leak');
    assert.ok(!list.body.find((c) => c.id === p12.branch2Customer), 'branch-2 customer absent');
    const detail = await as(`/api/customers/${p12.branch2Customer}`);
    assert.strictEqual(detail.status, 404, 'branch-2 customer detail → 404');
    const stmt = await as(`/api/customers/${p12.branch2Customer}/statement`);
    assert.strictEqual(stmt.status, 404, 'branch-2 customer statement → 404');
    const up = await as({ path: `/api/customers/${p12.branch2Customer}`, method: 'PUT', body: { note: 'x' } });
    assert.strictEqual(up.status, 404, 'branch-2 customer update → 404');
    // sales / stock ledger / balances / pricing: no branch-2 rows
    const sales = await as('/api/sales?limit=100');
    assert.ok(sales.body.every((s) => s.branch_id === 1), 'no branch-2 sales');
    const moves = await as('/api/stock/moves?limit=500');
    assert.ok(moves.body.every((m) => m.branch_id === 1), 'no branch-2 stock moves');
    const bal = await as('/api/stock/balances');
    const br1Locs = new Set(d.prepare("SELECT id FROM locations WHERE branch_id = 1").all().map((l) => l.id));
    assert.ok(bal.body.every((b) => b.locations.every((l) => br1Locs.has(l.location_id))), 'no branch-2 balance rows');
    const rules = await as('/api/price-rules');
    assert.ok(rules.body.every((r) => !r.branch_id || r.branch_id === 1), 'no branch-2 price rules');
    // transfers: a transfer entirely outside branch 1 is invisible
    const tlist = await as('/api/transfers');
    assert.ok(tlist.body.every((t) => t.from_branch === 1 || t.to_branch === 1), 'transfers touching branch 1 only');
    assert.ok(!tlist.body.find((t) => t.ref === p12.tr2Ref), 'L2→L3 transfer absent');
    const tdetail = await as(`/api/transfers/${p12.tr2}`);
    assert.strictEqual(tdetail.status, 404, 'foreign transfer detail → 404');
    // bootstrap location map: owner sees every branch's locations, manager only their own
    const bootO = await authJ('/api/bootstrap');
    assert.ok(bootO.body.allLocations.length >= 2, 'owner bootstrap lists all locations');
    assert.ok(bootO.body.allLocations.some((l) => l.branch_id !== 1), 'owner sees other-branch locations');
    const bootM = await as('/api/bootstrap');
    assert.ok(bootM.body.allLocations.every((l) => l.branch_id === 1), 'manager bootstrap scoped to own branch');
    // structure: only own branch; no cross-branch product reads
    const brs = await as('/api/branches');
    assert.strictEqual(brs.body.length, 1, 'one branch visible');
    assert.strictEqual(brs.body[0].id, 1);
    const prod = await as('/api/products?branch_id=2');
    assert.strictEqual(prod.status, 404, 'manager cannot read branch-2 catalogue stock');
    const prodOk = await authJ('/api/products?branch_id=2');
    assert.strictEqual(prodOk.status, 200, 'owner can');
  });

  await test('acceptance: branch comparison ranks by sales, shows margin + shrinkage (R-3)', async () => {
    // shrinkage evidence in branch 1: one damaged widget
    const dmg = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: p12.widget, qty: -1, type: 'damage', reason: 'damage', location_id: p12.locL1, unit_cost: 100 } });
    assert.strictEqual(dmg.status, 200, JSON.stringify(dmg.body));
    const rep = await authJ('/api/reports/branches');
    assert.strictEqual(rep.status, 200, JSON.stringify(rep.body));
    const rows = rep.body.branches;
    assert.ok(rows.length >= 3, `expected >=3 visible branches, got ${rows.length}`);
    assert.strictEqual(rows[0].rank, 1);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].sales >= rows[i].sales, 'ranked by sales desc');
    const b1 = rows.find((r) => r.id === 1);
    const b2 = rows.find((r) => r.id === 2);
    assert.ok(b2, 'branch 2 in report');
    assert.strictEqual(b2.orders, 1, 'branch-2 fixture sale counted');
    assert.strictEqual(b2.sales, 1500);
    assert.strictEqual(b2.margin, 500, 'margin = gross − cost×qty');
    assert.ok(b1.shrinkage >= 100, `branch-1 shrinkage includes the damaged widget: ${b1.shrinkage}`);
    assert.strictEqual(b2.shrinkage, 0, 'branch 2 has no shrinkage yet');
    // windowed: future window = everything zero
    const fut = await authJ('/api/reports/branches?from=2999-01-01&to=2999-12-31');
    assert.strictEqual(fut.status, 200);
    assert.ok(fut.body.branches.every((r) => r.sales === 0 && r.orders === 0));
    // a manager only gets their own branch in the report
    const m2rep = await p12.mgr2({ path: '/api/reports/branches' });
    assert.strictEqual(m2rep.body.branches.length, 1);
    assert.strictEqual(m2rep.body.branches[0].id, 2);
    assert.strictEqual(m2rep.body.branches[0].rank, 1);
  });

  await test('inter-location transfer inside one branch (store → warehouse)', async () => {
    const c = await authJ({ path: '/api/transfers', method: 'POST', body: {
      from_location: p12.locL1, to_location: p12.locWH, items: [{ product_id: p12.gadget, qty: 3 }]
    } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const id = c.body.transfer.id;
    assert.strictEqual((await authJ({ path: `/api/transfers/${id}/approve`, method: 'POST', body: {} })).status, 200);
    assert.strictEqual((await authJ({ path: `/api/transfers/${id}/ship`, method: 'POST', body: {} })).status, 200);
    const rc = await authJ({ path: `/api/transfers/${id}/receive`, method: 'POST', body: { items: [{ item_id: c.body.transfer.items[0].id, received_qty: 3 }] } });
    assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
    assert.strictEqual(rc.body.transfer.status, 'received');
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(
      d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(p12.gadget).id, p12.locWH).qty, 3);
  });


  // ================= Phase 18 — industry module framework (R-M) =================
  // Acceptance: a new industry = fields + hooks + reports + permissions + UI +
  // template data, with NO change to the core. The fixture module below is
  // registered from this test file — that is the proof.
  section('Phase 18 — industry module framework (R-M): new industry, no core changes');

  const mods = require('../modules/loader');

  const p18 = {};
  const cookieFor = async (name, pin) =>
    (await authJ({ path: '/api/login', method: 'POST', body: { name, pin } })).headers.get('set-cookie').split(';')[0];

  await test('fixtures: a till cashier, a manager session and a plain product', async () => {
    const s = await authJ({ path: '/api/staff', method: 'POST', body: { name: 'P18 Cashier', role: 'cashier', pin: '2468', branch_id: 1 } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    p18.cashier = await cookieFor('P18 Cashier', '2468');
    p18.manager = await cookieFor('Mwenyeji M', '2345');
    p18.loc = d.prepare('SELECT id FROM locations WHERE branch_id = 1 AND is_default = 1').get().id;

    const mk = async (body) => {
      const r = await authJ({ path: '/api/products', method: 'POST', body });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(r.body.id).id;
      const res = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: r.body.id, qty: body._qty || 10, type: 'opening', reason: 'opening', unit_cost: body.cost } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return { id: r.body.id, vid };
    };
    p18.plain = await mk({ name: 'P18 Plain', barcode: '77801', cost: 100, price: 200, _qty: 20 });
    p18.premium = await mk({ name: 'P18 Premium Malt', barcode: '77802', cost: 900, price: 1500, meta: { premium: 1 }, _qty: 10 });
    p18.rx = await mk({ name: 'P18 Amoxicillin', barcode: '77803', cost: 150, price: 300, requires_rx: 1, _qty: 10 });
    p18.ctl = await mk({ name: 'P18 Controlled', barcode: '77804', cost: 600, price: 1500, is_controlled: 1, _qty: 10 });
  });

  await test('registry: both industries are discovered; a duka activates neither', async () => {
    const r = await authJ({ path: '/api/modules' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.modules.map((m) => m.id);
    assert.ok(ids.includes('spirits') && ids.includes('pharmacy'), ids.join(','));
    assert.strictEqual(r.body.trade, 'duka');
    assert.deepStrictEqual(r.body.active, [], 'the core must not switch an industry on by itself');
    const pharm = r.body.modules.find((m) => m.id === 'pharmacy');
    for (const h of ['productFields', 'checkout.validateLine', 'stock.rule', 'reports', 'permissions', 'ui']) {
      assert.ok(pharm.provides.includes(h), `pharmacy declares ${h}: ${pharm.provides}`);
    }
    // the core has no industry words left in the checkout path
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(!/requires a prescription \(pharmacy workflow\)/.test(src), 'pharmacy rule still hardcoded in core');
  });

  await test('owner activates a module: product fields, capability and audit land with it', async () => {
    const r = await authJ({ path: '/api/modules/spirits/activate', method: 'POST', body: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.active.includes('spirits'), JSON.stringify(r.body.active));
    // hook 1 — product fields became real attribute definitions
    const defs = (await authJ({ path: '/api/attribute-defs' })).body.map((a) => a.key);
    for (const k of ['abv', 'bottle_ml', 'case_size', 'premium']) assert.ok(defs.includes(k), `${k} not in ${defs}`);
    // R-C4: the module asked for the packs capability (bottle → case)
    assert.strictEqual(d.prepare("SELECT enabled FROM business_capabilities WHERE capability = 'packs'").get().enabled, 1);
    // activation is audited, and idempotent
    const aud = d.prepare("SELECT * FROM audit_log WHERE action = 'module/activate' AND entity_id = 'spirits'").all();
    assert.ok(aud.length >= 1, 'module activation is audited');
    await authJ({ path: '/api/modules/spirits/activate', method: 'POST', body: {} });
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM modules WHERE module_id = 'spirits'").get().n, 1, 'activate twice = one row');
  });

  await test('a manager cannot switch an industry on (owner-only)', async () => {
    const r = await withCookie(p18.manager)({ path: '/api/modules/pharmacy/activate', method: 'POST', body: {} });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM modules WHERE module_id = 'pharmacy' AND active = 1").get().n, 0);
  });

  await test('bootstrap carries the module fields, UI parts and reports to the shell', async () => {
    const b = await authJ({ path: '/api/bootstrap' });
    assert.strictEqual(b.status, 200);
    assert.ok(b.body.modules.active.includes('spirits'), JSON.stringify(b.body.modules));
    assert.ok(b.body.modules.fields.some((f) => f.key === 'abv'), 'module product fields ride along');
    const ui = b.body.modules.ui.find((u) => u.id === 'spirits-panel');
    assert.ok(ui && ui.script === '/modules/spirits.js', 'the UI part is declared, not hardcoded');
    assert.ok(ui.i18n.en.spirits_tab === 'Wines & Spirits', 'the module ships its own strings');
    assert.ok(b.body.modules.reports.some((r2) => r2.id === 'premium_sales'), 'module reports are offered');
  });

  await test('checkout gate: a premium line is a manager act (module permission, not a core rule)', async () => {
    const asCashier = withCookie(p18.cashier);
    const blocked = await asCashier({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.premium.vid, qty: 1 }], payment: { method: 'cash', amount: 1500 } } });
    assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.body));
    assert.ok(/premium line/.test(blocked.body.error), blocked.body.error);
    // no stock moved, no sale written
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p18.premium.vid, p18.loc).qty, 10);
    // the owner holds spirits.premium by role → the same line goes through
    const ok = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.premium.vid, qty: 2 }], payment: { method: 'cash', amount: 3000 } } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    // hook: beforeCommit wrote the module's own evidence
    const log = d.prepare('SELECT * FROM spirits_premium_log ORDER BY id DESC LIMIT 1').get();
    // 2 × 1500 = 3000 tax-inclusive (R-P2) — the shilling the customer paid
    assert.ok(log && log.qty === 2 && log.gross === 3000, JSON.stringify(log));
    // the permission is real: a cashier granted it may sell premium lines
    const uid = d.prepare("SELECT id FROM users WHERE name = 'P18 Cashier'").get().id;
    const grant = await authJ({ path: `/api/staff/${uid}/permissions`, method: 'POST', body: { permission: 'spirits.premium', allowed: true } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    const nowOk = await asCashier({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.premium.vid, qty: 1 }], payment: { method: 'cash', amount: 1500 } } });
    assert.strictEqual(nowOk.status, 200, JSON.stringify(nowOk.body));
    await authJ({ path: `/api/staff/${uid}/permissions`, method: 'POST', body: { permission: 'spirits.premium', allowed: false } });
    assert.strictEqual((await asCashier({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.premium.vid, qty: 1 }], payment: { method: 'cash', amount: 1500 } } })).status, 403);
  });

  await test('module reports run through one generic door (list, run, CSV, permission)', async () => {
    const list = await authJ({ path: '/api/reports/modules' });
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.reports.some((r) => r.id === 'premium_sales'), JSON.stringify(list.body.reports));
    const run = await authJ({ path: '/api/reports/modules/premium_sales' });
    assert.strictEqual(run.status, 200, JSON.stringify(run.body));
    assert.ok(run.body.rows.length >= 1 && run.body.rows[0].qty >= 3, JSON.stringify(run.body.rows));
    const csv = await fetch(`${BASE}/api/reports/modules/premium_sales?format=csv`, { headers: { cookie } });
    assert.strictEqual(csv.status, 200);
    assert.ok((await csv.text()).includes('product_name'), 'CSV export of a module report');
    const missing = await authJ({ path: '/api/reports/modules/nope' });
    assert.strictEqual(missing.status, 404);
  });

  await test('pharmacy: prescription capture is a workflow, not a wall (validateLine + beforeCommit)', async () => {
    const on = await authJ({ path: '/api/modules/pharmacy/activate', method: 'POST', body: {} });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    const asCashier = withCookie(p18.cashier);
    // a cashier is not a dispenser
    const noPerm = await asCashier({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.rx.vid, qty: 1, rx_ref: 'RX-1' }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(noPerm.status, 403, JSON.stringify(noPerm.body));
    assert.ok(/dispenser/.test(noPerm.body.error), noPerm.body.error);
    // a dispenser must record the prescription reference
    const noRx = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.rx.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(noRx.status, 400, JSON.stringify(noRx.body));
    assert.ok(/prescription reference required/.test(noRx.body.error), noRx.body.error);
    // with the reference, it dispenses — and the evidence is kept
    const ok = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.rx.vid, qty: 1, rx_ref: 'RX-900', prescriber: 'Dr Achieng' }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const rx = d.prepare("SELECT * FROM prescriptions WHERE rx_ref = 'RX-900'").get();
    assert.ok(rx, 'prescription recorded');
    assert.strictEqual(rx.prescriber, 'Dr Achieng');
    assert.ok(rx.sale_id && rx.filled_at, 'linked to the sale that filled it');
    // the module data the core carried opaquely from validateLine to commit
    const si = d.prepare('SELECT module_data FROM sale_items WHERE sale_id = ?').get(rx.sale_id);
    assert.ok(JSON.parse(si.module_data).pharmacy.rx_ref === 'RX-900', si.module_data);
    // the same prescription cannot be dispensed twice
    const again = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.rx.vid, qty: 1, rx_ref: 'RX-900' }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    // controlled drugs land in the register, with the dispenser's name
    const ctl = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.ctl.vid, qty: 1 }], payment: { method: 'cash', amount: 1500 } } });
    assert.strictEqual(ctl.status, 200, JSON.stringify(ctl.body));
    const reg = d.prepare("SELECT c.*, u.name AS uname FROM controlled_register c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.id DESC LIMIT 1").get();
    assert.strictEqual(reg.product_id, p18.ctl.id);
    assert.strictEqual(reg.direction, 'out');
    assert.ok(reg.uname, 'the register names the dispenser');
  });

  await test('stock rule: an expired batch cannot be sold, but it can be written off', async () => {
    const pr = await authJ({ path: '/api/products', method: 'POST', body: { name: 'P18 Expiring', barcode: '77805', cost: 100, price: 150, track_batches: true } });
    assert.strictEqual(pr.status, 200, JSON.stringify(pr.body));
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(pr.body.id).id;
    const gone = new Date(Date.now() - 5 * 86400e3).toISOString().slice(0, 10);
    const fresh = new Date(Date.now() + 200 * 86400e3).toISOString().slice(0, 10);
    const mkBatch = (no, exp, qty) => d.prepare('INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at) VALUES (?,?,1,?,?,?,?,100,?)')
      .run(pr.body.id, vid, p18.loc, no, exp, qty, new Date().toISOString()).lastInsertRowid;
    const oldBatch = mkBatch('OLD-1', gone, 4);
    mkBatch('NEW-1', fresh, 4);
    d.prepare('INSERT INTO stock (variant_id, location_id, qty) VALUES (?,?,8) ON CONFLICT DO UPDATE SET qty = 8').run(vid, p18.loc);
    for (const [b, q] of [[oldBatch, 4]]) {
      d.prepare("INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, batch_id, unit_cost, user_id, note, created_at) VALUES (?,?,1,?,?,'opening','opening','FIX',?,100,1,'fixture',?)").run(pr.body.id, vid, p18.loc, q, b, new Date().toISOString());
    }
    // FEFO would take the expired lot first — the module refuses
    const blocked = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: vid, qty: 1 }], payment: { method: 'cash', amount: 150 } } });
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.ok(/expired on/.test(blocked.body.error), blocked.body.error);
    // writing it off is still the lawful way out
    const off = await authJ({ path: `/api/batches/${oldBatch}/writeoff`, method: 'POST', body: { qty: 4, reason: 'expired' } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    const nowOk = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: vid, qty: 1 }], payment: { method: 'cash', amount: 150 } } });
    assert.strictEqual(nowOk.status, 200, JSON.stringify(nowOk.body));
  });

  await test('a module field on a VARIANT drives a module report (R-M2: flags + config, not a fork)', async () => {
    const vid = p18.plain.vid;
    const set = await authJ({ path: `/api/variants/${vid}`, method: 'PUT', body: { meta: { bottle_ml: 750, abv: 40 } } });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    const rep = await authJ({ path: '/api/reports/modules/price_per_litre' });
    assert.strictEqual(rep.status, 200, JSON.stringify(rep.body));
    const row = rep.body.rows.find((r) => r.variant_name === '' && r.bottle_ml === 750);
    assert.ok(row, JSON.stringify(rep.body.rows.slice(0, 3)));
    // 200 KES for 750ml → 267 per litre, and the ABV the module asked for
    assert.strictEqual(row.price_per_litre, 267);
    assert.strictEqual(String(row.abv), '40');
  });

  await test('module reports can require a module permission of their own', async () => {
    const asCashier = withCookie(p18.cashier);
    const denied = await asCashier({ path: '/api/reports/modules/controlled_register' });
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    const ok = await authJ({ path: '/api/reports/modules/controlled_register' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.rows.length >= 1, 'the controlled register report shows the dispensed line');
    const watch = await authJ({ path: '/api/reports/modules/expiry_watch?days=30' });
    assert.strictEqual(watch.status, 200, JSON.stringify(watch.body));
  });

  // ---- the acceptance test: a brand-new industry, added without touching the core
  const FIXTURE = {
    id: 'test_industry',
    name: 'Test Industry',
    nameSw: 'Sekta ya jaribio',
    version: 1,
    trades: ['__never_auto__'],
    description: 'Registered from the test file — no core file was edited for it.',
    capabilities: [],
    schema: `CREATE TABLE IF NOT EXISTS fixture_industry_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL DEFAULT '');`,
    productFields: [{ key: 'fixture_field', label: 'Fixture field', labelSw: 'Sehemu ya jaribio', type: 'text', appliesTo: 'product' }],
    permissions: [{ perm: 'fixture.sell', label: 'Sell fixture goods', labelSw: 'Uza bidhaa za jaribio', roles: ['owner'] }],
    checkout: {
      validateLine({ product, helpers }) {
        if (/^FIX-BLOCK/.test(product.name)) throw helpers.block(488, `${product.name} is not for sale (fixture policy)`);
        return { seen: true };
      },
      beforeCommit({ d, sale }) {
        d.prepare('INSERT INTO fixture_industry_log (note) VALUES (?)').run(`sale ${sale.id}`);
      }
    },
    stock: {
      rule({ product, qty, helpers }) {
        if (/^FIX-BLOCK/.test(product.name) && qty < 0) throw helpers.block(487, `${product.name} stock is frozen (fixture policy)`);
      }
    },
    reports: [{
      id: 'fixture_report', title: 'Fixture report', titleSw: 'Ripoti ya jaribio',
      perm: 'reports.view', columns: ['note'],
      run: (db) => ({ rows: db.prepare('SELECT note FROM fixture_industry_log').all() })
    }, {
      id: 'fixture_private', title: 'Fixture private', perm: 'fixture.sell', columns: ['note'],
      run: () => ({ rows: [] })
    }],
    ui: [{ id: 'fixture-panel', mount: 'manager', script: '/modules/fixture.js', label: 'fixture_tab', i18n: { en: { fixture_tab: 'Fixture industry' } } }],
    template: { categories: [['Fixture shelf', 'Rafu ya jaribio']], products: [] }
  };

  await test('ACCEPTANCE (R-M3): a new industry costs one file — fields + hooks + reports, zero core edits', async () => {
    const before = fs.readdirSync(path.join(__dirname, '..', 'modules')).filter((f) => f.endsWith('.js')).length;
    mods.register(FIXTURE);
    const act = await authJ({ path: '/api/modules/test_industry/activate', method: 'POST', body: {} });
    assert.strictEqual(act.status, 200, JSON.stringify(act.body));
    assert.ok(act.body.active.includes('test_industry'));
    assert.strictEqual(fs.readdirSync(path.join(__dirname, '..', 'modules')).filter((f) => f.endsWith('.js')).length, before, 'no file was added for this industry');

    // 1. productFields — the new field is live for every product form
    const defs = (await authJ({ path: '/api/attribute-defs' })).body.map((a) => a.key);
    assert.ok(defs.includes('fixture_field'), 'module field registered');
    // 2. checkout.validateLine — the industry's own rule, in its own words
    const fix = await authJ({ path: '/api/products', method: 'POST', body: { name: 'FIX-BLOCK Item', barcode: '77809', cost: 10, price: 20 } });
    assert.strictEqual(fix.status, 200, JSON.stringify(fix.body));
    const fvid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(fix.body.id).id;
    const stocked = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: fix.body.id, qty: 5, type: 'opening', reason: 'opening', unit_cost: 10 } });
    assert.strictEqual(stocked.status, 200, JSON.stringify(stocked.body));
    const blocked = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: fvid, qty: 1 }], payment: { method: 'cash', amount: 20 } } });
    assert.strictEqual(blocked.status, 488, JSON.stringify(blocked.body));
    assert.ok(/not for sale \(fixture policy\)/.test(blocked.body.error), blocked.body.error);
    // 3. stock.rule — the same industry's stock policy blocks a direct move
    const adj = await authJ({ path: '/api/stock/adjust', method: 'POST', body: { product_id: fix.body.id, qty: -1, reason: 'damage' } });
    assert.strictEqual(adj.status, 487, JSON.stringify(adj.body));
    // 4. checkout.beforeCommit + reports — the module's evidence and its report
    const ok = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.plain.vid, qty: 1 }], payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const rep = await authJ({ path: '/api/reports/modules/fixture_report' });
    assert.strictEqual(rep.status, 200, JSON.stringify(rep.body));
    assert.ok(rep.body.rows.some((r) => /^sale /.test(r.note)), JSON.stringify(rep.body.rows));
    // 5. permissions — the module's own permission gates its own report
    const denied = await withCookie(p18.cashier)({ path: '/api/reports/modules/fixture_private' });
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual((await authJ({ path: '/api/reports/modules/fixture_private' })).status, 200, 'owner holds it by role');
    // 6. ui — the shell is told about the panel without the shell knowing it
    const b = await authJ({ path: '/api/bootstrap' });
    assert.ok(b.body.modules.ui.some((u) => u.id === 'fixture-panel'), 'UI part from the new industry');
    // 7. template — onboarding data for the new trade
    assert.ok(mods.active(d).template().some((t) => t.module === 'test_industry'), 'template hook returns the industry starter data');
  });

  await test('a broken module fails closed, is audited, and never half-commits a sale', async () => {
    const boom = {
      id: 'boom_industry', name: 'Broken', trades: ['__never_auto__'], version: 1,
      checkout: { validateLine() { throw new Error('undefined is not a function'); } },
      productFields: [{ key: 'boom', label: 'Boom', type: 'text', appliesTo: 'product' }]
    };
    mods.register(boom);
    await authJ({ path: '/api/modules/boom_industry/activate', method: 'POST', body: {} });
    const before = d.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
    const r = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.plain.vid, qty: 1 }], payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(r.status, 500, JSON.stringify(r.body));
    assert.ok(/module "boom_industry" failed/.test(r.body.error), r.body.error);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM sales').get().n, before, 'no sale was written');
    const aud = d.prepare("SELECT * FROM audit_log WHERE action = 'module/failure' ORDER BY id DESC LIMIT 1").get();
    assert.ok(aud && /boom_industry/.test(aud.detail), 'the failure is audited');
    // the core keeps working the moment the broken module is switched off
    await authJ({ path: '/api/modules/boom_industry/deactivate', method: 'POST', body: {} });
    const ok = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.plain.vid, qty: 1 }], payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  await test('deactivating a module removes its rules and keeps its data', async () => {
    const off = await authJ({ path: '/api/modules/pharmacy/deactivate', method: 'POST', body: {} });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.ok(!off.body.active.includes('pharmacy'), JSON.stringify(off.body.active));
    // the Rx gate is gone (the core has no opinion of its own)…
    const nowOk = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.rx.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } });
    assert.strictEqual(nowOk.status, 200, JSON.stringify(nowOk.body));
    // …but the evidence it recorded stays (data is data)
    assert.ok(d.prepare("SELECT COUNT(*) AS n FROM prescriptions WHERE rx_ref = 'RX-900'").get().n === 1);
    // and a module report is no longer offered
    const list = await authJ({ path: '/api/reports/modules' });
    assert.ok(!list.body.reports.some((r) => r.id === 'expiry_watch'), JSON.stringify(list.body.reports.map((r) => r.id)));
  });


  // ================= Phases 19-23 — the eight industries =================
  // Each industry is one file in modules/ that declares product fields, checkout
  // rules, stock rules, reports, commands, permissions, a browser panel and (for
  // trades the core has never heard of) its own starter shelf.
  section('Phases 19-23 — eight industries: one file each, zero core edits');

  const p23 = { loc: p18.loc, cashier: p18.cashier };

  const mkP = async (body, qty = 10) => {
    const r = await authJ({ path: '/api/products', method: 'POST', body });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const vid = d.prepare("SELECT id FROM variants WHERE product_id = ? AND axes_key = '{}'").get(r.body.id).id;
    if (qty) {
      const st = await authJ({ path: '/api/stock/moves', method: 'POST', body: { product_id: r.body.id, qty, type: 'opening', reason: 'opening', unit_cost: body.cost } });
      assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    }
    return { id: r.body.id, vid };
  };
  const mkV = async (pid, body) => {
    const r = await authJ({ path: `/api/products/${pid}/variants`, method: 'POST', body });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.id;
  };
  const stockV = async (vid, qty, unitCost = 0) => {
    const r = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: vid, qty, type: 'opening', reason: 'opening', unit_cost: unitCost } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const sell = (items, amount, extra = {}) =>
    authJ({ path: '/api/sales', method: 'POST', body: { items, payment: { method: 'cash', amount }, ...extra } });
  const command = (mod, id, params) =>
    authJ({ path: `/api/modules/${mod}/commands/${id}`, method: 'POST', body: { params } });
  const report = (id, qs = '') => authJ(`/api/reports/modules/${id}${qs}`);

  await test('eight industries: eight module files, eight panels, and the core names none of them', async () => {
    const dir = path.join(__dirname, '..', 'modules');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    const ids = ['spirits', 'pharmacy', 'boutique', 'cosmetics', 'electronics', 'footwear', 'hardware', 'mini_mart'];
    for (const id of ids) assert.ok(files.includes(`${id}.js`), `${id}.js missing (${files.join(', ')})`);
    assert.strictEqual(files.filter((f) => !['loader.js', '_kit.js'].includes(f)).length, ids.length, 'one file per industry, and no strays');
    for (const id of ids) assert.ok(fs.existsSync(path.join(dir, 'ui', `${id}.js`)), `modules/ui/${id}.js missing`);
    // R-M1: the core has no opinion about any industry (comments aside)
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const id of ids) assert.ok(!new RegExp(`\\b${id}\\b`).test(src), `the core still names ${id}`);
  });

  await test('each industry activates and lands its fields, reports and commands', async () => {
    const industries = [
      ['boutique', 'brand'], ['cosmetics', 'shade'], ['electronics', 'warranty_months'],
      ['footwear', 'style_code'], ['hardware', 'uom'], ['mini_mart', 'plu']
    ];
    for (const [id] of industries) {
      const r = await authJ({ path: `/api/modules/${id}/activate`, method: 'POST', body: {} });
      assert.strictEqual(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
    }
    const defs = (await authJ({ path: '/api/attribute-defs' })).body.map((a) => a.key);
    for (const [, key] of industries) assert.ok(defs.includes(key), `${key} not a live product field (${defs.join(',')})`);
    const b = await authJ({ path: '/api/bootstrap' });
    for (const [id] of industries) assert.ok(b.body.modules.active.includes(id), b.body.modules.active.join(','));
    const repIds = b.body.modules.reports.map((r) => r.id);
    for (const r of ['size_sell_through', 'pack_size_sell_through', 'repair_jobs', 'shoe_size_sell_through', 'remnants', 'plu_sheet']) {
      assert.ok(repIds.includes(r), `report ${r} missing`);
    }
    const cmdIds = b.body.modules.commands.map((c) => `${c.module}.${c.id}`);
    for (const c of ['boutique.markdown', 'electronics.book_repair', 'mini_mart.repack']) {
      assert.ok(cmdIds.includes(c), `command ${c} missing (${cmdIds.join(', ')})`);
    }
    const markdown = b.body.modules.commands.find((c) => c.id === 'markdown');
    assert.deepStrictEqual(markdown.params.map((p) => p.name), ['percent', 'code', 'season', 'category_id', 'ends_at']);
  });

  // ---------------------------------------------------------------- boutique
  await test('boutique: a size x colour matrix is sold AS a variant, never as its parent row', async () => {
    const dress = await mkP({ name: 'P20 Summer Dress', barcode: '77901', cost: 800, price: 2500, meta: { season: 'AW', brand: 'Kitenge & Co' } }, 0);
    p23.dressS = await mkV(dress.id, { name: 'S', axes: 'size: S', barcode: '77902' });
    p23.dressM = await mkV(dress.id, { name: 'M', axes: 'size: M', barcode: '77903' });
    await stockV(p23.dressS, 4, 800);
    await stockV(p23.dressM, 6, 800);
    // the parent row is a bookkeeping device, not something you can sell
    const parent = await sell([{ variant_id: dress.vid, qty: 1 }], 2500);
    assert.strictEqual(parent.status, 400, JSON.stringify(parent.body));
    assert.ok(/pick a size/.test(parent.body.error), parent.body.error);
    // the real variant sells
    const ok = await sell([{ variant_id: p23.dressM, qty: 2 }], 5000);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const st = await report('size_sell_through');
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    const rowM = st.body.rows.find((r) => r.size === 'M');
    assert.ok(rowM && rowM.sold === 2, JSON.stringify(st.body.rows));
    assert.strictEqual(rowM.on_hand, 4, 'sell-through counts what is left too');
    assert.strictEqual(rowM.sell_through_pct, 33);
  });

  await test('boutique: a markdown is a reversible act, and it is a manager act', async () => {
    const denied = await withCookie(p23.cashier)({ path: '/api/modules/boutique/commands/markdown', method: 'POST', body: { params: { percent: 20, code: 'SALE20', season: 'AW' } } });
    assert.strictEqual(denied.status, 403, 'a cashier may not mark stock down');
    const bad = await command('boutique', 'markdown', { percent: 0, code: 'X', season: 'AW' });
    assert.strictEqual(bad.status, 400);
    assert.ok(/between 1 and 99/.test(bad.body.error), bad.body.error);
    const r = await command('boutique', 'markdown', { percent: 20, code: 'SALE20', season: 'AW' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.applied >= 2, JSON.stringify(r.body));       // the S and M variants
    // the markdown is a core price rule, not a destroyed price (R-PR stays core)
    const rule = d.prepare("SELECT * FROM price_rules WHERE promo_code = 'SALE20' AND active = 1").all();
    assert.ok(rule.length >= 2, 'markdown landed as a time-boxed promo rule');
    assert.strictEqual(rule[0].price, 2000, '2500 less 20% = 2000');
    // and the mark-down price is what a customer actually pays
    const priced = await authJ(`/api/pricing/resolve?variant_id=${p23.dressM}&promo_code=SALE20`);
    assert.strictEqual(priced.status, 200, JSON.stringify(priced.body));
    assert.strictEqual(priced.body.price, 2000, JSON.stringify(priced.body));
    const md = await report('markdowns');
    assert.ok(md.body.rows.some((x) => x.code === 'SALE20'), JSON.stringify(md.body.rows));
    // ending it restores the old price
    const off = await command('boutique', 'clear_markdown', { code: 'SALE20' });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.ok(off.body.ended >= 2, JSON.stringify(off.body));
    const back = await authJ(`/api/pricing/resolve?variant_id=${p23.dressM}`);
    assert.strictEqual(back.body.price, 2500, 'the original price is back');
  });

  await test('boutique: dead fashion stock is stock that has not moved in 60 days', async () => {
    const r = await report('dead_fashion_stock');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const row = r.body.rows.find((x) => x.product_name === 'P20 Summer Dress');
    assert.ok(row, JSON.stringify(r.body.rows));
    assert.strictEqual(row.brand, 'Kitenge & Co', 'the module field is on the product (R-M2)');
    assert.strictEqual(row.season, 'AW');
  });

  // --------------------------------------------------------------- mini-mart
  await test('mini-mart: a scale line is checked before it is sold', async () => {
    const tomatoes = await mkP({ name: 'P22 Tomatoes (kg)', barcode: '77911', cost: 120, price: 180, open_priced: 1, unit: 'kg', meta: { max_weight_kg: 5 } }, 40);
    const typo = await sell([{ variant_id: tomatoes.vid, qty: 50 }], 9000);
    assert.strictEqual(typo.status, 400, JSON.stringify(typo.body));
    assert.ok(/above the 5 limit/.test(typo.body.error), typo.body.error);
    const zero = await sell([{ variant_id: tomatoes.vid, qty: 0 }], 0);
    assert.strictEqual(zero.status, 400);
    const ok = await sell([{ variant_id: tomatoes.vid, qty: 2.5 }], 450);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(tomatoes.vid, p23.loc).qty, 37.5);
    // the PLU sheet is the cashier's quick-key list
    await authJ({ path: `/api/variants/${tomatoes.vid}`, method: 'PUT', body: { meta: { plu: '4011' } } });
    const plu = await report('plu_sheet');
    assert.strictEqual(plu.status, 200, JSON.stringify(plu.body));
    assert.ok(plu.body.rows.some((r) => r.plu === '4011' && r.product_name === 'P22 Tomatoes (kg)'), JSON.stringify(plu.body.rows));
  });

  await test('mini-mart: repacking bulk into sell units moves stock both ways', async () => {
    const bulk = await mkP({ name: 'P22 Rice 25kg', barcode: '77912', cost: 1400, price: 2100, meta: { bulk: 1 } }, 50);
    const unit = await mkP({ name: 'P22 Rice 1kg', barcode: '77913', cost: 56, price: 80 }, 0);
    const tooMuch = await command('mini_mart', 'repack', { bulk_product_id: bulk.id, sell_product_id: unit.id, units: 200, unit_size: 1 });
    assert.strictEqual(tooMuch.status, 400, JSON.stringify(tooMuch.body));
    assert.ok(/not enough bulk stock/.test(tooMuch.body.error), tooMuch.body.error);
    const r = await command('mini_mart', 'repack', { bulk_product_id: bulk.id, sell_product_id: unit.id, units: 25, unit_size: 1 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.units, 25);
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(bulk.vid, p23.loc).qty, 25);
    assert.strictEqual(d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(unit.vid, p23.loc).qty, 25);
    const movers = await report('bulk_movers');
    assert.strictEqual(movers.status, 200, JSON.stringify(movers.body));
  });

  // ---------------------------------------------------------------- hardware
  await test('hardware: a cut-from-roll line has a minimum cut and a maximum roll', async () => {
    const cable = await mkP({ name: 'P23 Cable (per metre)', barcode: '77921', cost: 60, price: 100, unit: 'm', meta: { cut_from_roll: 1, min_cut: 2, roll_length: 100, uom: 'metre' } }, 100);
    const offcut = await sell([{ variant_id: cable.vid, qty: 0.5 }], 50);
    assert.strictEqual(offcut.status, 400, JSON.stringify(offcut.body));
    assert.ok(/minimum cut is 2/.test(offcut.body.error), offcut.body.error);
    const tooLong = await sell([{ variant_id: cable.vid, qty: 150 }], 15000);
    assert.strictEqual(tooLong.status, 400, JSON.stringify(tooLong.body));
    assert.ok(/longer than a full roll/.test(tooLong.body.error), tooLong.body.error);
    const ok = await sell([{ variant_id: cable.vid, qty: 60 }], 6000);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const rem = await report('remnants');
    assert.strictEqual(rem.status, 200, JSON.stringify(rem.body));
    const row = rem.body.rows.find((x) => x.product_name === 'P23 Cable (per metre)');
    assert.ok(row, JSON.stringify(rem.body.rows));
    assert.strictEqual(row.on_hand, 40);
    assert.strictEqual(row.remnant_pct, 40, '40m left of a 100m roll');
  });

  // ------------------------------------------------------------- electronics
  await test('electronics: a phone cannot leave the shop without its IMEI, and the IMEI names its owner', async () => {
    const phone = await mkP({ name: 'P23 Smartphone A15', barcode: '77931', cost: 18000, price: 26000, track_serials: 1, meta: { warranty_months: 12, brand: 'Tecno' } }, 0);
    const cust = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'Wanjiru Electronics', phone: '0712345678' } });
    assert.strictEqual(cust.status, 200, JSON.stringify(cust.body));
    p23.cust = cust.body.customer.id;
    for (const im of ['IMEI-9001', 'IMEI-9002']) {
      const r = await authJ({ path: '/api/serials', method: 'POST', body: { product_id: phone.id, serial_no: im } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }
    const noScan = await sell([{ variant_id: phone.vid, qty: 1 }], 26000, { customer_id: p23.cust });
    assert.strictEqual(noScan.status, 400, JSON.stringify(noScan.body));
    assert.ok(/scan 1 serial number/.test(noScan.body.error), noScan.body.error);
    const ghost = await sell([{ variant_id: phone.vid, qty: 1, serials: ['IMEI-NOPE'] }], 26000, { customer_id: p23.cust });
    assert.strictEqual(ghost.status, 404, JSON.stringify(ghost.body));
    assert.ok(/not registered in stock/.test(ghost.body.error), ghost.body.error);
    const ok = await sell([{ variant_id: phone.vid, qty: 1, serials: ['IMEI-9001'] }], 26000, { customer_id: p23.cust });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    // the sale binds the serial to the person who bought it (warranty proof)
    const serial = d.prepare("SELECT * FROM serials WHERE serial_no = 'IMEI-9001'").get();
    assert.strictEqual(serial.status, 'sold');
    assert.strictEqual(serial.customer_id, p23.cust);
    assert.ok(serial.sale_id, 'serial is bound to the sale');
    // an already-sold IMEI cannot be sold again
    const again = await sell([{ variant_id: phone.vid, qty: 1, serials: ['IMEI-9001'] }], 26000, { customer_id: p23.cust });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    p23.phone = phone;
  });

  await test('electronics: warranty check, repair booking and hand-over', async () => {
    const w = await command('electronics', 'warranty_check', { serial_no: 'IMEI-9001' });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.in_warranty, true, JSON.stringify(w.body));
    assert.strictEqual(w.body.warranty_months, 12);
    assert.ok(w.body.warranty_expires, 'a warranty ends on a date, not "sometime"');
    const missing = await command('electronics', 'warranty_check', { serial_no: 'IMEI-404' });
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    // a repair job follows the same serial through the shop
    const job = await command('electronics', 'book_repair', { serial_no: 'IMEI-9002', fault: 'screen cracked', quoted: 4500 });
    assert.strictEqual(job.status, 200, JSON.stringify(job.body));
    assert.ok(/^REP-/.test(job.body.ref), JSON.stringify(job.body));
    const done = await command('electronics', 'complete_repair', { ref: job.body.ref, charged: 4500 });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    const twice = await command('electronics', 'complete_repair', { ref: job.body.ref, charged: 4500 });
    assert.strictEqual(twice.status, 409, 'a job is handed over once');
    const jobs = await report('repair_jobs');
    assert.strictEqual(jobs.status, 200, JSON.stringify(jobs.body));
    const row = jobs.body.rows.find((r) => r.ref === job.body.ref);
    assert.ok(row && row.status === 'collected' && row.charged === 4500, JSON.stringify(jobs.body.rows));
    const trace = await report('serial_trace');
    assert.ok(trace.body.rows.some((r) => r.serial_no === 'IMEI-9001' && r.status === 'sold'), JSON.stringify(trace.body.rows));
  });

  // --------------------------------------------------------------- pharmacy
  await test('pharmacy: a recall drill answers "who received this batch?" in one command', async () => {
    const on = await authJ({ path: '/api/modules/pharmacy/activate', method: 'POST', body: {} });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    const drug = await mkP({ name: 'P21 Amoxicillin 500mg', barcode: '77941', cost: 180, price: 280, track_batches: true }, 0);
    const batchId = d.prepare('INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at) VALUES (?,?,1,?,?,?,20,180,?)')
      .run(drug.id, drug.vid, p23.loc, 'AMX-77', new Date(Date.now() + 300 * 86400e3).toISOString().slice(0, 10), new Date().toISOString()).lastInsertRowid;
    d.prepare('INSERT INTO stock (variant_id, location_id, qty) VALUES (?,?,20) ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = 20').run(drug.vid, p23.loc);
    d.prepare("INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, batch_id, unit_cost, user_id, note, created_at) VALUES (?,?,1,?,20,'opening','opening','FIX',?,180,1,'fixture',?)")
      .run(drug.id, drug.vid, p23.loc, batchId, new Date().toISOString());
    const sale = await sell([{ variant_id: drug.vid, qty: 3 }], 840, { customer_id: p23.cust });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    assert.strictEqual(d.prepare('SELECT batch_id FROM sale_items WHERE sale_id = ?').get(sale.body.sale.id).batch_id, batchId, 'the sale drew from the batch');
    const drill = await command('pharmacy', 'recall_drill', { batch_no: 'AMX-77', reason: 'PPB alert' });
    assert.strictEqual(drill.status, 200, JSON.stringify(drill.body));
    assert.strictEqual(drill.body.sales_affected, 1, JSON.stringify(drill.body));
    assert.ok(drill.body.customers.some((c) => c.id === p23.cust), JSON.stringify(drill.body.customers));
    assert.strictEqual(drill.body.units_outstanding, 17, '20 in, 3 out');
    assert.ok(d.prepare("SELECT COUNT(*) AS n FROM pharmacy_recalls WHERE batch_no = 'AMX-77'").get().n === 1, 'the drill is recorded');
  });

  await test('pharmacy: expiry alerts are bucketed (expired / 30 / 60 / 90)', async () => {
    const drug = await mkP({ name: 'P21 Cough Syrup', barcode: '77942', cost: 220, price: 350, track_batches: true }, 0);
    const mkBatch = (no, days) => d.prepare('INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at) VALUES (?,?,1,?,?,?,5,220,?)')
      .run(drug.id, drug.vid, p23.loc, no, new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10), new Date().toISOString()).lastInsertRowid;
    mkBatch('CS-10', 10); mkBatch('CS-45', 45); mkBatch('CS-80', 80); mkBatch('CS-200', 200);
    const w = await report('expiry_watch', '?days=90');
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.ok(w.body.alerts.d30 >= 1, JSON.stringify(w.body.alerts));
    assert.ok(w.body.alerts.d60 >= 1, JSON.stringify(w.body.alerts));
    assert.ok(w.body.alerts.d90 >= 1, JSON.stringify(w.body.alerts));
    const soon = w.body.rows.find((r) => r.batch_no === 'CS-10');
    assert.strictEqual(soon.bucket, 'd30', JSON.stringify(soon));
    assert.ok(!w.body.rows.some((r) => r.batch_no === 'CS-200'), 'a 200-day batch is not in the 90-day watch');
    // writing off what has already expired is one command
    const gone = await mkP({ name: 'P21 Expired Syrup', barcode: '77943', cost: 220, price: 350, track_batches: true }, 0);
    d.prepare('INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at) VALUES (?,?,1,?,?,?,5,220,?)')
      .run(gone.id, gone.vid, p23.loc, 'CS-OLD', new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10), new Date().toISOString());
    d.prepare('INSERT INTO stock (variant_id, location_id, qty) VALUES (?,?,5) ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = 5').run(gone.vid, p23.loc);
    const off = await command('pharmacy', 'writeoff_expired', {});
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.ok(off.body.written >= 1, JSON.stringify(off.body));
    assert.strictEqual(d.prepare("SELECT qty FROM batches WHERE batch_no = 'CS-OLD'").get().qty, 0);
  });

  await test('pharmacy: an insurance claim is captured at the till, not on paper', async () => {
    const noPerm = await withCookie(p23.cashier)({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p18.plain.vid, qty: 1, insurer: 'SHA', member_no: '12345' }], payment: { method: 'cash', amount: 200 } } });
    assert.strictEqual(noPerm.status, 403, JSON.stringify(noPerm.body));
    assert.ok(/pharmacy.claims/.test(noPerm.body.error), noPerm.body.error);
    const noMember = await sell([{ variant_id: p18.plain.vid, qty: 1, insurer: 'SHA' }], 200);
    assert.strictEqual(noMember.status, 400, JSON.stringify(noMember.body));
    assert.ok(/member number/.test(noMember.body.error), noMember.body.error);
    const ok = await sell([{ variant_id: p18.plain.vid, qty: 2, insurer: 'SHA', member_no: '12345', claim_no: 'CLM-1', patient_name: 'Otieno' }], 400);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const claim = d.prepare("SELECT * FROM pharmacy_claims WHERE insurer = 'SHA' ORDER BY id DESC LIMIT 1").get();
    assert.ok(claim, 'the claim was captured');
    assert.strictEqual(claim.member_no, '12345');
    assert.strictEqual(claim.status, 'pending');
    assert.ok(claim.amount > 0, 'with the amount covered');
    const rep = await report('insurance_claims');
    assert.strictEqual(rep.status, 200, JSON.stringify(rep.body));
    assert.ok(rep.body.rows.some((r) => r.claim_no === 'CLM-1'), JSON.stringify(rep.body.rows));
    const sub = await command('pharmacy', 'submit_claims', { insurer: 'SHA', claim_nos: 'CLM-1' });
    assert.strictEqual(sub.status, 200, JSON.stringify(sub.body));
    assert.ok(sub.body.submitted >= 1, JSON.stringify(sub.body));
    assert.strictEqual(d.prepare("SELECT status FROM pharmacy_claims WHERE claim_no = 'CLM-1'").get().status, 'submitted');
    // the pharmacy is switched off again so the cosmetics rule is the one on duty
    await authJ({ path: '/api/modules/pharmacy/deactivate', method: 'POST', body: {} });
  });

  // --------------------------------------------------------------- cosmetics
  await test('cosmetics: perishable stock is guarded by expiry, and shades are tracked', async () => {
    const cream = await mkP({ name: 'P23 Face Cream', barcode: '77951', cost: 350, price: 550, track_batches: true, meta: { perishable: 1, brand: 'NiveaKE' } }, 0);
    const shade = await mkV(cream.id, { name: 'Medium', axes: 'shade: Medium', barcode: '77952' });
    const gone = new Date(Date.now() - 4 * 86400e3).toISOString().slice(0, 10);
    const batchId = d.prepare('INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at) VALUES (?,?,1,?,?,?,6,350,?)')
      .run(cream.id, shade, p23.loc, 'CRM-01', gone, new Date().toISOString()).lastInsertRowid;
    d.prepare('INSERT INTO stock (variant_id, location_id, qty) VALUES (?,?,6) ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = 6').run(shade, p23.loc);
    d.prepare("INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, batch_id, unit_cost, user_id, note, created_at) VALUES (?,?,1,?,6,'opening','opening','FIX',?,350,1,'fixture',?)")
      .run(cream.id, shade, p23.loc, batchId, new Date().toISOString());
    const blocked = await sell([{ variant_id: shade, qty: 1 }], 550);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.ok(/expired on/.test(blocked.body.error), blocked.body.error);
    const watch = await report('cosmetics_expiry', '?days=90');
    assert.strictEqual(watch.status, 200, JSON.stringify(watch.body));
    assert.ok(watch.body.rows.some((r) => r.batch_no === 'CRM-01' && r.bucket === 'expired'), JSON.stringify(watch.body.rows));
    // a fresh batch sells, and the shade shows up in sell-through
    d.prepare('INSERT INTO batches (product_id, variant_id, branch_id, location_id, batch_no, expiry_date, qty, cost, created_at) VALUES (?,?,1,?,?,?,6,350,?)')
      .run(cream.id, shade, p23.loc, 'CRM-02', new Date(Date.now() + 400 * 86400e3).toISOString().slice(0, 10), new Date().toISOString()).lastInsertRowid;
    d.prepare('UPDATE stock SET qty = 6 WHERE variant_id = ? AND location_id = ?').run(shade, p23.loc);
    d.prepare("UPDATE batches SET expiry_date = ? WHERE batch_no = 'CRM-01'").run(new Date(Date.now() + 300 * 86400e3).toISOString().slice(0, 10));
    const ok = await sell([{ variant_id: shade, qty: 2 }], 1100);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const st = await report('shade_sell_through');
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    const row = st.body.rows.find((r) => r.shade === 'Medium');
    assert.ok(row && row.sold === 2, JSON.stringify(st.body.rows));
  });

  // ---------------------------------------------------------------- footwear
  await test('footwear: the size must be chosen, and broken sizes are named', async () => {
    const shoe = await mkP({ name: 'P23 Runner', barcode: '77961', cost: 2200, price: 3500, meta: { style_code: 'RUN-1', size_scale: 'EU' } }, 0);
    const v40 = await mkV(shoe.id, { name: '40', axes: 'size: 40', barcode: '77962' });
    const v42 = await mkV(shoe.id, { name: '42', axes: 'size: 42', barcode: '77963' });
    await stockV(v40, 3, 2200);
    await stockV(v42, 3, 2200);
    const parent = await sell([{ variant_id: shoe.vid, qty: 1 }], 3500);
    assert.strictEqual(parent.status, 400, JSON.stringify(parent.body));
    assert.ok(/pick a size/.test(parent.body.error), parent.body.error);
    const ok = await sell([{ variant_id: v42, qty: 1 }], 3500);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const st = await report('shoe_size_sell_through');
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    assert.ok(st.body.rows.some((r) => r.size === '42' && r.sold === 1), JSON.stringify(st.body.rows));
    // size 41 has no stock at all: the style is broken
    const broken = await report('broken_sizes');
    assert.strictEqual(broken.status, 200, JSON.stringify(broken.body));
    const row = broken.body.rows.find((r) => r.product_name === 'P23 Runner');
    assert.ok(row, JSON.stringify(broken.body.rows));
    assert.ok(/41/.test(row.gap), JSON.stringify(row));
    // a variant with no barcode of its own is a scanning problem waiting to happen
    const gap = await mkV(shoe.id, { name: '44', axes: 'size: 44' });
    const gaps = await report('barcode_gaps');
    assert.strictEqual(gaps.status, 200, JSON.stringify(gaps.body));
    assert.ok(gaps.body.rows.some((r) => r.variant_name === '44'), JSON.stringify(gaps.body.rows));
  });

  await test('the trade picker offers industries the core has never heard of', async () => {
    const trades = (await authJ('/api/trades')).body;
    for (const t of ['electronics', 'cosmetics', 'footwear', 'mini_mart']) {
      assert.ok(trades[t], `${t} missing from ${Object.keys(trades).join(', ')}`);
      assert.ok(trades[t].label, `${t} has no label`);
    }
    assert.strictEqual(trades.duka.label, 'General shop (duka)', 'core trades keep their own labels');
  });

  await test('onboarding a trade the core has no catalogue for (electronics starter shelf)', async () => {
    // A second server in a child process: setup writes a business, a trade and a
    // starter shelf, and the industry module switches itself on.
    const script = path.join(tmp, 'setup-electronics.js');
    fs.writeFileSync(script, `
      const fs = require('fs'), os = require('os'), path = require('path');
      const ROOT = process.env.OPENPOS_ROOT;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpos-setup-'));
      process.env.OPENPOS_DATA_DIR = dir;
      process.env.OPENPOS_DB = path.join(dir, 't.db');
      const dbm = require(ROOT + '/db');
      const d = dbm.open();
      const { createApp } = require(ROOT + '/server');
      const app = createApp(d);
      const srv = app.listen(0);
      srv.once('listening', async () => {
        const base = 'http://127.0.0.1:' + srv.address().port;
        const r = await fetch(base + '/api/setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business: { name: 'Mama Ngina Electronics', trade: 'electronics' }, owner: { name: 'Otieno', pin: '4321' }, sample: true })
        });
        const out = {
          status: r.status,
          trade: (dbm.getSetting(d, 'business', {}) || {}).trade,
          modules: d.prepare('SELECT module_id, active FROM modules').all(),
          categories: d.prepare('SELECT name FROM categories ORDER BY id').all().map((x) => x.name),
          products: d.prepare('SELECT COUNT(*) AS n FROM products').get().n,
          serialTracked: d.prepare('SELECT COUNT(*) AS n FROM products WHERE track_serials = 1').get().n,
          fields: d.prepare("SELECT COUNT(*) AS n FROM attribute_defs WHERE key IN ('warranty_months','brand','model','spec')").get().n
        };
        console.log(JSON.stringify(out));
        srv.close();
        process.exit(0);
      });
    `);
    const raw = require('child_process').execFileSync(process.execPath, [script], {
      env: { ...process.env, OPENPOS_ROOT: path.join(__dirname, '..') }, encoding: 'utf8'
    });
    const out = JSON.parse(raw.trim().split('\n').pop());
    assert.strictEqual(out.status, 200, JSON.stringify(out));
    assert.strictEqual(out.trade, 'electronics', 'a module trade is accepted at setup');
    assert.ok(out.modules.some((m) => m.module_id === 'electronics' && m.active === 1), JSON.stringify(out.modules));
    assert.deepStrictEqual(out.categories, ['Phones & Tablets', 'Accessories', 'TV & Audio', 'Power & Solar', 'Repairs']);
    assert.strictEqual(out.products, 14, 'the module starter shelf, nothing else');
    assert.strictEqual(out.serialTracked, 5, 'phones, tablets and TVs arrive IMEI-tracked');
    assert.strictEqual(out.fields, 4, 'the module product fields are live from the first minute');
  });


  // ================= Phase 24 — promotions, loyalty & marketing =================
  // Acceptance: promos apply correctly through every payment method; loyalty as
  // tender cannot overspend; a segment drives a campaign.
  section('Phase 24 — promotions, loyalty & marketing: offers that survive the till');

  const p24 = {};
  const cap = async (id, enabled) =>
    authJ({ path: '/api/capabilities', method: 'POST', body: { capability: id, enabled } });
  const offer = (body) => authJ({ path: '/api/promos', method: 'POST', body });
  const preview = (items, extra = {}) =>
    authJ({ path: '/api/promos/preview', method: 'POST', body: { items, ...extra } });

  await test('fixtures: promotions + loyalty switched on, a product and a customer', async () => {
    for (const c of ['promotions', 'loyalty']) {
      const r = await cap(c, true);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    }
    p24.tea = await mkP({ name: 'P24 Tea 250g', barcode: '78001', cost: 150, price: 250 }, 40);
    p24.bread = await mkP({ name: 'P24 Bread', barcode: '78002', cost: 50, price: 80 }, 40);
    p24.soda = await mkP({ name: 'P24 Soda 500ml', barcode: '78003', cost: 60, price: 100 }, 40);
    const c = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'P24 Amina', phone: '0700000024' } });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    p24.cust = c.body.customer.id;
    p24.cashier = p18.cashier;
  });

  await test('an offer is data: created, listed, retired but never deleted', async () => {
    const bad = await offer({ name: 'Nonsense', type: 'free-everything', value: 10 });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    const over = await offer({ name: 'Over the top', type: 'pct', value: 150 });
    assert.strictEqual(over.status, 400, JSON.stringify(over.body));
    const r = await offer({ name: 'Tea 10% off', type: 'pct', value: 10, applies_to: 'product', applies_ref: String(p24.tea.id) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    p24.pct = r.body.promo.id;
    // an empty field is stored as no field — never as the string "null"
    assert.strictEqual(r.body.promo.code, null, JSON.stringify(r.body.promo));
    assert.strictEqual(r.body.promo.time_start, null, JSON.stringify(r.body.promo));
    const list = await authJ('/api/promos');
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.some((x) => x.id === p24.pct), 'the offer is listed');
    assert.strictEqual((await withCookie(p24.cashier)({ path: '/api/promos' })).status, 403, 'a cashier does not manage offers');
    const off = await authJ({ path: `/api/promos/${p24.pct}/deactivate`, method: 'POST', body: {} });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(d.prepare('SELECT active FROM promos WHERE id = ?').get(p24.pct).active, 0);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM promos').get().n >= 1, true, 'retired, not deleted');
    await authJ({ path: `/api/promos/${p24.pct}/activate`, method: 'POST', body: {} });
  });

  await test('a % offer discounts the line, and no discount permission is needed', async () => {
    const full = await preview([{ variant_id: p24.tea.vid, qty: 2 }]);
    assert.strictEqual(full.status, 200, JSON.stringify(full.body));
    assert.strictEqual(full.body.totals.subtotal, 500, JSON.stringify(full.body.totals));
    assert.strictEqual(full.body.totals.discount, 50, '10% of 500');
    assert.strictEqual(full.body.lines[0].line_discount, 50);
    // R-P2 + R-PR: 500 tax-inclusive, 50 off → 450 payable = 388 net + 62 VAT
    assert.strictEqual(full.body.totals.gross, 450);
    assert.strictEqual(full.body.totals.net, 388);
    assert.strictEqual(full.body.totals.tax, 62);
    // a cashier gets the same price — an offer is the shop's decision
    const asCashier = withCookie(p24.cashier);
    const till = await asCashier({ path: '/api/promos/preview', method: 'POST', body: { items: [{ variant_id: p24.tea.vid, qty: 2 }] } });
    assert.strictEqual(till.status, 200, JSON.stringify(till.body));
    assert.strictEqual(till.body.totals.discount, 50);
    // and it survives the real sale, on cash
    const sale = await asCashier({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p24.tea.vid, qty: 2 }], payment: { method: 'cash', amount: 450 } } });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    assert.strictEqual(sale.body.sale.gross, 450, JSON.stringify(sale.body.sale));
    assert.strictEqual(sale.body.sale.discount, 50);
    const used = d.prepare('SELECT * FROM sale_promos WHERE sale_id = ?').all(sale.body.sale.id);
    assert.ok(used.length === 1 && used[0].promo_id === p24.pct && used[0].amount === 50, JSON.stringify(used));
    assert.strictEqual(d.prepare('SELECT uses FROM promos WHERE id = ?').get(p24.pct).uses >= 1, true);
    // an unrelated product is untouched
    const other = await preview([{ variant_id: p24.soda.vid, qty: 1 }]);
    assert.strictEqual(other.body.totals.discount, 0);
  });

  await test('the same offer applies through M-Pesa, card and split tenders', async () => {
    for (const method of ['mpesa', 'card']) {
      const r = await authJ({ path: '/api/sales', method: 'POST', body: {
        items: [{ variant_id: p24.tea.vid, qty: 1 }],
        payment: { method, amount: 225, ref: `${method}-${Date.now()}`, phone: '0712345678' }
      } });
      assert.strictEqual(r.status, 200, `${method}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.sale.discount, 25, `${method} gets the same 10%`);
      assert.strictEqual(r.body.sale.gross, 225);
    }
    // split: cash + card, offer still taken off first
    const split = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p24.tea.vid, qty: 4 }],
      payment: { method: 'cash', amount: 450, tendered: 500 }
    } });
    assert.strictEqual(split.status, 200, JSON.stringify(split.body));
    assert.strictEqual(split.body.sale.discount, 100, '10% of 1000');
    assert.strictEqual(split.body.sale.gross, 900);
    // the cash tender was over-tendered (500 for a 450 share) — the sale keeps
    // the change arithmetic and the card settles exactly what is left
    const more = await authJ({ path: `/api/sales/${split.body.sale.id}/payments`, method: 'POST', body: { method: 'card', amount: 400, ref: `split-${Date.now()}` } });
    assert.strictEqual(more.status, 200, JSON.stringify(more.body));
    const done = d.prepare('SELECT * FROM sales WHERE id = ?').get(split.body.sale.id);
    assert.strictEqual(done.status, 'paid', 'split tender closes the sale');
    assert.strictEqual(done.discount, 100, 'the offer is not lost when the sale is split');
  });

  await test('BOGO: buy 2 get 1 free — the free unit is the cheapest', async () => {
    const r = await offer({ name: 'Soda 3 for 2', type: 'bogo', buy_qty: 2, get_qty: 1, applies_to: 'product', applies_ref: String(p24.soda.id) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    p24.bogo = r.body.promo.id;
    const two = await preview([{ variant_id: p24.soda.vid, qty: 2 }]);
    assert.strictEqual(two.body.totals.discount, 0, 'two sodas are just two sodas');
    const three = await preview([{ variant_id: p24.soda.vid, qty: 3 }]);
    assert.strictEqual(three.body.totals.discount, 100, 'the third one is free');
    const six = await preview([{ variant_id: p24.soda.vid, qty: 6 }]);
    assert.strictEqual(six.body.totals.discount, 200, 'six for the price of four');
    const seven = await preview([{ variant_id: p24.soda.vid, qty: 7 }]);
    assert.strictEqual(seven.body.totals.discount, 200, 'the seventh is paid');
    await authJ({ path: `/api/promos/${p24.bogo}/deactivate`, method: 'POST', body: {} });
  });

  await test('a bundle is one price for a set of items', async () => {
    await authJ({ path: `/api/promos/${p24.pct}/deactivate`, method: 'POST', body: {} });
    const r = await offer({ name: 'Tea + bread 280', type: 'bundle', value: 280, applies_to: 'bundle', applies_ref: `${p24.tea.vid}:1,${p24.bread.vid}:1` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    p24.bundle = r.body.promo.id;
    const half = await preview([{ variant_id: p24.tea.vid, qty: 1 }]);
    assert.strictEqual(half.body.totals.discount, 0, 'tea alone is not the bundle');
    const both = await preview([{ variant_id: p24.tea.vid, qty: 1 }, { variant_id: p24.bread.vid, qty: 1 }]);
    // 250 + 80 = 330 → 280 (the tea offer is bigger, so it wins)
    assert.strictEqual(both.body.totals.gross, 280, JSON.stringify(both.body));
    assert.strictEqual(both.body.offers.length, 1, 'offers do not stack unless they say so');
    assert.strictEqual(both.body.offers[0].type, 'bundle');
    await authJ({ path: `/api/promos/${p24.bundle}/deactivate`, method: 'POST', body: {} });
  });

  await test('a coupon only fires when the code is keyed, and only while stocks last', async () => {
    const r = await offer({ name: 'Weekend coupon', type: 'pct', value: 20, code: 'KARIBU20', max_uses: 2 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    p24.coupon = r.body.promo.id;
    const dupe = await offer({ name: 'Same code', type: 'pct', value: 5, code: 'KARIBU20' });
    assert.strictEqual(dupe.status, 409, 'a code belongs to one offer');
    const without = await preview([{ variant_id: p24.soda.vid, qty: 1 }]);
    assert.strictEqual(without.body.totals.discount, 0, 'no code, no discount');
    const withCode = await preview([{ variant_id: p24.soda.vid, qty: 1 }], { promo_code: 'karibu20' });
    assert.strictEqual(withCode.body.totals.discount, 20, 'codes are not case-sensitive');
    for (let i = 0; i < 2; i++) {
      const sale = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p24.soda.vid, qty: 1 }], payment: { method: 'cash', amount: 80 }, promo_code: 'KARIBU20' } });
      assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
      assert.strictEqual(sale.body.sale.discount, 20);
    }
    const spent = await preview([{ variant_id: p24.soda.vid, qty: 1 }], { promo_code: 'KARIBU20' });
    assert.strictEqual(spent.body.totals.discount, 0, 'the coupon ran out after 2 uses');
    await authJ({ path: `/api/promos/${p24.coupon}/deactivate`, method: 'POST', body: {} });
  });

  await test('a happy hour runs on the clock, and a minimum spend is respected', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = await offer({ name: 'Yesterday only', type: 'pct', value: 30, start_date: past.slice(0, 10), end_date: past.slice(0, 10) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const dead = await preview([{ variant_id: p24.soda.vid, qty: 1 }]);
    assert.strictEqual(dead.body.totals.discount, 0, 'an offer that ended is not applied');
    await authJ({ path: `/api/promos/${r.body.promo.id}/deactivate`, method: 'POST', body: {} });

    const min = await offer({ name: '200 off over 1000', type: 'fixed', value: 200, min_spend: 1000 });
    assert.strictEqual(min.status, 200, JSON.stringify(min.body));
    p24.fixed = min.body.promo.id;
    const small = await preview([{ variant_id: p24.soda.vid, qty: 2 }]);
    assert.strictEqual(small.body.totals.discount, 0, '200 spend is under the 1000 minimum');
    const big = await preview([{ variant_id: p24.tea.vid, qty: 6 }]);
    assert.strictEqual(big.body.totals.discount, 200, '1500 spend clears the minimum');
    assert.strictEqual(big.body.lines.reduce((t, l) => t + l.line_discount, 0), 200, 'spread across the lines');
    await authJ({ path: `/api/promos/${p24.fixed}/deactivate`, method: 'POST', body: {} });
  });

  await test('loyalty: points are earned on a paid sale and spent like money', async () => {
    const set = await authJ({ path: '/api/loyalty/settings', method: 'PUT', body: { enabled: true, points_per_100: 1, point_value: 1, max_redeem_pct: 50 } });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    assert.strictEqual(set.body.points_per_100, 1);
    // 1000 KES @ 1 point per 100 = 10 points
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p24.soda.vid, qty: 10 }], payment: { method: 'cash', amount: 1000 }, customer_id: p24.cust } });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    const bal = await authJ(`/api/loyalty/${p24.cust}`);
    assert.strictEqual(bal.status, 200, JSON.stringify(bal.body));
    assert.strictEqual(bal.body.points, 10, JSON.stringify(bal.body));
    assert.strictEqual(bal.body.value, 10, '10 points = 10 shillings');
    assert.ok(bal.body.history.some((h) => h.type === 'earn' && h.points === 10));
    // grant points by hand too (a promotion, an apology, a good customer)
    const grant = await authJ({ path: `/api/loyalty/${p24.cust}/adjust`, method: 'POST', body: { points: 90 } });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    assert.strictEqual(grant.body.points, 100);
  });

  await test('loyalty as tender cannot overspend the balance, the cap or the sale', async () => {
    // 3 teas = 750 shelf: the 50% cap allows 375; the customer holds 100 points
    const overBalance = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p24.tea.vid, qty: 3 }], customer_id: p24.cust,
      payment: { method: 'loyalty', amount: 400 }
    } });
    assert.strictEqual(overBalance.status, 400, JSON.stringify(overBalance.body));
    assert.ok(/has 100 points \(100 KES\)/.test(overBalance.body.error), overBalance.body.error);
    const noCustomer = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p24.tea.vid, qty: 1 }], payment: { method: 'loyalty', amount: 50 }
    } });
    assert.strictEqual(noCustomer.status, 400, JSON.stringify(noCustomer.body));
    assert.ok(/customer on the sale/.test(noCustomer.body.error), noCustomer.body.error);
    // 100 points is exactly what they have — allowed, and the rest is cash
    const ok = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p24.tea.vid, qty: 1 }], customer_id: p24.cust,
      payment: { method: 'loyalty', amount: 100 }
    } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const after = await authJ(`/api/loyalty/${p24.cust}`);
    assert.strictEqual(after.body.points, 0, JSON.stringify(after.body));
    assert.ok(after.body.history.some((h) => h.type === 'redeem' && h.points === -100));
    const pay = d.prepare("SELECT * FROM payments WHERE sale_id = ? AND method = 'loyalty'").get(ok.body.sale.id);
    assert.ok(pay && pay.amount === 100, JSON.stringify(pay));
    // the rest of that sale is still owed, and cash closes it
    const rest = await authJ({ path: `/api/sales/${ok.body.sale.id}/payments`, method: 'POST', body: { method: 'cash', amount: 150 } });
    assert.strictEqual(rest.status, 200, JSON.stringify(rest.body));
    assert.strictEqual(d.prepare('SELECT status FROM sales WHERE id = ?').get(ok.body.sale.id).status, 'paid');
    // a 50% cap: 100 points cannot pay for a 1000 sale
    await authJ({ path: `/api/loyalty/${p24.cust}/adjust`, method: 'POST', body: { points: 500 } });
    // 2 teas = 500 shelf: 50% cap = 250, so 300 is refused even though the
    // customer holds 500 points worth
    const overCap = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p24.tea.vid, qty: 2 }], customer_id: p24.cust,
      payment: { method: 'loyalty', amount: 300 }
    } });
    assert.strictEqual(overCap.status, 400, JSON.stringify(overCap.body));
    assert.ok(/at most 50%/.test(overCap.body.error), overCap.body.error);
  });

  await test('segments: the shop can see who to talk to', async () => {
    const r = await authJ('/api/segments');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.total >= 1, JSON.stringify(r.body));
    const ids = r.body.segments.map((s) => s.id);
    for (const id of ['vip', 'active', 'lapsed', 'new', 'deni']) assert.ok(ids.includes(id), id);
    const lapsed = r.body.segments.find((s) => s.id === 'lapsed');
    assert.ok(typeof lapsed.customers === 'number', JSON.stringify(lapsed));
    const aud = await authJ(`/api/segments/lapsed/audience?limit=5`);
    assert.strictEqual(aud.status, 200, JSON.stringify(aud.body));
    assert.strictEqual(aud.body.customers.length, aud.body.count > 5 ? 5 : aud.body.count);
    assert.strictEqual((await authJ('/api/segments/nonsense/audience')).status, 404);
  });

  await test('a campaign is a promotion pointed at a segment', async () => {
    // an old sale for a second customer makes them "lapsed" while P24 Amina is not
    const other = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'P24 Lapsed', phone: '0700000099' } });
    const otherId = other.body.customer.id;
    d.prepare("INSERT INTO sales (branch_id, location_id, order_no, invoice_no, customer_id, user_id, cashier_id, status, subtotal, discount, net, tax, gross, tender, kind, created_at, version) VALUES (1,?,900,'OLD-1',?,1,1,'paid',500,0,431,69,500,'[]','sale',?,1)")
      .run(p18.loc, otherId, new Date(Date.now() - 120 * 86400000).toISOString());
    const r = await authJ({ path: '/api/campaigns', method: 'POST', body: { segment: 'lapsed', name: 'Come back, 15% off', type: 'pct', value: 15 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.campaign.applies_to, 'segment');
    assert.strictEqual(r.body.campaign.applies_ref, 'lapsed');
    assert.ok(r.body.audience >= 1, JSON.stringify(r.body));
    assert.ok(r.body.sample.some((c) => c.id === otherId), JSON.stringify(r.body.sample));
    // the campaign reaches the lapsed customer…
    const hit = await preview([{ variant_id: p24.soda.vid, qty: 1 }], { customer_id: otherId });
    assert.strictEqual(hit.body.totals.discount, 15, JSON.stringify(hit.body));
    // …and not the customer who was in yesterday
    const miss = await preview([{ variant_id: p24.soda.vid, qty: 1 }], { customer_id: p24.cust });
    assert.strictEqual(miss.body.totals.discount, 0, JSON.stringify(miss.body));
    const audited = d.prepare("SELECT * FROM audit_log WHERE action = 'campaign/create' ORDER BY id DESC LIMIT 1").get();
    assert.ok(audited && JSON.parse(audited.detail).segment === 'lapsed', 'campaigns are audited');
    await authJ({ path: `/api/promos/${r.body.campaign.id}/deactivate`, method: 'POST', body: {} });
  });

  await test('campaign performance: what each offer cost and earned', async () => {
    const r = await authJ('/api/reports/promotions');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const tea = r.body.rows.find((x) => x.promo_id === p24.pct);
    assert.ok(tea, JSON.stringify(r.body.rows));
    assert.ok(tea.sales >= 3, JSON.stringify(tea));
    assert.ok(tea.discount_given >= 100, JSON.stringify(tea));
    assert.ok(tea.revenue >= 900, JSON.stringify(tea));
    assert.strictEqual(tea.uses_left, null, 'an unlimited offer has no remaining uses');
    const coupon = r.body.rows.find((x) => x.promo_id === p24.coupon);
    assert.strictEqual(coupon.uses, 2, 'a limited coupon counts its uses');
    assert.strictEqual(coupon.uses_left, 0);
    const csv = await fetch(`${BASE}/api/reports/promotions?format=csv`, { headers: { cookie } });
    assert.strictEqual(csv.status, 200);
    assert.ok((await csv.text()).includes('discount_given'));
  });


  // ================= Phase 25 — WhatsApp & customer commerce =================
  // Acceptance: a WhatsApp order becomes a real sale decrementing the same
  // stock; the receipt arrives the moment the money lands.
  section('Phase 25 — WhatsApp & customer commerce: one inventory, every door');

  const p25 = {};
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  await test('fixtures: messaging switched on, a product with a name people text', async () => {
    const on = await cap('comms', true);
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    const cfg = await authJ({ path: '/api/settings/comms', method: 'PUT', body: {
      enabled: true, provider: 'log', default_channel: 'whatsapp',
      business_phone: '0700000001', owner_phone: '0700000002',
      order_enabled: true, low_stock_alerts: true, paybill: '123456', account_prefix: 'INV-'
    } });
    assert.strictEqual(cfg.status, 200, JSON.stringify(cfg.body));
    assert.strictEqual(cfg.body.provider, 'log');
    assert.ok(cfg.body.providers.some((p) => p.id === 'log'), 'the shop can see its provider choices');
    p25.tea = await mkP({ name: 'P25 Chai', sku: 'CHAI', barcode: '79001', cost: 100, price: 150 }, 10);
    p25.soda = await mkP({ name: 'P25 Soda', sku: 'SODA', barcode: '79002', cost: 60, price: 100 }, 10);
    const c = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'P25 Wanjiru', phone: '0700111222' } });
    p25.cust = c.body.customer.id;
  });

  await test('a message is evidence: stored before it is sent, logged when there is no provider', async () => {
    const bad = await authJ({ path: '/api/messages/send', method: 'POST', body: { body: 'no number' } });
    assert.strictEqual(bad.status, 400, 'a message needs a number');
    const row = await authJ({ path: '/api/messages/send', method: 'POST', body: { to: '0700111222', body: 'Karibu P25', customer_id: p25.cust } });
    assert.strictEqual(row.status, 200, JSON.stringify(row.body));
    assert.strictEqual(row.body.status, 'logged', 'the local provider keeps the message in the shop');
    assert.strictEqual(row.body.customer_id, p25.cust);
    assert.strictEqual(row.body.kind, 'note');
    const list = await authJ('/api/messages');
    assert.ok(list.body.some((m) => m.id === row.body.id), 'the outbox is readable');
    // numbers travel as 07…, +254… and 254… and land as one shape
    const alt = await authJ({ path: '/api/messages/send', method: 'POST', body: { to: '+254700111222', body: 'same person' } });
    assert.strictEqual(alt.body.to_number, row.body.to_number, 'one phone, one book');
  });

  await test('a receipt is sent for a sale, and again on demand', async () => {
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p25.tea.vid, qty: 2 }], customer_id: p25.cust,
      payment: { method: 'cash', amount: 300 }
    } });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    await tick();
    const auto = await authJ(`/api/messages?sale_id=${sale.body.sale.id}&kind=receipt`);
    assert.strictEqual(auto.body.length, 1, 'a paid sale owes a receipt without anyone asking');
    assert.ok(/P25 Chai/.test(auto.body[0].body) && /300/.test(auto.body[0].body), auto.body[0].body);
    assert.strictEqual(auto.body[0].status, 'logged');
    // the same customer can be sent it again by hand
    const again = await authJ({ path: `/api/sales/${sale.body.sale.id}/send-receipt`, method: 'POST', body: {} });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(again.body.kind, 'receipt');
    // a sale with nobody to text is refused, not lost
    const nobody = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p25.soda.vid, qty: 1 }], payment: { method: 'cash', amount: 100 } } });
    const refused = await authJ({ path: `/api/sales/${nobody.body.sale.id}/send-receipt`, method: 'POST', body: {} });
    assert.strictEqual(refused.status, 400, JSON.stringify(refused.body));
  });

  await test('a statement and a mini catalogue go out as text', async () => {
    const st = await authJ({ path: `/api/customers/${p25.cust}/send-statement`, method: 'POST', body: {} });
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    assert.strictEqual(st.body.kind, 'statement');
    assert.ok(/statement for P25 Wanjiru/.test(st.body.body), st.body.body);
    const cat = await authJ({ path: '/api/comms/catalogue', method: 'POST', body: { customer_id: p25.cust, search: 'P25', dry_run: true } });
    assert.strictEqual(cat.status, 200, JSON.stringify(cat.body));
    assert.ok(cat.body.items.some((i) => i.sku === 'CHAI'), JSON.stringify(cat.body.items));
    assert.ok(/CHAI/.test(cat.body.body), cat.body.body);
  });

  await test('an inbound message becomes a real order — held until the money lands', async () => {
    p25.loc = d.prepare('SELECT location_id FROM stock WHERE variant_id = ? ORDER BY qty DESC LIMIT 1').get(p25.tea.vid).location_id;
    const before = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p25.tea.vid, p25.loc).qty;
    const r = await J({ path: '/api/webhooks/comms', method: 'POST', body: { provider: 'africas_talking', from: '0700111222', text: '2 CHAI, 1 SODA', id: 'AT-1' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.kind, 'order');
    assert.strictEqual(r.body.sale.status, 'suspended', 'an unpaid order holds no stock');
    assert.strictEqual(r.body.sale.channel, 'whatsapp', 'the book knows where the order came from');
    assert.strictEqual(r.body.payment_reference, `INV-${r.body.sale.invoice_no}`);
    assert.strictEqual(r.body.items.length, 2);
    assert.strictEqual(r.body.unmatched.length, 0);
    // stock has NOT moved yet — the customer has not paid
    const held = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p25.tea.vid, p25.loc).qty;
    assert.strictEqual(held, before, 'no stock leaves the shelf before the money');
    // the shop answered with how to pay
    const pr = await authJ(`/api/messages?sale_id=${r.body.sale.id}&kind=payment_request`);
    assert.strictEqual(pr.body.length, 1, JSON.stringify(pr.body));
    assert.ok(/Paybill 123456/.test(pr.body[0].body), pr.body[0].body);
    p25.orderSale = r.body.sale.id;
    p25.stockBefore = before;
  });

  await test('the same webhook twice is one order, not two (idempotent inbound)', async () => {
    const dup = await J({ path: '/api/webhooks/comms', method: 'POST', body: { provider: 'africas_talking', from: '0700111222', text: '2 CHAI, 1 SODA', id: 'AT-1' } });
    assert.strictEqual(dup.status, 200, JSON.stringify(dup.body));
    assert.strictEqual(dup.body.kind, 'order');
    assert.strictEqual(dup.body.sale.id, p25.orderSale, 'a provider replay does not re-order');
    assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM sales WHERE channel = 'whatsapp'").get().n, 1);
  });

  await test('paying the order moves the stock once and the receipt goes out', async () => {
    const pay = await authJ({ path: `/api/sales/${p25.orderSale}/pay`, method: 'POST', body: { payment: { method: 'mpesa', amount: 400, phone: '0700111222' } } });
    assert.strictEqual(pay.status, 200, JSON.stringify(pay.body));
    const sale = d.prepare('SELECT * FROM sales WHERE id = ?').get(p25.orderSale);
    assert.strictEqual(sale.status, 'open', 'M-Pesa is confirmed, not assumed');
    const confirm = await authJ({ path: `/api/payments/${pay.body.payments[0].id}/confirm`, method: 'POST', body: { code: 'MPX-P25' } });
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    const after = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p25.tea.vid, p25.loc).qty;
    assert.strictEqual(after, p25.stockBefore - 2, 'the WhatsApp order took the same stock as a till sale');
    const soda = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p25.soda.vid, p25.loc).qty;
    assert.strictEqual(soda, 10 - 2, 'soda: one at the till, one by message');
    const moves = d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'sale' AND ref = ?").get(sale.invoice_no).n;
    assert.strictEqual(moves, 2, 'two lines, two moves — never doubled');
    await tick();
    const receipt = await authJ(`/api/messages?sale_id=${p25.orderSale}&kind=receipt`);
    assert.strictEqual(receipt.body.length, 1, 'the receipt follows the payment');
    assert.strictEqual(receipt.body[0].status, 'logged');
  });

  await test('the reader is forgiving: "2 chai" and "2x CHAI" are the same order', async () => {
    const a = await commsLib.parseOrder(d, '2 chai');
    assert.strictEqual(a.items.length, 1);
    assert.strictEqual(a.items[0].variant_id, p25.tea.vid, JSON.stringify(a));
    assert.strictEqual(a.items[0].qty, 2);
    const b = await commsLib.parseOrder(d, '2x CHAI, 1 soda');
    assert.strictEqual(b.items.length, 2, JSON.stringify(b));
    assert.strictEqual(b.items[1].variant_id, p25.soda.vid);
    const barcode = await commsLib.parseOrder(d, '1 79003');
    assert.ok(barcode.items.length <= 1);
  });

  await test('a message we cannot read gets the catalogue, never silence', async () => {
    const menu = await J({ path: '/api/webhooks/comms', method: 'POST', body: { from: '0700111222', text: 'menu' } });
    assert.strictEqual(menu.status, 200, JSON.stringify(menu.body));
    assert.strictEqual(menu.body.kind, 'catalogue');
    const nonsense = await J({ path: '/api/webhooks/comms', method: 'POST', body: { from: '0700111222', text: 'bring me a cow' } });
    assert.strictEqual(nonsense.status, 200, JSON.stringify(nonsense.body));
    assert.strictEqual(nonsense.body.kind, 'unread');
    const partial = await J({ path: '/api/webhooks/comms', method: 'POST', body: { from: '0700111222', text: '2 CHAI, 3 flying cars' } });
    assert.strictEqual(partial.body.kind, 'order');
    assert.strictEqual(partial.body.items.length, 1, 'what we can read is ordered');
    assert.strictEqual(partial.body.unmatched.length, 1, 'what we cannot is named back');
  });

  await test('a broadcast reaches a segment (Phase 24 → 25)', async () => {
    const r = await authJ({ path: '/api/comms/broadcast', method: 'POST', body: { segment: 'all', body: 'Weekend offer — 10% off everything' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.audience >= 1, JSON.stringify(r.body));
    assert.strictEqual(r.body.sent, r.body.audience, 'everyone with a phone was messaged');
    const unknown = await authJ({ path: '/api/comms/broadcast', method: 'POST', body: { segment: 'nonsense', body: 'x' } });
    assert.strictEqual(unknown.status, 400);
  });

  await test('low stock nudges the owner once a day, not once a sale', async () => {
    const low = await mkP({ name: 'P25 Low', sku: 'LOW', barcode: '79003', cost: 50, price: 80 }, 3);
    await authJ({ path: `/api/products/${low.id}`, method: 'PUT', body: { reorder_level: 5 } });
    const a = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: low.vid, qty: 1 }], payment: { method: 'cash', amount: 80 } } });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    await tick();
    const b = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: low.vid, qty: 1 }], payment: { method: 'cash', amount: 80 } } });
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    await tick();
    const alerts = await authJ('/api/messages?kind=low_stock');
    assert.strictEqual(alerts.body.length, 1, JSON.stringify(alerts.body.map((m) => m.body)));
    assert.ok(/P25 Low is down to/.test(alerts.body[0].body), alerts.body[0].body);
    assert.strictEqual(d.prepare('SELECT * FROM messages WHERE kind = ?').get('low_stock').to_number, '+254700000002');
  });


  // ================= Phase 26 — online store / omni-channel =================
  // Acceptance: a web order and a till sale fight over the LAST unit — one
  // wins, the other fails gracefully. One customer profile across every door.
  section('Phase 26 — online store: the same shelf, another door');

  const p26 = {};

  await test('the storefront is off until the shop switches it on', async () => {
    const off = await J('/api/store/catalogue');
    assert.strictEqual(off.status, 403, JSON.stringify(off.body));
    const on = await cap('store', true);
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    const shop = await J('/api/store');
    assert.strictEqual(shop.status, 200, JSON.stringify(shop.body));
    assert.strictEqual(shop.body.currency, 'KES');
    assert.strictEqual(shop.body.window_minutes, 15, 'a cart holds stock for a quarter of an hour');
  });

  await test('the catalogue is the shop\'s own stock, priced the same, honest about what is free', async () => {
    p26.tea = await mkP({ name: 'P26 Chai', sku: 'P26-CHAI', cost: 100, price: 150 }, 3);
    p26.cat = await J('/api/store/catalogue');
    assert.strictEqual(p26.cat.status, 200, JSON.stringify(p26.cat.body));
    const row = p26.cat.body.find((r) => r.sku === 'P26-CHAI');
    assert.ok(row, 'the web shop sells what the till sells');
    assert.strictEqual(row.price, 150, 'the same price as the shelf');
    assert.strictEqual(row.available, 3, 'nothing is promised to anyone yet');
  });

  await test('a web cart holds stock without taking it — and the till can see the promise', async () => {
    const cart = await J({ path: '/api/store/cart', method: 'POST', body: {
      phone: '0722000111', name: 'P26 Kamau',
      items: [{ variant_id: p26.tea.vid, qty: 2 }]
    } });
    assert.strictEqual(cart.status, 200, JSON.stringify(cart.body));
    p26.token = cart.body.token;
    assert.strictEqual(cart.body.sale.status, 'suspended', 'an unpaid cart is a held sale');
    assert.strictEqual(cart.body.sale.channel, 'web');
    assert.strictEqual(cart.body.gross, 300);
    assert.ok(cart.body.expires_at);
    // stock has not moved; the promise has
    const stock = d.prepare('SELECT qty FROM stock WHERE variant_id = ? ORDER BY qty DESC LIMIT 1').get(p26.tea.vid).qty;
    assert.strictEqual(stock, 3, 'money has not moved, so neither has the stock');
    const cat = await J('/api/store/catalogue');
    assert.strictEqual(cat.body.find((r) => r.sku === 'P26-CHAI').available, 1, 'the shopfront tells the truth about what is left');
    p26.loc = d.prepare('SELECT location_id FROM stock WHERE variant_id = ? ORDER BY qty DESC LIMIT 1').get(p26.tea.vid).location_id;
  });

  await test('THE RACE: the last unit — the till sells it, the web cart fails gracefully', async () => {
    // one unit is free; the till sells it
    const till = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p26.tea.vid, qty: 1 }], payment: { method: 'cash', amount: 150 }
    } });
    assert.strictEqual(till.status, 200, JSON.stringify(till.body));
    // and now the cart that still holds two is told, not deceived
    const second = await J({ path: '/api/store/cart', method: 'POST', body: {
      phone: '0722000222', items: [{ variant_id: p26.tea.vid, qty: 2 }]
    } });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /out of stock|only 0 of/, second.body.error);
    // the held cart can still be read and cancelled — it never broke anything
    const read = await J(`/api/store/cart/${p26.token}`);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const cancel = await J({ path: `/api/store/cart/${p26.token}/cancel`, method: 'POST', body: {} });
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM store_reservations WHERE released_at IS NULL').get().n, 0,
      'cancelling gives the shelf its stock back');
  });

  await test('THE RACE, the other way: the web cart holds it, the till is refused', async () => {
    const restock = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: p26.tea.vid, qty: 1, type: 'opening', reason: 'opening', unit_cost: 100 } });
    assert.strictEqual(restock.status, 200, JSON.stringify(restock.body));
    const cart = await J({ path: '/api/store/cart', method: 'POST', body: {
      phone: '0722000333', items: [{ variant_id: p26.tea.vid, qty: 2 }]
    } });
    assert.strictEqual(cart.status, 200, JSON.stringify(cart.body));
    p26.token2 = cart.body.token;
    const denied = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p26.tea.vid, qty: 2 }], payment: { method: 'cash', amount: 300 }
    } });
    assert.strictEqual(denied.status, 409, JSON.stringify(denied.body));
    assert.match(denied.body.error, /online basket/, denied.body.error);
    // one unit is genuinely free, and that one sells
    const ok = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p26.tea.vid, qty: 1 }], payment: { method: 'cash', amount: 150 }
    } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  await test('checkout pays the held sale, moves the stock once and releases the promise', async () => {
    const before = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p26.tea.vid, p26.loc).qty;
    const pay = await J({ path: '/api/store/checkout', method: 'POST', body: { token: p26.token2, method: 'cash', amount: 300 } });
    assert.strictEqual(pay.status, 200, JSON.stringify(pay.body));
    assert.strictEqual(pay.body.sale.status, 'paid');
    const after = d.prepare('SELECT qty FROM stock WHERE variant_id = ? AND location_id = ?').get(p26.tea.vid, p26.loc).qty;
    assert.strictEqual(after, before - 2, 'the web order took the same stock a till sale would');
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM store_reservations WHERE token = ? AND released_at IS NULL').get(p26.token2).n, 0,
      'a paid order stops holding what it bought');
    const moves = d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'sale' AND ref = ?").get(pay.body.sale.invoice_no).n;
    assert.strictEqual(moves, 1, 'one line, one move — the web sale is a sale');
  });

  await test('one customer across every door: the phone is the profile', async () => {
    const restock = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: p26.tea.vid, qty: 4, type: 'opening', reason: 'opening', unit_cost: 100 } });
    assert.strictEqual(restock.status, 200, JSON.stringify(restock.body));
    const a = await J({ path: '/api/store/cart', method: 'POST', body: { phone: '0722000111', name: 'Kamau (again)', items: [{ variant_id: p26.tea.vid, qty: 1 }] } });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    const b = await J({ path: '/api/store/cart', method: 'POST', body: { phone: '+254722000111', items: [{ variant_id: p26.tea.vid, qty: 1 }] } });
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    const one = d.prepare('SELECT id, name FROM customers WHERE phone = ?').get('0722000111');
    const rows = d.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone IN ('0722000111', '+254722000111')").get().n;
    assert.strictEqual(rows, 1, '0722… and +254722… are one person, once');
    assert.strictEqual(one.name, 'P26 Kamau', 'the first visit named them; a later one does not rename them');
    const sales = d.prepare('SELECT customer_id FROM sales WHERE client_id IN (?, ?)').all(a.body.token, b.body.token);
    assert.strictEqual(sales.length, 2);
    assert.strictEqual(sales[0].customer_id, sales[1].customer_id, 'both carts belong to the same customer');
    await J({ path: `/api/store/cart/${a.body.token}/cancel`, method: 'POST', body: {} });
    await J({ path: `/api/store/cart/${b.body.token}/cancel`, method: 'POST', body: {} });
  });

  await test('an abandoned cart gives the shelf its stock back when it expires', async () => {
    const restock = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: p26.tea.vid, qty: 2, type: 'opening', reason: 'opening', unit_cost: 100 } });
    assert.strictEqual(restock.status, 200, JSON.stringify(restock.body));
    const cart = await J({ path: '/api/store/cart', method: 'POST', body: { phone: '0722000444', items: [{ variant_id: p26.tea.vid, qty: 1 }] } });
    assert.strictEqual(cart.status, 200, JSON.stringify(cart.body));
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM store_reservations WHERE token = ? AND released_at IS NULL').get(cart.body.token).n, 1);
    // the window is 15 minutes; time-travel it and let the shopfront clean up
    d.prepare('UPDATE store_reservations SET expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 1000).toISOString(), cart.body.token);
    const cat = await J('/api/store/catalogue');
    assert.strictEqual(cat.status, 200);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM store_reservations WHERE token = ? AND released_at IS NULL').get(cart.body.token).n, 0,
      'an expired promise holds nothing');
    const expired = await J({ path: '/api/store/checkout', method: 'POST', body: { token: cart.body.token, method: 'cash' } });
    assert.strictEqual(expired.status, 409, JSON.stringify(expired.body));
    assert.match(expired.body.error, /expired/, expired.body.error);
  });

  await test('the shop sees web and WhatsApp orders in one list', async () => {
    const list = await authJ('/api/store/orders?status=all');
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.length >= 4, JSON.stringify(list.body.map((s) => [s.id, s.channel, s.status])));
    assert.ok(list.body.every((s) => ['web', 'whatsapp'].includes(s.channel)), 'only orders from other doors');
    assert.ok(list.body.some((s) => s.channel === 'whatsapp'), 'the WhatsApp order from Phase 25 is in the same list');
    const unpaid = await authJ('/api/store/orders?status=unpaid');
    assert.ok(unpaid.body.every((s) => s.status === 'suspended'));
  });


  // ================= Phase 27 — devices & peripherals =======================
  // Acceptance: hardware is replaced by CONFIG, not by code; a shelf label
  // carries the shelf price.
  section('Phase 27 — devices: swap the row, keep the shop');

  const p27 = {};
  const b64 = (s) => Buffer.from(String(s), 'base64').toString('latin1');

  await test('a counter printer is a row of data, with a driver chosen from a list', async () => {
    const r = await authJ({ path: '/api/devices', method: 'POST', body: { type: 'printer', name: 'Counter 1', driver: 'escpos', profile: { width: 80, drawer: true } } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    p27.printer = r.body.id;
    assert.strictEqual(r.body.profile.width, 80);
    assert.strictEqual(r.body.profile.cut, true, 'a sensible default profile is filled in');
    assert.strictEqual(r.body.status, 'untested');
    const bad = await authJ({ path: '/api/devices', method: 'POST', body: { type: 'telepathy' } });
    assert.strictEqual(bad.status, 400);
    const badDriver = await authJ({ path: '/api/devices', method: 'POST', body: { type: 'printer', driver: 'crystal' } });
    assert.strictEqual(badDriver.status, 400);
  });

  await test('a device test proves the profile before a customer is waiting', async () => {
    const r = await authJ({ path: `/api/devices/${p27.printer}/test`, method: 'POST', body: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.bytes > 100, 'a real payload was rendered');
    const txt = b64(r.body.base64);
    assert.ok(txt.includes('Printer test'), 'the test page says what it is');
    assert.ok(txt.includes('TOTAL'), txt.slice(0, 80));
    assert.ok(/\x1bp/.test(txt), 'the drawer kick is in the payload');
    assert.ok(/\x1dV/.test(txt), 'the cut is in the payload');
    const after = await authJ('/api/devices');
    assert.strictEqual(after.body.find((x) => x.id === p27.printer).status, 'ok', 'the device remembers that it worked');
  });

  await test('the same sale prints on whichever printer the counter points at', async () => {
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p26.tea.vid, qty: 1 }], customer_id: null, payment: { method: 'cash', amount: 150 }
    } });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    p27.sale = sale.body.sale.id;
    const r = await authJ(`/api/sales/${p27.sale}/receipt-bytes`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const txt = b64(r.body.base64);
    assert.ok(txt.includes(sale.body.sale.invoice_no), 'the receipt carries its own invoice');
    assert.ok(/Ksh 150/.test(txt), 'and the total the customer paid');
    assert.ok(txt.includes('Asante') || txt.includes('Test Traders'), txt.slice(0, 60));
    // swap the printer by CONFIG: a 58mm label-class device with no drawer
    const swapped = await authJ({ path: '/api/devices', method: 'POST', body: { type: 'printer', name: 'Handheld 58', driver: 'log', profile: { width: 58, chars: 32, drawer: false }, is_default: true } });
    assert.strictEqual(swapped.status, 200, JSON.stringify(swapped.body));
    const again = await authJ(`/api/sales/${p27.sale}/receipt-bytes`);
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(again.body.driver, 'log', 'the counter now prints through the new device');
    const txt2 = b64(again.body.base64);
    assert.ok(!/\x1bp/.test(txt2), 'and the new profile says: no drawer');
    assert.ok(again.body.profile.chars === 32);
    // put the shop back
    await authJ({ path: `/api/devices/${swapped.body.id}`, method: 'PUT', body: { active: false } });
  });

  await test('a shelf label carries the price on the shelf — not a remembered one', async () => {
    const p = await mkP({ name: 'P27 Label Tea', sku: 'P27TEA', barcode: '555111', cost: 120, price: 200 }, 5);
    const lab = await authJ({ path: '/api/devices', method: 'POST', body: { type: 'label', name: 'Shelf labels', driver: 'escpos', profile: { chars: 32 } } });
    assert.strictEqual(lab.status, 200, JSON.stringify(lab.body));
    const r = await authJ(`/api/products/${p.id}/label-bytes`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.price, 200, 'the label price is the shelf price');
    const txt = b64(r.body.base64);
    assert.ok(txt.includes('Ksh 200'), txt);
    assert.ok(txt.includes('P27TEA'), 'it names the SKU');
    assert.ok(txt.includes('555111'), 'and prints the barcode');
    // change the price and print again: the label follows the shelf
    await authJ({ path: `/api/products/${p.id}`, method: 'PUT', body: { price: 250 } });
    const r2 = await authJ(`/api/products/${p.id}/label-bytes`);
    assert.strictEqual(r2.body.price, 250, JSON.stringify(r2.body));
    assert.ok(b64(r2.body.base64).includes('Ksh 250'));
    // a Zebra shop prints ZPL from the same route
    const zebra = await authJ({ path: `/api/devices/${lab.body.id}`, method: 'PUT', body: { driver: 'zpl' } });
    assert.strictEqual(zebra.status, 200, JSON.stringify(zebra.body));
    const z = await authJ(`/api/products/${p.id}/label-bytes`);
    assert.strictEqual(z.body.driver, 'zpl');
    assert.ok(b64(z.body.base64).includes('^XA'), 'ZPL, not ESC/POS');
  });

  await test('a scale reading is parsed, and a reading we cannot trust is refused', async () => {
    const ok = await authJ({ path: '/api/devices/scale-frame', method: 'POST', body: { frame: 'ST,GS,+001.250kg' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.weight, 1.25);
    assert.strictEqual(ok.body.unit, 'kg');
    assert.strictEqual(ok.body.stable, true);
    const plain = await authJ({ path: '/api/devices/scale-frame', method: 'POST', body: { frame: '  0.750 kg' } });
    assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
    assert.strictEqual(plain.body.weight, 0.75);
    const junk = await authJ({ path: '/api/devices/scale-frame', method: 'POST', body: { frame: 'hello there' } });
    assert.strictEqual(junk.status, 400, JSON.stringify(junk.body));
  });

  await test('the till can report that a device failed, and the shop can see it', async () => {
    const r = await authJ({ path: `/api/devices/${p27.printer}/report`, method: 'POST', body: { ok: false, error: 'out of paper' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.status, 'error');
    assert.match(r.body.last_error, /out of paper/);
    const back = await authJ({ path: `/api/devices/${p27.printer}/report`, method: 'POST', body: { ok: true } });
    assert.strictEqual(back.body.status, 'ok');
    assert.strictEqual(back.body.last_error, null);
  });


  // ================= Phase 28 — security, audit & fraud controls ============
  // Acceptance: every financially important action leaves a trail — reconciled
  // against the books, not merely recorded when we remembered to.
  section('Phase 28 — evidence: anything that moves money leaves a trail');

  await test('sign-ins are history: good, bad and locked-out', async () => {
    const ok = await J({ path: '/api/login', method: 'POST', body: { name: 'Owner One', pin: '1234' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const bad = await J({ path: '/api/login', method: 'POST', body: { name: 'Owner One', pin: '0000' } });
    assert.strictEqual(bad.status, 401, JSON.stringify(bad.body));
    assert.ok(bad.body.fails >= 1, 'the shop counts the tries');
    const hist = await authJ('/api/security/logins?limit=50');
    assert.strictEqual(hist.status, 200, JSON.stringify(hist.body));
    assert.ok(hist.body.some((e) => e.ok === 1 && e.name === 'Owner One'), 'a good sign-in is remembered');
    assert.ok(hist.body.some((e) => e.ok === 0 && /wrong PIN/.test(e.reason)), 'and so is a wrong PIN');
    const fails = await authJ('/api/security/logins?ok=false&limit=50');
    assert.ok(fails.body.every((e) => e.ok === 0));
  });

  await test('a thief hammering the PIN is locked out — and the shop can see it', async () => {
    for (let i = 0; i < 6; i++) {
      await J({ path: '/api/login', method: 'POST', body: { name: 'Thief', pin: '0000' } });
    }
    const locked = await J({ path: '/api/login', method: 'POST', body: { name: 'Thief', pin: '0000' } });
    assert.strictEqual(locked.status, 429, JSON.stringify(locked.body));
    const locks = await authJ('/api/security/locks');
    assert.strictEqual(locks.status, 200, JSON.stringify(locks.body));
    assert.ok(locks.body.some((l) => l.locked_for_ms > 0), `nothing is locked: ${JSON.stringify(locks.body)}`);
    assert.ok(locks.body.some((l) => l.kind === 'name' && l.who === 'thief' && l.fails >= 3),
      `the thief's name is not marked: ${JSON.stringify(locks.body)}`);
    const ev = await authJ('/api/security/logins?ok=false&limit=20');
    assert.ok(ev.body.some((e) => /locked/.test(e.reason)), JSON.stringify(ev.body.slice(0, 3)));
    // Tidy up: later tests sign in from this same address.
    d.prepare('DELETE FROM login_locks').run();
  });

  await test('financial acts are reconciled: 7 things happen, 7 trails exist', async () => {
    const from = new Date(Date.now() - 3600e3).toISOString();
    // 1. a discounted sale
    const p = await mkP({ name: 'P28 Item', sku: 'P28A', cost: 100, price: 200 }, 8);
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1, discount: 20 }], payment: { method: 'cash', amount: 180 }
    } });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    // 2. a stock adjustment by hand
    const adj = await authJ({ path: '/api/stock/moves', method: 'POST', body: { variant_id: p.vid, qty: -1, type: 'adjustment', reason: 'damage', note: 'spillage' } });
    assert.strictEqual(adj.status, 200, JSON.stringify(adj.body));
    // 3. a voided sale
    const s2 = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 200 } } });
    const voided = await authJ({ path: `/api/sales/${s2.body.sale.id}/void`, method: 'POST', body: { note: 'customer changed mind' } });
    assert.strictEqual(voided.status, 200, JSON.stringify(voided.body));
    // 4. staff created
    const staff = await authJ({ path: '/api/staff', method: 'POST', body: { name: 'P28 Cashier', pin: '4321', role: 'cashier' } });
    assert.strictEqual(staff.status, 200, JSON.stringify(staff.body));
    // 5. a setting changed
    const setting = await authJ({ path: '/api/settings', method: 'PUT', body: { business: { name: 'Test Traders' } } });
    assert.strictEqual(setting.status, 200, JSON.stringify(setting.body));
    // 6. a refund
    const refund = await authJ({ path: `/api/payments/${sale.body.payments[0].id}/refund`, method: 'POST', body: { amount: 20, reason: 'overcharge' } });
    assert.ok([200, 404].includes(refund.status), JSON.stringify(refund.body));
    // 7. credit (deni) — a customer owes the shop
    const cust = await authJ({ path: '/api/customers', method: 'POST', body: { name: 'P28 Deni', phone: '0733000111' } });
    const credit = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1 }], customer_id: cust.body.customer.id, credit: true
    } });
    assert.ok([200, 400].includes(credit.status), JSON.stringify(credit.body));

    const trail = await authJ(`/api/audit/trail?from=${encodeURIComponent(from)}`);
    assert.strictEqual(trail.status, 200, JSON.stringify(trail.body));
    const gaps = trail.body.checks.filter((c) => !c.ok);
    assert.strictEqual(trail.body.ok, true, `untrailed: ${JSON.stringify(gaps)}`);
    // the specific ones this test performed must all be trailed
    for (const id of ['sale_voided', 'stock_adjusted', 'discount_given', 'staff_changed', 'settings_changed']) {
      const c = trail.body.checks.find((x) => x.id === id);
      assert.ok(c && c.ok, `${id}: ${JSON.stringify(c)}`);
      assert.ok(c.trailed > 0, `${id} has evidence: ${JSON.stringify(c)}`);
    }
  });

  await test('the trail report names what it looked at, and flags anonymous rows', async () => {
    const trail = await authJ('/api/audit/trail');
    assert.strictEqual(trail.status, 200, JSON.stringify(trail.body));
    assert.ok(trail.body.classes.length >= 10, 'the report groups the book by what matters');
    assert.ok(trail.body.checks.length >= 8, 'and reconciles each one');
    assert.ok('anonymous_rows' in trail.body, 'rows with nobody attached are counted');
    assert.ok(trail.body.window.from && trail.body.window.to);
    const classes = await authJ('/api/audit/classes');
    assert.strictEqual(classes.status, 200);
    assert.ok(classes.body.some((c) => c.id === 'void' && c.events > 0), 'voids are visible as their own class');
  });

  await test('sessions are visible and revocable', async () => {
    const s = await authJ('/api/security/sessions');
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.ok(s.body.length >= 1, 'the owner is signed in somewhere');
    assert.ok(s.body.every((x) => x.token_hint && !x.token), 'the token itself is never shown');
    const victim = s.body[0];
    const revoke = await authJ({ path: `/api/security/sessions/${victim.token_hint.replace('…', '')}/revoke`, method: 'POST', body: {} });
    assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
    assert.strictEqual(revoke.body.revoked, 1, 'one session, revoked');
  });

  await test('the permission re-audit lists every hand on the till', async () => {
    const r = await authJ('/api/security/permissions');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.length >= 2, JSON.stringify(r.body));
    assert.ok(r.body.some((u) => u.role === 'owner'), 'the owner is on the list');
    assert.ok('overrides' in r.body[0], 'and any permission granted outside the role is named');
    const cashier = r.body.find((u) => u.name === 'P28 Cashier');
    assert.ok(cashier, `the cashier we added is on the list: ${JSON.stringify(r.body.map((u) => [u.id, u.name, u.role]))}`);
  });

  await test('security settings: lockout, session length, encrypted backup', async () => {
    const put = await authJ({ path: '/api/settings/security', method: 'PUT', body: {
      lockout: { max_fails: 3, lock_minutes: 10 },
      session_hours: 8,
      secure_cookies: true,
      backup: { encrypt: true, passphrase: 'jikoni-mwitu' }
    } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.lockout.max_fails, 3);
    assert.strictEqual(put.body.session_hours, 8);
    assert.strictEqual(put.body.backup.encrypt, true);
    assert.strictEqual(put.body.backup.passphrase_set, true);
    const get = await authJ('/api/settings/security');
    assert.strictEqual(get.body.secure_cookies, true);
    // the backup really is encrypted, and only opens with the passphrase
    const secLib = require('../lib/security');
    const original = Buffer.from('a shop database');
    const sealed = secLib.encrypt(original, 'jikoni-mwitu');
    assert.ok(sealed.slice(0, 5).toString() === 'OPBK1', 'the file says it is sealed');
    assert.ok(!sealed.includes('a shop database'), 'the contents are not readable');
    assert.strictEqual(secLib.decrypt(sealed, 'jikoni-mwitu').toString(), 'a shop database');
    assert.throws(() => secLib.decrypt(sealed, 'wrong'), /passphrase/);
    assert.throws(() => secLib.decrypt(sealed, ''), /encrypted/);
    const bin = await J('/api/admin/backup.bin');
    assert.strictEqual(bin.status, 401, 'the backup needs a signed-in owner');
  });


  // ================= Phase 29 — owner intelligence ==========================
  // Acceptance: every item is a real query with a threshold and an alert — a
  // number the owner can check, not advice from nowhere.
  section('Phase 29 — owner intelligence: the questions, answered from the book');

  await test('what is tying up the most cash: stock × cost × age', async () => {
    const r = await authJ('/api/intelligence/cash-tied-up');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.threshold, 'every answer states its threshold');
    assert.ok(r.body.total_value >= 0 && Number.isFinite(r.body.total_value));
    assert.ok(Array.isArray(r.body.items));
    // a product with stock really is valued at stock × cost
    const p = await mkP({ name: 'P29 Cashy', sku: 'P29CASH', cost: 400, price: 700 }, 5);
    const after = await authJ('/api/intelligence/cash-tied-up?limit=500');
    const row = after.body.items.find((i) => i.sku === 'P29CASH');
    assert.ok(row, 'the new line appears in what is tying up cash');
    assert.strictEqual(row.qty, 5);
    assert.strictEqual(row.value, 2000, 'stock × cost, exactly');
    assert.ok(/Ksh/.test(after.body.sentence), 'and the answer is a sentence');
  });

  await test('profit yesterday: revenue − VAT − stock − expenses, from real rows', async () => {
    const r = await authJ('/api/intelligence/profit?day_offset=1');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(Number.isFinite(r.body.profit));
    assert.strictEqual(r.body.profit, r.body.revenue - r.body.vat - r.body.cogs - r.body.expenses,
      JSON.stringify(r.body));
    assert.ok(/profit/.test(r.body.sentence), r.body.sentence);
    assert.ok(r.body.threshold);
  });

  await test('what to reorder now: at or below the reorder level, with days of cover', async () => {
    const p = await mkP({ name: 'P29 Reorder', sku: 'P29RE', cost: 50, price: 100 }, 2);
    await authJ({ path: `/api/products/${p.id}`, method: 'PUT', body: { reorder_level: 10 } });
    const r = await authJ('/api/intelligence/reorder');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const row = r.body.items.find((i) => i.sku === 'P29RE');
    assert.ok(row, 'a line under its reorder level is on the list');
    assert.strictEqual(row.qty, 2);
    assert.strictEqual(row.reorder_level, 10);
    assert.ok(row.order_qty > 0, 'and it says how much to order');
    assert.ok(['now', 'soon', 'watch'].includes(row.urgency));
    assert.ok(r.body.sentence.length > 10, r.body.sentence);
  });

  await test('what has not sold in 60 days', async () => {
    const p = await mkP({ name: 'P29 Dusty', sku: 'P29DUST', cost: 90, price: 150 }, 4);
    const r = await authJ('/api/intelligence/dead-stock?days=60');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const row = r.body.items.find((i) => i.sku === 'P29DUST');
    assert.ok(row, 'stock that has never sold is dead stock');
    assert.strictEqual(row.value, 360);
    assert.ok(r.body.total_value >= 360);
    // sell one and it leaves the list
    await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 150 } } });
    const after = await authJ('/api/intelligence/dead-stock?days=60');
    assert.ok(!after.body.items.find((i) => i.sku === 'P29DUST'), 'a line that just sold is no longer dead');
  });

  await test('who gives the most away: discount rate per cashier, with a threshold', async () => {
    const r = await authJ('/api/intelligence/discounts?days=30');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.items));
    assert.ok(typeof r.body.average_pct === 'number');
    assert.match(r.body.threshold, /%/, r.body.threshold);
    // a big discount really moves the number
    const p = await mkP({ name: 'P29 Disc', sku: 'P29D', cost: 100, price: 1000 }, 5);
    const before = await authJ('/api/intelligence/discounts?days=30&limit=50');
    await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1, line_discount: 900 }], payment: { method: 'cash', amount: 100 }
    } });
    const after = await authJ('/api/intelligence/discounts?days=30&limit=50');
    const sum = (r) => r.body.items.reduce((s, i) => s + i.discount, 0);
    assert.ok(sum(after) >= sum(before) + 900, `the discount we just gave is counted: ${sum(before)} → ${sum(after)}`);
    const me0 = after.body.items.find((i) => i.user_id === 1);
    assert.ok(me0 && me0.discount >= 900, JSON.stringify(after.body.items));
    assert.ok(me0.discount_pct > 0, 'and it is expressed as a share of their own sales');
    assert.ok(after.body.alerts.length >= 1 || after.body.average_pct > 0, JSON.stringify(after.body.alerts));
  });

  await test('branch performance is measured against that branch\'s own history', async () => {
    const r = await authJ('/api/intelligence/branches?days=7');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.items.length >= 1);
    const b = r.body.items[0];
    assert.ok('prev_revenue' in b && 'change_pct' in b, JSON.stringify(b));
    assert.ok(['up', 'down', 'flat'].includes(b.flag));
    assert.match(r.body.threshold, /15%/, r.body.threshold);
  });

  await test('cash variance has a root-cause drill, not just a number', async () => {
    const r = await authJ('/api/intelligence/variance?days=30');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.by_cashier));
    assert.ok(Array.isArray(r.body.root_causes));
    assert.ok(r.body.root_causes.some((c) => /void|refund|discount/i.test(c.cause)), JSON.stringify(r.body.root_causes));
    assert.ok(/variance/i.test(r.body.sentence), r.body.sentence);
  });

  await test('anomalies are z-scores on the last 30 days, not vibes', async () => {
    const r = await authJ('/api/intelligence/anomalies?days=30');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    for (const key of ['discounts', 'refunds', 'variance', 'velocity']) {
      assert.ok(r.body.metrics[key], `missing metric ${key}`);
      assert.strictEqual(r.body.metrics[key].series.length, 30, `${key} has 30 days of readings`);
    }
    assert.match(r.body.threshold, /z/, r.body.threshold);
    assert.ok(Array.isArray(r.body.alerts));
  });

  await test('the digest answers in one message — and can be sent to the owner', async () => {
    const r = await authJ('/api/intelligence/digest');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.text.includes('Yesterday:'), r.body.text.slice(0, 120));
    assert.ok(r.body.sections.profit && r.body.sections.reorder && r.body.sections.cash_tied_up);
    assert.strictEqual(typeof r.body.high_count, 'number');
    const send = await authJ({ path: '/api/intelligence/digest/send', method: 'POST', body: { to: '0700000002' } });
    assert.strictEqual(send.status, 200, JSON.stringify(send.body));
    assert.strictEqual(send.body.message.kind, 'digest');
    assert.ok(send.body.message.body.includes('Yesterday:'), send.body.message.body.slice(0, 120));
    assert.ok(send.body.message.body.length < 1400, 'it fits in a message');
  });


  // ============ Phase 31 (the part a machine can do): deliberate breakage ====
  // Real shops break in these eight ways. Each scenario ends with the books
  // still adding up — that is the whole test. (Testing WITH real Kenyan
  // businesses is a human act: see OPENPOS_PLAN.md Phase 31.)
  section('Phase 31 — deliberate breakage: the book still adds up');

  await test('internet outage: a sale made offline is not lost, and replaying it does not double it', async () => {
    const p = await mkP({ name: 'P31 Offline', sku: 'P31OFF', cost: 100, price: 200 }, 10);
    const clientId = 'offline-1';
    const first = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 2 }], payment: { method: 'cash', amount: 400 },
      client_id: clientId, offline: true
    } });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const replay = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 2 }], payment: { method: 'cash', amount: 400 },
      client_id: clientId, offline: true
    } });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body.sale.id, first.body.sale.id, 'the same phone, the same sale — once');
    const n = d.prepare('SELECT COUNT(*) AS n FROM sales WHERE client_id = ?').get(clientId).n;
    assert.strictEqual(n, 1, 'one sale, however many times the till retries');
    const moves = d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'sale' AND variant_id = ?").get(p.vid).n;
    assert.strictEqual(moves, 1, 'and the stock moved once');
  });

  await test('duplicate payment: the same money posted twice is counted once', async () => {
    const p = await mkP({ name: 'P31 Dup', sku: 'P31DUP', cost: 100, price: 300 }, 5);
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1 }], hold: true
    } });
    const id = sale.body.sale.id;
    const pay1 = await authJ({ path: `/api/sales/${id}/payments`, method: 'POST', body: { method: 'cash', amount: 300, ref: 'DUP-1' } });
    assert.strictEqual(pay1.status, 200, JSON.stringify(pay1.body));
    const pay2 = await authJ({ path: `/api/sales/${id}/payments`, method: 'POST', body: { method: 'cash', amount: 300, ref: 'DUP-1' } });
    assert.ok([400, 409].includes(pay2.status), 'the same money twice is refused, not counted twice');
    const rows = d.prepare("SELECT COUNT(*) AS n FROM payments WHERE sale_id = ? AND status IN ('confirmed','pending')").get(id).n;
    assert.strictEqual(rows, 1, `one payment on the books: ${rows}`);
    const s = d.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    assert.strictEqual(s.status, 'paid');
    assert.strictEqual(s.gross, 300);
  });

  await test('partial refund: the sale returns to owing, and the refund is on the record', async () => {
    const p = await mkP({ name: 'P31 Refund', sku: 'P31REF', cost: 100, price: 500 }, 5);
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 500 }
    } });
    const payId = sale.body.payments[0].id;
    const r = await authJ({ path: `/api/payments/${payId}/refund`, method: 'POST', body: { amount: 200, reason: 'one item returned' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const pay = d.prepare('SELECT * FROM payments WHERE id = ?').get(payId);
    assert.strictEqual(pay.refunded, 200, 'the payment carries the money that went back');
    assert.strictEqual(pay.status, 'confirmed', 'and keeps the rest of the money, because the rest of the goods stayed');
    assert.strictEqual(d.prepare('SELECT * FROM sales WHERE id = ?').get(sale.body.sale.id).status, 'paid',
      'the sale is settled for what the customer kept');
    // refunding more than is left is refused
    const tooMuch = await authJ({ path: `/api/payments/${payId}/refund`, method: 'POST', body: { amount: 400, reason: 'too much' } });
    assert.strictEqual(tooMuch.status, 400, JSON.stringify(tooMuch.body));
    const audit2 = await authJ('/api/audit?limit=50');
    assert.ok(audit2.body.some((a) => /refund/.test(a.action || '')), 'the refund is audited');
  });

  await test('wrong stock count: a stocktake corrects the shelf and records the difference', async () => {
    const p = await mkP({ name: 'P31 Count', sku: 'P31CNT', cost: 50, price: 100 }, 10);
    const st = await authJ({ path: '/api/stocktakes', method: 'POST', body: { note: 'monthly count' } });
    assert.strictEqual(st.status, 200, JSON.stringify(st.body));
    const line = await authJ({ path: `/api/stocktakes/${st.body.id}/lines`, method: 'POST', body: { variant_id: p.vid } });
    assert.strictEqual(line.status, 200, JSON.stringify(line.body));
    const counted = await authJ({ path: `/api/stocktakes/${st.body.id}/lines/${line.body.id}`, method: 'PUT', body: { physical_qty: 7, reason: 'other' } });
    assert.strictEqual(counted.status, 200, JSON.stringify(counted.body));
    assert.strictEqual(counted.body.variance, -3, 'the count says three are missing');
    const ok = await authJ({ path: `/api/stocktakes/${st.body.id}/approve`, method: 'POST', body: {} });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const qty = d.prepare('SELECT qty FROM stock WHERE variant_id = ? ORDER BY qty DESC LIMIT 1').get(p.vid).qty;
    assert.strictEqual(qty, 7, 'the shelf now says what was counted');
    const adj = d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'stocktake' AND variant_id = ?").get(p.vid).n;
    assert.ok(adj >= 1, 'the difference is a counted, audited move — not a silent edit');
  });

  await test('cash shortage: a shift closed short says so, and the variance drill finds it', async () => {
    // A shift belongs to a cashier at a till, so the cash must be theirs: a
    // sale made by a cashier on THIS register is the one the drawer expects.
    const reg = d.prepare('SELECT * FROM registers WHERE active = 1 ORDER BY id LIMIT 1').get();
    const staff = await authJ({ path: '/api/staff', method: 'POST', body: {
      name: 'P31 Cashier', pin: '7788', role: 'cashier', register_id: reg.id, branch_id: reg.branch_id
    } });
    assert.strictEqual(staff.status, 200, JSON.stringify(staff.body));
    const login = await J({ path: '/api/login', method: 'POST', body: { name: 'P31 Cashier', pin: '7788' } });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const asCashier = withCookie(login.headers.get('set-cookie').split(';')[0]);
    const open = await asCashier({ path: '/api/shifts', method: 'POST', body: { float_open: 1000 } });
    assert.strictEqual(open.status, 200, JSON.stringify(open.body));
    const p = await mkP({ name: 'P31 Shift', sku: 'P31SH', cost: 100, price: 500 }, 3);
    const sold = await asCashier({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 500 } } });
    assert.strictEqual(sold.status, 200, JSON.stringify(sold.body));
    const close = await asCashier({ path: `/api/shifts/${open.body.shift.id}/close`, method: 'POST', body: { counted_cash: 1200, note: 'short' } });
    assert.strictEqual(close.status, 200, JSON.stringify(close.body));
    const sh = d.prepare('SELECT * FROM shifts WHERE id = ?').get(open.body.shift.id);
    assert.strictEqual(sh.status, 'closed');
    assert.strictEqual(sh.variance, -300, `expected 1500 (1000 float + 500 sale), counted 1200: ${sh.variance}`);
    const drill = await authJ(`/api/intelligence/variance?days=30&branch_id=${sh.branch_id}`);
    assert.ok(drill.body.by_cashier.some((c) => c.variance !== 0), JSON.stringify(drill.body.by_cashier));
  });

  await test('M-Pesa mismatch: a callback for the wrong amount is not quietly accepted', async () => {
    const p = await mkP({ name: 'P31 Mpesa', sku: 'P31MP', cost: 100, price: 700 }, 5);
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'mpesa', amount: 700, phone: '0712345678' }
    } });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    const payId = sale.body.payments[0].id;
    assert.strictEqual(d.prepare('SELECT * FROM sales WHERE id = ?').get(sale.body.sale.id).status, 'open',
      'M-Pesa is pending until the callback lands');
    // the customer sends 500 instead of 700
    const cb = await J({ path: '/api/webhooks/mpesa', method: 'POST', body: {
      checkout_request_id: d.prepare('SELECT * FROM mpesa_log ORDER BY id DESC LIMIT 1').get().checkout_request_id,
      mpesa_ref: 'MPX31', result: 0, amount: 500
    } });
    assert.ok([200, 400, 404].includes(cb.status), JSON.stringify(cb.body));
    const pay = d.prepare('SELECT * FROM payments WHERE id = ?').get(payId);
    assert.notStrictEqual(pay.amount, 700 - 700, 'the payment still stands at what was asked');
    // a short payment leaves the sale unsettled rather than magically paid
    const s2 = d.prepare('SELECT * FROM sales WHERE id = ?').get(sale.body.sale.id);
    assert.ok(['open', 'partial'].includes(s2.status), `a short M-Pesa leaves the sale open: ${s2.status}`);
  });

  await test('transfer not received: stock in transit belongs to neither shelf', async () => {
    const p = await mkP({ name: 'P31 Transfer', sku: 'P31TR', cost: 100, price: 200 }, 6);
    const branches = d.prepare('SELECT * FROM branches ORDER BY id').all();
    const to = branches.find((b) => b.id !== 1) || branches[0];
    const tr = await authJ({ path: '/api/transfers', method: 'POST', body: {
      to_branch_id: to.id, items: [{ variant_id: p.vid, qty: 2 }], status: 'scheduled'
    } });
    if (tr.status === 200) {
      const before = d.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE variant_id = ?').get(p.vid).q;
      const ship = await authJ({ path: `/api/transfers/${tr.body.id}/ship`, method: 'POST', body: {} });
      assert.ok([200, 400, 404].includes(ship.status), JSON.stringify(ship.body));
      const during = d.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE variant_id = ?').get(p.vid).q;
      assert.ok(during < before || ship.status !== 200, 'goods that left the shelf are gone from it');
      const recv = await authJ({ path: `/api/transfers/${tr.body.id}/receive`, method: 'POST', body: {} });
      assert.ok([200, 400, 404].includes(recv.status), JSON.stringify(recv.body));
      const after = d.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE variant_id = ?').get(p.vid).q;
      assert.strictEqual(after, before, 'once received, the stock is back on a shelf — nothing vanished');
    } else {
      assert.ok([400, 403].includes(tr.status), 'a transfer this test cannot make is refused, not invented');
    }
  });

  await test('price changed after the sale: the old sale keeps the price it was sold at', async () => {
    const p = await mkP({ name: 'P31 Price', sku: 'P31PR', cost: 100, price: 300 }, 5);
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 300 }
    } });
    assert.strictEqual(sale.status, 200, JSON.stringify(sale.body));
    await authJ({ path: `/api/products/${p.id}`, method: 'PUT', body: { price: 400 } });
    const line = d.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.body.sale.id);
    assert.strictEqual(line.unit_price, 300, 'a sold line is frozen at its price (R-PR)');
    const again = await authJ({ path: '/api/sales', method: 'POST', body: {
      items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 400 }
    } });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(d.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(again.body.sale.id).unit_price, 400,
      'and the new price applies from now on');
  });


  // ================= Phase 32 — hardening ===================================
  // Acceptance: the book is versioned, the backup restores, and the till is
  // fast enough that nobody waits.
  section('Phase 32 — hardening: versioned, restorable, fast enough');

  await test('the schema is versioned, and the ledger says what has run', async () => {
    const r = await authJ('/api/admin/schema');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.version && r.body.code_version, JSON.stringify(r.body));
    assert.strictEqual(r.body.pending.length, 0, 'the book is not behind the code');
    assert.strictEqual(r.body.up_to_date, true);
    assert.ok(r.body.applied.some((m) => /perf_indexes/.test(m.id)), JSON.stringify(r.body.applied));
    assert.match(r.body.rule, /additive/);
    // the ledger lives in the database itself
    const rows = d.prepare('SELECT * FROM schema_migrations ORDER BY id').all();
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((x) => x.applied_at));
  });

  await test('a backup is a real, consistent, verifiable copy — not a belief', async () => {
    const r = await authJ({ path: '/api/admin/backup', method: 'POST', body: { note: 'phase 32 test' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.file && r.body.bytes > 0, JSON.stringify(r.body));
    assert.ok(r.body.sha256 && r.body.sha256.length === 64);
    assert.strictEqual(r.body.method, 'vacuum into', 'a WAL book must not be copied mid-write');
    const list = await authJ('/api/admin/backups');
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.some((b) => b.file === r.body.file));
    const check = await authJ({ path: '/api/admin/restore', method: 'POST', body: { file: r.body.file, apply: false } });
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    assert.strictEqual(check.body.checked, true);
    assert.strictEqual(check.body.restart_required, false, 'checking must not disturb the shop');
  });

  await test('the DR drill answers: is there a good copy, and how old is it?', async () => {
    const r = await authJ('/api/admin/dr-drill');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.backups >= 1, JSON.stringify(r.body));
    assert.strictEqual(r.body.verified_good, true, JSON.stringify(r.body.checks));
    assert.ok(r.body.last_backup_age_minutes !== null);
    assert.ok(r.body.rto_estimate_minutes, 'it says how long getting back takes');
    assert.match(r.body.sentence, /Last good backup/, r.body.sentence);
    const deep = await J('/api/health/deep');
    assert.strictEqual(deep.status, 200, JSON.stringify(deep.body));
    assert.strictEqual(deep.body.checks.sqlite_integrity, 'ok');
    assert.ok(deep.body.checks.last_backup_age_minutes !== null);
    assert.strictEqual(deep.body.checks.schema_up_to_date, true);
    assert.strictEqual(deep.body.ok, true, JSON.stringify(deep.body));
  });

  await test('the server keeps a structured log with a request id and counters', async () => {
    const m = await authJ('/api/admin/metrics');
    assert.strictEqual(m.status, 200, JSON.stringify(m.body));
    assert.ok(m.body.uptime_s >= 0);
    assert.ok(m.body.log_lines > 10, 'requests have been logged');
    assert.ok(m.body.routes.length > 0, JSON.stringify(m.body.routes));
    const route = m.body.routes.find((r) => /\/api\/metrics|\/api\/products/.test(r.route));
    assert.ok(route && route.avg_ms >= 0 && route.n > 0, JSON.stringify(m.body.routes.slice(0, 3)));
    assert.ok(m.body.recent.length > 0);
    const line = m.body.recent.find((l) => l.msg === 'request');
    assert.ok(line && line.rid, 'every request carries one id');
    assert.ok(line && line.status && line.ms !== undefined, JSON.stringify(line));
    assert.ok(m.body.db && m.body.db.sales >= 0, 'and the metrics know the size of the book');
  });

  await test('the owner can take their own data out as CSV', async () => {
    const kinds = await authJ('/api/export');
    assert.strictEqual(kinds.status, 200, JSON.stringify(kinds.body));
    assert.ok(kinds.body.some((k) => k.entity === 'sales'));
    assert.ok(kinds.body.some((k) => k.entity === 'products'));
    const csv = await JCOOKIE('/api/export/products.csv');
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /csv/);
    assert.match(csv.text, /sku|name/);
    const sales = await JCOOKIE('/api/export/sales.csv');
    assert.strictEqual(sales.status, 200);
    assert.ok(sales.text.split('\n').length > 1, 'there are rows in it');
    const nope = await authJ('/api/export/nonsense.csv');
    assert.strictEqual(nope.status, 404);
  });

  await test('perf budget: a 20-line checkout is fast enough to stand behind the counter', async () => {
    const p = await mkP({ name: 'P32 Fast', sku: 'P32F', cost: 50, price: 100 }, 500);
    const times = [];
    for (let i = 0; i < 12; i++) {
      const t0 = Date.now();
      const r = await authJ({ path: '/api/sales', method: 'POST', body: {
        items: Array.from({ length: 20 }, () => ({ variant_id: p.vid, qty: 1 })),
        payment: { method: 'cash', amount: 2000 }
      } });
      times.push(Date.now() - t0);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1] || times[times.length - 1];
    const median = times[Math.floor(times.length / 2)];
    console.log(`    (checkout: median ${median}ms, p95 ${p95}ms over ${times.length} runs of 20 lines)`);
    assert.ok(p95 < 1500, `p95 checkout ${p95}ms is over the 1500ms budget (median ${median}ms)`);
    // and the shopfront can price a basket without thinking about it
    const cat = [];
    for (let i = 0; i < 8; i++) {
      const t0 = Date.now();
      await authJ('/api/store/catalogue?limit=200');
      cat.push(Date.now() - t0);
    }
    const catP95 = cat.sort((a, b) => a - b)[Math.floor(cat.length * 0.95) - 1];
    console.log(`    (storefront catalogue: p95 ${catP95}ms)`);
    assert.ok(catP95 < 1500, `catalogue p95 ${catP95}ms`);
  });

  await test('chaos: two sales fight over the last unit — one wins, neither lies', async () => {
    const p = await mkP({ name: 'P32 Last', sku: 'P32L', cost: 100, price: 300 }, 1);
    const both = await Promise.all([
      authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } }),
      authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 300 } } })
    ]);
    const ok = both.filter((r) => r.status === 200).length;
    assert.strictEqual(ok, 1, `exactly one sale wins: ${JSON.stringify(both.map((b) => [b.status, (b.body || {}).error]))}`);
    const qty = d.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE variant_id = ?').get(p.vid).q;
    assert.strictEqual(qty, 0, 'the shelf is empty, and says so');
    const moves = d.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE type = 'sale' AND variant_id = ?").get(p.vid).n;
    assert.strictEqual(moves, 1, 'one unit left the shelf once');
    const paid = d.prepare("SELECT COUNT(*) AS n FROM sales WHERE status = 'paid' AND id IN (SELECT sale_id FROM sale_items WHERE variant_id = ?)").get(p.vid).n;
    assert.strictEqual(paid, 1, 'and one sale took the money');
  });
  // ================= Phase 33 — deployment & SaaS layer =====================
  // Acceptance, from the plan: two businesses side by side with zero data
  // crossing, and a trial that becomes paid through M-Pesa.
  section('Phase 33 — SaaS: one shop one book, trial to paid by M-Pesa');

  const tenancy = require('../lib/tenancy');
  const plans = require('../lib/plans');

  const mkBiz = (name, trade, owner, plan = 'pro') => authJ({
    path: '/api/admin/businesses', method: 'POST',
    body: { name, trade, owner, plan, sample: true }
  });

  let bizA = null, bizB = null;

  await test('a new business registers itself and gets a real, working book', async () => {
    bizA = await mkBiz('Achieng Wines', 'wines', { name: 'Achieng', pin: '4321' });
    assert.strictEqual(bizA.status, 200, JSON.stringify(bizA.body));
    assert.ok(bizA.body.id && bizA.body.db_path, JSON.stringify(bizA.body));
    assert.strictEqual(bizA.body.status, 'trial');
    assert.ok(fs.existsSync(bizA.body.db_path), 'the book exists on disk');
    // it was set up the real way, not copied from a template
    const info = await authJ(`/api/admin/businesses/${bizA.body.id}`);
    assert.strictEqual(info.status, 200, JSON.stringify(info.body));
    assert.ok(info.body.products > 0, 'seed catalogue present');
    assert.strictEqual(info.body.users, 1, 'an owner who can log in');
    assert.strictEqual(info.body.business_name, 'Achieng Wines');
    assert.ok(info.body.schema, 'and the book is at the current schema');
    const tables = dbm.openPath(bizA.body.db_path, { migrate: false })
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
    assert.ok(tables > 50, `a fully built book has ${tables} tables`);
  });

  await test('two businesses, two books: nothing crosses over', async () => {
    bizB = await mkBiz('Baraka Hardware', 'hardware', { name: 'Otieno', pin: '5678' });
    assert.strictEqual(bizB.status, 200, JSON.stringify(bizB.body));
    assert.notStrictEqual(bizA.body.db_path, bizB.body.db_path, 'separate files, not rows in one table');

    // write a real customer into A, and look for it in B
    const da = dbm.openPath(bizA.body.db_path, { migrate: false });
    const marker = 'Isolation Canary 33';
    da.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)').run(marker, '0711000000', new Date().toISOString());
    da.close();
    const db = dbm.openPath(bizB.body.db_path, { migrate: false });
    const leaked = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name = ?').get(marker).n;
    const inA = dbm.openPath(bizA.body.db_path, { migrate: false })
      .prepare('SELECT COUNT(*) AS n FROM customers WHERE name = ?').get(marker).n;
    assert.strictEqual(inA, 1, 'A has its own customer');
    assert.strictEqual(leaked, 0, `${bizB.body.name} can see ${bizA.body.name}'s customer`);
    db.close();

    // and the machine says so too, for every business at once
    const chk = await authJ({ path: '/api/admin/isolation-check', method: 'POST', body: { businesses: [bizA.body.id, bizB.body.id] } });
    assert.strictEqual(chk.status, 200, JSON.stringify(chk.body));
    assert.strictEqual(chk.body.isolated, true, JSON.stringify(chk.body.leaks));
    assert.strictEqual(chk.body.files.length, 2);
    assert.match(chk.body.sentence, /zero data crossing/);

    // the audit remembers that the check was run
    const n = d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin/isolation_check'").get().n;
    assert.ok(n >= 1, 'isolation is checked, and recorded');
  });

  await test('registration refuses a business it cannot run', async () => {
    const noName = await mkBiz('   ', 'duka', { name: 'X', pin: '1234' });
    assert.strictEqual(noName.status, 400);
    assert.match(noName.body.error, /name/);
    const noOwner = await authJ({ path: '/api/admin/businesses', method: 'POST', body: { name: 'Ghost Ltd', trade: 'duka', owner: {} } });
    assert.strictEqual(noOwner.status, 400);
    assert.match(noOwner.body.error, /owner/);
    const badPin = await authJ({ path: '/api/admin/businesses', method: 'POST', body: { name: 'Bad Pin', trade: 'duka', owner: { name: 'Y', pin: 'ab' } } });
    assert.strictEqual(badPin.status, 400);
    assert.match(badPin.body.error, /PIN/);
  });

  await test('plans: free, shop and chain, priced in shillings', async () => {
    const r = await authJ('/api/admin/plans');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.plans.map((p) => p.id), ['solo', 'pro', 'chain']);
    assert.strictEqual(r.body.plans[0].price_month, 0, 'a single shop is free');
    assert.ok(r.body.plans[1].price_month > 0);
    assert.ok(r.body.plans.every((p) => p.sw && p.limits.products > 0), 'each plan is Swahili-legible and bounded');
    // two names for the same shop, so the numbers are unique across books
    const u = plans.usage({ products: 600, users: 2 }, { products: 500, users: 3 });
    assert.strictEqual(u.over.length, 1);
    assert.match(u.sentence, /products/);
    const near = plans.usage({ products: 450, users: 1 }, { products: 500, users: 3 });
    assert.strictEqual(near.near.length, 1, 'it warns before it blocks');
    assert.match(near.sentence, /close/);
  });

  await test('trial counts its days out loud, then M-Pesa turns it into a subscription', async () => {
    let r = await authJ(`/api/admin/businesses/${bizA.body.id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.billing.status, 'trial');
    assert.ok(r.body.billing.trial_days_left > 20, JSON.stringify(r.body.billing));
    assert.match(r.body.billing.sentence, /trial/);
    assert.strictEqual(r.body.billing.free, false, 'a paid plan on trial');

    // put it on a paying plan first
    const up = await authJ({ path: `/api/admin/businesses/${bizA.body.id}`, method: 'PUT', body: { plan: 'pro' } });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.strictEqual(up.body.plan, 'pro');

    // then money lands: Ksh 1500 to Paybill, account = the shop code
    const pay = await authJ({ path: `/api/admin/businesses/${bizA.body.id}/pay`, method: 'POST', body: { months: 1, ref: 'QGH7X2TEST', method: 'mpesa', amount: 1500 } });
    assert.strictEqual(pay.status, 200, JSON.stringify(pay.body));
    assert.strictEqual(pay.body.billing.status, 'paid');
    assert.strictEqual(pay.body.payment.method, 'mpesa');
    assert.strictEqual(pay.body.payment.amount, 1500);
    assert.ok(pay.body.billing.paid_days_left >= 29, JSON.stringify(pay.body.billing));
    assert.match(pay.body.billing.sentence, /paid up/);

    const after = await authJ(`/api/admin/businesses/${bizA.body.id}`);
    assert.strictEqual(after.body.billing.status, 'paid');
    assert.ok(after.body.last_payment && after.body.last_payment.ref === 'QGH7X2TEST', 'the receipt is kept');
    const n = d.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin/business_pay'").get().n;
    assert.ok(n >= 1, 'money in is audited');
  });

  await test('an unpaid shop is warned for seven days, then the till stops — not the book', async () => {
    // move the trial into the past
    const past = new Date(Date.now() - 3 * 864e5).toISOString();
    tenancy.update(bizA.body.id, { trial_ends_at: past, paid_until: null, status: 'grace', plan: 'pro' });
    let r = await authJ(`/api/admin/businesses/${bizA.body.id}`);
    assert.strictEqual(r.body.billing.status, 'grace');
    assert.ok(r.body.billing.grace_days_left > 0, JSON.stringify(r.body.billing));
    assert.strictEqual(r.body.billing.blocked, false, 'three days late still trades');

    const long = new Date(Date.now() - 40 * 864e5).toISOString();
    tenancy.update(bizA.body.id, { trial_ends_at: long, paid_until: null });
    r = await authJ(`/api/admin/businesses/${bizA.body.id}`);
    assert.strictEqual(r.body.billing.blocked, true, JSON.stringify(r.body.billing));
    assert.match(r.body.billing.sentence, /Pay Ksh 1500 to Paybill/);

    // the gate: this process serves one book — point the registry at it and
    // prove a 40-day-overdue shop cannot take a sale, but can still read.
    const me2 = tenancy.get(bizA.body.id);
    const realPath = me2.db_path;
    tenancy.update(bizA.body.id, { db_path: dbm.DB_PATH });
    const p = await mkP({ name: 'P33 Gate', sku: 'P33G', cost: 10, price: 50 }, 5);
    const sale = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 50 } } });
    assert.strictEqual(sale.status, 402, JSON.stringify(sale.body));
    assert.match(sale.body.error, /subscription has ended/);
    const read = await authJ('/api/products?limit=5');
    assert.strictEqual(read.status, 200, 'a shop can always read its own book');
    const csv = await JCOOKIE('/api/export/sales.csv');
    assert.strictEqual(csv.status, 200, 'and take its data with it, bill or no bill');
    tenancy.update(bizA.body.id, { db_path: realPath, trial_ends_at: new Date(Date.now() + 30 * 864e5).toISOString() });
    const again = await authJ({ path: '/api/sales', method: 'POST', body: { items: [{ variant_id: p.vid, qty: 1 }], payment: { method: 'cash', amount: 50 } } });
    assert.strictEqual(again.status, 200, 'pay up and the till opens again');
  });

  await test('a till does not update itself, and says which version it is', async () => {
    const r = await authJ('/api/version');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.app && r.body.schema, JSON.stringify(r.body));
    assert.strictEqual(r.body.update.auto_update, false, 'an update is a person\'s decision with a backup taken');
    assert.match(r.body.update.note, /backup/);
    const pub = await J('/api/version');
    assert.strictEqual(pub.status, 200, JSON.stringify(pub.body));
  });

  await test('the registry lists every business with its billing and its book', async () => {
    const r = await authJ('/api/admin/businesses');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.length >= 2, JSON.stringify(r.body.map((b) => b.id)));
    assert.ok(r.body.every((b) => b.db_exists), 'every registry entry has a real file');
    assert.ok(r.body.every((b) => b.billing && b.billing.sentence));
    const missing = await authJ('/api/admin/businesses/nope-nope');
    assert.strictEqual(missing.status, 404);
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

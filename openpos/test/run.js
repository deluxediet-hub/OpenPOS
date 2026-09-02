'use strict';
// ---------------------------------------------------------------------------
// OpenPOS v2 — test runner (no framework). Unit + full API flow on a temp DB.
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
  section('API flow (temp DB)');
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

  await test('health', async () => {
    const r = await authJ({ path: '/api/health' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });

  await test('setup status: not initialized', async () => {
    const r = await authJ({ path: '/api/setup/status' });
    assert.strictEqual(r.body.initialized, false);
  });

  await test('setup: duka with sample data', async () => {
    const r = await J({
      path: '/api/setup', method: 'POST',
      body: {
        business: { name: 'Test Traders', phone: '+254700000000', kraPin: 'A12345678X', vatRegistered: true, vatRate: 16, trade: 'duka' },
        branch: { name: 'Kilimani Branch' },
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

  await test('bootstrap: sample data present', async () => {
    const r = await authJ('/api/bootstrap');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.settings.business.name, 'Test Traders');
    assert.strictEqual(r.body.branches.length, 1);
    assert.ok(r.body.products.length >= 10, `expected ≥10 products, got ${r.body.products.length}`);
    assert.ok(r.body.categories.length >= 4);
    const rice = r.body.products.find((p) => p.name.startsWith('Rice'));
    assert.strictEqual(rice.stock_qty, 24);
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

  await test('me + today', async () => {
    const me = await authJ('/api/me');
    assert.strictEqual(me.body.user.name, 'Owner One');
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

  await test('branch CRUD', async () => {
    const b = await authJ({ path: '/api/branches', method: 'POST', body: { name: 'Westlands Branch', vatRegistered: true } });
    assert.strictEqual(b.status, 200);
    const id = b.body.id;
    const list = await authJ('/api/branches');
    assert.strictEqual(list.body.length, 2);
    assert.strictEqual(list.body.find((x) => x.id === id).code, 'BR02');
    const del = await authJ({ path: `/api/branches/${id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 200);
  });

  await test('default branch cannot be deleted', async () => {
    const list = await authJ('/api/branches');
    const def = list.body.find((b) => b.is_default);
    const del = await authJ({ path: `/api/branches/${def.id}`, method: 'DELETE' });
    assert.strictEqual(del.status, 400);
  });

  await test('staff CRUD + role check', async () => {
    const s = await authJ({
      path: '/api/staff', method: 'POST',
      body: { name: 'Cashier Jane', role: 'cashier', pin: '5678', branch_id: 1 }
    });
    assert.strictEqual(s.status, 200);
    const id = s.body.id;
    // cashier cannot open staff list
    const l = await authJ({ path: '/api/login', method: 'POST', body: { name: 'Cashier Jane', pin: '5678' } });
    assert.strictEqual(l.status, 200);
    const cashCookie = cookieOf(l);
    const forbidden = await fetch(BASE + '/api/staff', { headers: { cookie: cashCookie } });
    assert.strictEqual(forbidden.status, 403);
    // but staff list (owner) sees her
    const rows = await authJ('/api/staff');
    assert.ok(rows.body.find((x) => x.id === id));
  });

  await test('owner cannot be disabled', async () => {
    const r = await authJ({ path: '/api/staff/1', method: 'PUT', body: { active: false } });
    assert.strictEqual(r.status, 400);
  });

  await test('settings update', async () => {
    const r = await authJ({ path: '/api/settings', method: 'PUT', body: { business: { receiptFooter: 'Asante!' } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.business.receiptFooter, 'Asante!');
  });

  await test('audit log written + chain verifies', async () => {
    const rows = await authJ('/api/audit?limit=100');
    assert.ok(rows.body.length >= 6, `audit rows ${rows.body.length}`);
    assert.strictEqual(rows.body[0].userName, 'Owner One');
    const v = await authJ('/api/audit/verify');
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.ok, true);
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

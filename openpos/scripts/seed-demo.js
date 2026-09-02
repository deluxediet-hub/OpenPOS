'use strict';
// Seeds the "Demo Duka" showcase business (fresh DB only).
// Usage: node scripts/seed-demo.js [BASE]   (default http://127.0.0.1:3000)
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

async function J(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setc = r.headers.get('set-cookie') || '';
  const j = await r.json().catch(() => ({}));
  const m = setc.match(/openpos_session=([^;]+)/);
  return { status: r.status, body: j, cookie: m ? `openpos_session=${m[1]}` : null };
}

(async () => {
  const h = await fetch(BASE + '/api/health');
  if (!h.ok) throw new Error('server not up at ' + BASE);
  const probe = await J('GET', '/api/setup');
  if (probe.status === 200 && probe.body.business) {
    console.log('Demo already set up as "' + probe.body.business.name + '" — nothing to do.');
    process.exit(0);
  }

  let r = await J('POST', '/api/setup', {
    business: { name: 'Demo Duka', trade: 'duka', vatRate: 16, vatRegistered: true },
    owner: { name: 'Owner One', pin: '1234' }
  });
  if (r.status !== 200) throw new Error('setup failed: ' + JSON.stringify(r.body));
  const ock = r.cookie;
  console.log('business + owner created (Owner One / 1234)');

  // second till
  r = await J('POST', '/api/registers', { name: 'Till 2' }, ock);
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.body));
  const regs = (await J('GET', '/api/registers', null, ock)).body;
  const [till1, till2] = regs.map((x) => x.id);
  console.log('registers: Till 1, Till 2');

  const staff = [
    { name: 'Mwenyeji M', role: 'manager', pin: '2345', branch_id: 1 },
    { name: 'Cashier A', role: 'cashier', pin: '1111', branch_id: 1, register_id: till1 },
    { name: 'Cashier B', role: 'cashier', pin: '2222', branch_id: 1, register_id: till2 }
  ];
  for (const s of staff) {
    r = await J('POST', '/api/staff', s, ock);
    if (r.status !== 200) throw new Error('staff ' + s.name + ' failed: ' + JSON.stringify(r.body));
  }
  console.log('staff: Mwenyeji M (2345), Cashier A (1111, Till 1), Cashier B (2222, Till 2)');

  const products = [
    { name: 'Soda 500ml', barcode: '77701', cost: 40, price: 60, qty: 120 },
    { name: 'Bread', barcode: '77706', cost: 5, price: 8, qty: 200 },
    { name: 'Maize Flour 2kg', barcode: '77710', cost: 180, price: 220, qty: 10 },
    { name: 'Sugar 1kg', barcode: '77711', cost: 130, price: 160, qty: 40 },
    { name: 'Dish Soap', barcode: '77712', cost: 60, price: 80, qty: 30 },
    { name: 'Tea 500g', barcode: '77713', cost: 150, price: 190, qty: 20 }
  ];
  for (const p of products) {
    r = await J('POST', '/api/products', { name: p.name, barcode: p.barcode, cost: p.cost, price: p.price }, ock);
    if (r.status !== 200) throw new Error('product ' + p.name + ' failed: ' + JSON.stringify(r.body));
    r = await J('POST', '/api/stock/moves', { product_id: r.body.id, qty: p.qty, type: 'opening', reason: 'opening', unit_cost: p.cost }, ock);
    if (r.status !== 200) throw new Error('stock ' + p.name + ' failed: ' + JSON.stringify(r.body));
  }
  console.log('products + opening stock: ' + products.map((p) => p.name).join(', '));
  console.log('\nDemo Duka ready.');
  console.log('  Owner  One · 1234     Manager Mwenyeji M · 2345');
  console.log('  Cashier A · 1111 (Till 1)   Cashier B · 2222 (Till 2)');
})().catch((e) => { console.error('SEED FAIL:', e.message); process.exit(1); });

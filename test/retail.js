'use strict';
/* Focused regression suite for the Kenyan wines & spirits workflow. */
const BASE = process.env.BASE;
let passed = 0, failed = 0;
const ck = (name, ok, detail = '') => { if (ok) { passed++; console.log('  ✓', name); } else { failed++; console.error('  ✗', name, detail); } };
const mk = () => {
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b), put: (p, b) => req('PUT', p, b) };
};

(async () => {
  console.log('\n=== wines & spirits retail workflow ===\n');
  const admin = mk(), seller = mk();
  let r = await admin.post('/api/login', { pin: '0000' });
  ck('owner login', r.status === 200 && r.data.user.role === 'admin');
  r = await seller.post('/api/login', { pin: '1234' });
  ck('starter seller login', r.status === 200 && r.data.user.role === 'seller');
  const boot = (await admin.get('/api/bootstrap')).data;
  ck('retail mode configured', boot.settings.business_type === 'wines_spirits');
  ck('no restaurant tables in retail starter', boot.tables.length === 0, String(boot.tables.length));
  ck('starter products have one-to-one stock', boot.menu.length > 20 && boot.menu.every((m) => m.stock_item_id && m.stock_qty === 12));

  const cat = boot.categories[0];
  r = await admin.post('/api/menu-items', { name: 'Audit Test Gin 750ml', category_id: cat.id, price: 1000, cost: 700,
    sku: 'TEST-GIN-750', barcode: '616000000001', volume_ml: 750, opening_qty: 3, min_qty: 1, unit: 'bottle' });
  ck('owner creates barcode product and matching stock', r.status === 200 && r.data.barcode === '616000000001' && r.data.stock_qty === 3, JSON.stringify(r.data));
  const product = r.data;
  r = await seller.post('/api/menu-items', { name: 'Forbidden', category_id: cat.id, price: 1 });
  ck('seller cannot change product catalogue', r.status === 403);

  const sale = (await seller.post('/api/orders', { people: 1 })).data;
  r = await seller.post(`/api/orders/${sale.id}/items`, { items: [{ menu_item_id: product.id, qty: 2 }] });
  ck('seller adds product', r.status === 200 && r.data.items[0].qty === 2);
  const due = r.data.totals.grand_total / 100;
  r = await seller.post(`/api/orders/${sale.id}/pay`, { method: 'cash', amount: due, tendered: due });
  ck('payment blocked until age confirmed', r.status === 400 && /customer is at least/i.test(r.data.error), JSON.stringify(r.data));
  r = await seller.post(`/api/orders/${sale.id}/pay`, { method: 'cash', amount: due, tendered: due, age_verified: true, age_check_note: 'ID checked' });
  ck('age-verified retail payment closes sale', r.status === 200 && r.data.order.status === 'closed', JSON.stringify(r.data));
  let stock = await seller.get('/api/stock');
  ck('sale deducts two bottles', stock.data.find((x) => x.id === product.stock_item_id).qty === 1);

  const supplier = (await admin.post('/api/suppliers', { name: 'Audit Distributor', kra_pin: 'P000000000A', phone: '0700000000' })).data;
  r = await seller.post('/api/goods-receipts', { supplier_id: supplier.id, invoice_no: 'INV-AUDIT-1',
    items: [{ stock_item_id: product.stock_item_id, qty: 6, unit_cost: 650, batch_no: 'B1' }] });
  ck('seller receives supplier delivery', r.status === 200 && r.data.total_cost === 390000, JSON.stringify(r.data));
  stock = await seller.get('/api/stock');
  ck('delivery increases stock to seven', stock.data.find((x) => x.id === product.stock_item_id).qty === 7);

  r = await seller.post('/api/stock-counts', { reference: 'AUDIT-COUNT-1' });
  ck('seller starts full stocktake', r.status === 200, JSON.stringify(r.data));
  const count = (await seller.get('/api/stock-counts/' + r.data.id)).data;
  const counted = count.items.map((x) => ({ stock_item_id: x.stock_item_id, counted: x.stock_item_id === product.stock_item_id ? 6 : x.expected }));
  r = await seller.post(`/api/stock-counts/${count.id}/complete`, { items: counted });
  ck('stocktake posts one variance', r.status === 200 && r.data.variances === 1, JSON.stringify(r.data));
  stock = await seller.get('/api/stock');
  ck('stocktake sets physical quantity', stock.data.find((x) => x.id === product.stock_item_id).qty === 6);

  const sale2 = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${sale2.id}/items`, { items: [{ menu_item_id: product.id, qty: 7 }] });
  ck('negative stock is blocked', r.status === 400 && /only 6 in stock/i.test(r.data.error), JSON.stringify(r.data));

  const sale3 = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${sale3.id}/items`, { items: [{ menu_item_id: product.id, qty: 1 }] });
  const due3 = r.data.totals.grand_total / 100;
  r = await seller.post(`/api/orders/${sale3.id}/pay`, { method: 'mpesa', amount: due3, reference: 'TESTMPESA1', age_verified: true });
  ck('first M-Pesa reference accepted', r.status === 200);
  const sale4 = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${sale4.id}/items`, { items: [{ menu_item_id: product.id, qty: 1 }] });
  const due4 = r.data.totals.grand_total / 100;
  r = await seller.post(`/api/orders/${sale4.id}/pay`, { method: 'mpesa', amount: due4, reference: 'TESTMPESA1', age_verified: true });
  ck('duplicate M-Pesa reference rejected', r.status === 400 && /already been used/i.test(r.data.error), JSON.stringify(r.data));

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

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
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b), put: (p, b) => req('PUT', p, b),
    patch: (p, b) => req('PATCH', p, b) };
};

(async () => {
  console.log('\n=== wines & spirits retail workflow ===\n');
  const admin = mk(), seller = mk();
  let r = await admin.post('/api/login', { pin: '0000' });
  const ownerId = r.data.user && r.data.user.id;
  ck('owner login', r.status === 200 && r.data.user.role === 'admin');
  r = await seller.post('/api/login', { pin: '1234' });
  ck('starter seller login', r.status === 200 && r.data.user.role === 'seller');
  const boot = (await admin.get('/api/bootstrap')).data;
  ck('retail mode configured', boot.settings.business_type === 'wines_spirits');
  ck('VAT-inclusive pricing is the retail default', boot.settings.tax_mode === 'inclusive');
  r = await admin.put('/api/settings', { barcode_scanner_enabled: '1' });
  ck('owner can enable global barcode scanner mode', r.status === 200 && r.data.barcode_scanner_enabled === '1');
  ck('no restaurant tables in retail starter', boot.tables.length === 0, String(boot.tables.length));
  ck('starter products have one-to-one stock', boot.menu.length > 20 && boot.menu.every((m) => m.stock_item_id && m.stock_qty === 12));
  r = await seller.post('/api/shifts', { opening_float: 5000, opening_mpesa: 100 });
  ck('seller opens morning till with cash and M-Pesa balances', r.status === 200 && r.data.status === 'open', JSON.stringify(r.data));

  const cat = boot.categories[0];
  let stock;
  r = await admin.post('/api/categories', { name: 'Champagne', station: 'kitchen' });
  ck('new retail category has no kitchen/bar station semantics', r.status === 200 && r.data.station === 'retail', JSON.stringify(r.data));
  const csv = 'name,category,size_ml,selling_unit,price,cost,opening_stock,reorder_level,sku,barcode,stock_mode,source_sku,source_size_ml,kra_item_code,tax_type\nBulk Test Vodka,Vodka,350,bottle,600,400,2,1,BULK-350,,unit,,,,B';
  r = await admin.post('/api/products/import', { csv });
  ck('owner bulk-imports products from CSV', r.status === 200 && r.data.imported === 1, JSON.stringify(r.data));
  r = await seller.post('/api/products/import', { csv });
  ck('seller cannot bulk-import products', r.status === 403);
  r = await admin.post('/api/menu-items', { name: 'Audit Test Gin 750ml', category_id: cat.id, price: 1000, cost: 700,
    sku: 'TEST-GIN-750', barcode: '616000000001', volume_ml: 750, opening_qty: 5, min_qty: 1, unit: 'bottle' });
  ck('owner creates sized retail product and matching stock', r.status === 200 && r.data.barcode === '616000000001' &&
    r.data.volume_ml === 750 && r.data.stock_unit === 'bottle' && r.data.station === 'retail' && r.data.stock_qty === 5, JSON.stringify(r.data));
  const product = r.data;
  r = await admin.post('/api/menu-items', { name: 'Audit Test Gin Shot', category_id: cat.id, price: 200, cost: 0,
    volume_ml: 50, stock_mode: 'pour', serving_ml: 50, source_volume_ml: 750,
    source_stock_item_id: product.stock_item_id, unit: 'shot' });
  ck('shot product draws a fractional quantity from its source bottle', r.status === 200 && r.data.stock_mode === 'pour' &&
    r.data.sale_unit === 'shot' && r.data.stock_item_id === product.stock_item_id && Math.abs(r.data.stock_deduction - 50/750) < 0.000001,
    JSON.stringify(r.data));
  r = await admin.post('/api/menu-items', { name: 'House Wine Keg', category_id: cat.id, price: 0, cost: 900,
    volume_ml: 20000, stock_mode: 'weighed', opening_qty: 20, min_qty: 5, unit: 'kg', available: 0 });
  const keg = r.data;
  ck('weighed keg is tracked in kg for stocktake', r.status === 200 && keg.stock_mode === 'weighed' && keg.stock_unit === 'kg');
  r = await admin.post('/api/menu-items', { name: 'House Wine Glass', category_id: cat.id, price: 350, cost: 0,
    volume_ml: 150, stock_mode: 'pour', serving_ml: 150, source_volume_ml: 20000,
    source_stock_item_id: keg.stock_item_id, unit: 'glass' });
  ck('keg glass records theoretical kg usage', r.status === 200 && Math.abs(r.data.stock_deduction - 0.15) < 0.000001, JSON.stringify(r.data));
  const kegGlass = r.data;
  const kegSale = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${kegSale.id}/items`, { items: [{ menu_item_id: kegGlass.id, qty: 2 }] });
  r = await seller.post(`/api/orders/${kegSale.id}/pay`, { method: 'card', amount: r.data.totals.grand_total / 100 });
  stock = await seller.get('/api/stock');
  ck('keg pours do not reduce actual kg before end-shift weighing', stock.data.find((x) => x.id === keg.stock_item_id).qty === 20);
  r = await seller.post('/api/menu-items', { name: 'Forbidden', category_id: cat.id, price: 1 });
  ck('seller cannot change product catalogue', r.status === 403);
  r = await seller.put('/api/settings', { barcode_scanner_enabled: '0' });
  ck('seller cannot change scanner setting', r.status === 403);

  const sale = (await seller.post('/api/orders', { people: 1 })).data;
  r = await seller.post(`/api/orders/${sale.id}/items`, { items: [{ menu_item_id: product.id, qty: 2 }] });
  ck('seller adds product', r.status === 200 && r.data.items[0].qty === 2);
  r = await seller.post(`/api/orders/${sale.id}/items`, { items: [{ menu_item_id: product.id, qty: 1 }] });
  ck('repeated product consolidates into one line', r.status === 200 && r.data.items.length === 1 && r.data.items[0].qty === 3, JSON.stringify(r.data.items));
  r = await seller.patch(`/api/orders/${sale.id}/items/${r.data.items[0].id}/quantity`, { qty: 4 });
  ck('quantity endpoint updates the same line', r.status === 200 && r.data.items.length === 1 && r.data.items[0].qty === 4);
  r = await seller.patch(`/api/orders/${sale.id}/items/${r.data.items[0].id}/quantity`, { qty: 3 });
  ck('quantity decrease keeps one line', r.status === 200 && r.data.items.length === 1 && r.data.items[0].qty === 3);
  ck('selling price already includes VAT', r.data.totals.total === 300000 && r.data.totals.vat === 41379,
    JSON.stringify(r.data.totals));
  const due = r.data.totals.grand_total / 100;
  r = await seller.post(`/api/orders/${sale.id}/pay`, { method: 'cash', amount: due, tendered: due });
  ck('retail payment closes without an age prompt', r.status === 200 && r.data.order.status === 'closed', JSON.stringify(r.data));
  stock = await seller.get('/api/stock');
  ck('sale deducts three bottles from one consolidated line', stock.data.find((x) => x.id === product.stock_item_id).qty === 2);
  const measuredSale = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${measuredSale.id}/items`, { items: [{ menu_item_id: product.id, qty: 1, measure_ml: 31.25 }] });
  ck('31.25ml sale has proportional name, price and stock factor', r.status === 200 && Math.abs(r.data.items[0].stock_factor - 31.25/750) < 0.000001 &&
    r.data.items[0].price === 4167 && /31.25ml/.test(r.data.items[0].name), JSON.stringify(r.data.items));
  r = await seller.post(`/api/orders/${measuredSale.id}/pay`, { method: 'card', amount: 41.67 });
  ck('measured payment closes normally', r.status === 200 && r.data.order.status === 'closed');
  stock = await seller.get('/api/stock');
  ck('31.25ml sale keeps precise stock internally', Math.abs(stock.data.find((x) => x.id === product.stock_item_id).qty - 1.958333) < 0.000001);

  const supplier = (await admin.post('/api/suppliers', { name: 'Audit Distributor', kra_pin: 'P000000000A', phone: '0700000000' })).data;
  r = await seller.post('/api/goods-receipts', { supplier_id: supplier.id, payment_method: 'other',
    items: [{ stock_item_id: product.stock_item_id, qty: 6 }] });
  ck('delivery reference is optional and configured product cost is preserved',
    r.status === 200 && /^DEL-/.test(r.data.invoice_no) && r.data.total_cost === 420000 && r.data.payment_status === 'paid', JSON.stringify(r.data));
  stock = await seller.get('/api/stock');
  ck('delivery keeps a clean six-decimal balance', Math.abs(stock.data.find((x) => x.id === product.stock_item_id).qty - 7.958333) < 0.000001);
  const cashBeforeComp = (await admin.get('/api/shifts/current')).data.drawer.expected;
  r = await admin.post('/api/complimentaries', { menu_item_id: product.id, qty: 1, measure_ml: 125,
    reason: 'Owner consumption', recipient: 'Owner' });
  ck('owner records measured complimentary with retail and cost values', r.status === 200 && r.data.retail_value === 16667 && r.data.cost_value === 11667,
    JSON.stringify(r.data));
  stock = await seller.get('/api/stock');
  ck('complimentary deducts only its bottle fraction', Math.abs(stock.data.find((x) => x.id === product.stock_item_id).qty - (7.958333 - 125/750)) < 0.000001);
  const cashAfterComp = (await admin.get('/api/shifts/current')).data.drawer.expected;
  ck('complimentary does not change expected cash', cashAfterComp === cashBeforeComp);
  r = await admin.get('/api/complimentaries?from=2000-01-01&to=2099-12-31');
  ck('complimentary appears in owner reports', r.status === 200 && r.data.some((x) => x.reason === 'Owner consumption'));
  r = await seller.post('/api/complimentaries', { menu_item_id: product.id, qty: 1, reason: 'Staff complimentary', recipient: 'Seller 1' });
  ck('seller complimentary requires owner authorization declaration', r.status === 400 && /owner authorized/i.test(r.data.error));
  r = await seller.post('/api/complimentaries', { menu_item_id: product.id, qty: 1, reason: 'Staff complimentary', recipient: 'Seller 1',
    owner_authorized: true, authorization_reference: 'Phone call test' });
  ck('seller records owner-authorized complimentary with both identities', r.status === 200 && r.data.created_by !== r.data.authorized_by,
    JSON.stringify(r.data));
  ck('seller-authorized complimentary still leaves expected cash unchanged', (await admin.get('/api/shifts/current')).data.drawer.expected === cashBeforeComp);
  r = await seller.post('/api/goods-receipts', { payment_method: 'pay_later',
    items: [{ stock_item_id: boot.menu[0].stock_item_id, qty: 1 }] });
  ck('pay-later delivery is recorded unpaid with an automatic reference', r.status === 200 && r.data.payment_status === 'unpaid' && /^DEL-/.test(r.data.invoice_no));
  const unpaidDeliveryId = r.data.id;
  r = await seller.post(`/api/goods-receipts/${unpaidDeliveryId}/pay`, { method: 'other' });
  ck('pay-later delivery can be marked paid later', r.status === 200 && r.data.payment_status === 'paid');
  r = await seller.post(`/api/goods-receipts/${unpaidDeliveryId}/pay`, { method: 'other' });
  ck('delivery cannot be paid twice', r.status === 400 && /already marked paid/i.test(r.data.error));

  const sale2 = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${sale2.id}/items`, { items: [{ menu_item_id: product.id, qty: 8 }] });
  ck('negative stock is blocked', r.status === 400 && /only 6 measured sale unit/i.test(r.data.error), JSON.stringify(r.data));

  const sale3 = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${sale3.id}/items`, { items: [{ menu_item_id: product.id, qty: 1 }] });
  const due3 = r.data.totals.grand_total / 100;
  r = await seller.post(`/api/orders/${sale3.id}/pay`, { method: 'mpesa', amount: due3, reference: 'TESTMPESA1' });
  ck('first M-Pesa reference accepted', r.status === 200);
  const sale4 = (await seller.post('/api/orders', {})).data;
  r = await seller.post(`/api/orders/${sale4.id}/items`, { items: [{ menu_item_id: product.id, qty: 1 }] });
  const due4 = r.data.totals.grand_total / 100;
  r = await seller.post(`/api/orders/${sale4.id}/pay`, { method: 'mpesa', amount: due4, reference: 'TESTMPESA1' });
  ck('duplicate M-Pesa reference rejected', r.status === 400 && /already been used/i.test(r.data.error), JSON.stringify(r.data));
  /* sale2 is empty after its rejected line and must be discarded automatically at reconciliation. */
  await admin.post(`/api/orders/${sale4.id}/void`, { reason: 'Duplicate payment test cleanup' });

  r = await seller.post(`/api/stock/${product.stock_item_id}/adjust`, { delta: 1, reason: 'Not allowed' });
  ck('seller cannot directly edit or adjust stock', r.status === 403);
  r = await seller.post('/api/stock-counts', { reference: 'AUDIT-COUNT-1' });
  ck('seller starts end-of-day stocktake', r.status === 200, JSON.stringify(r.data));
  const count = (await seller.get('/api/stock-counts/' + r.data.id)).data;
  const addedStockItem = count.items.find((x) => x.stock_item_id !== product.stock_item_id && x.unit === 'bottle');
  const counted = count.items.map((x) => ({ stock_item_id: x.stock_item_id,
    counted: x.stock_item_id === product.stock_item_id ? 115/24 : x.stock_item_id === addedStockItem.stock_item_id ? x.expected + 1 : x.expected,
    added_qty: x.stock_item_id === addedStockItem.stock_item_id ? 1 : 0 }));
  r = await seller.post(`/api/stock-counts/${count.id}/complete`, { items: counted });
  ck('stocktake completes without a 500 and records financial variance separately from cash',
    r.status === 200 && r.data.variances === 1 && r.data.cost_variance === -70000 && r.data.retail_variance === -100000,
    JSON.stringify(r.data));
  stock = await seller.get('/api/stock');
  ck('stocktake sets physical quantity', Math.abs(stock.data.find((x) => x.id === product.stock_item_id).qty - 115/24) < 0.000001);

  const current = (await seller.get('/api/shifts/current')).data;
  ck('till reconciliation exposes stock variance without changing expected cash',
    current.stocktake && current.stocktake.cost_variance === -70000 && current.stocktake.retail_variance === -100000);
  r = await seller.post(`/api/shifts/${current.shift.id}/payout`, { amount: 100, method: 'cash', reason: 'Transport receipt' });
  ck('cash expense is recorded', r.status === 200 && r.data.cash_expenses === 10000, JSON.stringify(r.data));
  r = await seller.post(`/api/shifts/${current.shift.id}/payout`, { amount: 50, method: 'mpesa', reason: 'Airtime receipt' });
  ck('M-Pesa expense is recorded', r.status === 200 && r.data.mpesa_expenses === 5000, JSON.stringify(r.data));
  r = await seller.post(`/api/shifts/${current.shift.id}/close`, { counted_cash: 7900, counted_mpesa: 1050, notes: 'Retail test close' });
  ck('seller closes till after stocktake with cash and M-Pesa reconciled', r.status === 200 && r.data.variance === 0 && r.data.mpesa_variance === 0, JSON.stringify(r.data));
  r = await seller.post('/api/orders', {});
  ck('seller sales blocked after till close', r.status === 400 && /open the till/i.test(r.data.error), JSON.stringify(r.data));
  r = await admin.post('/api/orders', {});
  ck('owner can sell without a separate open-till prompt and sale is attributed to owner',
    r.status === 200 && r.data.waiter_id === ownerId, JSON.stringify(r.data));

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/* Focused regressions for Phase 2 financial and transaction polishing. */
const fs = require('fs');
const BASE = process.env.BASE;
let passed = 0, failed = 0;
const ck = (name, ok, detail = '') => {
  if (ok) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail); }
};
const mk = () => {
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b), put: (p, b) => req('PUT', p, b) };
};

(async () => {
  console.log('\n=== Phase 2 transaction hardening ===\n');
  const admin = mk(), seller = mk();
  await admin.post('/api/login', { pin: '0000' });
  await seller.post('/api/login', { pin: '1234' });
  const boot = (await admin.get('/api/bootstrap')).data;
  await seller.post('/api/shifts', { opening_float: 1000, opening_mpesa: 0, opening_card: 0 });
  const cat = boot.categories[0];

  const a = (await admin.post('/api/menu-items', {
    name: 'Hardening Whisky 750ml', category_id: cat.id, price: 1000, cost: 600,
    sku: 'HARD-A', barcode: '616999000001', volume_ml: 750, opening_qty: 10, min_qty: 1, unit: 'bottle'
  })).data;
  const b = (await admin.post('/api/menu-items', {
    name: 'Hardening Mixer 500ml', category_id: cat.id, price: 500, cost: 200,
    sku: 'HARD-B', barcode: '616999000002', volume_ml: 500, opening_qty: 10, min_qty: 1, unit: 'bottle'
  })).data;

  /* A discounted sale becomes immutable as soon as its first payment lands. */
  let order = (await seller.post('/api/orders', {})).data;
  await seller.post(`/api/orders/${order.id}/items`, { items: [{ menu_item_id: a.id, qty: 2 }] });
  let r = await admin.post(`/api/orders/${order.id}/discount`, { amount: 200, reason: 'Phase 2 fixture' });
  ck('discount is accepted before payment', r.status === 200 && r.data.totals.total === 180000, JSON.stringify(r.data));
  r = await seller.post(`/api/orders/${order.id}/pay`, {
    method: 'card', amount: 500, reference: 'PHASE2-CARD-1', idempotency_key: 'phase2-part-card'
  });
  ck('part payment leaves an explicit balance', r.status === 200 && r.data.order.status === 'billed' && r.data.order.balance === 130000,
    JSON.stringify(r.data));
  const partial = r.data.order;
  r = await admin.post(`/api/orders/${order.id}/discount`, { amount: 300, reason: 'Must be blocked' });
  ck('discount cannot change after payment starts', r.status === 409 && /after payment/i.test(r.data.error), r.data.error);

  /* Even a caller asking for paid=1 cannot make a billed order print as PAID. */
  r = await seller.post(`/api/print/receipt/${order.id}?paid=1&partial=1`);
  const partialBytes = r.status === 200 && r.data.spool ? fs.readFileSync(r.data.spool).toString('utf8') : '';
  ck('part-payment ESC/POS document is truthful', /PART PAYMENT - BALANCE DUE/.test(partialBytes) &&
    /BALANCE REMAINING/.test(partialBytes) && !/SALES RECEIPT - PAID/.test(partialBytes), partialBytes.slice(0, 160));

  r = await seller.post(`/api/orders/${order.id}/pay`, {
    method: 'cash', amount: 1300, tendered: 1500, idempotency_key: 'phase2-final-cash'
  });
  ck('final payment closes the sale and records change', r.status === 200 && r.data.order.status === 'closed' && r.data.change === 20000,
    JSON.stringify(r.data));
  const replay = await seller.post(`/api/orders/${order.id}/pay`, {
    method: 'cash', amount: 1300, tendered: 1500, idempotency_key: 'phase2-final-cash'
  });
  ck('cash payment replay returns original tender and change', replay.status === 200 && replay.data.idempotent_replay === true &&
    replay.data.tendered === 150000 && replay.data.change === 20000, JSON.stringify(replay.data));
  r = await admin.post(`/api/orders/${order.id}/discount`, { amount: 0, reason: 'Must remain frozen' });
  ck('closed-sale discount is immutable', r.status === 409, r.data.error);

  /* Two discounted lines exercise net-value allocation and duplicate protection. */
  order = (await seller.post('/api/orders', {})).data;
  await seller.post(`/api/orders/${order.id}/items`, { items: [
    { menu_item_id: a.id, qty: 1 }, { menu_item_id: b.id, qty: 1 }
  ] });
  await admin.post(`/api/orders/${order.id}/discount`, { amount: 300, reason: 'Allocation fixture' });
  let closed = await seller.post(`/api/orders/${order.id}/pay`, {
    method: 'cash', amount: 1200, tendered: 1200, idempotency_key: 'phase2-return-sale'
  });
  const lines = closed.data.order.items;
  const aLine = lines.find((x) => x.menu_item_id === a.id), bLine = lines.find((x) => x.menu_item_id === b.id);
  const stockBeforeDuplicate = (await seller.get('/api/stock')).data.find((x) => x.id === a.stock_item_id).qty;
  r = await admin.post(`/api/orders/${order.id}/refund`, {
    amount: 1000, method: 'cash', reason: 'Duplicate line must fail', restock: true,
    idempotency_key: 'phase2-duplicate-return',
    items: [{ order_item_id: aLine.id, qty: 1 }, { order_item_id: aLine.id, qty: 1 }]
  });
  ck('duplicate return lines are rejected', r.status === 400 && /only once/i.test(r.data.error), r.data.error);
  const stockAfterDuplicate = (await seller.get('/api/stock')).data.find((x) => x.id === a.stock_item_id).qty;
  ck('rejected duplicate return does not change stock', stockAfterDuplicate === stockBeforeDuplicate,
    `${stockBeforeDuplicate} -> ${stockAfterDuplicate}`);

  r = await admin.post(`/api/orders/${order.id}/refund`, {
    amount: 1200, method: 'cash', reason: 'Valid discounted return', restock: true,
    idempotency_key: 'phase2-valid-return',
    items: [{ order_item_id: aLine.id, qty: 1 }, { order_item_id: bLine.id, qty: 1 }]
  });
  ck('discounted multi-line return succeeds', r.status === 200 && r.data.return_record.amount === 120000, JSON.stringify(r.data));
  const returnId = r.data.return_record.id;
  const returned = await admin.get('/api/returns/' + returnId);
  ck('return allocation is non-negative and exact', returned.status === 200 && returned.data.items.every((x) => x.amount >= 0) &&
    returned.data.items.reduce((n, x) => n + x.amount, 0) === 120000,
    JSON.stringify(returned.data.items));
  ck('return allocation follows immutable discounted line values',
    returned.data.items.find((x) => x.order_item_id === aLine.id).amount === 80000 &&
    returned.data.items.find((x) => x.order_item_id === bLine.id).amount === 40000,
    JSON.stringify(returned.data.items));
  const orderAfterReturn = await admin.get('/api/orders/' + order.id);
  ck('refund payment links directly to its return', orderAfterReturn.data.payments.some((p) => p.kind === 'refund' && p.return_id === returnId),
    JSON.stringify(orderAfterReturn.data.payments));
  r = await admin.post(`/api/orders/${order.id}/refund`, {
    amount: 1200, method: 'cash', reason: 'Replay', restock: true,
    idempotency_key: 'phase2-valid-return', items: [{ order_item_id: aLine.id, qty: 1 }]
  });
  ck('return replay resolves the exact original return', r.status === 200 && r.data.idempotent_replay === true &&
    r.data.return_record.id === returnId, JSON.stringify(r.data));

  /* A non-resellable return reverses revenue but does not put cost back into stock/COGS. */
  order = (await seller.post('/api/orders', {})).data;
  await seller.post(`/api/orders/${order.id}/items`, { items: [{ menu_item_id: b.id, qty: 1 }] });
  closed = await seller.post(`/api/orders/${order.id}/pay`, {
    method: 'cash', amount: 500, tendered: 500, idempotency_key: 'phase2-damaged-sale'
  });
  const damagedLine = closed.data.order.items[0];
  r = await admin.post(`/api/orders/${order.id}/refund`, {
    amount: 500, method: 'cash', reason: 'Damaged product', restock: false,
    idempotency_key: 'phase2-damaged-return', items: [{ order_item_id: damagedLine.id, qty: 1 }]
  });
  ck('non-restocked return records successfully', r.status === 200 && r.data.return_record.restocked === 0, JSON.stringify(r.data));

  const today = (await (await fetch(BASE + '/api/today')).json()).date;
  const summary = await admin.get(`/api/reports/summary?from=${today}&to=${today}`);
  ck('gross profit uses VAT-exclusive net sales', summary.status === 200 &&
    summary.data.gross_profit === summary.data.net - summary.data.cogs,
    JSON.stringify(summary.data));
  ck('non-restocked return cost is disclosed as inventory loss', summary.data.inventory_loss === 20000,
    JSON.stringify(summary.data));
  const items = await admin.get(`/api/reports/items?from=${today}&to=${today}`);
  const mixer = items.data.find((x) => x.name === b.name);
  ck('non-restocked return does not reverse damaged stock cost', mixer && mixer.revenue === 0 && mixer.cogs === 20000,
    JSON.stringify(mixer));
  const sellers = await admin.get(`/api/reports/waiters?from=${today}&to=${today}`);
  ck('seller report uses the same sale/return period policy', sellers.data.reduce((n, x) => n + x.revenue, 0) === summary.data.gross,
    JSON.stringify({ sellers: sellers.data, gross: summary.data.gross }));

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nHARDENING TEST CRASH:', e); process.exit(2); });

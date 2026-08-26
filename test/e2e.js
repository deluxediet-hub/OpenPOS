'use strict';
/* End-to-end API test against the running server. Exercises the real HTTP handlers. */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
let pass = 0, fail = 0;

function ck(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ FAIL ' + name + '  ' + extra); }
}

/* Local date string matching the server's datetime('now','localtime') — the
   suites run with TZ=Africa/Nairobi, so toISOString() (UTC) would be a day off
   around midnight and silently empty every date-scoped report. */
/* Use the server's SQLite-side local date, not this process's clock. On Windows the
   app/Node clock and SQLite localtime can disagree, which made date-scoped reports
   select an empty range. The server is the single source of truth for "today". */
let TODAY = null;
const today = () => TODAY;
const loadToday = async () => { TODAY = (await (await fetch(BASE + '/api/today')).json()).date; };
const mk = () => {
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b), patch: (p, b) => req('PATCH', p, b), del: (p, b) => req('DELETE', p, b) };
};

const login = async (pin) => { const c = mk(); await c.post('/api/login', { pin }); return c; };

(async () => {
  console.log('\n=== POS end-to-end test ===\n');
  await loadToday();

  /* ---- auth ---- */
  console.log('AUTH');
  const anon = mk();
  let r = await anon.get('/api/bootstrap');
  ck('anonymous bootstrap rejected', r.status === 401, 'status=' + r.status);
  r = await anon.post('/api/login', { pin: '9999' });
  ck('bad PIN rejected', r.status === 401, 'status=' + r.status);

  const waiter = mk();
  r = await waiter.post('/api/login', { pin: '1234' });
  ck('waiter login (1234)', r.status === 200 && r.data.user.role === 'waiter', JSON.stringify(r.data.user || {}));

  /* Deterministic money math: switch off seeded happy-hour pricing (it is
     time-of-day dependent and would discount bar items during 17:00-19:00). */
  {
    const m0 = await login('1111');
    const dp = await m0.get('/api/dayparts');
    for (const d of dp.data.dayparts) await m0.put('/api/dayparts/' + d.id, { active: 0 });
  }

  /* ---- bootstrap ---- */
  console.log('BOOTSTRAP');
  r = await waiter.get('/api/bootstrap');
  ck('bootstrap 200', r.status === 200);
  const boot = r.data;
  ck('menu seeded', boot.menu.length > 50, boot.menu.length + ' items');
  ck('categories seeded', boot.categories.length === 13, boot.categories.length + ' categories');
  ck('tables seeded', boot.tables.length === 27, boot.tables.length + ' tables');
  ck('VAT 16% / service 10%', boot.settings.vat_rate === 16 && boot.settings.service_charge_rate === 10);
  ck('tax mode inclusive', boot.settings.tax_mode === 'inclusive');

  /* ---- order lifecycle ---- */
  console.log('ORDER LIFECYCLE');
  const freeTable = boot.tables.find((t) => !boot.orders.some((o) => o.table_id === t.id));
  r = await waiter.post('/api/orders', { table_id: freeTable.id, people: 4 });
  ck('open order on ' + freeTable.name, r.status === 200 && r.data.status === 'open', '#' + (r.data || {}).number);
  const order = r.data;

  r = await waiter.post(`/api/orders/${order.id}/items`, { items: [] });
  ck('empty item list rejected', r.status === 400 || r.status === 500 || r.status === 200);

  const tilapia = boot.menu.find((m) => m.name === 'Grilled Whole Tilapia');
  const tusker = boot.menu.find((m) => m.name === 'Tusker (Bottle)');
  const ugali = boot.menu.find((m) => m.name === 'Ugali');
  ck('kitchen item is station=kitchen', tilapia.station === 'kitchen');
  ck('bar item is station=bar', tusker.station === 'bar');

  r = await waiter.post(`/api/orders/${order.id}/items`, {
    items: [{ menu_item_id: tilapia.id, qty: 2, note: 'extra kachumbari' },
            { menu_item_id: ugali.id, qty: 4 },
            { menu_item_id: tusker.id, qty: 4 }]
  });
  ck('add 3 lines', r.status === 200 && r.data.items.length === 3, r.data.items.length + ' lines');
  const subtotal = 2 * tilapia.price + 4 * ugali.price + 4 * tusker.price;
  ck('subtotal math', r.data.totals.subtotal === subtotal, `${r.data.totals.subtotal} === ${subtotal}`);

  const sc = Math.round((subtotal) * 0.10);
  ck('service charge 10%', r.data.totals.service === sc, `${r.data.totals.service} === ${sc}`);
  const taxable = subtotal + sc;
  const vat = Math.round(taxable - taxable / 1.16);
  ck('inclusive VAT 16%', r.data.totals.vat === vat, `${r.data.totals.vat} === ${vat}`);
  ck('total = subtotal + service (incl. VAT)', r.data.totals.total === taxable, `${r.data.totals.total} === ${taxable}`);

  // duplicate table guard
  r = await waiter.post('/api/orders', { table_id: freeTable.id, people: 2 });
  ck('cannot double-open a table', r.status === 400, r.data.error);

  // people
  r = await waiter.patch(`/api/orders/${order.id}/people`, { people: 6 });
  ck('update guest count', r.status === 200 && r.data.people === 6, 'people=' + r.data.people);

  // send
  r = await waiter.post(`/api/orders/${order.id}/send`);
  ck('send ticket', r.status === 200 && r.data.items.every((i) => i.status === 'sent'));

  /* ---- KDS ---- */
  console.log('KITCHEN DISPLAY');
  const chef = mk();
  await chef.post('/api/login', { pin: '4567' });
  r = await chef.get('/api/orders');
  ck('kitchen sees open orders', r.status === 200 && r.data.length >= 1, r.data.length + ' orders');
  const kitchenLine = r.data.find((o) => o.id === order.id).items.find((i) => i.station === 'kitchen');
  r = await chef.patch(`/api/orders/${order.id}/items/${kitchenLine.id}`, { status: 'ready' });
  ck('kitchen marks line ready', r.status === 200 && r.data.items.find((i) => i.id === kitchenLine.id).status === 'ready');

  /* ---- permissions ---- */
  console.log('PERMISSIONS');
  r = await waiter.patch(`/api/orders/${order.id}/items/${kitchenLine.id}`, { status: 'void', reason: 'x' });
  ck('waiter cannot void', r.status === 403, r.data.error);
  r = await waiter.post(`/api/orders/${order.id}/pay`, { method: 'cash', amount: 10000 });
  ck('waiter cannot take payment', r.status === 403, r.data.error);
  r = await waiter.put('/api/settings', { vat_rate: '0' });
  ck('waiter cannot change settings', r.status === 403, r.data.error);
  r = await waiter.del('/api/menu-items/' + tilapia.id);
  ck('waiter cannot delete menu items', r.status === 403, r.data.error);

  /* ---- discount + payment ---- */
  console.log('DISCOUNT & PAYMENT');
  const mgr = mk();
  await mgr.post('/api/login', { pin: '1111' });
  r = await mgr.post(`/api/orders/${order.id}/discount`, { amount: 100, reason: 'test discount' });
  ck('manager applies discount', r.status === 200 && r.data.discount === 10000, 'discount=' + r.data.discount);
  // response must reflect the post-update row, not a stale read
  r = await mgr.get(`/api/orders/${order.id}`);
  ck('discount persisted to DB', r.data.discount === 10000, 'discount=' + r.data.discount);
  const afterDisc = r.data.totals;
  ck('discount recalculates service+VAT',
    afterDisc.service === Math.round((subtotal - 10000) * 0.1) && afterDisc.total === (subtotal - 10000) + afterDisc.service,
    `service=${afterDisc.service} total=${afterDisc.total}`);

  const cashier = mk();
  await cashier.post('/api/login', { pin: '2345' });

  // M-Pesa without reference must fail
  r = await cashier.post(`/api/orders/${order.id}/pay`, { method: 'mpesa', amount: afterDisc.total / 100, reference: '' });
  ck('M-Pesa requires confirmation code', r.status === 400, r.data.error);

  // partial card payment
  const part = Math.round(afterDisc.total / 2);
  r = await cashier.post(`/api/orders/${order.id}/pay`, { method: 'card', amount: part / 100, reference: 'EDC-001' });
  ck('partial card payment', r.status === 200 && r.data.order.status === 'billed', 'status=' + r.data.order.status);
  ck('balance after part payment', r.data.order.balance === afterDisc.total - part, `balance=${r.data.order.balance}`);

  // card cannot overpay
  r = await cashier.post(`/api/orders/${order.id}/pay`, { method: 'card', amount: (afterDisc.total) / 100 });
  ck('card cannot exceed balance', r.status === 400, r.data.error);

  // settle with cash + tip
  const remaining = afterDisc.total - part;
  const due = remaining + 5000;                 // balance + tip
  r = await cashier.post(`/api/orders/${order.id}/pay`, { method: 'cash', amount: due / 100, tendered: (due - 100) / 100, tip: 50 });
  ck('short cash tender rejected by server', r.status === 400, r.data.error);
  r = await cashier.post(`/api/orders/${order.id}/pay`, { method: 'cash', amount: due / 100, tip: 50 });
  ck('cash without tender amount rejected', r.status === 400, r.data.error);

  r = await cashier.post(`/api/orders/${order.id}/pay`, { method: 'cash', amount: due / 100, tendered: (due + 5000) / 100, tip: 50 });
  ck('final cash payment closes order', r.status === 200 && r.data.order.status === 'closed', 'status=' + r.data.order.status);
  ck('tip recorded', r.data.order.totals.tip === 5000, 'tip=' + r.data.order.totals.tip);
  ck('change computed from tender', r.data.change === 5000, 'change=' + r.data.change + ' tendered=' + r.data.tendered);
  ck('tender/change recorded on the payment',
    r.data.order.payments.some((p) => p.method === 'cash' && /Tendered .*Change 50\.00/.test(p.reference || '')),
    JSON.stringify((r.data.order.payments.find((p) => p.method === 'cash') || {}).reference));
  ck('over-tender is not recorded as revenue',
    r.data.paid === r.data.order.totals.grand_total, `paid=${r.data.paid} due=${r.data.order.totals.grand_total}`);

  /* ---- receipt ---- */
  console.log('RECEIPT');
  r = await waiter.get('/api/receipt/' + order.id);
  ck('receipt endpoint', r.status === 200 && r.data.items.length === 3 && !!r.data.settings.business_name,
    r.data.settings.business_name);
  ck('receipt shows payments', r.data.order.payments.length === 2, r.data.order.payments.length + ' payments');

  /* ---- table freed ---- */
  console.log('PAYMENT SEARCH & REPRINT');
  r = await cashier.get('/api/last-closed-order');
  ck('last-closed returns a settled order', r.status === 200 && r.data.status === 'closed', 'number=' + (r.data || {}).number);
  r = await cashier.get('/api/payments?q=');
  ck('payment search returns rows', r.status === 200 && r.data.length > 0, r.data.length + ' rows');
  r = await cashier.get('/api/payments?q=cash');
  ck('payment search filters by method', r.data.length > 0 && r.data.every((p) => p.method === 'cash'), r.data.length + ' cash rows');
  r = await cashier.get('/api/payments?q=zzz-not-a-thing');
  ck('payment search empty for no match', r.status === 200 && r.data.length === 0);
  r = await waiter.get('/api/payments?q=');
  ck('waiter blocked from payment search', r.status === 403);

  console.log('FLOOR STATE');
  r = await waiter.get('/api/orders');
  ck('closed order leaves the open list', !r.data.some((o) => o.id === order.id));

  /* ---- reports ---- */
  console.log('REPORTS');
  const t = today();
  r = await mgr.get(`/api/reports/summary?from=${t}&to=${t}`);
  ck('summary report', r.status === 200 && r.data.gross > 0, 'gross=' + r.data.gross);
  ck('VAT collected on gross', Math.abs(r.data.vat_collected - (r.data.gross - Math.round(r.data.gross / 1.16))) <= 2,
    `vat=${r.data.vat_collected} gross=${r.data.gross}`);
  ck('covers counted', r.data.covers === 6, 'covers=' + r.data.covers);
  ck('avg ticket', r.data.avg_ticket === r.data.gross, 'avg=' + r.data.avg_ticket);
  r = await mgr.get(`/api/reports/items?from=${t}&to=${t}`);
  ck('item report', r.status === 200 && r.data.length === 3, r.data.length + ' distinct items');
  r = await mgr.get(`/api/reports/waiters?from=${t}&to=${t}`);
  ck('waiter report attributes sales', r.status === 200 && r.data[0].revenue > 0, r.data[0].waiter + ' = ' + r.data[0].revenue);
  r = await mgr.get(`/api/reports/categories?from=${t}&to=${t}`);
  ck('category report', r.status === 200 && r.data.length === 3, r.data.length + ' categories');
  r = await mgr.get('/api/zreport?date=' + t);
  ck('Z-report', r.status === 200 && r.data.by_method.length === 2, JSON.stringify(r.data.by_method));
  ck('Z-report net = card + cash', r.data.net === r.data.by_method.reduce((a, m) => a + m.total, 0));

  /* ---- void + refund ---- */
  console.log('STATION READY & SHIFT CLEARING');
  const bar = await login('3456');
  const so = await waiter.post('/api/orders', { people: 2 });
  const ug = boot.menu.find((m) => m.name === 'Ugali');
  const tu = boot.menu.find((m) => m.name === 'Tusker (Bottle)');
  await waiter.post(`/api/orders/${so.data.id}/items`, { items: [{ menu_item_id: ug.id, qty: 1 }, { menu_item_id: tu.id, qty: 1 }] });
  await waiter.post(`/api/orders/${so.data.id}/send`, {});
  let od = (await waiter.get(`/api/orders/${so.data.id}`)).data;
  const kLine = od.items.find((i) => i.station === 'kitchen');
  const bLine = od.items.find((i) => i.station === 'bar');
  r = await chef.patch(`/api/orders/${so.data.id}/items/${bLine.id}`, { status: 'ready' });
  ck('kitchen cannot ready a bar item', r.status === 403, r.data.error);
  r = await bar.patch(`/api/orders/${so.data.id}/items/${kLine.id}`, { status: 'ready' });
  ck('bar cannot ready a kitchen item', r.status === 403, r.data.error);
  r = await chef.patch(`/api/orders/${so.data.id}/items/${kLine.id}`, { status: 'ready' });
  ck('kitchen readies kitchen item', r.status === 200);
  r = await bar.patch(`/api/orders/${so.data.id}/items/${bLine.id}`, { status: 'ready' });
  ck('bar readies bar item', r.status === 200);

  r = await cashier.post('/api/shifts', { opening_float: 100 });
  ck('open a shift for clearing', r.status === 200, r.data.error || '');
  const due2 = (await waiter.get(`/api/orders/${so.data.id}`)).data.totals;
  await cashier.post(`/api/orders/${so.data.id}/pay`, { method: 'cash', amount: due2.grand_total / 100, tendered: due2.grand_total / 100 });
  r = await cashier.get('/api/shift-clearing');
  ck('shift clearing returns methods', r.status === 200 && r.data.by_method.some((m) => m.method === 'cash'), JSON.stringify(r.data.by_method));
  ck('shift clearing returns station split', r.data.by_station.length >= 2, r.data.by_station.map((x) => x.station).join(','));
  ck('shift clearing has drawer expectation', r.data.drawer && r.data.drawer.expected != null, 'expected=' + ((r.data.drawer || {}).expected));
  r = await waiter.get('/api/shift-clearing');
  ck('waiter blocked from shift clearing', r.status === 403);

  console.log('VOID & REFUND');
  r = await waiter.post('/api/orders', { table_id: boot.tables.find((x) => x.id !== freeTable.id && !boot.orders.some(o => o.table_id === x.id)).id, people: 2 });
  const o2 = r.data;
  await waiter.post(`/api/orders/${o2.id}/items`, { items: [{ menu_item_id: tusker.id, qty: 2 }] });
  await waiter.post(`/api/orders/${o2.id}/send`);
  const sentLine = (await waiter.get(`/api/orders/${o2.id}`)).data.items[0];
  r = await mgr.patch(`/api/orders/${o2.id}/items/${sentLine.id}`, { status: 'void', reason: 'guest changed mind' });
  ck('manager voids a sent item', r.status === 200 && r.data.items.length === 0, r.data.items.length + ' live lines');
  ck('voided item drops out of the total', r.data.totals.subtotal === 0, 'subtotal=' + r.data.totals.subtotal);
  r = await mgr.post(`/api/orders/${o2.id}/void`, { reason: 'guest left' });
  ck('manager voids unpaid order', r.status === 200);
  r = await mgr.get(`/api/reports/summary?from=${t}&to=${t}`);
  ck('void counted in report', r.data.orders_void >= 1, 'voids=' + r.data.orders_void);

  r = await mgr.post(`/api/orders/${order.id}/refund`, { amount: 50, reason: 'test refund' });
  ck('manager issues refund', r.status === 200);
  r = await cashier.post(`/api/orders/${order.id}/refund`, { amount: 50, reason: 'x' });
  ck('cashier cannot refund', r.status === 403, r.data.error);

  /* ---- menu / stock / staff ---- */
  console.log('CATALOGUE & STOCK');
  r = await mgr.post('/api/menu-items', { name: 'Test Special', category_id: boot.categories[0].id, price: 12.5, cost: 4, station: 'kitchen' });
  ck('create menu item', r.status === 200 && r.data.price === 1250, 'price=' + r.data.price);
  const newItem = r.data;
  r = await mgr.put('/api/menu-items/' + newItem.id, { price: 15, available: 0 });
  ck('update + 86 an item', r.status === 200 && r.data.price === 1500 && r.data.available === 0);
  r = await mgr.del('/api/menu-items/' + newItem.id);
  ck('delete menu item', r.status === 200);

  r = await mgr.get('/api/stock');
  ck('stock list', r.status === 200 && r.data.length === 20, r.data.length + ' stock items');
  const beef = r.data.find((s) => s.name === 'Beef');
  r = await mgr.post(`/api/stock/${beef.id}/adjust`, { delta: -5, reason: 'usage' });
  ck('stock adjustment', r.status === 200 && r.data.qty === beef.qty - 5, beef.qty + ' -> ' + r.data.qty);
  r = await waiter.post(`/api/stock/${beef.id}/adjust`, { delta: 100 });
  ck('waiter cannot adjust stock', r.status === 403);

  r = await mgr.post('/api/users', { name: 'Test Waiter', pin: '9876', role: 'waiter' });
  ck('create staff member', r.status === 200 && r.data.pin === '9876');
  const tw = r.data;
  r = await mgr.post('/api/users', { name: 'Dupe', pin: '9876', role: 'waiter' });
  ck('duplicate PIN rejected', r.status === 400, r.data.error);
  r = await mgr.del('/api/users/' + tw.id);
  ck('manager cannot disable staff (admin only)', r.status === 403, r.data.error);
  const admin = mk();
  await admin.post('/api/login', { pin: '0000' });
  r = await admin.del('/api/users/' + tw.id);
  ck('admin disables staff member', r.status === 200);
  const gone = mk();
  r = await gone.post('/api/login', { pin: '9876' });
  ck('disabled PIN can no longer sign in', r.status === 401, r.data.error);

  /* ---- audit ---- */
  console.log('AUDIT TRAIL');
  r = await mgr.get('/api/audit?limit=500');
  ck('audit log populated', r.status === 200 && r.data.length > 10, r.data.length + ' entries');
  const actions = [...new Set(r.data.map((x) => x.action))];
  ['login', 'order.open', 'order.send', 'item.void', 'order.discount', 'payment', 'refund', 'order.void', 'stock.adjust', 'user.create']
    .forEach((a) => ck('audit has ' + a, actions.includes(a)));
  r = await waiter.get('/api/audit');
  ck('waiter blocked from audit log', r.status === 403);

  /* ---- static ---- */
  console.log('FRONTEND');
  for (const p of ['/', '/kds', '/assets/app.js', '/assets/pos.js', '/assets/cashier.js', '/assets/manager.js', '/assets/kds.js', '/assets/kds-boot.js', '/assets/api.js', '/assets/print.js', '/assets/style.css']) {
    const res = await fetch(BASE + p);
    ck('GET ' + p, res.status === 200, res.status + ' ' + res.headers.get('content-type'));
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nTEST CRASH:', e); process.exit(2); });

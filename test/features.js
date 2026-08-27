'use strict';
/* API tests for the Phase 2-4 features. Runs against the harness server. */
const net = require('net');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
const ck = (n, c, e = '') => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ FAIL ' + n + '  ' + e); }
};
const mk = () => {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(BASE + p, {
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
/* Local date matching the server's datetime('now','localtime'); the suites run
   with TZ=Africa/Nairobi so toISOString() (UTC) would be a day off near midnight. */
/* Use the server's SQLite-side local date, not this process's clock. On Windows the
   app/Node clock and SQLite localtime can disagree, which made date-scoped reports
   select an empty range. The server is the single source of truth for "today". */
let TODAY = null;
const today = () => TODAY;
const loadToday = async () => { TODAY = (await (await fetch(BASE + '/api/today')).json()).date; };


(async () => {
  console.log('\n=== Phase 2-4 feature tests ===\n');
  await loadToday();
  const admin = await login('0000');
  const mgr = await login('1111');
  const waiter = await login('1234');
  const cashier = await login('2345');
  const chef = await login('4567');
  const boot = (await waiter.get('/api/bootstrap')).data;
  /* Deterministic pricing: disable seeded time-of-day happy-hour rules. */
  { const dp = await mgr.get('/api/dayparts'); for (const d of dp.data.dayparts) await mgr.put('/api/dayparts/' + d.id, { active: 0 }); }

  /* =================== DAYPARTS / HAPPY HOUR =================== */
  console.log('HAPPY HOUR / DAYPART PRICING');
  let r = await mgr.get('/api/dayparts');
  ck('seeded dayparts present', r.data.dayparts.length >= 2, r.data.dayparts.length + ' rules');
  ck('happy hour covers beers', r.data.dayparts.some((d) => d.name.includes('Beers')));
  ck('seeded late-night rule ships disabled', r.data.dayparts.find((d) => d.name.includes('Late Night')).active === 0);

  const tusker = boot.menu.find((m) => m.name === 'Tusker (Bottle)');
  const ugali = boot.menu.find((m) => m.name === 'Ugali');
  /* Always ask the server which tables are free — the bootstrap snapshot goes stale
     as soon as this test opens its own orders. */
  const freeTable = async () => {
    const b = (await waiter.get('/api/bootstrap')).data;
    return b.tables.find((t) => !b.orders.some((o) => o.table_id === t.id));
  };
  const freeT = await freeTable();

  /* An all-day rule so the test does not depend on the wall clock. */
  r = await mgr.post('/api/dayparts', { name: 'Test All Day', days: '0,1,2,3,4,5,6', start_time: '00:00', end_time: '23:59', discount_pct: 50, station: 'bar' });
  ck('create daypart (active by default)', r.status === 200 && r.data.active === 1, 'id=' + (r.data || {}).id + ' active=' + (r.data || {}).active);
  const dp = r.data;

  r = await mgr.get('/api/pricing/now');
  ck('pricing/now lists active rules', Array.isArray(r.data.active) && r.data.active.length >= 1,
    r.data.active.map((a) => a.name).join(','));
  ck('active discount produces an override', !!r.data.overrides[tusker.id]);
  ck('override price is 50% off', (r.data.overrides[tusker.id] || {}).price === 12500,
    'price=' + ((r.data.overrides[tusker.id] || {}).price));
  ck('kitchen items are NOT discounted by a bar-only rule', !r.data.overrides[ugali.id]);

  r = await waiter.post('/api/orders', { table_id: freeT.id, people: 2 });
  const dpOrder = r.data;
  r = await waiter.post(`/api/orders/${dpOrder.id}/items`, { items: [{ menu_item_id: tusker.id, qty: 2 }] });
  const beerLine = r.data.items.find((i) => i.menu_item_id === tusker.id);
  ck('line carries the discounted price, not the menu price',
    beerLine.price === 12500 && beerLine.price !== tusker.price, `line=${beerLine.price} menu=${tusker.price}`);
  ck('discounted subtotal (2 x 125)', r.data.totals.subtotal === 25000, 'subtotal=' + r.data.totals.subtotal);
  await waiter.post(`/api/orders/${dpOrder.id}/send`);
  ck('discounted ticket sent to bar', r.status === 200);

  /* change the rule and confirm a NEW order picks up the new price */
  r = await mgr.put('/api/dayparts/' + dp.id, { discount_pct: 10 });
  ck('update daypart discount', r.status === 200 && r.data.discount_pct === 10);
  const t2 = await freeTable();
  r = await waiter.post('/api/orders', { table_id: t2.id, people: 1 });
  const o2id = r.data.id;
  r = await waiter.post(`/api/orders/${o2id}/items`, { items: [{ menu_item_id: tusker.id, qty: 1 }] });
  ck('new order uses the updated 10% price', r.data.items[0].price === 22500, 'price=' + r.data.items[0].price);

  /* delete the rule — prices revert to the menu */
  r = await mgr.del('/api/dayparts/' + dp.id);
  ck('delete daypart', r.status === 200);
  r = await waiter.post(`/api/orders/${o2id}/items`, { items: [{ menu_item_id: tusker.id, qty: 1 }] });
  ck('price reverts to full menu price after deletion', r.data.items.slice(-1)[0].price === tusker.price,
    'price=' + r.data.items.slice(-1)[0].price);

  /* =================== RECIPES / BOM =================== */
  console.log('\nRECIPES / STOCK DEPLETION');
  r = await mgr.get('/api/recipes');
  ck('seeded recipes present', r.data.length >= 10, r.data.length + ' recipe lines');
  ck('Nyama Choma uses beef', r.data.some((x) => x.item_name === 'Nyama Choma 500g' && x.stock_name === 'Beef'));

  const before = (await mgr.get('/api/stock')).data.find((s) => s.name === 'Beef').qty;
  const nyama = boot.menu.find((m) => m.name === 'Nyama Choma 500g');
  const rTbl = await freeTable();
  r = await waiter.post('/api/orders', { table_id: rTbl.id, people: 2 });
  const bomOrder = r.data;
  /* no modifiers required on choma? it has required Steak doneness — supply it */
  const mods = await mgr.get('/api/modifiers');
  const donenessGroup = mods.data.groups.find((g) => g.name === 'Steak doneness');
  const medium = mods.data.options.find((o) => o.group_id === donenessGroup.id && o.name === 'Medium');
  r = await waiter.post(`/api/orders/${bomOrder.id}/items`, {
    items: [{ menu_item_id: nyama.id, qty: 2, modifiers: [{ id: medium.id }] }]
  });
  ck('item with required modifier accepted', r.status === 200, r.status === 200 ? '' : JSON.stringify(r.data));
  await waiter.post(`/api/orders/${bomOrder.id}/send`);

  let stockMid = (await mgr.get('/api/stock')).data.find((s) => s.name === 'Beef').qty;
  ck('stock NOT depleted before payment', stockMid === before, `${before} -> ${stockMid}`);

  const od = await waiter.get(`/api/orders/${bomOrder.id}`);
  const due = od.data.totals.grand_total / 100;
  r = await cashier.post(`/api/orders/${bomOrder.id}/pay`, { method: 'cash', amount: due, tendered: due });
  ck('order closed', r.data.order && r.data.order.status === 'closed');

  const after = (await mgr.get('/api/stock')).data.find((s) => s.name === 'Beef').qty;
  ck('stock depleted on close (2 x 0.55kg = 1.1kg)', Math.round((before - after) * 100) === 110,
    `${before} -> ${after}`);

  r = await mgr.get('/api/reports/stock-usage?from=' + today());
  ck('stock usage report returns rows', r.status === 200 && r.data.length > 0, r.data.length + ' rows');
  ck('usage report shows theoretical beef', r.data.find((x) => x.name === 'Beef').theoretical >= 1.1,
    'theoretical=' + r.data.find((x) => x.name === 'Beef').theoretical);

  /* =================== MODIFIERS =================== */
  console.log('\nMODIFIERS & VARIANTS');
  ck('modifier groups seeded', mods.data.groups.length >= 4, mods.data.groups.length + ' groups');
  ck('options seeded', mods.data.options.length >= 10, mods.data.options.length + ' options');

  const sauceGroup = mods.data.groups.find((g) => g.name === 'Sauce');
  const chilli = mods.data.options.find((o) => o.group_id === sauceGroup.id && o.name === 'Chilli sauce');
  /* bomOrder was settled above — the modifier tests need a live order of their own */
  const modOrder = (await waiter.post('/api/orders', { table_id: (await freeTable()).id, people: 2 })).data;
  r = await waiter.post(`/api/orders/${modOrder.id}/items`, {
    items: [{ menu_item_id: nyama.id, qty: 1, modifiers: [{ id: medium.id }, { id: chilli.id }] }]
  });
  ck('priced modifier raises the line price',
    r.status === 200 && r.data.items.slice(-1)[0].price === nyama.price + 5000,
    r.status === 200 ? 'line=' + r.data.items.slice(-1)[0].price : r.data.error);
  ck('modifiers parsed back as objects', Array.isArray(r.data.items.slice(-1)[0].modifiers)
    && r.data.items.slice(-1)[0].modifiers.length === 2);

  /* a modifier from a group not attached to the item must be refused */
  const pourSize = mods.data.groups.find((g) => g.name === 'Pour size');
  const doublePour = mods.data.options.find((o) => o.group_id === pourSize.id && o.name === 'Double 60ml');
  r = await waiter.post(`/api/orders/${modOrder.id}/items`, {
    items: [{ menu_item_id: nyama.id, qty: 1, modifiers: [{ id: medium.id }, { id: doublePour.id }] }]
  });
  ck('modifier from an unrelated group rejected', r.status === 400, r.data.error);

  /* omitting a required group must be refused */
  r = await waiter.post(`/api/orders/${modOrder.id}/items`, { items: [{ menu_item_id: nyama.id, qty: 1 }] });
  ck('missing required modifier rejected', r.status === 400 && /Please choose/.test(r.data.error), r.data.error);

  r = await waiter.post(`/api/orders/${modOrder.id}/items`, { items: [{ menu_item_id: ugali.id, qty: 1 }] });
  ck('item with no modifiers still works', r.status === 200);

  r = await mgr.post('/api/modifier-groups', { name: 'Test Group', required: 0, max_pick: 1 });
  ck('create modifier group', r.status === 200 && r.data.id);
  r = await mgr.post('/api/modifier-options', { group_id: r.data.id, name: 'Extra', price: 100 });
  ck('create modifier option with price', r.status === 200 && r.data.price === 10000, 'price=' + r.data.price);
  r = await mgr.del('/api/modifier-groups/' + r.data.id);
  ck('delete group cascades', r.status === 200);

  /* =================== CASH DRAWER =================== */
  console.log('\nCASH DRAWER RECONCILIATION');
  r = await cashier.get('/api/shifts/current');
  ck('no shift open initially', r.data.shift === null);
  r = await cashier.post('/api/shifts', { opening_float: 50, notes: 'test float' });
  ck('open shift with float', r.status === 200 && r.data.opening_float === 5000, 'float=' + r.data.opening_float);
  const shift = r.data;
  r = await cashier.post('/api/shifts', { opening_float: 100 });
  ck('cannot open a second shift', r.status === 400, r.data.error);

  r = await cashier.get('/api/shifts/current');
  ck('drawer figures exposed', !!r.data.drawer && typeof r.data.drawer.expected === 'number');

  /* a cash sale made inside this shift must be attributed to it */
  const drTbl = await freeTable();
  const drOrder = (await waiter.post('/api/orders', { table_id: drTbl.id, people: 1 })).data;
  await waiter.post(`/api/orders/${drOrder.id}/items`, { items: [{ menu_item_id: ugali.id, qty: 5 }] });
  const drDue = (await waiter.get(`/api/orders/${drOrder.id}`)).data.totals;
  r = await cashier.post(`/api/orders/${drOrder.id}/pay`, {
    method: 'cash', amount: drDue.grand_total / 100, tendered: drDue.grand_total / 100
  });
  ck('cash sale inside shift settled', r.status === 200 && r.data.order.status === 'closed');

  r = await cashier.post(`/api/shifts/${shift.id}/payout`, { amount: 20, reason: 'boda delivery' });
  ck('cash payout recorded', r.status === 200 && r.data.payouts === 2000, 'payouts=' + r.data.payouts);

  r = await cashier.get('/api/shifts/current');
  ck('cash sales attributed to shift', r.data.drawer.cash_sales === drDue.grand_total,
    `cash_sales=${r.data.drawer.cash_sales} bill=${drDue.grand_total}`);
  const expected = r.data.drawer.expected;
  ck('expected = float + sales - payouts',
    expected === 5000 + drDue.grand_total - 2000, `expected=${expected}`);

  r = await cashier.post(`/api/shifts/${shift.id}/close`, { counted_cash: expected / 100 + 10 });
  ck('close shift computes variance', r.status === 200 && r.data.variance === 1000,
    'variance=' + r.data.variance + ' expected=' + r.data.expected_cash + ' counted=' + r.data.counted_cash);
  ck('closed shift is marked closed', r.data.status === 'closed');
  r = await cashier.post(`/api/shifts/${shift.id}/close`, { counted_cash: 100 });
  ck('cannot close twice', r.status === 400, r.data.error);
  r = await mgr.get('/api/audit?limit=50');
  ck('drawer variance audited', r.data.some((a) => a.action === 'drawer.variance'));

  /* =================== TABS =================== */
  console.log('\nOPEN BAR TABS');
  r = await waiter.post('/api/tabs', { customer_name: 'James Mwangi', phone: '0712000111', card_last4: '4242', preauth_amount: 5000, preauth_ref: 'AUTH123' });
  ck('open a bar tab', r.status === 200 && r.data.id && r.data.preauth_amount === 500000, 'id=' + (r.data || {}).id);
  const tab = r.data;
  r = await waiter.get('/api/tabs');
  ck('tab listed as open', r.data.some((t) => t.id === tab.id) && r.data[0].spend === 0, 'spend=' + r.data[0].spend);
  r = await waiter.post('/api/tabs', { phone: '0700' });
  ck('tab requires a customer name', r.status === 400, r.data.error);
  r = await waiter.post(`/api/tabs/${tab.id}/release`);
  ck('waiter cannot release pre-auth', r.status === 403, r.data.error);
  r = await mgr.post(`/api/tabs/${tab.id}/release`);
  ck('manager releases pre-auth', r.status === 200);

  /* =================== TIMECLOCK / LABOUR =================== */
  console.log('\nSTAFF TIME & LABOUR COST');
  r = await waiter.post('/api/timeclock/in', {});
  ck('clock in', r.status === 200 && r.data.clock_in);
  r = await waiter.post('/api/timeclock/in', {});
  ck('cannot clock in twice', r.status === 400, r.data.error);
  r = await waiter.post('/api/timeclock/out', {});
  ck('clock out', r.status === 200 && r.data.clock_out);
  r = await waiter.post('/api/timeclock/out', {});
  ck('cannot clock out when not in', r.status === 400, r.data.error);

  const tday = today();
  r = await mgr.get(`/api/reports/labour?from=${tday}&to=${tday}`);
  ck('labour report returns', r.status === 200 && Array.isArray(r.data.by_user));
  ck('labour report has target', typeof r.data.target_pct === 'number', 'target=' + r.data.target_pct + '%');
  r = await waiter.get(`/api/reports/labour?from=${today}`);
  ck('waiter blocked from labour report', r.status === 403);

  /* =================== RESERVATIONS =================== */
  console.log('\nRESERVATIONS');
  r = await waiter.post('/api/reservations', { name: 'Achieng O.', phone: '0733000222', people: 6, res_date: tday, res_time: '19:30', table_id: boot.tables[5].id, notes: 'window seat' });
  ck('create reservation', r.status === 200 && r.data.id, 'id=' + (r.data || {}).id);
  const res = r.data;
  r = await waiter.get('/api/reservations?date=' + tday);
  ck('reservation listed for the day', r.data.some((x) => x.id === res.id) && r.data[0].table_name, 'table=' + r.data[0].table_name);
  r = await waiter.put('/api/reservations/' + res.id, { status: 'seated' });
  ck('mark reservation seated', r.status === 200 && r.data.status === 'seated');
  r = await waiter.del('/api/reservations/' + res.id);
  ck('cancel reservation', r.status === 200);
  r = await waiter.post('/api/reservations', { name: 'No Date', res_time: '20:00' });
  ck('reservation requires a date', r.status === 400, r.data.error);

  /* =================== LOYALTY & GIFT CARDS =================== */
  console.log('\nLOYALTY & GIFT CARDS');
  r = await waiter.get('/api/customers?q=Wanjiru');
  ck('search customer', r.status === 200 && r.data.length === 1 && r.data[0].points === 250, 'points=' + (r.data[0] || {}).points);
  const cust = r.data[0];

  r = await waiter.post('/api/customers', { name: 'New Guest', phone: '0799888777' });
  ck('create customer', r.status === 200 && r.data.points === 0);
  const newCust = r.data;
  r = await waiter.post('/api/customers', { name: 'Dupe', phone: '0799888777' });
  ck('duplicate phone rejected', r.status === 400, r.data.error);

  /* earn points: 1 point per 100 KSh */
  const lTbl = await freeTable();
  r = await waiter.post('/api/orders', { table_id: lTbl.id, people: 2 });
  const loyOrder = r.data;
  await waiter.post(`/api/orders/${loyOrder.id}/items`, { items: [{ menu_item_id: ugali.id, qty: 10 }] });
  const loyDue = (await waiter.get(`/api/orders/${loyOrder.id}`)).data.totals;
  r = await cashier.post(`/api/orders/${loyOrder.id}/pay`, {
    method: 'cash', amount: loyDue.grand_total / 100, tendered: loyDue.grand_total / 100, customer_id: newCust.id
  });
  ck('loyalty order closed', r.data.order.status === 'closed');
  const expectedPts = Math.floor(loyDue.total / 100 / 100);
  r = await waiter.get('/api/customers/' + newCust.id);
  ck('points earned on close', r.data.points === expectedPts, `points=${r.data.points} expected=${expectedPts}`);
  ck('visit counted', r.data.visits === 1, 'visits=' + r.data.visits);
  ck('points log written', r.data.points_log.length === 1 && r.data.points_log[0].points === expectedPts);

  /* gift cards */
  r = await cashier.get('/api/gift-cards/lookup/GC-DEMO-1234-ABCD');
  ck('lookup seeded gift card', r.status === 200 && r.data.balance === 200000, 'balance=' + r.data.balance);
  r = await cashier.get('/api/gift-cards/lookup/NOPE-0000-0000-0000');
  ck('unknown gift card 404s', r.status === 404);

  await admin.post('/api/shifts', { opening_float: 0 });
  r = await admin.post('/api/gift-cards', { value: 1000, payment_method: 'cash' });
  ck('admin funds and issues gift card', r.status === 200 && /^GC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.data.code), 'code=' + (r.data || {}).code);
  const gc = r.data;

  /* spend part of it */
  const gTbl = await freeTable();
  r = await waiter.post('/api/orders', { table_id: gTbl.id, people: 1 });
  const gcOrder = r.data;
  await waiter.post(`/api/orders/${gcOrder.id}/items`, { items: [{ menu_item_id: ugali.id, qty: 1 }] });
  const gcDue = (await waiter.get(`/api/orders/${gcOrder.id}`)).data.totals;
  r = await cashier.post(`/api/orders/${gcOrder.id}/pay`, { method: 'giftcard', amount: gcDue.grand_total / 100, reference: gc.code });
  ck('pay with gift card', r.status === 200 && r.data.order.status === 'closed', r.data.error || '');
  r = await cashier.get('/api/gift-cards/lookup/' + gc.code);
  ck('gift card balance reduced', r.data.balance === gc.balance - gcDue.grand_total,
    `${gc.balance} -> ${r.data.balance} (bill ${gcDue.grand_total})`);

  /* overspend guard */
  r = await waiter.post('/api/orders', { table_id: (await freeTable()).id, people: 1 });
  const osOrder = r.data;
  await waiter.post(`/api/orders/${osOrder.id}/items`, { items: [{ menu_item_id: boot.menu.find((m) => m.name === 'Moët & Chandon (Bottle)').id, qty: 1 }] });
  const osDue = (await waiter.get(`/api/orders/${osOrder.id}`)).data.totals;
  r = await cashier.post(`/api/orders/${osOrder.id}/pay`, { method: 'giftcard', amount: osDue.grand_total / 100, reference: gc.code });
  ck('gift card cannot overspend', r.status === 400, r.data.error);

  /* redeem points */
  r = await cashier.post(`/api/orders/${osOrder.id}/pay`, {
    method: 'points', amount: expectedPts, customer_id: newCust.id
  });
  ck('redeem points as payment', r.status === 200, r.data.error || '');
  r = await waiter.get('/api/customers/' + newCust.id);
  ck('points deducted after redemption', r.data.points < expectedPts, 'points=' + r.data.points);

  /* =================== LOCATIONS =================== */
  console.log('\nMULTI-LOCATION');
  r = await mgr.get('/api/locations');
  ck('default location exists', r.data.length >= 1 && !!r.data[0].name, (r.data[0] || {}).name);
  r = await admin.post('/api/locations', { name: 'Westlands Branch', address: 'Waiyaki Way', kra_pin: 'P059999999A' });
  ck('admin creates a location', r.status === 200 && r.data.id);
  const loc2 = r.data;
  r = await mgr.post('/api/locations', { name: 'Should Fail' });
  ck('manager cannot create locations', r.status === 403, r.data.error);
  r = await admin.put('/api/locations/' + loc2.id, { active: 0 });
  ck('deactivate a location', r.status === 200 && r.data.active === 0);

  /* =================== ESC/POS PRINTING =================== */
  console.log('\nESC/POS PRINTING');
  /* spin up a fake printer that captures raw bytes on 9100 */
  const received = [];
  const printer = net.createServer((sock) => {
    sock.on('data', (d) => received.push(d));
    sock.on('end', () => sock.end());
  });
  await new Promise((res) => printer.listen(9100, '127.0.0.1', res));

  r = await admin.put('/api/settings', {
    printer_enabled: '1', printer_host: '127.0.0.1', printer_port: '9100',
    kitchen_printer_host: '127.0.0.1', kitchen_printer_port: '9100'
  });
  ck('configure printer', r.status === 200 && r.data.printer_enabled === '1', 'printer_enabled=' + (r.data||{}).printer_enabled);

  r = await cashier.post('/api/print/receipt/' + bomOrder.id + '?paid=1');
  ck('receipt print accepted', r.status === 200 && r.data.sent === true, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 300));
  const bytes = Buffer.concat(received);
  ck('printer received bytes', bytes.length > 100, bytes.length + ' bytes');
  ck('starts with ESC @ (init)', bytes[0] === 0x1b && bytes[1] === 0x40);
  ck('contains GS V cut', bytes.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00])));
  ck('contains drawer kick ESC p', bytes.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])));
  ck('receipt contains the configured business name', bytes.includes(Buffer.from(boot.settings.business_name)));
  ck('receipt contains the item sold', bytes.includes(Buffer.from('Nyama Choma')));
  ck('receipt contains modifier chosen', bytes.includes(Buffer.from('Medium')));

  r = await chef.post('/api/print/kitchen/' + dpOrder.id, { station: 'bar' });
  ck('kitchen ticket print accepted', r.status === 200 && r.data.sent === true, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 300));
  const all = Buffer.concat(received);
  ck('kitchen ticket header printed', all.includes(Buffer.from('BAR ORDER')));

  r = await chef.post('/api/print/kitchen/' + bomOrder.id, { station: 'kitchen' });
  ck('no kitchen lines -> clear error', r.status === 400, r.data.error);

  /* spool file written for the audit trail */
  const spool = path.join(__dirname, '..', 'spool');
  ck('job spooled to disk', fs.existsSync(spool) && fs.readdirSync(spool).length > 0,
    fs.existsSync(spool) ? fs.readdirSync(spool).length + ' files' : 'no spool dir');

  /* printer down -> graceful failure, not a crash */
  await new Promise((res) => printer.close(res));
  r = await admin.put('/api/settings', { printer_host: '127.0.0.1', printer_port: '9101' });
  r = await cashier.post('/api/print/receipt/' + bomOrder.id);
  ck('unreachable printer returns 502, not a crash', r.status === 502 && r.data.error, r.data.error);
  r = await admin.put('/api/settings', { printer_enabled: '0', printer_host: '', kitchen_printer_host: '' });
  r = await cashier.post('/api/print/receipt/' + bomOrder.id);
  ck('disabled printer spools instead of failing', r.status === 200 && r.data.sent === false, r.data.reason);

  /* =================== INTEGRATION CONFIG =================== */
  console.log('\nINTEGRATION CONFIG (eTIMS / M-Pesa)');
  r = await mgr.get('/api/integrations');
  ck('integration status endpoint', r.status === 200 && r.data.status === 'config_only');
  ck('eTIMS reports missing credentials', r.data.etims.configured === false && r.data.etims.missing.length > 0,
    'missing=' + r.data.etims.missing.join(','));
  ck('M-Pesa reports missing credentials', r.data.mpesa.configured === false);
  /* Store a secret first, then confirm the API never hands it back in the clear. */
  await admin.put('/api/settings', { mpesa_consumer_secret: 'SUPERSECRETVALUE', mpesa_consumer_key: 'CKPLAINTEXT' });
  r = await mgr.get('/api/integrations');
  const wire = JSON.stringify(r.data);
  ck('secrets never returned in plaintext',
    !wire.includes('SUPERSECRETVALUE') && !wire.includes('CKPLAINTEXT'), wire.slice(0, 120));
  ck('secrets masked instead', wire.includes('\u2022'), 'masked form present');
  r = await waiter.get('/api/integrations');
  ck('waiter blocked from integration config', r.status === 403);

  r = await admin.put('/api/settings', {
    etims_enabled: '1', etims_username: 'kra_test', etims_password: 'secret123',
    etims_device_serial: 'SRN-0001', etims_branch_code: '00'
  });
  r = await mgr.get('/api/integrations');
  ck('eTIMS config accepted', r.data.etims.configured === true, 'missing=' + r.data.etims.missing.join(','));
  ck('password masked after save', r.data.etims.password.includes('\u2022'), r.data.etims.password);

  r = await mgr.post('/api/integrations/dry-run', { target: 'etims' });
  ck('eTIMS dry-run shapes a payload', r.status === 200 && !!r.data.payload);
  ck('payload carries the configured KRA PIN', r.data.payload.tin === boot.settings.kra_pin, r.data.payload.tin);
  ck('payload has itemised lines with tax class', r.data.payload.items.length > 0 && r.data.payload.items[0].taxClass === 'A');
  ck('payload totals in shillings', r.data.payload.totalAmount > 0 && r.data.payload.totalAmount < 100000,
    'total=' + r.data.payload.totalAmount);
  ck('payload notes the offline window', r.data.payload.offlineQueueHours === 48);

  r = await admin.put('/api/settings', {
    mpesa_enabled: '1', mpesa_consumer_key: 'ck_test', mpesa_consumer_secret: 'cs_test',
    mpesa_shortcode: '174379', mpesa_passkey: 'pk_test', mpesa_callback_url: 'https://example.com/cb'
  });
  r = await mgr.post('/api/integrations/dry-run', { target: 'mpesa', phone: '0712345678', amount: 1595.50 });
  ck('M-Pesa dry-run shapes a request', r.status === 200 && r.data.ok === true, JSON.stringify(r.data.config));
  ck('phone normalised to 254 format', r.data.phone === '254712345678', r.data.phone);
  ck('amount rounded to whole shillings', r.data.payload.Amount === 1596, 'Amount=' + r.data.payload.Amount);
  ck('sandbox endpoint selected', r.data.endpoint.includes('sandbox.safaricom.co.ke'), r.data.endpoint);
  ck('password not echoed in dry-run', r.data.payload.Password === '••••');
  r = await mgr.post('/api/integrations/dry-run', { target: 'mpesa', phone: '12345', amount: 100 });
  ck('invalid phone rejected by dry-run', r.data.ok === false && r.data.invalid === '12345', r.data.invalid);
  r = await admin.put('/api/settings', { mpesa_env: 'production' });
  r = await mgr.post('/api/integrations/dry-run', { target: 'mpesa', phone: '0712345678', amount: 100 });
  ck('production endpoint selected when env=production', r.data.endpoint.includes('api.safaricom.co.ke'), r.data.endpoint);

  /* restore */
  await admin.put('/api/settings', { mpesa_env: 'sandbox' });

  /* =================== ORDER CHANNELS (4.13) =================== */
  console.log('\nORDER CHANNELS / DELIVERY');
  const chTbl = await freeTable();
  r = await waiter.post('/api/orders', { table_id: chTbl.id, people: 2, channel: 'uber_eats' });
  ck('order records its channel', r.status === 200 && r.data.channel === 'uber_eats', 'channel=' + (r.data || {}).channel);
  const chOrder = r.data;
  r = await waiter.post('/api/orders', { people: 1, channel: 'bolt_food', commission: 250 });
  ck('commission stored in cents', r.status === 200 && r.data.commission === 25000, 'commission=' + r.data.commission);
  const chOrder2 = r.data;
  r = await waiter.post('/api/orders', { people: 1, channel: 'carrier_pigeon' });
  ck('unknown channel rejected', r.status === 400 || r.data.channel === 'takeaway', 'got ' + (r.data.channel || r.data.error));
  r = await waiter.post('/api/orders', { table_id: (await freeTable()).id, people: 2 });
  ck('table order defaults to dine_in', r.data.channel === 'dine_in', 'channel=' + r.data.channel);
  r = await waiter.post('/api/orders', { people: 1 });
  ck('tableless order defaults to takeaway', r.data.channel === 'takeaway', 'channel=' + r.data.channel);

  /* settle the channel orders so they appear in the report */
  for (const o of [chOrder, chOrder2]) {
    await waiter.post(`/api/orders/${o.id}/items`, { items: [{ menu_item_id: ugali.id, qty: 2 }] });
    const due = (await waiter.get(`/api/orders/${o.id}`)).data.totals;
    await cashier.post(`/api/orders/${o.id}/pay`, { method: 'cash', amount: due.grand_total / 100, tendered: due.grand_total / 100 });
  }
  r = await mgr.get('/api/reports/channels?from=' + tday);
  ck('channel report returns rows', r.status === 200 && r.data.length > 0, r.data.map((x) => x.channel).join(','));
  const ue = r.data.find((x) => x.channel === 'uber_eats');
  ck('uber_eats revenue attributed', !!ue && ue.revenue > 0, ue ? 'revenue=' + ue.revenue : 'missing');
  const bf = r.data.find((x) => x.channel === 'bolt_food');
  ck('aggregator commission tracked', !!bf && bf.commission === 25000, bf ? 'commission=' + bf.commission : 'missing');
  r = await waiter.get('/api/reports/channels');
  ck('waiter blocked from channel report', r.status === 403);
  r = await cashier.post(`/api/orders/${chOrder.id}/commission`, { commission: 100 });
  ck('commission can be corrected after the fact', r.status === 200 && r.data.commission === 10000, 'commission=' + (r.data||{}).commission);

  /* =================== QR TABLE ORDERING (4.13) =================== */
  console.log('\nQR TABLE ORDERING');
  const qrTable = boot.tables.find((t) => t.qr_token);
  ck('tables have QR tokens', !!qrTable && qrTable.qr_token.length === 18, (qrTable || {}).qr_token);
  const PUB = async (m, p, b) => {
    const res = await fetch(BASE + p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  r = await PUB('GET', '/api/qr/' + qrTable.qr_token);
  ck('guest menu is public (no login)', r.status === 200 && !!r.data.business, r.data.business);
  ck('guest sees the table name', r.data.table.name === qrTable.name, r.data.table.name);
  ck('guest menu excludes 86 items', r.data.menu.every((m) => m.available !== 0));
  ck('guest menu carries modifier groups', r.data.menu.some((m) => m.groups.length > 0));
  r = await PUB('GET', '/api/qr/not-a-real-token');
  ck('bad token rejected with 404', r.status === 404, r.data.error);
  r = await PUB('POST', '/api/qr/not-a-real-token/items', { items: [{ menu_item_id: ugali.id, qty: 1 }] });
  ck('bad token cannot place an order', r.status === 404, r.data.error);

  r = await PUB('POST', '/api/qr/' + qrTable.qr_token + '/items', { people: 3, items: [{ menu_item_id: ugali.id, qty: 2 }] });
  ck('guest can place an order', r.status === 200 && r.data.items.length === 2, 'lines=' + (r.data.items || []).length);
  const qrOrder = r.data;
  ck('guest order is linked to the table', qrOrder.table_id === qrTable.id);
  ck('guest order appears in the waiter view',
    (await waiter.get('/api/orders')).data.some((o) => o.id === qrOrder.id));

  r = await PUB('POST', '/api/qr/' + qrTable.qr_token + '/items', { items: [{ menu_item_id: nyama.id, qty: 1 }] });
  ck('guest cannot skip a required modifier', r.status === 400 && /Please choose/.test(r.data.error), r.data.error);
  r = await PUB('POST', '/api/qr/' + qrTable.qr_token + '/items', { items: [{ menu_item_id: nyama.id, qty: 1, modifiers: [{ id: doublePour.id }] }] });
  ck('guest cannot attach an unrelated modifier', r.status === 400, r.data.error);
  r = await PUB('POST', '/api/qr/' + qrTable.qr_token + '/items', { items: [{ menu_item_id: nyama.id, qty: 1, modifiers: [{ id: medium.id }] }] });
  ck('guest order with a valid modifier succeeds', r.status === 200);
  r = await PUB('POST', '/api/qr/' + qrTable.qr_token + '/items', { items: [{ menu_item_id: 999999, qty: 1 }] });
  ck('unknown item rejected', r.status === 400 && /No such menu item/.test(r.data.error), r.data.error);

  /* guests get no privileged endpoints */
  r = await PUB('GET', '/api/bootstrap');
  ck('guest cannot reach staff endpoints', r.status === 401);
  r = await PUB('GET', '/api/audit');
  ck('guest cannot read the audit log', r.status === 401);
  const qrPage = await fetch(BASE + '/order/' + qrTable.qr_token);
  ck('guest order page served', qrPage.status === 200 && (await qrPage.text()).includes('Send to kitchen'));

  /* =================== REGRESSION =================== */
  console.log('\nREGRESSION');
  r = await waiter.get('/api/bootstrap');
  ck('bootstrap still works', r.status === 200 && r.data.menu.length >= 87);
  r = await mgr.get('/api/zreport?date=' + tday);
  ck('Z-report still works', r.status === 200 && r.data.by_method.length > 0,
    r.data.by_method.map((m) => m.method).join(','));
  ck('Z-report includes gift card + points tenders',
    r.data.by_method.some((m) => m.method === 'giftcard') && r.data.by_method.some((m) => m.method === 'points'),
    r.data.by_method.map((m) => m.method).join(','));

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFEATURE TEST CRASH:', e); process.exit(2); });

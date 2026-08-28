'use strict';
/* Unit tests for lib/domain.js — pure business rules, no server needed. */
const D = require('../lib/domain');

let pass = 0, fail = 0;
const ck = (n, c, e = '') => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ FAIL ' + n + '  ' + e); }
};
const at = (s) => new Date('2026-08-24T' + s + ':00');   // 24 Aug 2026 is a Monday (dow=1)

console.log('\n=== domain unit tests ===\n');

/* ------------------------- time ranges ------------------------- */
console.log('TIME RANGES');
ck('14:00 inside 12:00-17:00', D.inTimeRange(840, 720, 1020) === true);
ck('11:00 outside 12:00-17:00', D.inTimeRange(660, 720, 1020) === false);
ck('start is inclusive', D.inTimeRange(720, 720, 1020) === true);
ck('end is exclusive', D.inTimeRange(1020, 720, 1020) === false);
ck('wrapping: 23:00 inside 17:00-02:00', D.inTimeRange(1380, 1020, 120) === true);
ck('wrapping: 01:00 inside 17:00-02:00', D.inTimeRange(60, 1020, 120) === true);
ck('wrapping: 10:00 outside 17:00-02:00', D.inTimeRange(600, 1020, 120) === false);
ck('zero-length range never matches', D.inTimeRange(720, 720, 720) === false);
ck('toMinutes parses', D.toMinutes('17:30') === 1050);

/* ------------------------- dayparts ------------------------- */
console.log('\nDAYPARTS');
const HP = [{ id: 1, name: 'Happy Hour', days: '0,1,2,3,4,5,6', start_time: '17:00', end_time: '19:00', discount_pct: 20, active: 1 }];
const NIGHT = [{ id: 2, name: 'Late Night', days: '4,5,6', start_time: '22:00', end_time: '02:00', discount_pct: 15, active: 1 }];
const OFF = [{ id: 3, name: 'Disabled', days: '0,1,2,3,4,5,6', start_time: '12:00', end_time: '14:00', discount_pct: 50, active: 0 }];

ck('Monday 18:00 hits happy hour', D.activeDayparts(HP, at('18:00')).length === 1);
ck('Monday 16:59 misses happy hour', D.activeDayparts(HP, at('16:59')).length === 0);
ck('Monday 19:00 misses happy hour (end exclusive)', D.activeDayparts(HP, at('19:00')).length === 0);
ck('inactive daypart never fires', D.activeDayparts(OFF, at('13:00')).length === 0);

/* Monday = dow 1; the NIGHT rule covers 4,5,6 (Thu/Fri/Sat) */
ck('Monday 23:00 misses Thu-Sat night rule', D.activeDayparts(NIGHT, at('23:00')).length === 0);
/* Saturday 2026-08-22 is dow 6 -> 23:00 should match */
ck('Saturday 23:00 hits late night', D.activeDayparts(NIGHT, new Date('2026-08-22T23:00:00')).length === 1);
/* Sunday 2026-08-23 01:00 is dow 0, but the range started Saturday (dow 6) -> should still match */
ck('Sunday 01:00 still inside Saturday-started range', D.activeDayparts(NIGHT, new Date('2026-08-23T01:00:00')).length === 1);
ck('Monday 01:00 outside (Sunday was dow 0, not in 4,5,6)', D.activeDayparts(NIGHT, new Date('2026-08-24T01:00:00')).length === 0);

/* ------------------------- discounts ------------------------- */
console.log('\nDISCOUNTS');
ck('20% off 1000 = 800', D.discountedPrice(1000, 20) === 800);
ck('0% leaves price', D.discountedPrice(1000, 0) === 1000);
ck('100% gives free, not negative', D.discountedPrice(1000, 100) === 0);
ck('rounds to whole cents', D.discountedPrice(333, 15) === 283);

const catItem = { id: 9, category_id: 5, station: 'bar', price: 500 };
const otherItem = { id: 10, category_id: 6, station: 'kitchen', price: 500 };
const CAT_HP = [{ id: 1, name: 'Bar HH', days: '0,1,2,3,4,5,6', start_time: '17:00', end_time: '19:00', discount_pct: 25, category_id: 5, active: 1 }];
ck('category rule applies to its category', D.bestDiscountFor(catItem, CAT_HP, at('18:00')) !== null);
ck('category rule skips other categories', D.bestDiscountFor(otherItem, CAT_HP, at('18:00')) === null);

const STACK = [
  { id: 1, name: 'Small', days: '0,1,2,3,4,5,6', start_time: '17:00', end_time: '19:00', discount_pct: 10, active: 1 },
  { id: 2, name: 'Big', days: '0,1,2,3,4,5,6', start_time: '17:00', end_time: '19:00', discount_pct: 30, active: 1 }
];
ck('largest discount wins when rules overlap', D.bestDiscountFor(catItem, STACK, at('18:00')).discount_pct === 30);

/* ------------------------- loyalty ------------------------- */
console.log('\nLOYALTY');
ck('1 pt per 100 KSh on 1595 = 15 pts', D.pointsEarned(159500, 100) === 15);
ck('no earn rule -> 0 pts', D.pointsEarned(159500, 0) === 0);
ck('small bill earns nothing', D.pointsEarned(5000, 100) === 0);

let r = D.pointsToRedeem(10, 500, 100000, 1);
ck('redeem 10 pts @1KSh = 1000 off', r.points === 10 && r.value === 1000, JSON.stringify(r));
r = D.pointsToRedeem(1000, 50, 100000, 1);
ck('capped at available balance', r.points === 50, JSON.stringify(r));
r = D.pointsToRedeem(1000, 5000, 2000, 1);
ck('capped at bill total', r.value === 2000, JSON.stringify(r));
r = D.pointsToRedeem(-5, 100, 100000, 1);
ck('negative request clamps to 0', r.points === 0 && r.value === 0);
r = D.pointsToRedeem(10, 100, 100000, 0);
ck('zero point value -> no redemption', r.value === 0);

/* ------------------------- drawer ------------------------- */
console.log('\nCASH DRAWER');
ck('float + sales - refunds - payouts',
  D.expectedCash({ openingFloat: 5000, cashSales: 40000, cashRefunds: 2000, payouts: 3000 }) === 40000);
ck('expected with nothing but float', D.expectedCash({ openingFloat: 5000 }) === 5000);
ck('over counts positive', D.drawerVariance(41000, 40000) === 1000);
ck('short counts negative', D.drawerVariance(39000, 40000) === -1000);
ck('exact counts zero', D.drawerVariance(40000, 40000) === 0);
ck('generic tender expectation includes opening, sales, refunds and expenses',
  D.expectedTender({ opening: 1000, sales: 5000, refunds: 500, expenses: 250 }) === 5250);

console.log('\nRECONCILIATION');
const rc = (x) => D.reconcile({ tolerance: 2000, critical: 50000, ...x });
let rr = rc({ cashVariance: 0, mpesaVariance: 0, cardVariance: 0, stockVariance: 0, stockCoverage: 'full' });
ck('full exact match is fully balanced', rr.status === 'FULLY BALANCED' && rr.overall_variance === 0 && !rr.requires_note);
rr = rc({ cashVariance: 150000, stockVariance: -150000, stockCoverage: 'full' });
ck('cash over offsets stock shortage without false shortage', rr.status === 'RECONCILED — POSSIBLE UNRECORDED SALES' && rr.overall_variance === 0 && rr.requires_note);
rr = rc({ cashVariance: -10000, stockVariance: 0, stockCoverage: 'full' });
ck('cash shortage remains independently visible', rr.cash_variance === -10000 && /SHORTAGE/.test(rr.status));
rr = rc({ cashVariance: 10000, stockVariance: 0, stockCoverage: 'full' });
ck('cash surplus remains independently visible', rr.cash_variance === 10000 && /OVERAGE/.test(rr.status));
rr = rc({ stockVariance: -10000, stockCoverage: 'full' });
ck('stock shortage is classified', rr.stock_retail_variance === -10000 && /SHORTAGE/.test(rr.status));
rr = rc({ stockVariance: 10000, stockCoverage: 'full' });
ck('stock surplus is classified', rr.stock_retail_variance === 10000 && /OVERAGE/.test(rr.status));
rr = rc({ cashVariance: 0, stockVariance: null, stockCoverage: 'none' });
ck('no count never pretends stock variance is zero', rr.status === 'TENDERS BALANCED — STOCK NOT COUNTED' && rr.stock_retail_variance === null && rr.overall_variance === null && !rr.requires_note);
rr = rc({ cashVariance: 0, stockVariance: 0, stockCoverage: 'partial' });
ck('partial count is explicitly scoped', rr.status === 'TENDERS BALANCED — PARTIAL STOCK COUNT' && rr.stock_coverage === 'partial');
rr = rc({ cashVariance: 150000, stockVariance: -150000, stockCoverage: 'partial' });
ck('partial offset is explicitly scoped', rr.status === 'SCOPED RECONCILED — POSSIBLE UNRECORDED SALES' && rr.overall_variance === 0);
rr = rc({ cashVariance: -60000, stockVariance: null, stockCoverage: 'none' });
ck('critical tender shortage without count is explicit', rr.status === 'CRITICAL TENDER SHORTAGE — STOCK NOT COUNTED' && rr.requires_note);
rr = rc({ mpesaVariance: 2500, cardVariance: -2500, stockVariance: 0, stockCoverage: 'full' });
ck('offsetting tender methods are reconciled but not fully balanced', rr.status === 'RECONCILED — OFFSETTING VARIANCES' && rr.tender_variance === 0);

/* ------------------------- recipes ------------------------- */
console.log('\nRECIPES / BOM');
const recipes = [
  { menu_item_id: 1, stock_item_id: 10, qty: 0.5 },   // 0.5kg beef per choma
  { menu_item_id: 1, stock_item_id: 11, qty: 0.1 },   // 0.1kg charcoal
  { menu_item_id: 2, stock_item_id: 10, qty: 0.3 }
];
let mv = D.stockMovementsFor([
  { menu_item_id: 1, qty: 2, status: 'sent' },
  { menu_item_id: 2, qty: 1, status: 'sent' }
], recipes);
ck('aggregates shared ingredient across lines',
  mv.find((m) => m.stock_item_id === 10).qty === 1.3, JSON.stringify(mv));
ck('includes secondary ingredient', mv.find((m) => m.stock_item_id === 11).qty === 0.2);
mv = D.stockMovementsFor([{ menu_item_id: 1, qty: 2, status: 'void' }], recipes);
ck('voided lines consume nothing', mv.length === 0);
mv = D.stockMovementsFor([{ menu_item_id: 99, qty: 5, status: 'sent' }], recipes);
ck('item with no recipe consumes nothing', mv.length === 0);

/* ------------------------- labour ------------------------- */
console.log('\nLABOUR');
const users = [{ id: 1, hourly_rate: 15000 }, { id: 2, hourly_rate: 10000 }];  // 150 & 100 KSh/hr
let lc = D.labourCost([
  { user_id: 1, clock_in: '2026-08-24 09:00:00', clock_out: '2026-08-24 17:00:00' },
  { user_id: 2, clock_in: '2026-08-24 10:00:00', clock_out: '2026-08-24 16:30:00' }
], users);
ck('hours summed', lc.hours === 14.5, 'hours=' + lc.hours);
ck('cost = 8*150 + 6.5*100 = 1850', lc.cost === 185000, 'cost=' + lc.cost);
lc = D.labourCost([{ user_id: 1, clock_in: '2026-08-24 09:00:00', clock_out: null }], users);
ck('open punch excluded', lc.hours === 0 && lc.cost === 0);
lc = D.labourCost([{ user_id: 1, clock_in: '2026-08-24 17:00:00', clock_out: '2026-08-24 09:00:00' }], users);
ck('reversed punch ignored, no negative pay', lc.cost === 0, 'cost=' + lc.cost);
lc = D.labourCost([{ user_id: 1, clock_in: '2026-08-24 09:00:00', clock_out: '2026-08-25 18:00:00' }], users);
ck('absurd 33h punch ignored', lc.hours === 0);
ck('user with no rate costs nothing',
  D.labourCost([{ user_id: 99, clock_in: '2026-08-24 09:00:00', clock_out: '2026-08-24 17:00:00' }], users).cost === 0);
ck('labour pct of sales', D.labourPct(185000, 600000) === 30.8, D.labourPct(185000, 600000) + '%');
ck('labour pct with no sales is 0', D.labourPct(185000, 0) === 0);

/* ------------------------- gift cards ------------------------- */
console.log('\nGIFT CARDS');
const codes = new Set(Array.from({ length: 500 }, () => D.randomGiftCode('SRN')));
ck('codes are unique (500 draws)', codes.size === 500, codes.size + ' unique');
ck('code format SRN-XXXX-XXXX-XXXX', /^SRN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test([...codes][0]), [...codes][0]);
ck('custom prefix honoured', D.randomGiftCode('VIP').startsWith('VIP-'));
ck('no ambiguous chars (I,O,0,1)', ![...codes].some((c) => /[IO01]/.test(c.replace('SRN-', ''))));

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);

'use strict';
/**
 * server.js — Kenyan wines and spirits retail POS. REST API + static frontend + SSE realtime feed.
 */
const path = require('path');
const express = require('express');
const {
  db, seed, loadSampleData, importRetailCsv, setupStatus, runSetup, hashPin, findUserByPin, pinTaken,
  getSettings, getSetting, setSetting, computeTotals, nextOrderNumber, audit, DB_PATH,
  nowLocal, todayLocal
} = require('./db');
const domain = require('./lib/domain');
const integrations = require('./lib/integrations');
const escpos = require('./lib/escpos');

seed();

const app = express();
app.use(express.json({ limit: '3mb' })); // supports owner CSV onboarding/import up to the validated 2 MB limit

/* Route modules receive explicit dependencies so APIs stay unchanged without
   introducing a framework, container or global service locator. */
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const dayBounds = (date) => `${date} 00:00:00`;
const dayEnd = (date) => `${date} 23:59:59`;
const { requireAuth, requireRole } = require('./routes/auth')(app, {
  db, findUserByPin, audit, bad
});
const stockLedger = require('./services/inventory-ledger')({ db });

/* ------------------------------- realtime ------------------------------- */
const clients = new Set();
function broadcast(type, payload = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify({ ...payload, _t: Date.now() })}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}
app.get('/api/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

/* ----------------------- server calendar date --------------------------- */
/* The SQLite-side local calendar date — the exact frame row timestamps are
   written in (datetime('now','localtime')). Date-scoped reports must compare
   against this, not a client/Node-computed date, because on platforms where the
   app clock and SQLite localtime disagree (notably Windows TZ handling) a
   client-supplied "today" would silently select an empty range. */
app.get('/api/today', (req, res) =>
  res.json({ date: db.prepare("SELECT date('now','localtime') d").get().d }));

/* ------------------------- first-run onboarding ------------------------- */
/* Public so the onboarding wizard can reach it before anyone is signed in. */
app.get('/api/setup/status', (req, res) => res.json(setupStatus()));
app.post('/api/setup', (req, res) => {
  const r = runSetup(req.body || {});
  if (!r.ok) return bad(res, r.error);
  res.json({ ok: true, business_name: getSetting('business_name') });
});
/* Load the optional sample menu later, after setup (manager/admin only). */
app.post('/api/setup/sample', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  if (loadSampleData()) { audit(req.user, 'sample.load', 'Loaded the wines and spirits starter catalogue'); broadcast('menu'); res.json({ ok: true }); }
  else return bad(res, 'Sample data already loaded, or a menu already exists — not clobbering your data');
});

/* ------------------------------- bootstrap ------------------------------ */
const listMenu = () => db.prepare(`
  SELECT m.*, c.name AS category_name,
    (SELECT si.qty FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_qty,
    (SELECT si.min_qty FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_min_qty,
    (SELECT si.id FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_item_id,
    (SELECT si.unit FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_unit,
    (SELECT r.qty FROM recipes r WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_deduction,
    (SELECT si.name FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_source_name,
    (SELECT si.deduction_mode FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_deduction_mode,
    (SELECT si.capacity_ml FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_capacity_ml
  FROM menu_items m JOIN categories c ON c.id = m.category_id
  ORDER BY c.sort_order, m.sort_order, m.name`).all();

const orderWithTotals = (o) => {
  const items = db.prepare(
    'SELECT * FROM order_items WHERE order_id = ? AND status != ? ORDER BY id').all(o.id, 'void')
    .map((i) => {
      /* modifiers are stored as JSON text; hand the client a real array */
      let mods = [];
      if (i.modifiers) { try { mods = JSON.parse(i.modifiers); } catch { mods = []; } }
      return { ...i, modifiers: mods };
    });
  const s = getSettings();
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) p FROM payments WHERE order_id=? AND kind='sale'").get(o.id).p;
  const calculated = computeTotals(items, o.discount, s, o.tip);
  const totals = o.status === 'closed' && o.total_snapshot != null ? {
    subtotal: o.subtotal_snapshot, discount: o.discount, service: o.service_snapshot,
    vat: o.vat_snapshot, total: o.total_snapshot, tip: o.tip,
    grand_total: o.grand_total_snapshot, currency: s.currency
  } : calculated;
  return { ...o, items, totals, paid, balance: 0,
    payments: db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(o.id) };
};
const decorate = (o) => { const d = orderWithTotals(o); d.balance = o.status === 'closed' ? 0 : d.totals.grand_total - d.paid; return d; };
/* Always re-read the row before serialising: callers frequently mutate the order
   immediately beforehand and a stale row would return pre-update discount/tip/status. */
const readOrder = (id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id);

app.get('/api/bootstrap', requireAuth, (req, res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE status IN ('open','billed') ORDER BY id").all();
  const dayparts = db.prepare('SELECT * FROM dayparts WHERE active = 1').all();
  const active = domain.activeDayparts(dayparts);
  /* Effective prices right now, so the till shows what the guest will be charged. */
  const pricing = {};
  const menu = listMenu();
  for (const m of menu) {
    const rule = domain.bestDiscountFor(m, active);
    if (rule) pricing[m.id] = { price: domain.discountedPrice(m.price, rule.discount_pct), rule: rule.name, discount_pct: Number(rule.discount_pct) };
  }
  res.json({
    user: { id: req.user.id, name: req.user.name, role: req.user.role },
    settings: getSettings(),
    categories: db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all(),
    menu,
    tables: db.prepare('SELECT * FROM tables ORDER BY sort_order, name').all(),
    orders: orders.map(decorate),
    qr_base: (req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + (process.env.PORT || 3000)),
    users: db.prepare('SELECT id,name,role,active FROM users ORDER BY role,name').all(),
    stock: db.prepare('SELECT * FROM stock_items ORDER BY name').all(),
    stock_packages: db.prepare(`SELECT p.*,s.name stock_name,s.unit base_unit FROM stock_packages p
      JOIN stock_items s ON s.id=p.stock_item_id WHERE p.active=1 ORDER BY s.name,p.units_per_package`).all(),
    /* Phase 2-4 working data */
    dayparts, active_dayparts: active, pricing,
    modifier_groups: db.prepare('SELECT * FROM modifier_groups ORDER BY name').all(),
    modifier_options: db.prepare('SELECT * FROM modifier_options ORDER BY group_id, sort_order, name').all(),
    item_modifiers: db.prepare('SELECT * FROM menu_item_modifiers').all(),
    shift: db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get() || null,
    reservations: db.prepare(`SELECT r.*, t.name AS table_name FROM reservations r
      LEFT JOIN tables t ON t.id = r.table_id
      WHERE r.res_date = date('now','localtime') AND r.status = 'booked' ORDER BY r.res_time`).all(),
    locations: db.prepare('SELECT * FROM locations WHERE active = 1 ORDER BY name').all()
  });
});

require('./routes/catalogue')(app, {
  db, requireAuth, requireRole, getSetting, importRetailCsv, listMenu, stockLedger, audit, broadcast, bad
});

require('./routes/tables')(app, { db, requireAuth, requireRole, broadcast, bad });

/* -------------------------------- orders -------------------------------- */
const ensureRetailTill = require('./services/retail-till')({ db, audit, broadcast });
require('./routes/orders')(app, {
  db, domain, requireAuth, requireRole, getSetting, getSettings, ensureRetailTill,
  nextOrderNumber, nowLocal, decorate, readOrder, audit, broadcast, bad
});

/* ------------------------------- payments ------------------------------- */
const closeOut = require('./services/sale-closeout')({ db, domain, stockLedger });
require('./routes/payments')(app, {
  db, domain, requireAuth, requireRole, getSettings, ensureRetailTill,
  decorate, readOrder, computeTotals, closeOut, audit, broadcast, bad
});

require('./routes/returns')(app, {
  db, requireAuth, requireRole, getSetting, decorate, readOrder, stockLedger, audit, broadcast, bad
});

app.get('/api/receipt/:id', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).send('Order not found');
  const t = o.table_id ? db.prepare('SELECT * FROM tables WHERE id=?').get(o.table_id) : null;
  const w = db.prepare('SELECT name FROM users WHERE id=?').get(o.waiter_id);
  const items = db.prepare("SELECT * FROM order_items WHERE order_id=? AND status!='void' ORDER BY id").all(o.id);
  res.json({ order: decorate(o), table: t, waiter: w, settings: getSettings(), items });
});

require('./routes/inventory')(app, { db, requireAuth, requireRole, stockLedger, audit, broadcast, bad });

require('./routes/complimentaries')(app, {
  db, requireAuth, requireRole, getSetting, ensureRetailTill, todayLocal, dayBounds, dayEnd,
  stockLedger, audit, broadcast, bad
});

/* ---------------------- retail receiving & stocktakes --------------------- */
require('./routes/purchases')(app, {
  db, requireAuth, requireRole, todayLocal, stockLedger, audit, broadcast, bad
});
require('./routes/stocktakes')(app, {
  db, requireAuth, requireRole, getSetting, todayLocal, stockLedger, audit, broadcast, bad
});

require('./routes/users')(app, {
  db, requireAuth, requireRole, hashPin, pinTaken, audit, broadcast, bad
});

require('./routes/reports')(app, {
  db, requireAuth, requireRole, todayLocal, dayBounds, dayEnd, getSettings,
  setSetting, audit, broadcast
});

require('./routes/pricing')(app, {
  db, domain, requireAuth, requireRole, todayLocal, audit, broadcast, bad
});

/* ================= CASH DRAWER RECONCILIATION (2.6) ==================== */
const { drawerFigures } = require('./services/reconciliation')({ db, domain, nowLocal });
require('./routes/shifts')(app, {
  db, domain, requireAuth, requireRole, getSetting, getSettings,
  drawerFigures, audit, broadcast, bad
});

require('./routes/hospitality')(app, {
  db, domain, requireAuth, requireRole, todayLocal, getSettings, audit, broadcast, bad
});

require('./routes/loyalty')(app, {
  db, domain, requireAuth, requireRole, getSettings, audit, broadcast, bad
});

require('./routes/locations')(app, { db, requireAuth, requireRole, bad });

/* ==================== ESC/POS PRINTING (2.5) =========================== */
require('./routes/printing')(app, {
  db, escpos, requireAuth, requireRole, getSettings, decorate, audit, bad,
  spoolDir: path.join(__dirname, 'spool')
});

require('./routes/integrations')(app, {
  db, integrations, requireAuth, requireRole, getSettings, computeTotals, decorate, nowLocal
});

require('./routes/payment-search')(app, { db, requireAuth, requireRole, decorate, bad });

require('./routes/channels')(app, {
  db, requireAuth, requireRole, todayLocal, decorate, readOrder, audit, bad
});

require('./routes/qr-ordering')(app, {
  db, domain, getSettings, listMenu, nextOrderNumber, decorate, readOrder,
  audit, broadcast, bad
});

const backupOperations=require('./services/backup-operations')({rootDir:__dirname,dbPath:DB_PATH});
require('./routes/operations')(app,{requireAuth,requireRole,backupOperations,bad});

/* ------------------------------- frontend ------------------------------- */
/* Legacy hospitality screens stay available only to migrated restaurant installs. */
app.get(['/kds', '/kds.html'], (req, res, next) => {
  if (getSetting('business_type') === 'wines_spirits') return res.redirect('/');
  next();
});
app.get('/kds', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kds.html')));
app.get('/order/:token', (req, res, next) => {
  if (getSetting('business_type') === 'wines_spirits') return res.status(404).send('Retail ordering is available at the till.');
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.json({ ok: true, orders: clients.size }));

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  const listener=app.listen(PORT, '0.0.0.0', () => {
    console.log(`${getSettings().business_name} POS listening on http://0.0.0.0:${PORT}`);
  });
  let stopping=false;
  const shutdown=()=>{
    if(stopping)return;stopping=true;
    const force=setTimeout(()=>process.exit(1),5000);force.unref();
    listener.close(()=>{
      try{db.pragma('wal_checkpoint(TRUNCATE)');db.close();}catch{}
      clearTimeout(force);process.exit(0);
    });
  };
  process.on('SIGTERM',shutdown);
  process.on('SIGINT',shutdown);
}
module.exports = app;

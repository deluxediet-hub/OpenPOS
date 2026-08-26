'use strict';
/**
 * server.js — Kenyan wines and spirits retail POS. REST API + static frontend + SSE realtime feed.
 */
const path = require('path');
const express = require('express');
const {
  db, seed, loadSampleData, setupStatus, runSetup, hashPin, verifyPin, findUserByPin, pinTaken,
  getSettings, getSetting, setSetting, computeTotals, nextOrderNumber, audit, money,
  nowLocal, todayLocal
} = require('./db');
const domain = require('./lib/domain');
const integrations = require('./lib/integrations');
const escpos = require('./lib/escpos');

seed();

const app = express();
app.use(express.json({ limit: '1mb' }));

/* --------------------------- session cookies --------------------------- */
const SESSIONS = new Map(); // token -> {user_id}
const LOGIN_ATTEMPTS = new Map(); // IP -> { failures, blockedUntil }; local brute-force protection
const COOKIE = 'pos_session';
const genToken = () => require('crypto').randomBytes(24).toString('hex');

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t || !SESSIONS.has(t)) return null;
  /* never pull the credential hash into the request-scoped user object */
  return db.prepare('SELECT id,name,role,active FROM users WHERE id = ? AND active = 1')
    .get(SESSIONS.get(t).user_id) || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  req.user = u; next();
}
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Permission denied' });
  next();
};
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ------------------------------- realtime ------------------------------- */
const clients = new Set();
function broadcast(type, payload = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify({ ...payload, _t: Date.now() })}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}
app.get('/api/events', (req, res) => {
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

/* --------------------------------- auth --------------------------------- */
/* The server's own local calendar date. Date-scoped reports must compare against
   this — NOT a client-computed date — because row timestamps are written by this
   process via datetime('now','localtime'). On platforms where the app's clock and
   SQLite's localtime disagree (notably Windows TZ handling), a client-supplied
   "today" would silently select an empty range. */
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

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'local';
  const attempt = LOGIN_ATTEMPTS.get(ip) || { failures: 0, blockedUntil: 0 };
  if (attempt.blockedUntil > Date.now())
    return bad(res, `Too many failed PINs. Try again in ${Math.ceil((attempt.blockedUntil - Date.now()) / 1000)} seconds.`, 429);
  const pin = String(req.body.pin || '').trim();
  if (!pin) return bad(res, 'PIN required');
  const user = findUserByPin(pin);            /* verifies against the stored scrypt hash */
  if (!user) {
    attempt.failures += 1;
    if (attempt.failures >= 5) { attempt.blockedUntil = Date.now() + 60000; attempt.failures = 0; }
    LOGIN_ATTEMPTS.set(ip, attempt);
    return bad(res, 'Invalid PIN', 401);
  }
  LOGIN_ATTEMPTS.delete(ip);
  const token = genToken();
  SESSIONS.set(token, { user_id: user.id });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
  audit({ id: user.id, name: user.name }, 'login', user.role);
  res.json({ user });
});
app.post('/api/logout', (req, res) => {
  const t = parseCookies(req)[COOKIE];
  if (t) SESSIONS.delete(t);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) =>
  res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role } }));

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
      WHERE r.menu_item_id=m.id ORDER BY r.id LIMIT 1) AS stock_source_name
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
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) p FROM payments WHERE order_id = ?').get(o.id).p;
  return { ...o, items, totals: computeTotals(items, o.discount, s, o.tip), paid, balance: 0,
    payments: db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(o.id) };
};
const decorate = (o) => { const d = orderWithTotals(o); d.balance = d.totals.grand_total - d.paid; return d; };
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

/* ------------------------------- catalogue ------------------------------ */
app.get('/api/menu', requireAuth, (req, res) => res.json(listMenu()));

app.post('/api/menu-items', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { name, category_id, price, cost = 0, station = 'bar', available = 1,
    sku = '', barcode = '', volume_ml = null, kra_item_code = '', tax_type = 'B',
    opening_qty = 0, min_qty = 0, unit = 'bottle', stock_mode = 'unit',
    source_stock_item_id = null, serving_ml = null, source_volume_ml = null } = req.body;
  if (!name || !category_id) return bad(res, 'Name and category required');
  const retail = getSetting('business_type') === 'wines_spirits';
  const effectiveStation = retail ? 'retail' : station;
  const mode = retail && stock_mode === 'pour' ? 'pour' : 'unit';
  let sourceStock = null, deduction = 1;
  if (mode === 'pour') {
    sourceStock = db.prepare('SELECT * FROM stock_items WHERE id=?').get(Number(source_stock_item_id));
    const serving = Number(serving_ml || volume_ml), container = Number(source_volume_ml);
    if (!sourceStock) return bad(res, 'Choose the bottle or keg stock used for this pour');
    if (!(serving > 0) || !(container >= serving)) return bad(res, 'Serving and source container sizes are required');
    deduction = serving / container;
  }
  if (barcode && db.prepare('SELECT id FROM menu_items WHERE barcode=?').get(String(barcode).trim())) return bad(res, 'Barcode already belongs to another product');
  if (sku && db.prepare('SELECT id FROM menu_items WHERE sku=?').get(String(sku).trim())) return bad(res, 'SKU already belongs to another product');
  let itemId;
  const tx = db.transaction(() => {
    const enteredCost = Math.round(Number(cost) * 100);
    const effectiveCost = mode === 'pour' && !enteredCost ? Math.round(sourceStock.cost * deduction) : enteredCost;
    itemId = db.prepare(`INSERT INTO menu_items(category_id,name,price,cost,station,available,sort_order,sku,barcode,volume_ml,stock_mode,serving_ml,sale_unit,kra_item_code,tax_type)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(category_id, name.trim(), Math.round(Number(price) * 100),
      effectiveCost, effectiveStation, available ? 1 : 0, 999, String(sku).trim() || null,
      String(barcode).trim() || null, Number(volume_ml) || null, mode, mode === 'pour' ? Number(serving_ml || volume_ml) : null,
      unit || (mode === 'pour' ? 'shot' : 'piece'), String(kra_item_code).trim() || null, tax_type || 'B').lastInsertRowid;
    if (retail && mode === 'pour') {
      db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,?)').run(itemId, sourceStock.id, deduction);
    } else if (retail) {
      const opening = Number(opening_qty) || 0;
      const stockId = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost) VALUES(?,?,?,?,?)')
        .run(name.trim(), unit || 'bottle', opening, Number(min_qty) || 0, effectiveCost).lastInsertRowid;
      db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,1)').run(itemId, stockId);
      if (opening) db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
        .run(stockId, opening, 'Opening stock', req.user.id);
    }
  });
  try { tx(); } catch (e) { return bad(res, e.message); }
  audit(req.user, 'product.create', `${name} @ KSh${Number(price).toFixed(2)} sku=${sku || '-'} barcode=${barcode || '-'}`);
  broadcast('menu'); broadcast('stock');
  res.json(listMenu().find((m) => m.id === Number(itemId)));
});

app.put('/api/menu-items/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(req.params.id);
  if (!cur) return bad(res, 'Not found', 404);
  const b = req.body, barcode = b.barcode !== undefined ? String(b.barcode).trim() : cur.barcode,
    sku = b.sku !== undefined ? String(b.sku).trim() : cur.sku;
  if (barcode && db.prepare('SELECT id FROM menu_items WHERE barcode=? AND id!=?').get(barcode, cur.id)) return bad(res, 'Barcode already belongs to another product');
  if (sku && db.prepare('SELECT id FROM menu_items WHERE sku=? AND id!=?').get(sku, cur.id)) return bad(res, 'SKU already belongs to another product');
  const retail = getSetting('business_type') === 'wines_spirits';
  const effectiveStation = retail ? 'retail' : (b.station ?? cur.station);
  const mode = cur.stock_mode || 'unit';
  let pourSource = null, pourDeduction = null;
  if (retail && mode === 'pour') {
    const currentRecipe = db.prepare('SELECT * FROM recipes WHERE menu_item_id=? ORDER BY id LIMIT 1').get(cur.id);
    pourSource = db.prepare('SELECT * FROM stock_items WHERE id=?').get(Number(b.source_stock_item_id) || (currentRecipe || {}).stock_item_id);
    const serving = Number(b.serving_ml || b.volume_ml || cur.serving_ml || cur.volume_ml);
    const inferredContainer = currentRecipe && currentRecipe.qty ? serving / currentRecipe.qty : 0;
    const container = Number(b.source_volume_ml) || inferredContainer;
    if (!pourSource || !(serving > 0) || !(container >= serving)) return bad(res, 'Valid pour source and sizes are required');
    pourDeduction = serving / container;
  }
  const tx = db.transaction(() => {
    db.prepare(`UPDATE menu_items SET category_id=?,name=?,price=?,cost=?,station=?,available=?,sku=?,barcode=?,volume_ml=?,stock_mode=?,serving_ml=?,sale_unit=?,kra_item_code=?,tax_type=? WHERE id=?`)
      .run(b.category_id ?? cur.category_id, b.name ?? cur.name,
        b.price != null ? Math.round(Number(b.price) * 100) : cur.price,
        b.cost != null ? Math.round(Number(b.cost) * 100) : cur.cost,
        effectiveStation, b.available != null ? (b.available ? 1 : 0) : cur.available,
        sku || null, barcode || null, b.volume_ml !== undefined ? (Number(b.volume_ml) || null) : cur.volume_ml,
        mode, mode === 'pour' ? Number(b.serving_ml || b.volume_ml || cur.serving_ml || cur.volume_ml) : null,
        b.unit || cur.sale_unit || 'piece',
        b.kra_item_code !== undefined ? (String(b.kra_item_code).trim() || null) : cur.kra_item_code,
        b.tax_type ?? cur.tax_type, cur.id);
    const stock = db.prepare(`SELECT si.* FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id WHERE r.menu_item_id=? ORDER BY r.id LIMIT 1`).get(cur.id);
    if (retail && mode === 'pour') {
      db.prepare('DELETE FROM recipes WHERE menu_item_id=?').run(cur.id);
      db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,?)').run(cur.id, pourSource.id, pourDeduction);
    } else if (stock && retail) {
      const sourceCost = b.cost != null ? Math.round(Number(b.cost) * 100) : cur.cost;
      db.prepare('UPDATE stock_items SET name=?,cost=?,min_qty=COALESCE(?,min_qty),unit=COALESCE(?,unit) WHERE id=?')
        .run(b.name ?? cur.name, sourceCost, b.min_qty !== undefined ? Number(b.min_qty) : null, b.unit || null, stock.id);
      if (b.cost != null) db.prepare(`UPDATE menu_items SET cost=ROUND(? *
        (SELECT r.qty FROM recipes r WHERE r.menu_item_id=menu_items.id AND r.stock_item_id=?))
        WHERE stock_mode='pour' AND id IN (SELECT menu_item_id FROM recipes WHERE stock_item_id=?)`)
        .run(sourceCost, stock.id, stock.id);
    }
  });
  try { tx(); } catch (e) { return bad(res, e.message); }
  audit(req.user, 'product.update', `${cur.name} sku=${sku || '-'} barcode=${barcode || '-'}`);
  broadcast('menu'); broadcast('stock');
  res.json(listMenu().find((m) => m.id === cur.id));
});

app.delete('/api/menu-items/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(req.params.id);
  if (!cur) return bad(res, 'Not found', 404);
  const linkedStock = db.prepare('SELECT stock_item_id FROM recipes WHERE menu_item_id=?').all(cur.id).map((r) => r.stock_item_id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM menu_items WHERE id=?').run(cur.id);
    if (getSetting('business_type') === 'wines_spirits') for (const stockId of linkedStock) {
      const stillUsed = db.prepare('SELECT id FROM recipes WHERE stock_item_id=? LIMIT 1').get(stockId);
      if (!stillUsed) db.prepare('DELETE FROM stock_items WHERE id=?').run(stockId);
    }
  });
  tx();
  audit(req.user, 'product.delete', cur.name);
  broadcast('menu');
  res.json({ ok: true });
});

app.post('/api/categories', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { name, station = 'kitchen' } = req.body;
  if (!name) return bad(res, 'Name required');
  const effectiveStation = getSetting('business_type') === 'wines_spirits' ? 'retail' : station;
  const r = db.prepare('INSERT INTO categories(name,station,sort_order) VALUES(?,?,?)')
    .run(name.trim(), effectiveStation, db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 s FROM categories').get().s);
  broadcast('menu');
  res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/categories/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
  if (!c) return bad(res, 'Not found', 404);
  const station = getSetting('business_type') === 'wines_spirits' ? 'retail' : (req.body.station ?? c.station);
  db.prepare('UPDATE categories SET name=?, station=? WHERE id=?')
    .run(req.body.name ?? c.name, station, c.id);
  broadcast('menu');
  res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(c.id));
});
app.delete('/api/categories/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  broadcast('menu');
  res.json({ ok: true });
});

/* -------------------------------- tables -------------------------------- */
app.post('/api/tables', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { name, area, seats = 4 } = req.body;
  if (!name || !area) return bad(res, 'Name and area required');
  const r = db.prepare('INSERT INTO tables(name,area,seats,sort_order) VALUES(?,?,?,?)')
    .run(name.trim(), area.trim(), Number(seats) || 1,
      db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 s FROM tables').get().s);
  broadcast('tables');
  res.json(db.prepare('SELECT * FROM tables WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/tables/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const t = db.prepare('SELECT * FROM tables WHERE id=?').get(req.params.id);
  if (!t) return bad(res, 'Not found', 404);
  db.prepare('UPDATE tables SET name=?, area=?, seats=? WHERE id=?')
    .run(req.body.name ?? t.name, req.body.area ?? t.area, req.body.seats ?? t.seats, t.id);
  broadcast('tables');
  res.json(db.prepare('SELECT * FROM tables WHERE id=?').get(t.id));
});
app.delete('/api/tables/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const open = db.prepare("SELECT COUNT(*) c FROM orders WHERE table_id=? AND status IN ('open','billed')").get(req.params.id).c;
  if (open) return bad(res, 'Table has an open order');
  db.prepare('DELETE FROM tables WHERE id=?').run(req.params.id);
  broadcast('tables');
  res.json({ ok: true });
});

/* -------------------------------- orders -------------------------------- */
function ensureRetailTill(user) {
  const active = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get();
  if (active) return active.status === 'open' ? active : null;
  if (!['admin', 'manager'].includes(user.role)) return null;
  const id = db.prepare("INSERT INTO shifts(opened_by,opening_float,opening_mpesa,notes) VALUES(?,0,0,'Automatically opened for owner sale')")
    .run(user.id).lastInsertRowid;
  audit(user, 'shift.auto_open', 'Owner started sale with zero opening Cash/M-Pesa balances');
  broadcast('sales');
  return db.prepare('SELECT * FROM shifts WHERE id=?').get(id);
}

app.get('/api/orders', requireAuth, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY opened_at DESC').all(status)
    : db.prepare("SELECT * FROM orders WHERE status IN ('open','billed') ORDER BY opened_at DESC").all();
  res.json(rows.map(decorate));
});

app.get('/api/orders/:id', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  res.json(decorate(o));
});

app.post('/api/orders', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
  if (getSetting('business_type') === 'wines_spirits' && !ensureRetailTill(req.user))
    return bad(res, req.user.role === 'seller' ? 'Open the till before starting a sale' : 'Finish the current till reconciliation before starting another sale');
  const table_id = Number(req.body.table_id) || null;
  const people = Number(req.body.people) || Number(getSettings().default_people) || 1;
  /* Order channel (Phase 4) — how the sale reached us, and what an aggregator took. */
  const CHANNELS = ['dine_in', 'takeaway', 'delivery', 'uber_eats', 'bolt_food', 'glovo', 'phone'];
  const channel = CHANNELS.includes(req.body.channel) ? req.body.channel : (table_id ? 'dine_in' : 'takeaway');
  const commission = Math.max(0, Math.round(Number(req.body.commission || 0) * 100));
  if (table_id) {
    const busy = db.prepare("SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed')").get(table_id);
    if (busy) return bad(res, 'Table already has an open order');
  }
  const r = db.prepare('INSERT INTO orders(number,table_id,waiter_id,people,notes,channel,commission,tab_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(nextOrderNumber(), table_id, req.user.id, people, req.body.notes || null, channel, commission,
      req.body.tab_id || null);
  const o = decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid));
  audit(req.user, 'order.open', `#${o.number}${channel !== 'dine_in' ? ' (' + channel + ')' : ''}`);
  broadcast('orders'); broadcast('kitchen'); broadcast('tables');
  res.json(o);
});

app.post('/api/orders/:id/items', requireAuth, requireRole('seller', 'waiter', 'cashier', 'bartender', 'manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  if (o.status === 'closed' || o.status === 'void') return bad(res, 'Order is closed');
  const lines = Array.isArray(req.body.items) ? req.body.items : [req.body];
  /* Happy hour / daypart pricing is resolved once, at the moment of sale, and the
     resulting price is frozen onto the line so later rule edits can't rewrite history. */
  const dayparts = db.prepare('SELECT * FROM dayparts WHERE active = 1').all();
  const groups = db.prepare('SELECT * FROM modifier_groups').all();
  const options = db.prepare('SELECT * FROM modifier_options').all();
  const ins = db.prepare(`INSERT INTO order_items(order_id,menu_item_id,name,price,qty,note,station,added_by,modifiers)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const l of lines) {
      const m = db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(l.menu_item_id));
      if (!m) throw new Error('Menu item not found');
      if (!m.available && !['manager', 'admin'].includes(req.user.role)) throw new Error(`${m.name} is unavailable`);
      const requestedQty = Number(l.qty) || 1;
      if (getSetting('business_type') === 'wines_spirits' && getSetting('prevent_negative_stock') === '1') {
        const tracked = db.prepare(`SELECT si.qty,r.qty deduction FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
          WHERE r.menu_item_id=? ORDER BY r.id LIMIT 1`).get(m.id);
        const already = db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM order_items
          WHERE order_id=? AND menu_item_id=? AND status!='void'`).get(o.id, m.id).q;
        if (tracked && (already + requestedQty) * tracked.deduction > tracked.qty) {
          const servings = Math.floor(tracked.qty / tracked.deduction);
          throw new Error(`${m.name}: only ${servings} sale unit(s) available`);
        }
      }

      /* base price, less any active daypart discount */
      const rule = domain.bestDiscountFor(m, dayparts);
      let price = rule ? domain.discountedPrice(m.price, rule.discount_pct) : m.price;
      const chosen = [];

      /* modifiers: validate every one against the menu item's allowed groups */
      if (Array.isArray(l.modifiers) && l.modifiers.length) {
        const allowed = db.prepare('SELECT group_id FROM menu_item_modifiers WHERE menu_item_id=?').all(m.id)
          .map((g) => g.group_id);
        for (const mod of l.modifiers) {
          const opt = options.find((x) => x.id === Number(mod.id));
          if (!opt) throw new Error('Unknown modifier');
          if (!allowed.includes(opt.group_id)) throw new Error(`"${opt.name}" is not available on ${m.name}`);
          chosen.push({ id: opt.id, group_id: opt.group_id, name: opt.name, price: opt.price });
          price += opt.price;
        }
        /* enforce required groups */
        const requiredGroups = groups.filter((g) => g.required && allowed.includes(g.id));
        for (const g of requiredGroups) {
          if (!chosen.some((c) => c.group_id === g.id)) throw new Error(`Please choose: ${g.name}`);
        }
      } else {
        const requiredGroups = db.prepare(`SELECT g.* FROM modifier_groups g
          JOIN menu_item_modifiers mm ON mm.group_id = g.id
          WHERE mm.menu_item_id = ? AND g.required = 1`).all(m.id);
        if (requiredGroups.length) throw new Error(`Please choose: ${requiredGroups[0].name}`);
      }

      ins.run(o.id, m.id, m.name, price, Number(l.qty) || 1, l.note || null, m.station, req.user.id,
        chosen.length ? JSON.stringify(chosen) : null);
    }
  });
  try { tx(); } catch (e) { return bad(res, e.message); }
  audit(req.user, 'order.add_items', `#${o.number} x${lines.length}`);
  broadcast('orders'); broadcast('kitchen');
  res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});

app.patch('/api/orders/:id/items/:itemId', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM order_items WHERE order_id=? AND id=?').get(req.params.id, req.params.itemId);
  if (!it) return bad(res, 'Item not found', 404);
  const to = req.body.status;
  if (!['pending', 'sent', 'ready', 'served', 'void'].includes(to)) return bad(res, 'Bad status');
  if (to === 'ready' && !['kitchen', 'bartender', 'manager', 'admin'].includes(req.user.role))
    return bad(res, 'Only kitchen/bar can mark ready', 403);
  /* Station isolation: the kitchen readies kitchen lines, the bar readies bar lines. */
  if (to === 'ready') {
    if (req.user.role === 'kitchen' && it.station !== 'kitchen')
      return bad(res, 'Kitchen can only ready kitchen items', 403);
    if (req.user.role === 'bartender' && it.station !== 'bar')
      return bad(res, 'Bar can only ready bar items', 403);
  }
  if (to === 'void' && !['manager', 'admin'].includes(req.user.role))
    return bad(res, 'Only a manager can void an item', 403);
  const sent = to === 'sent' ? nowLocal() : it.sent_at;
  db.prepare('UPDATE order_items SET status=?, sent_at=?, void_reason=? WHERE id=?')
    .run(to, sent, to === 'void' ? (req.body.reason || null) : null, it.id);
  if (to === 'void') audit(req.user, 'item.void', `#${req.params.id} ${it.name} — ${req.body.reason || ''}`);
  broadcast('orders'); broadcast('kitchen');
  res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id)));
});

app.delete('/api/orders/:id/items/:itemId', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM order_items WHERE order_id=? AND id=?').get(req.params.id, req.params.itemId);
  if (!it) return bad(res, 'Item not found', 404);
  if (it.status !== 'pending' && !['manager', 'admin'].includes(req.user.role))
    return bad(res, 'Item already sent — ask a manager to void it', 403);
  if (it.status === 'pending') db.prepare('DELETE FROM order_items WHERE id=?').run(it.id);
  else {
    db.prepare("UPDATE order_items SET status='void', void_reason=? WHERE id=?")
      .run(req.body?.reason || 'Manager removal', it.id);
    audit(req.user, 'item.void', `${it.name} on #${req.params.id}`);
  }
  broadcast('orders'); broadcast('kitchen');
  res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id)));
});

// Send all pending lines to their station (fire ticket)
app.post('/api/orders/:id/send', requireAuth, requireRole('seller', 'waiter', 'cashier', 'bartender', 'manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const now = nowLocal();
  const n = db.prepare("UPDATE order_items SET status='sent', sent_at=? WHERE order_id=? AND status='pending'")
    .run(now, o.id).changes;
  if (!n) return bad(res, 'Nothing pending to send');
  audit(req.user, 'order.send', `#${o.number} (${n} lines)`);
  broadcast('orders'); broadcast('kitchen');
  res.json(decorate(readOrder(o.id)));
});

app.patch('/api/orders/:id/people', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const people = Math.max(1, Math.min(200, Math.round(Number(req.body.people) || 1)));
  db.prepare('UPDATE orders SET people=? WHERE id=?').run(people, o.id);
  audit(req.user, 'order.people', `#${o.number} → ${people} guests`);
  broadcast('orders');
  res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});

app.post('/api/orders/:id/discount', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const amount = Math.max(0, Math.round(Number(req.body.amount) * 100));
  db.prepare('UPDATE orders SET discount=?, discount_reason=? WHERE id=?')
    .run(amount, req.body.reason || null, o.id);
  audit(req.user, 'order.discount', `#${o.number} KSh${(amount / 100).toFixed(2)} — ${req.body.reason || ''}`);
  broadcast('orders');
  res.json(decorate(readOrder(o.id)));
});

app.post('/api/orders/:id/transfer', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  const t = db.prepare('SELECT * FROM tables WHERE id=?').get(Number(req.body.table_id));
  if (!o || !t) return bad(res, 'Order or table not found', 404);
  const busy = db.prepare("SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed') AND id != ?").get(t.id, o.id);
  if (busy) return bad(res, 'Destination table is occupied');
  db.prepare('UPDATE orders SET table_id=? WHERE id=?').run(t.id, o.id);
  audit(req.user, 'order.transfer', `#${o.number} -> ${t.name}`);
  broadcast('orders'); broadcast('tables');
  res.json(decorate(readOrder(o.id)));
});

app.post('/api/orders/:id/void', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  if (o.status === 'closed') return bad(res, 'Paid orders must be refunded, not voided');
  db.prepare("UPDATE order_items SET status='void', void_reason=? WHERE order_id=? AND status != 'void'")
    .run('Order voided', o.id);
  db.prepare("UPDATE orders SET status='void', closed_at=datetime('now','localtime'), closed_by=? WHERE id=?")
    .run(req.user.id, o.id);
  audit(req.user, 'order.void', `#${o.number} — ${req.body.reason || ''}`);
  broadcast('orders'); broadcast('kitchen'); broadcast('tables');
  res.json({ ok: true });
});

/* ------------------------------- payments ------------------------------- */
app.post('/api/orders/:id/pay', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const d = decorate(o);
  const s = getSettings();
  if (s.business_type === 'wines_spirits' && !ensureRetailTill(req.user))
    return bad(res, req.user.role === 'seller' ? 'The till is closed. Open it before taking payment.' : 'Finish the current till reconciliation before taking payment.');
  const method = req.body.method;
  const METHODS = ['cash', 'card', 'mpesa', 'giftcard', 'points'];
  if (!METHODS.includes(method)) return bad(res, 'Unknown payment method');
  const tip = Math.max(0, Math.round(Number(req.body.tip || 0) * 100));
  const amount = Math.round(Number(req.body.amount) * 100);
  if (!amount || amount <= 0) return bad(res, 'Amount must be greater than zero');
  const balance = d.totals.grand_total + tip - d.paid;
  if (method === 'mpesa' && !String(req.body.reference || '').trim())
    return bad(res, 'M-Pesa confirmation code is required');
  if (method === 'mpesa' && db.prepare("SELECT id FROM payments WHERE method='mpesa' AND upper(reference)=upper(?)").get(String(req.body.reference).trim()))
    return bad(res, 'That M-Pesa confirmation code has already been used');
  if (method !== 'cash' && amount > balance)
    return bad(res, `${method} payment cannot exceed the balance due`);

  /* Cash: the amount tendered is what actually lands in the drawer, so the server
     must see it — the client alone cannot be trusted to work out the change. */
  let tendered = null, change = 0, reference = req.body.reference || null;
  if (method === 'cash') {
    if (req.body.tendered == null || isNaN(Number(req.body.tendered)))
      return bad(res, 'Cash tender amount is required');
    tendered = Math.round(Number(req.body.tendered) * 100);
    if (tendered < amount)
      return bad(res, `Short by ${((amount - tendered) / 100).toFixed(2)} — cannot settle in cash`);
    change = tendered - amount;
    reference = `Tendered ${(tendered / 100).toFixed(2)} · Change ${(change / 100).toFixed(2)}`;
  }

  /* Gift card: validate the code and that it holds enough value */
  let card = null;
  if (method === 'giftcard') {
    const code = String(req.body.reference || '').trim().toUpperCase();
    card = db.prepare('SELECT * FROM gift_cards WHERE code=?').get(code);
    if (!card) return bad(res, 'No gift card with that code');
    if (card.status !== 'active') return bad(res, `Gift card is ${card.status}`);
    if (card.balance < amount) return bad(res, `Gift card holds only ${(card.balance / 100).toFixed(2)}`);
    reference = `Gift card ${card.code}`;
  }

  /* Loyalty: a customer can be attached on ANY tender — earning points on a cash
     or card bill matters just as much as redeeming them. */
  let customer = null, pointsSpent = 0;
  const requestedCustomer = Number(req.body.customer_id) || null;
  if (requestedCustomer) {
    customer = db.prepare('SELECT * FROM customers WHERE id=?').get(requestedCustomer);
    if (!customer) return bad(res, 'Customer not found');
  }
  if (method === 'points') {
    if (!customer) return bad(res, 'A customer is required to redeem points');
    const perPoint = Number(s.loyalty_redeem_per) || 0;
    if (!perPoint) return bad(res, 'Point redemption value is not configured');
    pointsSpent = amount / (perPoint * 100);
    if (pointsSpent % 1 !== 0) return bad(res, 'Redemption must be a whole number of points');
    if (pointsSpent > customer.points) return bad(res, `Customer only has ${customer.points} points`);
    reference = `${pointsSpent} points redeemed`;
  }

  const openShift = db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
  if (s.business_type === 'wines_spirits' && s.prevent_negative_stock === '1' && d.paid + amount >= d.totals.grand_total + tip) {
    const movements = domain.stockMovementsFor(d.items, db.prepare('SELECT * FROM recipes').all());
    for (const movement of movements) {
      const stock = db.prepare('SELECT name,qty FROM stock_items WHERE id=?').get(movement.stock_item_id);
      if (stock && stock.qty < movement.qty) return bad(res, `${stock.name}: only ${stock.qty} in stock; recount before payment`);
    }
  }

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO payments(order_id,method,amount,reference,tip,cashier_id,shift_id) VALUES(?,?,?,?,?,?,?)')
      .run(o.id, method, amount, reference, tip, req.user.id, openShift ? openShift.id : null);

    if (card) {
      const left = card.balance - amount;
      db.prepare('UPDATE gift_cards SET balance=?, status=? WHERE id=?')
        .run(left, left <= 0 ? 'depleted' : 'active', card.id);
    }
    if (customer && pointsSpent) {
      db.prepare('UPDATE customers SET points = points - ? WHERE id=?').run(pointsSpent, customer.id);
      db.prepare('INSERT INTO loyalty_log(customer_id,order_id,points,reason) VALUES(?,?,?,?)')
        .run(customer.id, o.id, -pointsSpent, 'Redeemed at till');
    }
    if (tip) db.prepare('UPDATE orders SET tip = tip + ? WHERE id=?').run(tip, o.id);
    if (customer) db.prepare('UPDATE orders SET customer_id=? WHERE id=?').run(customer.id, o.id);

    // Finalise retail units without exposing hospitality preparation states.
    if (s.business_type === 'wines_spirits')
      db.prepare("UPDATE order_items SET status='sold' WHERE order_id=? AND status!='void'").run(o.id);
    else
      db.prepare("UPDATE order_items SET status='served' WHERE order_id=? AND status IN ('sent','ready')").run(o.id);
    const after = db.prepare('SELECT COALESCE(SUM(amount),0) p FROM payments WHERE order_id=?').get(o.id).p;

    if (after >= d.totals.grand_total + tip) {
      db.prepare("UPDATE orders SET status='closed', closed_at=datetime('now','localtime'), closed_by=?, shift_id=? WHERE id=?")
        .run(req.user.id, openShift ? openShift.id : null, o.id);
      closeOut(o.id, d, s, req.user, customer ? customer.id : null);
    } else {
      db.prepare("UPDATE orders SET status='billed' WHERE id=?").run(o.id);
    }
  });
  tx();
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) p FROM payments WHERE order_id=?').get(o.id).p;
  audit(req.user, 'payment', `#${o.number} ${method} KSh${(amount / 100).toFixed(2)}` +
    (change ? ` (tendered ${(tendered / 100).toFixed(2)}, change ${(change / 100).toFixed(2)})` : ''));
  broadcast('orders'); broadcast('kitchen'); broadcast('tables'); broadcast('sales'); broadcast('stock');
  res.json({ change, tendered, paid, order: decorate(readOrder(o.id)) });
});

/**
 * Runs once an order is fully settled: deplete stock from recipes and award
 * loyalty points. Both are idempotent-ish by virtue of only running on the
 * transition into `closed`.
 *
 * customerId is passed in rather than read off the decorated order, because the
 * order row was snapshotted before the customer was attached to it.
 */
function closeOut(orderId, d, s, user, customerId) {
  /* ---- Recipe / BOM stock depletion (Phase 2.4) ---- */
  const lines = db.prepare("SELECT * FROM order_items WHERE order_id=? AND status != 'void'").all(orderId);
  const recipes = db.prepare('SELECT * FROM recipes').all();
  for (const mv of domain.stockMovementsFor(lines, recipes)) {
    db.prepare('UPDATE stock_items SET qty = qty - ? WHERE id=?').run(mv.qty, mv.stock_item_id);
    db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
      .run(mv.stock_item_id, -mv.qty, `Recipe usage — order #${orderId}`, user ? user.id : null);
  }

  /* ---- Loyalty points earned (Phase 3.12) ---- */
  const cust = customerId ? db.prepare('SELECT * FROM customers WHERE id=?').get(customerId) : null;
  if (s.loyalty_enabled === '1' && cust) {
    const earned = domain.pointsEarned(d.totals.total, s.loyalty_earn_per);
    if (earned > 0) {
      db.prepare('UPDATE customers SET points = points + ?, total_spend = total_spend + ?, visits = visits + 1 WHERE id=?')
        .run(earned, d.totals.total, cust.id);
      db.prepare('INSERT INTO loyalty_log(customer_id,order_id,points,reason) VALUES(?,?,?,?)')
        .run(cust.id, orderId, earned, `Earned on ${(d.totals.total / 100).toFixed(2)}`);
    }
  }
}

app.post('/api/orders/:id/refund', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const amount = Math.round(Number(req.body.amount) * 100);
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) p FROM payments WHERE order_id=?').get(o.id).p;
  if (!amount || amount <= 0) return bad(res, 'Amount must be greater than zero');
  if (amount > paid) return bad(res, 'Refund exceeds amount paid');
  db.prepare('INSERT INTO payments(order_id,method,amount,reference,cashier_id) VALUES(?,?,?,?,?)')
    .run(o.id, 'refund', -amount, req.body.reason || 'Refund', req.user.id);
  audit(req.user, 'refund', `#${o.number} KSh${(amount / 100).toFixed(2)} — ${req.body.reason || ''}`);
  broadcast('sales'); broadcast('orders');
  res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});

app.get('/api/receipt/:id', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).send('Order not found');
  const t = o.table_id ? db.prepare('SELECT * FROM tables WHERE id=?').get(o.table_id) : null;
  const w = db.prepare('SELECT name FROM users WHERE id=?').get(o.waiter_id);
  const items = db.prepare("SELECT * FROM order_items WHERE order_id=? AND status!='void' ORDER BY id").all(o.id);
  res.json({ order: decorate(o), table: t, waiter: w, settings: getSettings(), items });
});

/* ------------------------------- inventory ------------------------------ */
app.get('/api/stock', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM stock_items ORDER BY name').all()));
app.get('/api/stock-moves', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.prepare(`SELECT sm.*,si.name,si.unit,u.name user_name FROM stock_moves sm
    JOIN stock_items si ON si.id=sm.stock_item_id LEFT JOIN users u ON u.id=sm.user_id
    ORDER BY sm.id DESC LIMIT ?`).all(limit));
});

app.post('/api/stock', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { name, unit = 'pcs', qty = 0, min_qty = 0, cost = 0 } = req.body;
  if (!name) return bad(res, 'Name required');
  const r = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost) VALUES(?,?,?,?,?)')
    .run(name.trim(), unit, Number(qty) || 0, Number(min_qty) || 0, Math.round(Number(cost) * 100));
  res.json(db.prepare('SELECT * FROM stock_items WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/stock/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const s = db.prepare('SELECT * FROM stock_items WHERE id=?').get(req.params.id);
  if (!s) return bad(res, 'Not found', 404);
  db.prepare('UPDATE stock_items SET name=?, unit=?, qty=?, min_qty=?, cost=? WHERE id=?')
    .run(req.body.name ?? s.name, req.body.unit ?? s.unit, req.body.qty ?? s.qty,
      req.body.min_qty ?? s.min_qty, req.body.cost != null ? Math.round(Number(req.body.cost) * 100) : s.cost, s.id);
  res.json(db.prepare('SELECT * FROM stock_items WHERE id=?').get(s.id));
});

app.delete('/api/stock/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  db.prepare('DELETE FROM stock_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/stock/:id/adjust', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const s = db.prepare('SELECT * FROM stock_items WHERE id=?').get(req.params.id);
  if (!s) return bad(res, 'Not found', 404);
  const delta = Number(req.body.delta) || 0;
  const reason = String(req.body.reason || '').trim();
  if (!delta) return bad(res, 'Stock change cannot be zero');
  if (!reason) return bad(res, 'A reason or stock-count reference is required');
  db.prepare('UPDATE stock_items SET qty = qty + ? WHERE id=?').run(delta, s.id);
  db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
    .run(s.id, delta, reason, req.user.id);
  audit(req.user, 'stock.adjust', `${s.name} ${delta > 0 ? '+' : ''}${delta} — ${reason}`);
  res.json(db.prepare('SELECT * FROM stock_items WHERE id=?').get(s.id));
});

/* ---------------------- retail receiving & stocktakes --------------------- */
app.get('/api/suppliers', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all()));

app.post('/api/suppliers', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return bad(res, 'Supplier name required');
  const r = db.prepare('INSERT INTO suppliers(name,phone,email,kra_pin,address) VALUES(?,?,?,?,?)')
    .run(String(b.name).trim(), b.phone || null, b.email || null, b.kra_pin || null, b.address || null);
  audit(req.user, 'supplier.create', String(b.name).trim());
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/suppliers/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const cur = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!cur) return bad(res, 'Supplier not found', 404);
  const b = req.body || {};
  db.prepare('UPDATE suppliers SET name=?,phone=?,email=?,kra_pin=?,address=?,active=? WHERE id=?')
    .run(b.name ?? cur.name, b.phone ?? cur.phone, b.email ?? cur.email, b.kra_pin ?? cur.kra_pin,
      b.address ?? cur.address, b.active !== undefined ? (b.active ? 1 : 0) : cur.active, cur.id);
  audit(req.user, 'supplier.update', cur.name);
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(cur.id));
});

app.get('/api/goods-receipts', requireAuth, (req, res) => res.json(db.prepare(`
  SELECT gr.*,s.name supplier_name,u.name received_by_name,
    (SELECT COUNT(*) FROM goods_receipt_items gi WHERE gi.receipt_id=gr.id) lines
  FROM goods_receipts gr LEFT JOIN suppliers s ON s.id=gr.supplier_id
  LEFT JOIN users u ON u.id=gr.received_by ORDER BY gr.id DESC LIMIT 100`).all()));

app.post('/api/goods-receipts', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
  const b = req.body || {}, lines = Array.isArray(b.items) ? b.items : [];
  if (!String(b.invoice_no || '').trim()) return bad(res, 'Supplier invoice or delivery note number required');
  if (!lines.length) return bad(res, 'Add at least one delivered product');
  let receiptId, total = 0;
  const tx = db.transaction(() => {
    receiptId = db.prepare('INSERT INTO goods_receipts(supplier_id,invoice_no,notes,received_by) VALUES(?,?,?,?)')
      .run(Number(b.supplier_id) || null, String(b.invoice_no).trim(), b.notes || null, req.user.id).lastInsertRowid;
    const ins = db.prepare('INSERT INTO goods_receipt_items(receipt_id,stock_item_id,qty,unit_cost,batch_no,expiry_date) VALUES(?,?,?,?,?,?)');
    for (const line of lines) {
      const stock = db.prepare('SELECT * FROM stock_items WHERE id=?').get(Number(line.stock_item_id));
      const qty = Number(line.qty);
      if (!stock || !(qty > 0)) throw new Error('Every delivery line needs a valid product and positive quantity');
      /* Product cost is owner-controlled in Product Settings. Receiving staff only enter quantity. */
      ins.run(receiptId, stock.id, qty, stock.cost, null, null);
      db.prepare('UPDATE stock_items SET qty=qty+? WHERE id=?').run(qty, stock.id);
      db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
        .run(stock.id, qty, `Delivery ${String(b.invoice_no).trim()}`, req.user.id);
      total += qty * stock.cost;
    }
    db.prepare('UPDATE goods_receipts SET total_cost=? WHERE id=?').run(Math.round(total), receiptId);
  });
  try { tx(); } catch (e) { return bad(res, e.message); }
  audit(req.user, 'delivery.receive', `${b.invoice_no} · ${lines.length} lines · KSh${(total / 100).toFixed(2)}`);
  broadcast('stock');
  res.json({ id: receiptId, total_cost: Math.round(total), ok: true });
});

app.get('/api/stock-counts', requireAuth, (req, res) => res.json(db.prepare(`
  SELECT sc.*,us.name started_by_name,uc.name completed_by_name,
    (SELECT COUNT(*) FROM stock_count_items si WHERE si.stock_count_id=sc.id) lines,
    (SELECT COUNT(*) FROM stock_count_items si WHERE si.stock_count_id=sc.id AND ABS(COALESCE(si.variance,0))>0.0001) variances
  FROM stock_counts sc LEFT JOIN users us ON us.id=sc.started_by LEFT JOIN users uc ON uc.id=sc.completed_by
  ORDER BY sc.id DESC LIMIT 100`).all()));

app.post('/api/stock-counts', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
  if (db.prepare("SELECT id FROM stock_counts WHERE status='open'").get()) return bad(res, 'Complete the open stocktake first');
  const retailShift = getSetting('business_type') === 'wines_spirits'
    ? db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get() : null;
  if (getSetting('business_type') === 'wines_spirits' && !retailShift) return bad(res, 'Open the till before starting an end-of-day stocktake');
  if (getSetting('business_type') === 'wines_spirits') {
    const empty = db.prepare(`SELECT o.id,o.number FROM orders o WHERE o.status='open'
      AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.status!='void')`).all();
    for (const order of empty) {
      db.prepare("UPDATE orders SET status='void',closed_at=datetime('now','localtime'),closed_by=? WHERE id=?").run(req.user.id, order.id);
      audit(req.user, 'order.auto_void_empty', `#${order.number} before stocktake`);
    }
  }
  const openSales = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','billed')").get().c;
  if (getSetting('business_type') === 'wines_spirits' && openSales) return bad(res, `Close or void ${openSales} non-empty sale(s) before stocktake`);
  const reference = String(req.body.reference || `COUNT-${todayLocal()}`).trim();
  let id;
  const tx = db.transaction(() => {
    id = db.prepare('INSERT INTO stock_counts(reference,notes,started_by) VALUES(?,?,?)')
      .run(reference, req.body.notes || null, req.user.id).lastInsertRowid;
    const ins = db.prepare('INSERT INTO stock_count_items(stock_count_id,stock_item_id,expected) VALUES(?,?,?)');
    for (const stock of db.prepare('SELECT id,qty FROM stock_items ORDER BY name').all()) ins.run(id, stock.id, stock.qty);
    if (retailShift) db.prepare("UPDATE shifts SET status='reconciling' WHERE id=?").run(retailShift.id);
  }); tx();
  audit(req.user, 'stocktake.start', reference);
  broadcast('orders'); broadcast('sales');
  res.json({ id, reference, ok: true });
});

app.get('/api/stock-counts/:id', requireAuth, (req, res) => {
  const count = db.prepare('SELECT * FROM stock_counts WHERE id=?').get(req.params.id);
  if (!count) return bad(res, 'Stocktake not found', 404);
  count.items = db.prepare(`SELECT sci.*,si.name,si.unit FROM stock_count_items sci
    JOIN stock_items si ON si.id=sci.stock_item_id WHERE sci.stock_count_id=? ORDER BY si.name`).all(count.id);
  res.json(count);
});

app.post('/api/stock-counts/:id/save', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
  const count = db.prepare('SELECT * FROM stock_counts WHERE id=?').get(req.params.id);
  if (!count || count.status !== 'open') return bad(res, 'Open stocktake not found', 404);
  const upd = db.prepare('UPDATE stock_count_items SET counted=?,variance=?,added_qty=? WHERE stock_count_id=? AND stock_item_id=?');
  const tx = db.transaction(() => {
    for (const line of (Array.isArray(req.body.items) ? req.body.items : [])) {
      if (line.counted === '' || line.counted == null || !Number.isFinite(Number(line.counted))) continue;
      const row = db.prepare('SELECT expected FROM stock_count_items WHERE stock_count_id=? AND stock_item_id=?').get(count.id, Number(line.stock_item_id));
      if (row) upd.run(Number(line.counted), Number(line.counted) - row.expected, Number(line.added_qty) || 0,
        count.id, Number(line.stock_item_id));
    }
  }); tx();
  audit(req.user, 'stocktake.save', count.reference);
  res.json({ ok: true });
});

app.post('/api/stock-counts/:id/complete', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
  const count = db.prepare('SELECT * FROM stock_counts WHERE id=?').get(req.params.id);
  if (!count || count.status !== 'open') return bad(res, 'Open stocktake not found', 404);
  const submitted = new Map((Array.isArray(req.body.items) ? req.body.items : []).map((x) => [Number(x.stock_item_id), x]));
  const rows = db.prepare('SELECT * FROM stock_count_items WHERE stock_count_id=?').all(count.id);
  const valueOf = (row) => submitted.has(row.stock_item_id) ? Number(submitted.get(row.stock_item_id).counted) : row.counted;
  if (rows.some((r) => valueOf(r) == null || !Number.isFinite(Number(valueOf(r)))))
    return bad(res, 'Enter or skip every product before completing the stocktake');
  const tx = db.transaction(() => {
    for (const row of rows) {
      const counted = Number(valueOf(row)), variance = counted - row.expected;
      const added = submitted.has(row.stock_item_id) ? Number(submitted.get(row.stock_item_id).added_qty) || 0 : row.added_qty || 0;
      db.prepare('UPDATE stock_count_items SET counted=?,variance=?,added_qty=? WHERE id=?').run(counted, variance, added, row.id);
      db.prepare('UPDATE stock_items SET qty=? WHERE id=?').run(counted, row.stock_item_id);
      if (variance) db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
        .run(row.stock_item_id, variance, `Stocktake ${count.reference}`, req.user.id);
    }
    db.prepare("UPDATE stock_counts SET status='completed',completed_by=?,completed_at=datetime('now','localtime') WHERE id=?")
      .run(req.user.id, count.id);
  }); tx();
  const variances = rows.filter((r) => entered.get(r.stock_item_id) !== r.expected).length;
  audit(req.user, 'stocktake.complete', `${count.reference} · ${variances} variances`);
  broadcast('stock');
  res.json({ ok: true, variances });
});

/* --------------------------------- staff -------------------------------- */
/* PINs are stored as scrypt hashes and are never returned by list/detail calls.
   The plaintext is echoed exactly once — on the create/update response — so the
   manager can write it down, mirroring the gift-card code pattern. */
const reveal = (row, pin) => ({ id: row.id, name: row.name, role: row.role, active: row.active,
  hourly_rate: row.hourly_rate, pin });

app.get('/api/users', requireAuth, requireRole('manager', 'admin'), (req, res) =>
  res.json(db.prepare('SELECT id,name,role,active,hourly_rate FROM users ORDER BY role,name')
    .all().map((u) => ({ ...u, has_pin: true }))));

app.post('/api/users', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { name, pin, role } = req.body;
  if (!name || !pin || !role) return bad(res, 'Name, PIN and role required');
  const allowedRoles = ['seller', 'admin', 'manager', 'waiter', 'cashier', 'bartender', 'kitchen'];
  if (!allowedRoles.includes(role)) return bad(res, 'Unknown role');
  if (role === 'admin' && req.user.role !== 'admin') return bad(res, 'Only an admin can create another admin', 403);
  if (!/^\d{4,6}$/.test(String(pin))) return bad(res, 'PIN must be 4-6 digits');
  if (pinTaken(String(pin))) return bad(res, 'That PIN is already in use');
  const r = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)').run(name.trim(), hashPin(String(pin)), role);
  audit(req.user, 'user.create', `${name} (${role})`);
  broadcast('users');
  res.json(reveal(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid), String(pin)));
});

app.put('/api/users/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return bad(res, 'Not found', 404);
  let newPin = null;
  if (req.body.pin != null && String(req.body.pin).trim() !== '') {
    newPin = String(req.body.pin).trim();
    if (!/^\d{4,6}$/.test(newPin)) return bad(res, 'PIN must be 4-6 digits');
    if (pinTaken(newPin, u.id)) return bad(res, 'That PIN is already in use');
  }
  const nextRole = req.body.role ?? u.role;
  if (!['seller', 'admin', 'manager', 'waiter', 'cashier', 'bartender', 'kitchen'].includes(nextRole))
    return bad(res, 'Unknown role');
  if ((u.role === 'admin' || nextRole === 'admin') && req.user.role !== 'admin')
    return bad(res, 'Only an admin can manage administrator accounts', 403);
  db.prepare('UPDATE users SET name=?, pin=?, role=?, active=? WHERE id=?')
    .run(req.body.name ?? u.name, newPin ? hashPin(newPin) : u.pin, nextRole,
      req.body.active != null ? (req.body.active ? 1 : 0) : u.active, u.id);
  audit(req.user, 'user.update', u.name + (newPin ? ' (PIN changed)' : ''));
  broadcast('users');
  res.json(reveal(db.prepare('SELECT * FROM users WHERE id=?').get(u.id), newPin));
});

app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return bad(res, 'You cannot remove yourself');
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(req.params.id);
  audit(req.user, 'user.disable', String(req.params.id));
  broadcast('users');
  res.json({ ok: true });
});

/* -------------------------------- reports ------------------------------- */
const dayBounds = (d) => `${d} 00:00:00`;
const dayEnd = (d) => `${d} 23:59:59`;

app.get('/api/reports/summary', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  const a = dayBounds(from), b = dayEnd(to);
  const s = getSettings();
  const vatRate = s.vat_rate / 100;

  const g = (sql, p) => db.prepare(sql).get(...p) || {};
  const paid = g(`SELECT COALESCE(SUM(amount),0) v FROM payments
    WHERE created_at BETWEEN ? AND ? AND method != 'refund'`, [a, b]).v || 0;
  const refunded = -1 * (g(`SELECT COALESCE(SUM(amount),0) v FROM payments
    WHERE created_at BETWEEN ? AND ? AND method = 'refund'`, [a, b]).v || 0);
  const gross = paid - refunded;
  const closed = g(`SELECT COUNT(*) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'`, [a, b]).c;
  const voids = g(`SELECT COUNT(*) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='void'`, [a, b]).c;
  const covers = g(`SELECT COALESCE(SUM(people),0) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'`, [a, b]).c;
  const discounts = g(`SELECT COALESCE(SUM(discount),0) c FROM orders WHERE closed_at BETWEEN ? AND ?`, [a, b]).c;
  const tips = g(`SELECT COALESCE(SUM(tip),0) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'`, [a, b]).c;
  const cost = g(`SELECT COALESCE(SUM(oi.price*oi.qty - m.cost*oi.qty),0) gp, COALESCE(SUM(m.cost*oi.qty),0) c
    FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN menu_items m ON m.id=oi.menu_item_id
    WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed' AND oi.status != 'void'`, [a, b]);

  const byMethod = db.prepare(`SELECT method, COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments
    WHERE created_at BETWEEN ? AND ? GROUP BY method ORDER BY total DESC`).all(a, b);

  const inclusive = s.tax_mode === 'inclusive';
  const netSales = inclusive ? Math.round(gross / (1 + vatRate)) : Math.round(gross - gross * vatRate / (1 + vatRate));
  const vatCollected = gross - netSales;

  res.json({
    from, to, gross, refunded, paid, net: netSales, vat_collected: vatCollected,
    orders_closed: closed, orders_void: voids, covers,
    avg_ticket: closed ? Math.round(gross / closed) : 0,
    avg_per_cover: covers ? Math.round(gross / covers) : 0,
    discounts, tips, cogs: cost.c || 0, gross_profit: cost.gp || 0,
    margin: cost.c ? Math.round(((cost.gp) / (cost.gp + cost.c)) * 1000) / 10 : 0,
    by_method: byMethod
  });
});

app.get('/api/reports/items', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  res.json(db.prepare(`
    SELECT oi.name, oi.station, COUNT(*) lines, SUM(oi.qty) qty,
           SUM(oi.price*oi.qty) revenue, SUM(m.cost*oi.qty) cogs
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items m ON m.id = oi.menu_item_id
    WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed' AND oi.status != 'void'
    GROUP BY oi.name, oi.station ORDER BY revenue DESC LIMIT 100`).all(dayBounds(from), dayEnd(to)));
});

app.get('/api/reports/waiters', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  res.json(db.prepare(`
    SELECT u.name AS waiter, COUNT(DISTINCT o.id) orders, COALESCE(SUM(o.people),0) covers,
           COALESCE(SUM((SELECT SUM(p.amount) FROM payments p WHERE p.order_id=o.id AND p.method!='refund')),0) revenue
    FROM orders o LEFT JOIN users u ON u.id = o.waiter_id
    WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed'
    GROUP BY u.name ORDER BY revenue DESC`).all(dayBounds(from), dayEnd(to)));
});

app.get('/api/reports/categories', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  res.json(db.prepare(`
    SELECT c.name AS category, c.station, SUM(oi.qty) qty, SUM(oi.price*oi.qty) revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    JOIN menu_items m ON m.id = oi.menu_item_id JOIN categories c ON c.id = m.category_id
    WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed' AND oi.status != 'void'
    GROUP BY c.id ORDER BY revenue DESC`).all(dayBounds(from), dayEnd(to)));
});

app.get('/api/reports/hourly', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
  const from = req.query.from || todayLocal();
  res.json(db.prepare(`
    SELECT substr(created_at,12,2) AS hour, COALESCE(SUM(amount),0) total, COUNT(*) n
    FROM payments WHERE method != 'refund' AND created_at BETWEEN ? AND ?
    GROUP BY hour ORDER BY hour`).all(dayBounds(from), dayEnd(from)));
});

app.get('/api/zreport', requireAuth, requireRole('seller', 'manager', 'admin', 'cashier'), (req, res) => {
  const day = req.query.date || todayLocal();
  const a = dayBounds(day), b = dayEnd(day);
  const sales = db.prepare(`SELECT method, COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments
    WHERE created_at BETWEEN ? AND ? GROUP BY method`).all(a, b);
  const orders = db.prepare("SELECT COUNT(*) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'").get(a, b).c;
  const voids = db.prepare("SELECT COUNT(*) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='void'").get(a, b).c;
  const tips = db.prepare("SELECT COALESCE(SUM(tip),0) c FROM orders WHERE closed_at BETWEEN ? AND ?").get(a, b).c;
  const discounts = db.prepare("SELECT COALESCE(SUM(discount),0) c FROM orders WHERE closed_at BETWEEN ? AND ?").get(a, b).c;
  const covers = db.prepare("SELECT COALESCE(SUM(people),0) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'").get(a, b).c;
  res.json({
    date: day, settings: getSettings(), by_method: sales, orders, voids, tips, discounts, covers,
    net: sales.filter((s) => s.method !== 'refund').reduce((x, s) => x + s.total, 0)
      + sales.filter((s) => s.method === 'refund').reduce((x, s) => x + s.total, 0)
  });
});

app.get('/api/audit', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
});

app.get('/api/settings', requireAuth, requireRole('manager', 'admin'), (req, res) => res.json(getSettings()));
app.put('/api/settings', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (typeof v === 'boolean') setSetting(k, v ? '1' : '0');
    else if (v !== undefined) setSetting(k, v);
  }
  audit(req.user, 'settings.update', Object.keys(req.body || {}).join(','));
  broadcast('settings');
  res.json(getSettings());
});

/* ====================== DAYPARTS / HAPPY HOUR (2.7) ====================== */
app.get('/api/dayparts', requireAuth, (req, res) => {
  const all = db.prepare('SELECT * FROM dayparts ORDER BY start_time, name').all();
  res.json({ dayparts: all, active_now: domain.activeDayparts(all) });
});
app.post('/api/dayparts', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const b = req.body;
  if (!b.name || !b.start_time || !b.end_time) return bad(res, 'Name and start/end times required');
  if (!/^\d{2}:\d{2}$/.test(b.start_time) || !/^\d{2}:\d{2}$/.test(b.end_time))
    return bad(res, 'Times must be HH:MM');
  const r = db.prepare(`INSERT INTO dayparts(name,days,start_time,end_time,discount_pct,category_id,station,active)
    VALUES(?,?,?,?,?,?,?,?)`).run(b.name, b.days || '0,1,2,3,4,5,6', b.start_time, b.end_time,
      Number(b.discount_pct) || 0, b.category_id || null, b.station || null,
      /* a rule is live unless explicitly switched off — creating one that does
         nothing is a silent footgun */
      b.active === undefined ? 1 : (b.active ? 1 : 0));
  audit(req.user, 'daypart.create', `${b.name} ${b.start_time}-${b.end_time} ${b.discount_pct}%`);
  broadcast('menu');
  res.json(db.prepare('SELECT * FROM dayparts WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/dayparts/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const d = db.prepare('SELECT * FROM dayparts WHERE id=?').get(req.params.id);
  if (!d) return bad(res, 'Not found', 404);
  const b = req.body;
  db.prepare(`UPDATE dayparts SET name=?, days=?, start_time=?, end_time=?, discount_pct=?, category_id=?, station=?, active=? WHERE id=?`)
    .run(b.name ?? d.name, b.days ?? d.days, b.start_time ?? d.start_time, b.end_time ?? d.end_time,
      b.discount_pct ?? d.discount_pct, b.category_id !== undefined ? (b.category_id || null) : d.category_id,
      b.station !== undefined ? (b.station || null) : d.station,
      b.active !== undefined ? (b.active ? 1 : 0) : d.active, d.id);
  audit(req.user, 'daypart.update', d.name);
  broadcast('menu');
  res.json(db.prepare('SELECT * FROM dayparts WHERE id=?').get(d.id));
});
app.delete('/api/dayparts/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  db.prepare('DELETE FROM dayparts WHERE id=?').run(req.params.id);
  broadcast('menu');
  res.json({ ok: true });
});
/** Effective selling price for an item right now — what the till should display. */
app.get('/api/pricing/now', requireAuth, (req, res) => {
  const dayparts = db.prepare('SELECT * FROM dayparts WHERE active=1').all();
  const active = domain.activeDayparts(dayparts);
  const out = {};
  for (const m of db.prepare('SELECT * FROM menu_items').all()) {
    const rule = domain.bestDiscountFor(m, active);
    if (rule) out[m.id] = { price: domain.discountedPrice(m.price, rule.discount_pct), rule: rule.name, discount_pct: Number(rule.discount_pct) };
  }
  res.json({ active, overrides: out });
});

/* ========================= RECIPES / BOM (2.4) ========================= */
app.get('/api/recipes', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT r.*, m.name AS item_name, s.name AS stock_name, s.unit
    FROM recipes r JOIN menu_items m ON m.id = r.menu_item_id
    JOIN stock_items s ON s.id = r.stock_item_id
    ORDER BY m.name, s.name`).all());
});
app.post('/api/recipes', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { menu_item_id, stock_item_id, qty } = req.body;
  if (!menu_item_id || !stock_item_id) return bad(res, 'Menu item and stock item required');
  if (!(Number(qty) > 0)) return bad(res, 'Quantity must be greater than zero');
  db.prepare(`INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,?)
    ON CONFLICT(menu_item_id,stock_item_id) DO UPDATE SET qty=excluded.qty`)
    .run(Number(menu_item_id), Number(stock_item_id), Number(qty));
  audit(req.user, 'recipe.set', `menu ${menu_item_id} <- stock ${stock_item_id} x${qty}`);
  res.json({ ok: true });
});
app.delete('/api/recipes/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  db.prepare('DELETE FROM recipes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
/** Theoretical usage from sales vs what was actually counted off. */
app.get('/api/reports/stock-usage', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  const rows = db.prepare(`
    SELECT s.id, s.name, s.unit, s.qty AS on_hand,
           COALESCE(SUM(r.qty * oi.qty), 0) AS theoretical
    FROM stock_items s
    LEFT JOIN recipes r ON r.stock_item_id = s.id
    LEFT JOIN order_items oi ON oi.menu_item_id = r.menu_item_id
      AND oi.status != 'void'
      AND oi.id IN (SELECT id FROM order_items WHERE order_id IN
        (SELECT id FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'))
    GROUP BY s.id ORDER BY s.name`).all(from + ' 00:00:00', to + ' 23:59:59');
  res.json(rows);
});

/* ===================== MODIFIERS & VARIANTS (3.9) ====================== */
app.get('/api/modifiers', requireAuth, (req, res) => {
  res.json({
    groups: db.prepare('SELECT * FROM modifier_groups ORDER BY name').all(),
    options: db.prepare('SELECT * FROM modifier_options ORDER BY group_id, sort_order, name').all(),
    item_groups: db.prepare('SELECT * FROM menu_item_modifiers').all()
  });
});
app.post('/api/modifier-groups', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { name, required = 0, min_pick = 0, max_pick = 1 } = req.body;
  if (!name) return bad(res, 'Name required');
  const r = db.prepare('INSERT INTO modifier_groups(name,required,min_pick,max_pick) VALUES(?,?,?,?)')
    .run(name, required ? 1 : 0, Number(min_pick) || 0, Number(max_pick) || 1);
  broadcast('menu');
  res.json(db.prepare('SELECT * FROM modifier_groups WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/modifier-groups/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  db.prepare('DELETE FROM modifier_groups WHERE id=?').run(req.params.id);
  broadcast('menu'); res.json({ ok: true });
});
app.post('/api/modifier-options', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const { group_id, name, price = 0 } = req.body;
  if (!group_id || !name) return bad(res, 'Group and name required');
  const r = db.prepare('INSERT INTO modifier_options(group_id,name,price,sort_order) VALUES(?,?,?,?)')
    .run(Number(group_id), name, Math.round(Number(price) * 100),
      db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 s FROM modifier_options WHERE group_id=?').get(group_id).s);
  broadcast('menu');
  res.json(db.prepare('SELECT * FROM modifier_options WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/modifier-options/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  db.prepare('DELETE FROM modifier_options WHERE id=?').run(req.params.id);
  broadcast('menu'); res.json({ ok: true });
});
app.post('/api/menu-items/:id/modifiers', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const groups = Array.isArray(req.body.groups) ? req.body.groups : [req.body.group_id];
  db.prepare('DELETE FROM menu_item_modifiers WHERE menu_item_id=?').run(req.params.id);
  const ins = db.prepare('INSERT OR IGNORE INTO menu_item_modifiers(menu_item_id,group_id) VALUES(?,?)');
  for (const g of groups) if (g) ins.run(Number(req.params.id), Number(g));
  broadcast('menu');
  res.json(db.prepare('SELECT * FROM menu_item_modifiers WHERE menu_item_id=?').all(req.params.id));
});

/* ================= CASH DRAWER RECONCILIATION (2.6) ==================== */
app.get('/api/shifts', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  res.json(db.prepare(`SELECT s.*, uo.name AS opened_by_name, uc.name AS closed_by_name
    FROM shifts s LEFT JOIN users uo ON uo.id = s.opened_by
    LEFT JOIN users uc ON uc.id = s.closed_by ORDER BY s.id DESC LIMIT 100`).all());
});
app.get('/api/shifts/current', requireAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get();
  if (!s) return res.json({ shift: null, drawer: null });
  res.json({ shift: s, drawer: drawerFigures(s) });
});
function drawerFigures(s) {
  const a = s.opened_at, b = s.closed_at || nowLocal();
  const g = (sql, ...p) => db.prepare(sql).get(...p).v || 0;
  const cashSales = g(`SELECT COALESCE(SUM(amount),0) v FROM payments
    WHERE method='cash' AND shift_id=? AND created_at BETWEEN ? AND ?`, s.id, a, b);
  const mpesaSales = g(`SELECT COALESCE(SUM(amount),0) v FROM payments
    WHERE method='mpesa' AND shift_id=? AND created_at BETWEEN ? AND ?`, s.id, a, b);
  const cashRefunds = -g(`SELECT COALESCE(SUM(amount),0) v FROM payments
    WHERE method='refund' AND shift_id=? AND created_at BETWEEN ? AND ?`, s.id, a, b);
  const cashExpenses = g(`SELECT COALESCE(SUM(amount),0) v FROM cash_payouts
    WHERE shift_id=? AND method='cash' AND created_at BETWEEN ? AND ?`, s.id, a, b);
  const mpesaExpenses = g(`SELECT COALESCE(SUM(amount),0) v FROM cash_payouts
    WHERE shift_id=? AND method='mpesa' AND created_at BETWEEN ? AND ?`, s.id, a, b);
  const expected = domain.expectedCash({ openingFloat: s.opening_float, cashSales, cashRefunds, payouts: cashExpenses });
  const expectedMpesa = (s.opening_mpesa || 0) + mpesaSales - mpesaExpenses;
  return { cash_sales: cashSales, mpesa_sales: mpesaSales, cash_refunds: cashRefunds,
    payouts: cashExpenses + mpesaExpenses, cash_expenses: cashExpenses, mpesa_expenses: mpesaExpenses,
    expected, expected_mpesa: expectedMpesa };
}
app.post('/api/shifts', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const open = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling')").get();
  if (open) return bad(res, 'A till is already open or reconciling — close it first');
  const float = Math.round(Number(req.body.opening_float || 0) * 100);
  const openingMpesa = Math.round(Number(req.body.opening_mpesa || 0) * 100);
  const r = db.prepare('INSERT INTO shifts(opened_by,opening_float,opening_mpesa,notes) VALUES(?,?,?,?)')
    .run(req.user.id, float, openingMpesa, req.body.notes || null);
  audit(req.user, 'shift.open', `cash KSh${(float / 100).toFixed(2)}, M-Pesa KSh${(openingMpesa / 100).toFixed(2)}`);
  broadcast('sales');
  res.json(db.prepare('SELECT * FROM shifts WHERE id=?').get(r.lastInsertRowid));
});
app.post('/api/shifts/:id/close', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id=?').get(req.params.id);
  if (!s) return bad(res, 'Shift not found', 404);
  if (s.status === 'closed') return bad(res, 'Shift already closed');
  if (req.body.counted_cash == null) return bad(res, 'Counted cash is required');
  if (getSetting('business_type') === 'wines_spirits' && req.body.counted_mpesa == null) return bad(res, 'M-Pesa balance is required');
  const openSales = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','billed')").get().c;
  if (openSales) return bad(res, `Close or void ${openSales} open sale(s) before closing the till`);
  if (getSetting('business_type') === 'wines_spirits' && !db.prepare("SELECT id FROM stock_counts WHERE status='completed' AND completed_at>=? ORDER BY id DESC LIMIT 1").get(s.opened_at))
    return bad(res, 'Complete the end-of-day stocktake before closing the till');
  const counted = Math.round(Number(req.body.counted_cash) * 100);
  const countedMpesa = Math.round(Number(req.body.counted_mpesa || 0) * 100);
  const fig = drawerFigures(s);
  const variance = domain.drawerVariance(counted, fig.expected);
  const mpesaVariance = countedMpesa - fig.expected_mpesa;
  db.prepare(`UPDATE shifts SET closed_at=datetime('now','localtime'),closed_by=?,counted_cash=?,
    expected_cash=?,variance=?,counted_mpesa=?,expected_mpesa=?,mpesa_variance=?,status='closed',notes=? WHERE id=?`)
    .run(req.user.id, counted, fig.expected, variance, countedMpesa, fig.expected_mpesa, mpesaVariance,
      req.body.notes || s.notes, s.id);
  audit(req.user, 'shift.close', `cash expected KSh${(fig.expected / 100).toFixed(2)}, counted KSh${(counted / 100).toFixed(2)}, variance KSh${(variance / 100).toFixed(2)}; M-Pesa expected KSh${(fig.expected_mpesa / 100).toFixed(2)}, counted KSh${(countedMpesa / 100).toFixed(2)}, variance KSh${(mpesaVariance / 100).toFixed(2)}`);
  if (variance) audit(req.user, 'drawer.variance', `Cash KSh${(variance / 100).toFixed(2)} ${variance > 0 ? 'over' : 'short'}`);
  if (mpesaVariance) audit(req.user, 'mpesa.variance', `KSh${(mpesaVariance / 100).toFixed(2)} ${mpesaVariance > 0 ? 'over' : 'short'}`);
  broadcast('sales');
  res.json({ ...db.prepare('SELECT * FROM shifts WHERE id=?').get(s.id), drawer: fig });
});
app.post('/api/shifts/:id/payout', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id=?').get(req.params.id);
  if (!s) return bad(res, 'Shift not found', 404);
  if (s.status === 'closed') return bad(res, 'Cannot add an expense to a closed till');
  const amount = Math.round(Number(req.body.amount) * 100);
  const method = req.body.method === 'mpesa' ? 'mpesa' : 'cash';
  const reason = String(req.body.reason || '').trim();
  if (!amount || amount <= 0) return bad(res, 'Amount must be greater than zero');
  if (!reason) return bad(res, 'Expense reason is required');
  db.prepare('INSERT INTO cash_payouts(shift_id,amount,reason,user_id,method) VALUES(?,?,?,?,?)')
    .run(s.id, amount, reason, req.user.id, method);
  audit(req.user, 'expense.record', `${method.toUpperCase()} KSh${(amount / 100).toFixed(2)} — ${reason}`);
  broadcast('sales');
  res.json(drawerFigures(s));
});

/* End-of-shift clearing sheet: everything a cashier needs to cash up. */
app.get('/api/shift-clearing', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const s = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get()
        || db.prepare('SELECT * FROM shifts ORDER BY id DESC LIMIT 1').get();
  const q = (sql) => s ? db.prepare(sql).all(s.id) : [];
  const one = (sql) => s ? db.prepare(sql).get(s.id).v : 0;
  const byMethod = q(`SELECT method, COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments
    WHERE shift_id=? GROUP BY method ORDER BY total DESC`);
  const byStation = q(`SELECT oi.station, COALESCE(SUM(oi.price*oi.qty),0) v, COUNT(*) lines
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.shift_id=? AND o.status='closed' AND oi.status!='void' GROUP BY oi.station`);
  const byCategory = q(`SELECT COALESCE(c.name,'Uncategorised') category,
      COALESCE(SUM(oi.price*oi.qty),0) v, COALESCE(SUM(oi.qty),0) units
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    LEFT JOIN menu_items m ON m.id=oi.menu_item_id LEFT JOIN categories c ON c.id=m.category_id
    WHERE o.shift_id=? AND o.status='closed' AND oi.status!='void' GROUP BY c.id,c.name ORDER BY v DESC`);
  const tips = one(`SELECT COALESCE(SUM(tip),0) v FROM payments WHERE shift_id=?`);
  const payouts = one(`SELECT COALESCE(SUM(amount),0) v FROM cash_payouts WHERE shift_id=?`);
  const covers = one(`SELECT COALESCE(SUM(people),0) v FROM orders WHERE shift_id=? AND status='closed'`);
  const ordersN = one(`SELECT COUNT(*) v FROM orders WHERE shift_id=? AND status='closed'`);
  let drawer = null;
  if (s) drawer = s.status !== 'closed' ? drawerFigures(s)
    : { expected: s.expected_cash, counted: s.counted_cash, variance: s.variance,
      expected_mpesa: s.expected_mpesa, counted_mpesa: s.counted_mpesa, mpesa_variance: s.mpesa_variance, payouts };
  res.json({ shift: s || null, by_method: byMethod, by_station: byStation, by_category: byCategory,
    tips, payouts, covers, units: byCategory.reduce((n, x) => n + Number(x.units || 0), 0), orders: ordersN, drawer });
});

/* ==================== OPEN BAR TABS / PRE-AUTH (3.8) ==================== */
app.get('/api/tabs', requireAuth, (req, res) =>
  res.json(db.prepare(`SELECT t.*, u.name AS opened_by_name,
      COALESCE((SELECT SUM(oi.price*oi.qty) FROM order_items oi JOIN orders o ON o.id=oi.order_id
                WHERE o.tab_id = t.id AND oi.status != 'void'),0) AS spend
    FROM tabs t LEFT JOIN users u ON u.id = t.opened_by
    WHERE t.status='open' ORDER BY t.id`).all()));
app.post('/api/tabs', requireAuth, requireRole('waiter', 'bartender', 'cashier', 'manager', 'admin'), (req, res) => {
  const { customer_name, phone, card_last4, preauth_amount = 0, preauth_ref, notes } = req.body;
  if (!customer_name) return bad(res, 'Customer name is required');
  const r = db.prepare(`INSERT INTO tabs(customer_name,phone,card_last4,preauth_amount,preauth_ref,notes,opened_by)
    VALUES(?,?,?,?,?,?,?)`).run(customer_name, phone || null, card_last4 || null,
      Math.round(Number(preauth_amount) * 100), preauth_ref || null, notes || null, req.user.id);
  audit(req.user, 'tab.open', `${customer_name}${preauth_ref ? ' pre-auth ' + preauth_ref : ''}`);
  broadcast('orders');
  res.json(db.prepare('SELECT * FROM tabs WHERE id=?').get(r.lastInsertRowid));
});
app.post('/api/tabs/:id/release', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const t = db.prepare('SELECT * FROM tabs WHERE id=?').get(req.params.id);
  if (!t) return bad(res, 'Tab not found', 404);
  db.prepare("UPDATE tabs SET status='released', closed_at=datetime('now','localtime') WHERE id=?").run(t.id);
  audit(req.user, 'tab.release', `${t.customer_name} — pre-auth released`);
  broadcast('orders');
  res.json({ ok: true });
});

/* ===================== STAFF TIME & LABOUR (3.10) ====================== */
app.get('/api/timeclock', requireAuth, (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  res.json(db.prepare(`SELECT t.*, u.name, u.hourly_rate FROM timeclock t
    JOIN users u ON u.id = t.user_id
    WHERE t.clock_in BETWEEN ? AND ? ORDER BY t.clock_in DESC`).all(from + ' 00:00:00', to + ' 23:59:59'));
});
app.post('/api/timeclock/in', requireAuth, (req, res) => {
  const open = db.prepare('SELECT * FROM timeclock WHERE user_id=? AND clock_out IS NULL').get(req.user.id);
  if (open) return bad(res, 'You are already clocked in');
  const r = db.prepare('INSERT INTO timeclock(user_id,note) VALUES(?,?)').run(req.user.id, req.body.note || null);
  audit(req.user, 'clock.in', '');
  res.json(db.prepare('SELECT * FROM timeclock WHERE id=?').get(r.lastInsertRowid));
});
app.post('/api/timeclock/out', requireAuth, (req, res) => {
  const open = db.prepare('SELECT * FROM timeclock WHERE user_id=? AND clock_out IS NULL').get(req.user.id);
  if (!open) return bad(res, 'You are not clocked in');
  db.prepare("UPDATE timeclock SET clock_out=datetime('now','localtime') WHERE id=?").run(open.id);
  audit(req.user, 'clock.out', `${domain.HOURS(open.clock_in, new Date()).toFixed(2)}h`);
  res.json(db.prepare('SELECT * FROM timeclock WHERE id=?').get(open.id));
});
app.get('/api/reports/labour', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  const entries = db.prepare('SELECT * FROM timeclock WHERE clock_in BETWEEN ? AND ?')
    .all(from + ' 00:00:00', to + ' 23:59:59');
  const users = db.prepare('SELECT id,name,hourly_rate FROM users').all();
  const total = domain.labourCost(entries, users);
  const s = getSettings();
  const sales = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM payments
    WHERE method != 'refund' AND created_at BETWEEN ? AND ?`).get(from + ' 00:00:00', to + ' 23:59:59').v;
  const byUser = {};
  for (const e of entries) {
    const u = users.find((x) => x.id === e.user_id) || { name: 'Unknown', hourly_rate: 0 };
    if (!e.clock_out) continue;
    const h = domain.HOURS(e.clock_in, e.clock_out);
    if (h <= 0 || h > 24) continue;
    byUser[u.name] = byUser[u.name] || { name: u.name, hours: 0, cost: 0 };
    byUser[u.name].hours += h;
    byUser[u.name].cost += h * (u.hourly_rate || 0);
  }
  res.json({
    ...total, sales, pct: domain.labourPct(total.cost, sales),
    target_pct: Number(s.labour_target_pct) || 0,
    by_user: Object.values(byUser).map((x) => ({ ...x, hours: Math.round(x.hours * 100) / 100, cost: domain.round(x.cost) }))
  });
});

/* ========================== RESERVATIONS (3.11) ========================= */
app.get('/api/reservations', requireAuth, (req, res) => {
  const day = req.query.date || todayLocal();
  res.json(db.prepare(`SELECT r.*, t.name AS table_name, t.area FROM reservations r
    LEFT JOIN tables t ON t.id = r.table_id
    WHERE r.res_date = ? ORDER BY r.res_time`).all(day));
});
app.post('/api/reservations', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
  const { name, phone, people = 2, res_date, res_time, table_id, notes } = req.body;
  if (!name || !res_date || !res_time) return bad(res, 'Name, date and time required');
  const r = db.prepare(`INSERT INTO reservations(name,phone,people,res_date,res_time,table_id,notes,created_by)
    VALUES(?,?,?,?,?,?,?,?)`).run(name, phone || null, Number(people) || 2, res_date, res_time,
      table_id || null, notes || null, req.user.id);
  audit(req.user, 'reservation.create', `${name} ${res_date} ${res_time} x${people}`);
  broadcast('tables');
  res.json(db.prepare('SELECT * FROM reservations WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/reservations/:id', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
  const r0 = db.prepare('SELECT * FROM reservations WHERE id=?').get(req.params.id);
  if (!r0) return bad(res, 'Not found', 404);
  const b = req.body;
  db.prepare(`UPDATE reservations SET name=?, phone=?, people=?, res_date=?, res_time=?, table_id=?, status=?, notes=? WHERE id=?`)
    .run(b.name ?? r0.name, b.phone ?? r0.phone, b.people ?? r0.people, b.res_date ?? r0.res_date,
      b.res_time ?? r0.res_time, b.table_id !== undefined ? (b.table_id || null) : r0.table_id,
      b.status ?? r0.status, b.notes ?? r0.notes, r0.id);
  broadcast('tables');
  res.json(db.prepare('SELECT * FROM reservations WHERE id=?').get(r0.id));
});
app.delete('/api/reservations/:id', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
  db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(req.params.id);
  broadcast('tables'); res.json({ ok: true });
});

/* ==================== LOYALTY & GIFT CARDS (3.12) ====================== */
app.get('/api/customers', requireAuth, (req, res) => {
  const q = req.query.q;
  res.json(q
    ? db.prepare(`SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name LIMIT 50`)
        .all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM customers ORDER BY name LIMIT 200').all());
});
app.post('/api/customers', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return bad(res, 'Name required');
  const dupe = phone && db.prepare('SELECT id FROM customers WHERE phone=?').get(phone);
  if (dupe) return bad(res, 'A customer with that phone already exists');
  const r = db.prepare('INSERT INTO customers(name,phone,email) VALUES(?,?,?)').run(name, phone || null, email || null);
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(r.lastInsertRowid));
});
app.get('/api/customers/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return bad(res, 'Not found', 404);
  res.json({
    ...c,
    /* orders has no stored total — it is derived from its lines, discount and tip */
    history: db.prepare(`
      SELECT o.id, o.number, o.closed_at,
             COALESCE((SELECT SUM(oi.price * oi.qty) FROM order_items oi
                       WHERE oi.order_id = o.id AND oi.status != 'void'), 0) AS subtotal,
             o.discount, o.tip
      FROM orders o WHERE o.customer_id = ? AND o.status = 'closed'
      ORDER BY o.id DESC LIMIT 20`).all(c.id),
    points_log: db.prepare('SELECT * FROM loyalty_log WHERE customer_id=? ORDER BY id DESC LIMIT 30').all(c.id)
  });
});
app.get('/api/gift-cards', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) =>
  res.json(db.prepare(`SELECT g.*, c.name AS customer_name FROM gift_cards g
    LEFT JOIN customers c ON c.id = g.customer_id ORDER BY g.id DESC LIMIT 200`).all()));
app.get('/api/gift-cards/lookup/:code', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM gift_cards WHERE code=?').get(String(req.params.code).trim().toUpperCase());
  if (!g) return bad(res, 'No gift card with that code', 404);
  res.json(g);
});
app.post('/api/gift-cards', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const s = getSettings();
  const value = Math.round(Number(req.body.value) * 100);
  if (!value || value <= 0) return bad(res, 'Value must be greater than zero');
  let code = String(req.body.code || '').trim().toUpperCase() || domain.randomGiftCode(s.giftcard_prefix);
  if (db.prepare('SELECT id FROM gift_cards WHERE code=?').get(code)) return bad(res, 'That code already exists');
  const r = db.prepare('INSERT INTO gift_cards(code,value,balance,customer_id,created_by) VALUES(?,?,?,?,?)')
    .run(code, value, value, req.body.customer_id || null, req.user.id);
  audit(req.user, 'giftcard.issue', `${code} KSh${(value / 100).toFixed(2)}`);
  res.json(db.prepare('SELECT * FROM gift_cards WHERE id=?').get(r.lastInsertRowid));
});
app.post('/api/gift-cards/:id/void', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  db.prepare("UPDATE gift_cards SET status='void' WHERE id=?").run(req.params.id);
  audit(req.user, 'giftcard.void', String(req.params.id));
  res.json({ ok: true });
});

/* ======================= MULTI-LOCATION (4.13) ========================= */
app.get('/api/locations', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM locations ORDER BY name').all()));
app.post('/api/locations', requireAuth, requireRole('admin'), (req, res) => {
  const { name, address, phone, kra_pin } = req.body;
  if (!name) return bad(res, 'Name required');
  const r = db.prepare('INSERT INTO locations(name,address,phone,kra_pin) VALUES(?,?,?,?)')
    .run(name, address || null, phone || null, kra_pin || null);
  res.json(db.prepare('SELECT * FROM locations WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/locations/:id', requireAuth, requireRole('admin'), (req, res) => {
  const l = db.prepare('SELECT * FROM locations WHERE id=?').get(req.params.id);
  if (!l) return bad(res, 'Not found', 404);
  db.prepare('UPDATE locations SET name=?, address=?, phone=?, kra_pin=?, active=? WHERE id=?')
    .run(req.body.name ?? l.name, req.body.address ?? l.address, req.body.phone ?? l.phone,
      req.body.kra_pin ?? l.kra_pin, req.body.active !== undefined ? (req.body.active ? 1 : 0) : l.active, l.id);
  res.json(db.prepare('SELECT * FROM locations WHERE id=?').get(l.id));
});

/* ==================== ESC/POS PRINTING (2.5) =========================== */
const printerTarget = (which) => {
  const s = getSettings();
  const host = which === 'kitchen' ? s.kitchen_printer_host : s.printer_host;
  const port = which === 'kitchen' ? s.kitchen_printer_port : s.printer_port;
  return { enabled: s.printer_enabled === '1', host, port: Number(port) || 9100, settings: s };
};

app.post('/api/print/receipt/:id', requireAuth, async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const d = decorate(o);
  const t = o.table_id ? db.prepare('SELECT * FROM tables WHERE id=?').get(o.table_id) : null;
  const w = db.prepare('SELECT name FROM users WHERE id=?').get(o.waiter_id);
  const c = db.prepare('SELECT name FROM users WHERE id=?').get(o.closed_by);
  const cust = o.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(o.customer_id) : null;
  const payload = {
    order: d, table: t, waiter: w, settings: getSettings(),
    items: d.items, cashier: (c || {}).name || req.user.name,
    customer_phone: cust ? cust.phone : null
  };
  const buf = escpos.buildReceipt(payload, { paid: req.query.paid !== '0' });
  await deliverPrint(buf, 'till', `receipt-${o.number}`, res, req);
});

app.post('/api/print/kitchen/:id', requireAuth, async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const station = req.body.station || 'kitchen';
  const d = decorate(o);
  const lines = d.items.filter((i) => i.station === station && ['sent', 'ready'].includes(i.status));
  if (!lines.length) return bad(res, `No ${station} lines to print`);
  const t = o.table_id ? db.prepare('SELECT * FROM tables WHERE id=?').get(o.table_id) : null;
  const buf = escpos.buildKitchenTicket({ ...o, items: lines }, {
    table: t, waiter: waiterNameOf(o.waiter_id), station, settings: getSettings()
  });
  await deliverPrint(buf, 'kitchen', `kitchen-${o.number}-${station}`, res, req);
});

function waiterNameOf(id) { return (db.prepare('SELECT name FROM users WHERE id=?').get(id) || {}).name || '-'; }

/**
 * Send to the network printer if configured. Always also writes the job to
 * spool/ so there is an audit trail and something to test against.
 */
async function deliverPrint(buf, kind, name, res, req) {
  const p = printerTarget(kind);
  const spoolPath = path.join(__dirname, 'spool', `${name}-${Date.now()}.prn`);
  escpos.writeToFile(spoolPath, buf);
  audit(req.user, 'print', `${kind} ${name} (${buf.length} bytes)`);
  if (!p.enabled || !p.host) return res.json({ ok: true, sent: false, bytes: buf.length, spool: spoolPath,
    reason: 'No printer configured — job spooled to disk' });
  try {
    await escpos.send(p.host, p.port, buf);
    res.json({ ok: true, sent: true, bytes: buf.length, printer: `${p.host}:${p.port}` });
  } catch (e) {
    res.status(502).json({ ok: false, sent: false, error: e.message, spool: spoolPath });
  }
}

/* ================= INTEGRATION CONFIG (eTIMS/M-Pesa) =================== */
app.get('/api/integrations', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const s = getSettings();
  const etims = integrations.checkConfig(s, 'etims');
  const mpesa = integrations.checkConfig(s, 'mpesa');
  /* never send secrets back to the browser in full */
  const mask = (v) => (v ? String(v).slice(0, 4) + '••••' + String(v).slice(-2) : '');
  res.json({
    etims: { ...etims, endpoint: s.etims_endpoint, username: s.etims_username,
      password: mask(s.etims_password), branch_code: s.etims_branch_code,
      device_serial: s.etims_device_serial, receipt_prefix: s.etims_receipt_prefix,
      offline_queue_hours: s.etims_offline_queue_hours },
    mpesa: { ...mpesa, env: s.mpesa_env, consumer_key: mask(s.mpesa_consumer_key),
      consumer_secret: mask(s.mpesa_consumer_secret), shortcode: s.mpesa_shortcode,
      callback_url: s.mpesa_callback_url, paybill_account: s.mpesa_paybill_account },
    required: { etims: integrations.REQUIRED_ETIMS, mpesa: integrations.REQUIRED_MPESA },
    status: 'config_only'
  });
});
/** Dry-run: shapes a real payload without sending it, so config can be validated. */
app.post('/api/integrations/dry-run', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const s = getSettings();
  if (req.body.target === 'mpesa') {
    const r = integrations.buildStkRequest({
      phone: req.body.phone || '0712345678', amount: Number(req.body.amount) || 100,
      settings: s, reference: 'DRYRUN'
    });
    return res.json({ ok: r.valid, phone: r.valid ? r.body.PartyA : null,
      invalid: !r.valid ? r.invalidPhone : undefined, endpoint: r.baseUrl + '/mpesa/stkpush/v1/processrequest',
      payload: { ...r.body, Password: '••••' }, config: integrations.checkConfig(s, 'mpesa') });
  }
  const o = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 1").get();
  /* On a fresh install there are no orders yet — shape a representative sample so
     an admin can still validate credentials before the first sale. */
  const d = o ? decorate(o) : {
    ...{ number: 0, people: 2, opened_at: nowLocal(), payments: [] },
    totals: computeTotals([{ price: 100000, qty: 2 }], 0, s, 0),
    items: [{ name: 'Sample item', qty: 2, price: 100000, kra_item_code: null, tax_class: 'A' }]
  };
  res.json({
    sample: !o,
    config: integrations.checkConfig(s, 'etims'),
    endpoint: s.etims_endpoint,
    payload: integrations.buildEtimsInvoice(d, { items: d.items, settings: s })
  });
});

/* Read-only payment lookup for the cashier's "find a payment / reprint" box. */
app.get('/api/payments', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  let rows = db.prepare(`SELECT p.*, o.number AS order_number, o.channel
    FROM payments p JOIN orders o ON o.id = p.order_id
    ORDER BY p.id DESC LIMIT 800`).all();
  if (q) rows = rows.filter((r) =>
    String(r.order_number).includes(q) || (r.reference || '').toLowerCase().includes(q) ||
    r.method.toLowerCase().includes(q) || (r.created_at || '').includes(q));
  res.json(rows.slice(0, limit));
});

/* Most recent settled order, for one-tap reprint. */
app.get('/api/last-closed-order', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
  const o = db.prepare("SELECT * FROM orders WHERE status='closed' ORDER BY closed_at DESC, id DESC LIMIT 1").get();
  if (!o) return bad(res, 'No closed orders yet', 404);
  res.json(decorate(o));
});

/* ================== ORDER CHANNELS / DELIVERY (4.13) =================== */
app.get('/api/reports/channels', requireAuth, requireRole('cashier', 'manager', 'admin'), (req, res) => {
  const from = req.query.from || todayLocal();
  const to = req.query.to || from;
  res.json(db.prepare(`
    SELECT o.channel, COUNT(*) orders, COALESCE(SUM(o.people),0) covers,
           COALESCE(SUM((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.method != 'refund')),0) revenue,
           COALESCE(SUM(o.commission),0) commission
    FROM orders o
    WHERE o.closed_at BETWEEN ? AND ? AND o.status = 'closed'
    GROUP BY o.channel ORDER BY revenue DESC`).all(from + ' 00:00:00', to + ' 23:59:59'));
});
app.post('/api/orders/:id/commission', requireAuth, requireRole('cashier', 'manager', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return bad(res, 'Order not found', 404);
  const commission = Math.max(0, Math.round(Number(req.body.commission || 0) * 100));
  db.prepare('UPDATE orders SET commission=? WHERE id=?').run(commission, o.id);
  audit(req.user, 'order.commission', `#${o.number} ${(commission / 100).toFixed(2)}`);
  res.json(decorate(readOrder(o.id)));
});

/* ====================== QR TABLE ORDERING (4.13) ====================== */
/**
 * Public, token-scoped endpoints for guest self-ordering.
 * The token is a random 18-hex string per table, printed as a QR on the table.
 * Guests can read the menu and add items to that table's order; they cannot see
 * prices of other tables, pay, or change anything else.
 */
const tableByToken = (token) => db.prepare('SELECT * FROM tables WHERE qr_token=?').get(String(token || ''));

app.get('/api/qr/:token', (req, res) => {
  const t = tableByToken(req.params.token);
  if (!t) return bad(res, 'Unknown table code', 404);
  const s = getSettings();
  const dayparts = db.prepare('SELECT * FROM dayparts WHERE active=1').all();
  const active = domain.activeDayparts(dayparts);
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
  const menu = listMenu().filter((m) => m.available).map((m) => {
    const rule = domain.bestDiscountFor(m, active);
    return {
      id: m.id, name: m.name, category_id: m.category_id, station: m.station,
      price: rule ? domain.discountedPrice(m.price, rule.discount_pct) : m.price,
      was: rule ? m.price : null, rule: rule ? rule.name : null,
      groups: db.prepare('SELECT * FROM modifier_groups WHERE id IN (SELECT group_id FROM menu_item_modifiers WHERE menu_item_id=?)').all(m.id)
        .map((g) => ({ ...g, options: db.prepare('SELECT * FROM modifier_options WHERE group_id=? ORDER BY sort_order, name').all(g.id) }))
    };
  });
  const open = db.prepare("SELECT * FROM orders WHERE table_id=? AND status IN ('open','billed') ORDER BY id DESC LIMIT 1").get(t.id);
  res.json({
    table: { name: t.name, area: t.area }, business: s.business_name,
    currency_symbol: s.currency_symbol, categories: cats, menu,
    order: open ? { id: open.id, number: open.number, items: decorate(open).items } : null
  });
});

app.post('/api/qr/:token/items', (req, res) => {
  const t = tableByToken(req.params.token);
  if (!t) return bad(res, 'Unknown table code', 404);
  let order = db.prepare("SELECT * FROM orders WHERE table_id=? AND status IN ('open','billed') ORDER BY id DESC LIMIT 1").get(t.id);
  if (!order) {
    const r = db.prepare("INSERT INTO orders(number,table_id,waiter_id,people,notes,channel) VALUES(?,?,?,?,?,?)")
      .run(nextOrderNumber(), t.id, null, Number(req.body.people) || 1, 'Guest QR order', 'dine_in');
    order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
    audit(null, 'qr.order.open', `${t.name} #${order.number}`);
  }
  const lines = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const dayparts = db.prepare('SELECT * FROM dayparts WHERE active=1').all();
  const ins = db.prepare(`INSERT INTO order_items(order_id,menu_item_id,name,price,qty,note,station,modifiers)
    VALUES(?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (const l of lines) {
      const m = db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(l.menu_item_id));
      if (!m) throw new Error('No such menu item');
      if (!m.available) throw new Error(`${m.name} is currently unavailable`);
      const rule = domain.bestDiscountFor(m, dayparts);
      let price = rule ? domain.discountedPrice(m.price, rule.discount_pct) : m.price;
      const chosen = [];
      const allowed = db.prepare('SELECT group_id FROM menu_item_modifiers WHERE menu_item_id=?').all(m.id).map((g) => g.group_id);
      for (const mod of (Array.isArray(l.modifiers) ? l.modifiers : [])) {
        const opt = db.prepare('SELECT * FROM modifier_options WHERE id=?').get(Number(mod.id));
        if (!opt || !allowed.includes(opt.group_id)) throw new Error('Invalid option');
        chosen.push({ id: opt.id, group_id: opt.group_id, name: opt.name, price: opt.price });
        price += opt.price;
      }
      const reqGroups = db.prepare(`SELECT g.* FROM modifier_groups g JOIN menu_item_modifiers mm ON mm.group_id=g.id
        WHERE mm.menu_item_id=? AND g.required=1`).all(m.id);
      for (const g of reqGroups) if (!chosen.some((c) => c.group_id === g.id)) throw new Error(`Please choose: ${g.name}`);
      ins.run(order.id, m.id, m.name, price, Number(l.qty) || 1, l.note || null, m.station,
        chosen.length ? JSON.stringify(chosen) : null);
    }
  });
  try { tx(); } catch (e) { return bad(res, e.message); }
  audit(null, 'qr.order.add', `${t.name} #${order.number} x${lines.length}`);
  broadcast('orders'); broadcast('kitchen'); broadcast('tables');
  res.json(decorate(readOrder(order.id)));
});

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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`${getSettings().business_name} POS listening on http://0.0.0.0:${PORT}`);
  });
}
module.exports = app;

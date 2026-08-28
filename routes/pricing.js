'use strict';

/** Daypart pricing, recipes/BOM and modifiers retained as one cohesive catalogue boundary. */
module.exports = function register(app, {
  db, domain, requireAuth, requireRole, todayLocal, audit, broadcast, bad
}) {
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
      SELECT s.id, s.name, s.unit, s.capacity_ml, s.qty AS on_hand,
             COALESCE(SUM(r.qty * oi.qty * oi.stock_factor), 0) AS theoretical
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
};

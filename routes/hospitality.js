'use strict';

/** Reusable hospitality-only tabs, timeclock/labour and reservations. */
module.exports = function register(app, {
  db, domain, requireAuth, requireRole, todayLocal, getSettings, audit, broadcast, bad
}) {
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
    const from=req.query.from||todayLocal(),to=req.query.to||from;
    if(!['manager','admin'].includes(req.user.role)) return res.json(db.prepare(`SELECT t.id,t.user_id,t.clock_in,t.clock_out,t.note,u.name
      FROM timeclock t JOIN users u ON u.id=t.user_id WHERE t.user_id=? AND t.clock_in BETWEEN ? AND ? ORDER BY t.clock_in DESC`)
      .all(req.user.id,from+' 00:00:00',to+' 23:59:59'));
    res.json(db.prepare(`SELECT t.*,u.name,u.hourly_rate FROM timeclock t JOIN users u ON u.id=t.user_id
      WHERE t.clock_in BETWEEN ? AND ? ORDER BY t.clock_in DESC`).all(from+' 00:00:00',to+' 23:59:59'));
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
};

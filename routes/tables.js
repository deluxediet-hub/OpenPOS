'use strict';

/** Legacy hospitality table master data, preserved behind the existing mode. */
module.exports = function register(app, {
  db, requireAuth, requireRole, broadcast, bad
}) {
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
};

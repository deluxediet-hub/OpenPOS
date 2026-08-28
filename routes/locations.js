'use strict';

/** Existing location master-data routes. */
module.exports = function register(app, {
  db, requireAuth, requireRole, bad
}) {
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
};

'use strict';

/** Stock listing, protected master-data changes and owner adjustments. */
module.exports = function register(app, {
  db, requireAuth, requireRole, audit, bad
}) {
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
    if(db.prepare('SELECT id FROM recipes WHERE stock_item_id=? LIMIT 1').get(req.params.id)
      ||db.prepare('SELECT id FROM goods_receipt_items WHERE stock_item_id=? LIMIT 1').get(req.params.id))
      return bad(res,'Stock with product or delivery history cannot be deleted',409);
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
    db.prepare('UPDATE stock_items SET qty = ROUND(qty + ?, 6) WHERE id=?').run(delta, s.id);
    db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
      .run(s.id, delta, reason, req.user.id);
    audit(req.user, 'stock.adjust', `${s.name} ${delta > 0 ? '+' : ''}${delta} — ${reason}`);
    res.json(db.prepare('SELECT * FROM stock_items WHERE id=?').get(s.id));
  });
};

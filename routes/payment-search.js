'use strict';

/** Cashier payment lookup and latest-receipt queries. */
module.exports = function register(app, {
  db, requireAuth, requireRole, decorate, bad
}) {
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
};

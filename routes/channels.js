'use strict';

/** Existing order-channel reporting and commission metadata. */
module.exports = function register(app, {
  db, requireAuth, requireRole, todayLocal, decorate, readOrder, audit, bad
}) {
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
    if (!['open', 'billed'].includes(o.status) || o.closed_out)
      return bad(res, 'Commission cannot change after a sale is closed', 409);
    if (db.prepare("SELECT id FROM payments WHERE order_id=? AND kind='sale' LIMIT 1").get(o.id))
      return bad(res, 'Commission cannot change after payment has started', 409);
    const commission = Math.max(0, Math.round(Number(req.body.commission || 0) * 100));
    db.prepare('UPDATE orders SET commission=? WHERE id=?').run(commission, o.id);
    audit(req.user, 'order.commission', `#${o.number} ${(commission / 100).toFixed(2)}`);
    res.json(decorate(readOrder(o.id)));
  });
};

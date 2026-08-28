'use strict';

/** Customer, loyalty and funded gift-card routes; balances and APIs are preserved. */
module.exports = function register(app, {
  db, domain, requireAuth, requireRole, getSettings, audit, broadcast, bad
}) {
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
  app.get('/api/gift-cards', requireAuth, requireRole('manager', 'admin'), (req, res) =>
    res.json(db.prepare(`SELECT g.*, c.name AS customer_name FROM gift_cards g
      LEFT JOIN customers c ON c.id = g.customer_id ORDER BY g.id DESC LIMIT 200`).all()));
  app.get('/api/gift-cards/lookup/:code', requireAuth, (req, res) => {
    const g = db.prepare('SELECT * FROM gift_cards WHERE code=?').get(String(req.params.code).trim().toUpperCase());
    if (!g) return bad(res, 'No gift card with that code', 404);
    res.json(g);
  });
  app.post('/api/gift-cards', requireAuth, requireRole('manager','admin'), (req, res) => {
    const idem=String(req.body.idempotency_key||'').trim().slice(0,100)||null;
    if(idem){const funded=db.prepare('SELECT id FROM gift_card_funding WHERE idempotency_key=?').get(idem);if(funded){const prior=db.prepare('SELECT * FROM gift_cards WHERE funding_id=?').get(funded.id);return res.json({...prior,idempotent_replay:true});}}
    const s = getSettings(), value = Math.round(Number(req.body.value) * 100);
    const method = String(req.body.payment_method || '').toLowerCase();
    if (!value || value <= 0) return bad(res, 'Value must be greater than zero');
    if (!['cash','card','mpesa'].includes(method)) return bad(res, 'Gift card funding method must be Cash, Card or M-Pesa');
    const shift = db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    if (!shift) return bad(res, 'Open the till before funding a gift card');
    const reference = String(req.body.reference || '').trim().toUpperCase() || null;
    if (['card','mpesa'].includes(method) && !reference) return bad(res, `${method.toUpperCase()} reference is required`);
    if (reference && (db.prepare('SELECT id FROM gift_card_funding WHERE upper(reference)=upper(?)').get(reference)
        || db.prepare("SELECT id FROM payments WHERE upper(reference)=upper(?) AND reference IS NOT NULL").get(reference)))
      return bad(res, 'That payment reference has already been used');
    let code = String(req.body.code || '').trim().toUpperCase() || domain.randomGiftCode(s.giftcard_prefix);
    if (db.prepare('SELECT id FROM gift_cards WHERE code=?').get(code)) return bad(res, 'That code already exists');
    let cardId;
    const tx = db.transaction(() => {
      const fundingId = db.prepare('INSERT INTO gift_card_funding(amount,method,reference,shift_id,created_by,idempotency_key) VALUES(?,?,?,?,?,?)')
        .run(value, method, reference, shift.id, req.user.id, idem).lastInsertRowid;
      cardId = db.prepare('INSERT INTO gift_cards(code,value,balance,customer_id,created_by,funding_id) VALUES(?,?,?,?,?,?)')
        .run(code, value, value, req.body.customer_id || null, req.user.id, fundingId).lastInsertRowid;
    }); tx();
    audit(req.user, 'giftcard.issue', `${code} KSh${(value / 100).toFixed(2)} funded by ${method}${reference ? ' '+reference : ''}`);
    broadcast('sales');
    res.json(db.prepare('SELECT * FROM gift_cards WHERE id=?').get(cardId));
  });

  app.post('/api/gift-cards/:id/void', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    db.prepare("UPDATE gift_cards SET status='void' WHERE id=?").run(req.params.id);
    audit(req.user, 'giftcard.void', String(req.params.id));
    res.json({ ok: true });
  });
};

'use strict';

/** Simple owner-authorized declarations; seller policy is intentionally unchanged. */
module.exports = function register(app, {
  db, requireAuth, requireRole, getSetting, ensureRetailTill, todayLocal, dayBounds, dayEnd, audit, broadcast, bad
}) {
  /* ---------------- complimentary stock issues (no cash transaction) -------- */
  app.get('/api/complimentaries', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const from = req.query.from || todayLocal(), to = req.query.to || from;
    res.json(db.prepare(`SELECT ci.*,u.name created_by_name,a.name authorized_by_name,si.unit stock_unit FROM complimentary_issues ci
      LEFT JOIN users u ON u.id=ci.created_by LEFT JOIN users a ON a.id=ci.authorized_by
      LEFT JOIN stock_items si ON si.id=ci.stock_item_id
      WHERE ci.created_at BETWEEN ? AND ? ORDER BY ci.id DESC`).all(dayBounds(from), dayEnd(to)));
  });

  app.post('/api/complimentaries', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
    if (getSetting('business_type') !== 'wines_spirits') return bad(res, 'Complimentary issues are available in retail mode only');
    let authorizer = req.user;
    let authorizationReference = String(req.body.authorization_reference || '').trim();
    if (req.user.role === 'seller') {
      if (!req.body.owner_authorized) return bad(res, 'Confirm that the owner authorized this complimentary issue', 400);
      authorizer = db.prepare("SELECT id,name,role FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get();
      if (!authorizer) return bad(res, 'No active owner account is available to authorize this issue', 400);
      authorizationReference = authorizationReference || 'Owner authorized — declared by seller';
    }
    const shift = ensureRetailTill(req.user);
    if (!shift) return bad(res, 'Finish till reconciliation before recording a complimentary issue');
    const m = db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(req.body.menu_item_id));
    if (!m) return bad(res, 'Product not found', 404);
    const qty = Number(req.body.qty || 1), fullMl = Number(m.volume_ml) || 0, measureMl = Number(req.body.measure_ml) || 0;
    if (!Number.isInteger(qty) || qty <= 0) return bad(res, 'Quantity must be a positive whole number');
    if (measureMl && (!(fullMl > 0) || measureMl <= 0 || measureMl > fullMl)) return bad(res, 'Measured amount is invalid');
    const reason = String(req.body.reason || '').trim(), recipient = String(req.body.recipient || '').trim();
    if (!reason) return bad(res, 'Complimentary reason is required');
    if (['Staff complimentary', 'Friends / guests', 'Other'].includes(reason) && !recipient)
      return bad(res, 'Recipient or explanation is required for this complimentary reason');
    const priceFactor = measureMl ? measureMl / fullMl : 1;
    const stockFactor = measureMl ? (m.stock_mode === 'weighed' ? measureMl / 1000 : priceFactor) : 1;
    const recipe = db.prepare(`SELECT r.qty deduction,si.* FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
      WHERE r.menu_item_id=? ORDER BY r.id LIMIT 1`).get(m.id);
    if (!recipe) return bad(res, 'Product has no stock mapping');
    const stockQty = recipe.deduction * stockFactor * qty;
    if (getSetting('prevent_negative_stock') === '1' && recipe.qty < stockQty)
      return bad(res, `${m.name}: insufficient stock for this complimentary issue`);
    const itemName = measureMl ? `${m.name} — ${Number(measureMl.toFixed(2))}ml` : m.name;
    const retailValue = Math.round(m.price * priceFactor * qty), costValue = Math.round(m.cost * stockFactor * qty);
    let id;
    const tx = db.transaction(() => {
      const deducted = recipe.deduction_mode === 'count' ? 0 : 1;
      if (deducted) {
        db.prepare(`UPDATE stock_items SET qty=CASE WHEN ABS(ROUND(qty-?,6))<0.000001 THEN 0 ELSE ROUND(qty-?,6) END WHERE id=?`)
          .run(stockQty, stockQty, recipe.id);
        db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
          .run(recipe.id, -stockQty, `Complimentary: ${reason}${recipient ? ' · ' + recipient : ''}`, req.user.id);
      }
      id = db.prepare(`INSERT INTO complimentary_issues(menu_item_id,item_name,qty,measure_ml,stock_factor,
        retail_value,cost_value,stock_item_id,stock_qty,deducted,reason,recipient,shift_id,created_by,authorized_by,authorization_reference)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(m.id, itemName, qty, measureMl || null, stockFactor,
        retailValue, costValue, recipe.id, stockQty, deducted, reason, recipient || null, shift.id, req.user.id,
        authorizer.id, authorizationReference || (req.user.id === authorizer.id ? 'Owner self-authorized' : null)).lastInsertRowid;
    }); tx();
    audit(req.user, 'complimentary.issue', `${itemName} x${qty} · retail KSh${(retailValue / 100).toFixed(2)} · cost KSh${(costValue / 100).toFixed(2)} · ${reason}${recipient ? ' · ' + recipient : ''} · recorded by ${req.user.name} · authorized by ${authorizer.name} (${authorizationReference || 'self'})`);
    broadcast('stock'); broadcast('sales');
    res.json(db.prepare('SELECT * FROM complimentary_issues WHERE id=?').get(id));
  });
};

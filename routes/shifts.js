'use strict';

/** Shared till, expenses, clearing sheet and close reconciliation routes. */
module.exports = function registerShifts(app, {
  db, domain, requireAuth, requireRole, getSetting, getSettings, todayLocal,
  drawerFigures, audit, broadcast, bad
}) {
  /* ================= CASH DRAWER RECONCILIATION (2.6) ==================== */
  app.get('/api/shifts', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
    res.json(db.prepare(`SELECT s.*, uo.name AS opened_by_name, uc.name AS closed_by_name
      FROM shifts s LEFT JOIN users uo ON uo.id = s.opened_by
      LEFT JOIN users uc ON uc.id = s.closed_by ORDER BY s.id DESC LIMIT 100`).all());
  });
  app.get('/api/shifts/current', requireAuth, (req, res) => {
    const s = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get();
    if (!s) return res.json({ shift: null, drawer: null, stocktake: null });
    const stocktake = db.prepare("SELECT * FROM stock_counts WHERE status='completed' AND completed_at>=? ORDER BY id DESC LIMIT 1").get(s.opened_at) || null;
    res.json({ shift: s, drawer: drawerFigures(s), stocktake });
  });
  app.post('/api/shifts', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
    const open = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling')").get();
    if (open) return bad(res, 'A till is already open or reconciling — close it first');
    const float = Math.round(Number(req.body.opening_float || 0) * 100);
    const openingMpesa = Math.round(Number(req.body.opening_mpesa || 0) * 100);
    const openingCard = Math.round(Number(req.body.opening_card || 0) * 100);
    const r = db.prepare('INSERT INTO shifts(opened_by,opening_float,opening_mpesa,opening_card,notes) VALUES(?,?,?,?,?)')
      .run(req.user.id, float, openingMpesa, openingCard, req.body.notes || null);
    audit(req.user, 'shift.open', `cash KSh${(float / 100).toFixed(2)}, M-Pesa KSh${(openingMpesa / 100).toFixed(2)}, Card batch KSh${(openingCard / 100).toFixed(2)}`);
    broadcast('sales');
    res.json(db.prepare('SELECT * FROM shifts WHERE id=?').get(r.lastInsertRowid));
  });
  app.post('/api/shifts/:id/close', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
    const s = db.prepare('SELECT * FROM shifts WHERE id=?').get(req.params.id);
    if (!s) return bad(res, 'Shift not found', 404);
    if (s.status === 'closed') return bad(res, 'Shift already closed');
    if (req.body.counted_cash == null) return bad(res, 'Counted cash is required');
    const retailMode = getSetting('business_type') === 'wines_spirits';
    if (retailMode && req.body.counted_mpesa == null) return bad(res, 'M-Pesa balance is required');
    if (retailMode && req.body.counted_card == null) return bad(res, 'Card/EDC batch total is required');
    if (retailMode) {
      const empty = db.prepare(`SELECT o.id,o.number FROM orders o WHERE o.status='open'
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.status!='void')`).all();
      for (const order of empty) {
        db.prepare("UPDATE orders SET status='void',closed_at=datetime('now','localtime'),closed_by=? WHERE id=?").run(req.user.id, order.id);
        audit(req.user, 'order.auto_void_empty', `#${order.number} at till close`);
      }
    }
    const openSales = db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','billed')").get().c;
    if (openSales) return bad(res, `Close or void ${openSales} open sale(s) before closing the till`);
    const stocktake = retailMode ? db.prepare("SELECT * FROM stock_counts WHERE status='completed' AND completed_at>=? ORDER BY id DESC LIMIT 1").get(s.opened_at) : null;
    if (retailMode && !stocktake) return bad(res, 'Complete the end-of-day stocktake before closing the till');

    const counted = Math.round(Number(req.body.counted_cash) * 100);
    const countedMpesa = Math.round(Number(req.body.counted_mpesa || 0) * 100);
    const countedCard = Math.round(Number(req.body.counted_card || 0) * 100);
    const fig = drawerFigures(s);
    const variance = domain.drawerVariance(counted, fig.expected);
    const mpesaVariance = countedMpesa - fig.expected_mpesa;
    const cardVariance = countedCard - fig.expected_card;
    const tenderVariance = variance + mpesaVariance + cardVariance;
    const stockRetailVariance = stocktake ? stocktake.retail_variance : 0;
    const overallVariance = tenderVariance + stockRetailVariance;
    const settings = getSettings();
    const tolerance = Math.max(0, Math.round(Number(settings.reconciliation_tolerance || 20) * 100));
    const critical = Math.max(tolerance, Math.round(Number(settings.reconciliation_critical_threshold || 500) * 100));
    const components = [variance, mpesaVariance, cardVariance, stockRetailVariance];
    let reconciliationStatus;
    if (components.every((v) => Math.abs(v) <= tolerance)) reconciliationStatus = 'FULLY BALANCED';
    else if (Math.abs(overallVariance) <= tolerance && tenderVariance > tolerance && stockRetailVariance < -tolerance)
      reconciliationStatus = 'RECONCILED — POSSIBLE UNRECORDED SALES';
    else if (Math.abs(overallVariance) <= tolerance) reconciliationStatus = 'RECONCILED — OFFSETTING VARIANCES';
    else if (overallVariance < -critical) reconciliationStatus = 'CRITICAL SHORTAGE';
    else if (overallVariance > critical) reconciliationStatus = 'CRITICAL OVERAGE';
    else reconciliationStatus = overallVariance < 0 ? 'SHORTAGE — INVESTIGATE' : 'OVERAGE — INVESTIGATE';
    const reconciliationNote = String(req.body.reconciliation_note || req.body.notes || '').trim();
    if (reconciliationStatus !== 'FULLY BALANCED' && !reconciliationNote)
      return bad(res, 'Add a reconciliation note explaining the variance or possible missed sales');

    db.prepare(`UPDATE shifts SET closed_at=datetime('now','localtime'),closed_by=?,counted_cash=?,expected_cash=?,variance=?,
      counted_mpesa=?,expected_mpesa=?,mpesa_variance=?,counted_card=?,expected_card=?,card_variance=?,tender_variance=?,
      stock_retail_variance=?,overall_variance=?,reconciliation_status=?,reconciliation_note=?,status='closed',notes=? WHERE id=?`)
      .run(req.user.id, counted, fig.expected, variance, countedMpesa, fig.expected_mpesa, mpesaVariance,
        countedCard, fig.expected_card, cardVariance, tenderVariance, stockRetailVariance, overallVariance,
        reconciliationStatus, reconciliationNote || null, req.body.notes || s.notes, s.id);
    audit(req.user, 'shift.close', `Cash ${variance / 100}, M-Pesa ${mpesaVariance / 100}, Card ${cardVariance / 100}, tender ${tenderVariance / 100}, stock retail ${stockRetailVariance / 100}, overall ${overallVariance / 100} — ${reconciliationStatus}${reconciliationNote ? ' — ' + reconciliationNote : ''}`);
    if (variance) audit(req.user, 'drawer.variance', `Cash KSh${(variance / 100).toFixed(2)} ${variance > 0 ? 'over' : 'short'}`);
    if (mpesaVariance) audit(req.user, 'mpesa.variance', `KSh${(mpesaVariance / 100).toFixed(2)} ${mpesaVariance > 0 ? 'over' : 'short'}`);
    if (cardVariance) audit(req.user, 'card.variance', `KSh${(cardVariance / 100).toFixed(2)} ${cardVariance > 0 ? 'over' : 'short'}`);
    if (stockRetailVariance) audit(req.user, 'stock.retail_variance', `KSh${(stockRetailVariance / 100).toFixed(2)}`);
    broadcast('sales');
    res.json({ ...db.prepare('SELECT * FROM shifts WHERE id=?').get(s.id), drawer: fig, stocktake,
      reconciliation: { cash_variance: variance, mpesa_variance: mpesaVariance, card_variance: cardVariance,
        tender_variance: tenderVariance, stock_retail_variance: stockRetailVariance, overall_variance: overallVariance,
        status: reconciliationStatus, tolerance } });
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
    const saleMethods = q(`SELECT method,COALESCE(SUM(amount),0) total,COUNT(*) n FROM payments WHERE shift_id=? GROUP BY method`);
    const fundingMethods = q(`SELECT method,COALESCE(SUM(amount),0) total,COUNT(*) n FROM gift_card_funding WHERE shift_id=? GROUP BY method`);
    const methodMap=new Map();
    for(const row of [...saleMethods,...fundingMethods]){const cur=methodMap.get(row.method)||{method:row.method,total:0,n:0};cur.total+=row.total;cur.n+=row.n;methodMap.set(row.method,cur);}
    const byMethod=[...methodMap.values()].sort((a,b)=>b.total-a.total);
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
    const complimentary = s ? db.prepare(`SELECT ci.*,u.name created_by_name,a.name authorized_by_name FROM complimentary_issues ci
      LEFT JOIN users u ON u.id=ci.created_by LEFT JOIN users a ON a.id=ci.authorized_by
      WHERE ci.shift_id=? ORDER BY ci.id`).all(s.id) : [];
    const stocktake = s ? db.prepare("SELECT * FROM stock_counts WHERE status='completed' AND completed_at>=? ORDER BY id DESC LIMIT 1").get(s.opened_at) || null : null;
    let drawer = null;
    if (s) drawer = s.status !== 'closed' ? drawerFigures(s)
      : { expected: s.expected_cash, counted: s.counted_cash, variance: s.variance,
        expected_mpesa: s.expected_mpesa, counted_mpesa: s.counted_mpesa, mpesa_variance: s.mpesa_variance,
        expected_card: s.expected_card, counted_card: s.counted_card, card_variance: s.card_variance,
        tender_variance: s.tender_variance, stock_retail_variance: s.stock_retail_variance,
        overall_variance: s.overall_variance, reconciliation_status: s.reconciliation_status,
        reconciliation_note: s.reconciliation_note, payouts };
    res.json({ shift: s || null, by_method: byMethod, by_station: byStation, by_category: byCategory,
      tips, payouts, covers, units: byCategory.reduce((n, x) => n + Number(x.units || 0), 0), orders: ordersN,
      complimentary, complimentary_value: complimentary.reduce((n, x) => n + x.retail_value, 0),
      complimentary_cost: complimentary.reduce((n, x) => n + x.cost_value, 0), stocktake, drawer });
  });
};

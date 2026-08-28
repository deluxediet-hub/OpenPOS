'use strict';

/** Shared till, expenses, clearing sheet and close reconciliation routes. */
module.exports = function registerShifts(app, {
  db, domain, requireAuth, requireRole, getSetting, getSettings,
  drawerFigures, audit, broadcast, bad
}) {
  const completedCountFor=(shift)=>db.prepare(`SELECT * FROM stock_counts WHERE status='completed' AND for_close=1
    AND (shift_id=? OR (shift_id IS NULL AND completed_at>=?)) ORDER BY id DESC LIMIT 1`).get(shift.id,shift.opened_at)||null;
  const coverageOf=(count)=>!count?'none':(count.count_type==='full'&&Number(count.coverage_ratio)>=0.999999?'full':'partial');
  const reconciliationFor=(shift,body,stocktake=null)=>{
    const figures=drawerFigures(shift),settings=getSettings();
    const counted=Math.round(Number(body.counted_cash||0)*100);
    const countedMpesa=Math.round(Number(body.counted_mpesa||0)*100);
    const countedCard=Math.round(Number(body.counted_card||0)*100);
    return {figures,counted,countedMpesa,countedCard,result:domain.reconcile({
      cashVariance:domain.drawerVariance(counted,figures.expected),
      mpesaVariance:countedMpesa-figures.expected_mpesa,cardVariance:countedCard-figures.expected_card,
      stockVariance:stocktake?stocktake.retail_variance:null,stockCoverage:coverageOf(stocktake),
      tolerance:Math.max(0,Math.round(Number(settings.reconciliation_tolerance||20)*100)),
      critical:Math.max(0,Math.round(Number(settings.reconciliation_critical_threshold||500)*100))
    })};
  };

  /* ================= CASH DRAWER RECONCILIATION (2.6) ==================== */
  app.get('/api/shifts', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
    res.json(db.prepare(`SELECT s.*, uo.name AS opened_by_name, uc.name AS closed_by_name
      FROM shifts s LEFT JOIN users uo ON uo.id = s.opened_by
      LEFT JOIN users uc ON uc.id = s.closed_by ORDER BY s.id DESC LIMIT 100`).all());
  });
  app.get('/api/shifts/current', requireAuth, (req, res) => {
    const s = db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get();
    if (!s) return res.json({ shift: null, drawer: null, stocktake: null });
    const stocktake=completedCountFor(s);
    res.json({ shift: s, drawer: drawerFigures(s), stocktake,
      stock_coverage:coverageOf(stocktake),stock_count_policy:getSetting('stock_count_close_policy')||'none' });
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
  app.post('/api/shifts/:id/reconciliation-preview', requireAuth, requireRole('seller','cashier','manager','admin'), (req,res)=>{
    const shift=db.prepare('SELECT * FROM shifts WHERE id=?').get(req.params.id);
    if(!shift)return bad(res,'Shift not found',404);
    if(shift.status==='closed')return bad(res,'Shift already closed');
    const stocktake=completedCountFor(shift);
    const effectiveCount=getSetting('business_type')==='wines_spirits'?stocktake:{retail_variance:0,count_type:'full',coverage_ratio:1};
    const calc=reconciliationFor(shift,req.body||{},effectiveCount);
    res.json({...calc.result,expected_cash:calc.figures.expected,expected_mpesa:calc.figures.expected_mpesa,
      expected_card:calc.figures.expected_card,stocktake});
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
    const stocktake=retailMode?completedCountFor(s):null;
    const policy=retailMode?String(getSetting('stock_count_close_policy')||'none').toLowerCase():'none';
    if(retailMode&&policy==='any'&&!stocktake)return bad(res,'Complete a closing stock count before closing the till');
    if(retailMode&&policy==='full'&&coverageOf(stocktake)!=='full')return bad(res,'Complete a full closing stock count before closing the till');

    const calc=reconciliationFor(s,req.body,retailMode?stocktake:{retail_variance:0,count_type:'full',coverage_ratio:1});
    const {figures:fig,counted,countedMpesa,countedCard,result:reconciliation}=calc;
    const reconciliationNote=String(req.body.reconciliation_note||req.body.notes||'').trim();
    if(reconciliation.requires_note&&!reconciliationNote)
      return bad(res,'Add a reconciliation note explaining the variance or possible missed sales');

    db.prepare(`UPDATE shifts SET closed_at=datetime('now','localtime'),closed_by=?,counted_cash=?,expected_cash=?,variance=?,
      counted_mpesa=?,expected_mpesa=?,mpesa_variance=?,counted_card=?,expected_card=?,card_variance=?,tender_variance=?,
      stock_retail_variance=?,overall_variance=?,reconciliation_status=?,reconciliation_note=?,stock_count_id=?,
      stock_count_type=?,stock_coverage=?,status='closed',notes=? WHERE id=?`)
      .run(req.user.id,counted,fig.expected,reconciliation.cash_variance,countedMpesa,fig.expected_mpesa,reconciliation.mpesa_variance,
        countedCard,fig.expected_card,reconciliation.card_variance,reconciliation.tender_variance,
        reconciliation.stock_retail_variance,reconciliation.overall_variance,reconciliation.status,reconciliationNote||null,
        stocktake?stocktake.id:null,stocktake?stocktake.count_type:null,reconciliation.stock_coverage,req.body.notes||s.notes,s.id);
    const stockText=reconciliation.stock_retail_variance==null?'not counted':String(reconciliation.stock_retail_variance/100);
    const overallText=reconciliation.overall_variance==null?'not available':String(reconciliation.overall_variance/100);
    audit(req.user,'shift.close',`Cash ${reconciliation.cash_variance/100}, M-Pesa ${reconciliation.mpesa_variance/100}, Card ${reconciliation.card_variance/100}, tender ${reconciliation.tender_variance/100}, stock retail ${stockText}, overall ${overallText} — ${reconciliation.status}${reconciliationNote?' — '+reconciliationNote:''}`);
    if(reconciliation.cash_variance)audit(req.user,'drawer.variance',`Cash KSh${(reconciliation.cash_variance/100).toFixed(2)} ${reconciliation.cash_variance>0?'over':'short'}`);
    if(reconciliation.mpesa_variance)audit(req.user,'mpesa.variance',`KSh${(reconciliation.mpesa_variance/100).toFixed(2)} ${reconciliation.mpesa_variance>0?'over':'short'}`);
    if(reconciliation.card_variance)audit(req.user,'card.variance',`KSh${(reconciliation.card_variance/100).toFixed(2)} ${reconciliation.card_variance>0?'over':'short'}`);
    if(reconciliation.stock_retail_variance)audit(req.user,'stock.retail_variance',`KSh${(reconciliation.stock_retail_variance/100).toFixed(2)} · ${reconciliation.stock_coverage}`);
    broadcast('sales');
    res.json({...db.prepare('SELECT * FROM shifts WHERE id=?').get(s.id),drawer:fig,stocktake,reconciliation});
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
    const stocktake=s?completedCountFor(s):null;
    let drawer = null;
    if (s) drawer = s.status !== 'closed' ? drawerFigures(s)
      : { expected: s.expected_cash, counted: s.counted_cash, variance: s.variance,
        expected_mpesa: s.expected_mpesa, counted_mpesa: s.counted_mpesa, mpesa_variance: s.mpesa_variance,
        expected_card: s.expected_card, counted_card: s.counted_card, card_variance: s.card_variance,
        tender_variance: s.tender_variance, stock_retail_variance: s.stock_retail_variance,
        overall_variance: s.overall_variance, reconciliation_status: s.reconciliation_status,
        reconciliation_note: s.reconciliation_note, stock_coverage:s.stock_coverage,
        stock_count_type:s.stock_count_type,payouts };
    res.json({ shift: s || null, by_method: byMethod, by_station: byStation, by_category: byCategory,
      tips, payouts, covers, units: byCategory.reduce((n, x) => n + Number(x.units || 0), 0), orders: ordersN,
      complimentary, complimentary_value: complimentary.reduce((n, x) => n + x.retail_value, 0),
      complimentary_cost: complimentary.reduce((n, x) => n + x.cost_value, 0), stocktake, drawer });
  });
};

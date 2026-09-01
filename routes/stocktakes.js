'use strict';

/** Physical stock-count routes, including existing seller-entered additions. */
module.exports = function register(app, {
  db, requireAuth, requireRole, getSetting, todayLocal, stockLedger, audit, broadcast, bad
}) {
  app.get('/api/stock-counts', requireAuth, (req, res) => res.json(db.prepare(`
    SELECT sc.*,us.name started_by_name,uc.name completed_by_name,ux.name cancelled_by_name,
      (SELECT COUNT(*) FROM stock_count_items si WHERE si.stock_count_id=sc.id) lines,
      (SELECT COUNT(*) FROM stock_count_items si WHERE si.stock_count_id=sc.id AND ABS(COALESCE(si.variance,0))>0.0001) variances
    FROM stock_counts sc LEFT JOIN users us ON us.id=sc.started_by LEFT JOIN users uc ON uc.id=sc.completed_by
      LEFT JOIN users ux ON ux.id=sc.cancelled_by
    ORDER BY sc.id DESC LIMIT 100`).all()));

  app.post('/api/stock-counts', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
    if (db.prepare("SELECT id FROM stock_counts WHERE status='open'").get()) return bad(res, 'Complete the open stocktake first');
    const retail = getSetting('business_type') === 'wines_spirits';
    const countType=String(req.body.count_type||'full').toLowerCase();
    if(!['full','category','selected','cycle','spot','correction'].includes(countType))return bad(res,'Unknown stock count type');
    const forClose=req.body.for_close!==false;
    const retailShift=retail?db.prepare("SELECT * FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get():null;
    if(retail&&forClose&&!retailShift)return bad(res,'Open the till before starting a closing stock count');
    if(retail&&forClose){
      const empty=db.prepare(`SELECT o.id,o.number FROM orders o WHERE o.status='open'
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.status!='void')`).all();
      for(const order of empty){
        db.prepare("UPDATE orders SET status='void',closed_at=datetime('now','localtime'),closed_by=? WHERE id=?").run(req.user.id,order.id);
        audit(req.user,'order.auto_void_empty',`#${order.number} before stocktake`);
      }
      const openSales=db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('open','billed')").get().c;
      if(openSales)return bad(res,`Close or void ${openSales} non-empty sale(s) before stocktake`);
    }

    const allStock=db.prepare('SELECT id,qty,name FROM stock_items ORDER BY name').all();
    let selected=allStock,categoryId=null,scopeLabel='All stock';
    if(countType==='category'){
      categoryId=Number(req.body.category_id)||null;
      const category=categoryId?db.prepare('SELECT id,name FROM categories WHERE id=?').get(categoryId):null;
      if(!category)return bad(res,'Choose a valid category for this count');
      const ids=new Set(db.prepare(`SELECT DISTINCT r.stock_item_id id FROM recipes r JOIN menu_items m ON m.id=r.menu_item_id
        WHERE m.category_id=?`).all(categoryId).map((x)=>x.id));
      selected=allStock.filter((x)=>ids.has(x.id));scopeLabel=category.name;
    }else if(countType!=='full'){
      const ids=new Set((Array.isArray(req.body.stock_item_ids)?req.body.stock_item_ids:[]).map(Number).filter(Number.isInteger));
      selected=allStock.filter((x)=>ids.has(x.id));scopeLabel=String(req.body.scope_label||countType).trim()||countType;
    }
    if(!selected.length)return bad(res,'Choose at least one stock product to count');
    const coverage=allStock.length?selected.length/allStock.length:1;
    const reference=String(req.body.reference||`COUNT-${todayLocal()}`).trim();
    let id;
    const tx=db.transaction(()=>{
      id=db.prepare(`INSERT INTO stock_counts(reference,notes,started_by,count_type,scope_label,category_id,for_close,shift_id,
        total_stock_items,coverage_count,coverage_ratio) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(reference,req.body.notes||null,req.user.id,countType,scopeLabel,categoryId,forClose?1:0,
          retailShift?retailShift.id:null,allStock.length,selected.length,coverage).lastInsertRowid;
      const ins=db.prepare('INSERT INTO stock_count_items(stock_count_id,stock_item_id,expected) VALUES(?,?,?)');
      for(const stock of selected)ins.run(id,stock.id,stock.qty);
      if(retailShift&&forClose)db.prepare("UPDATE shifts SET status='reconciling' WHERE id=?").run(retailShift.id);
    });tx();
    audit(req.user,'stocktake.start',`${reference} · ${countType} · ${selected.length}/${allStock.length} products${forClose?' · closing count':''}`);
    broadcast('orders');broadcast('sales');
    res.json({id,reference,count_type:countType,scope_label:scopeLabel,for_close:forClose?1:0,
      coverage_count:selected.length,total_stock_items:allStock.length,coverage_ratio:coverage,ok:true});
  });

  app.get('/api/stock-counts/:id', requireAuth, (req, res) => {
    const count = db.prepare('SELECT * FROM stock_counts WHERE id=?').get(req.params.id);
    if (!count) return bad(res, 'Stocktake not found', 404);
    count.items = db.prepare(`SELECT sci.*,si.name,si.unit,si.capacity_ml FROM stock_count_items sci
      JOIN stock_items si ON si.id=sci.stock_item_id WHERE sci.stock_count_id=? ORDER BY si.name`).all(count.id);
    res.json(count);
  });

  app.post('/api/stock-counts/:id/cancel', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
    const count=db.prepare('SELECT * FROM stock_counts WHERE id=?').get(req.params.id);
    if(!count||count.status!=='open')return bad(res,'Open stocktake not found',404);
    const reason=String(req.body.reason||'').trim();
    if(reason.length<3)return bad(res,'Add a short reason for cancelling the stocktake');
    db.transaction(()=>{
      db.prepare(`UPDATE stock_counts SET status='cancelled',cancelled_by=?,cancelled_at=datetime('now','localtime'),
        cancel_reason=? WHERE id=?`).run(req.user.id,reason,count.id);
      if(count.for_close&&count.shift_id){
        const shift=db.prepare('SELECT status FROM shifts WHERE id=?').get(count.shift_id);
        if(shift&&shift.status==='reconciling')db.prepare("UPDATE shifts SET status='open' WHERE id=?").run(count.shift_id);
      }
    })();
    audit(req.user,'stocktake.cancel',`${count.reference} — ${reason}`);
    broadcast('stock');broadcast('sales');
    res.json({ok:true,status:'cancelled',shift_recovered:Boolean(count.for_close&&count.shift_id)});
  });

  app.post('/api/stock-counts/:id/save', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
    const count = db.prepare('SELECT * FROM stock_counts WHERE id=?').get(req.params.id);
    if (!count || count.status !== 'open') return bad(res, 'Open stocktake not found', 404);
    const upd = db.prepare('UPDATE stock_count_items SET counted=?,variance=?,added_qty=? WHERE stock_count_id=? AND stock_item_id=?');
    const tx = db.transaction(() => {
      for (const line of (Array.isArray(req.body.items) ? req.body.items : [])) {
        if (line.counted === '' || line.counted == null || !Number.isFinite(Number(line.counted))) continue;
        const row = db.prepare('SELECT expected FROM stock_count_items WHERE stock_count_id=? AND stock_item_id=?').get(count.id, Number(line.stock_item_id));
        const added = Number(line.added_qty) || 0;
        const counted = Math.round(Number(line.counted) * 1e6) / 1e6;
        if (row) upd.run(counted, counted - row.expected - added, added,
          count.id, Number(line.stock_item_id));
      }
    }); tx();
    audit(req.user, 'stocktake.save', count.reference);
    res.json({ ok: true });
  });

  app.post('/api/stock-counts/:id/complete', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
    const count = db.prepare('SELECT * FROM stock_counts WHERE id=?').get(req.params.id);
    if (!count || count.status !== 'open') return bad(res, 'Open stocktake not found', 404);
    const submitted = new Map((Array.isArray(req.body.items) ? req.body.items : []).map((x) => [Number(x.stock_item_id), x]));
    const rows = db.prepare('SELECT * FROM stock_count_items WHERE stock_count_id=?').all(count.id);
    const valueOf = (row) => submitted.has(row.stock_item_id) ? Number(submitted.get(row.stock_item_id).counted) : row.counted;
    if (rows.some((r) => valueOf(r) == null || !Number.isFinite(Number(valueOf(r)))))
      return bad(res, 'Enter or skip every product before completing the stocktake');
    if(!count.for_close&&rows.some((r)=>{
      const current=db.prepare('SELECT qty FROM stock_items WHERE id=?').get(r.stock_item_id);
      return !current||Math.abs(Number(current.qty)-Number(r.expected))>0.000001;
    }))return bad(res,'Stock changed while this spot/cycle count was open. Restart the count from a fresh snapshot',409);
    let totalCostVariance = 0, totalRetailVariance = 0;
    const tx = db.transaction(() => {
      for (const row of rows) {
        const counted = Math.round(Number(valueOf(row)) * 1e6) / 1e6;
        const added = submitted.has(row.stock_item_id) ? Number(submitted.get(row.stock_item_id).added_qty) || 0 : row.added_qty || 0;
        const variance = counted - row.expected - added;
        const actualStockMove = counted - row.expected;
        const stock = db.prepare('SELECT cost FROM stock_items WHERE id=?').get(row.stock_item_id) || { cost: 0 };
        const retail = db.prepare(`SELECT COALESCE(
            MAX(CASE WHEN m.stock_mode='unit' AND r.qty=1 THEN m.price END),
            MAX(CASE WHEN r.qty>0 AND m.available=1 THEN m.price/r.qty END),0) value
          FROM recipes r JOIN menu_items m ON m.id=r.menu_item_id WHERE r.stock_item_id=?`).get(row.stock_item_id);
        const costVariance = Math.round(variance * stock.cost);
        const retailVariance = Math.round(variance * (retail.value || 0));
        totalCostVariance += costVariance; totalRetailVariance += retailVariance;
        db.prepare('UPDATE stock_count_items SET counted=?,variance=?,added_qty=?,cost_variance=?,retail_variance=? WHERE id=?')
          .run(counted, variance, added, costVariance, retailVariance, row.id);
        db.prepare('UPDATE stock_items SET qty=? WHERE id=?').run(counted, row.stock_item_id);
        if (actualStockMove) stockLedger.record({ stockItemId:row.stock_item_id, delta:actualStockMove,
          movementType:'STOCKTAKE', reason:`Stocktake ${count.reference}${added ? ` · unrecorded added ${added}` : ''}`,
          userId:req.user.id, referenceType:'stock_count', referenceId:Number(count.id),
          referenceCode:count.reference, alreadyApplied:true });
      }
      db.prepare(`UPDATE stock_counts SET status='completed',completed_by=?,completed_at=datetime('now','localtime'),
        cost_variance=?,retail_variance=? WHERE id=?`).run(req.user.id, totalCostVariance, totalRetailVariance, count.id);
    }); tx();
    const completedRows = db.prepare('SELECT * FROM stock_count_items WHERE stock_count_id=?').all(count.id);
    const variances = completedRows.filter((r) => Math.abs(Number(r.variance) || 0) > 0.000001).length;
    audit(req.user, 'stocktake.complete', `${count.reference} · ${count.count_type} · ${count.coverage_count}/${count.total_stock_items} products · ${variances} variances · cost KSh${(totalCostVariance / 100).toFixed(2)} · retail KSh${(totalRetailVariance / 100).toFixed(2)}`);
    broadcast('stock');
    res.json({ ok: true, variances, cost_variance: totalCostVariance, retail_variance: totalRetailVariance,
      count_type:count.count_type,scope_label:count.scope_label,for_close:count.for_close,
      coverage_count:count.coverage_count,total_stock_items:count.total_stock_items,coverage_ratio:count.coverage_ratio });
  });
};

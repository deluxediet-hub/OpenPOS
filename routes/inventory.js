'use strict';

/** Stock listing, protected master-data changes and owner adjustments. */
module.exports = function register(app, {
  db, requireAuth, requireRole, stockLedger, audit, broadcast, bad
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

  app.get('/api/stock-packages', requireAuth, (req, res) => {
    const activeOnly=req.query.all!=='1';
    res.json(db.prepare(`SELECT p.*,s.name stock_name,s.unit base_unit FROM stock_packages p
      JOIN stock_items s ON s.id=p.stock_item_id ${activeOnly?'WHERE p.active=1':''}
      ORDER BY s.name,p.units_per_package,p.name`).all());
  });

  app.post('/api/stock-packages', requireAuth, requireRole('manager','admin'), (req,res)=>{
    const b=req.body||{},stock=db.prepare('SELECT * FROM stock_items WHERE id=?').get(Number(b.stock_item_id));
    const units=Number(b.units_per_package),name=String(b.name||'').trim();
    const sku=String(b.sku||'').trim()||null,barcode=String(b.barcode||'').trim()||null;
    if(!stock)return bad(res,'Stock item not found',404);
    if(!name||!Number.isFinite(units)||units<=0)return bad(res,'Package name and a positive conversion are required');
    if(sku&&(db.prepare('SELECT id FROM menu_items WHERE sku=?').get(sku)||db.prepare('SELECT id FROM stock_packages WHERE sku=?').get(sku)))return bad(res,'SKU is already in use');
    if(barcode&&(db.prepare('SELECT id FROM menu_items WHERE barcode=?').get(barcode)||db.prepare('SELECT id FROM stock_packages WHERE barcode=?').get(barcode)))return bad(res,'Barcode is already in use');
    const result=db.prepare(`INSERT INTO stock_packages(stock_item_id,name,units_per_package,sku,barcode,purchase_cost,sale_price,saleable)
      VALUES(?,?,?,?,?,?,?,?)`).run(stock.id,name,units,sku,barcode,Math.round(Number(b.purchase_cost||0)*100),
      Math.round(Number(b.sale_price||0)*100),b.saleable?1:0);
    audit(req.user,'stock.package.create',`${stock.name} · ${name} = ${units} ${stock.unit}`);
    broadcast('stock');
    res.json(db.prepare('SELECT * FROM stock_packages WHERE id=?').get(result.lastInsertRowid));
  });

  app.put('/api/stock-packages/:id', requireAuth, requireRole('manager','admin'), (req,res)=>{
    const cur=db.prepare('SELECT * FROM stock_packages WHERE id=?').get(req.params.id);
    if(!cur)return bad(res,'Package not found',404);
    const b=req.body||{},units=b.units_per_package==null?cur.units_per_package:Number(b.units_per_package);
    const sku=b.sku===undefined?cur.sku:(String(b.sku||'').trim()||null);
    const barcode=b.barcode===undefined?cur.barcode:(String(b.barcode||'').trim()||null);
    if(!String(b.name??cur.name).trim()||!Number.isFinite(units)||units<=0)return bad(res,'Package name and a positive conversion are required');
    if(sku&&(db.prepare('SELECT id FROM menu_items WHERE sku=?').get(sku)||db.prepare('SELECT id FROM stock_packages WHERE sku=? AND id!=?').get(sku,cur.id)))return bad(res,'SKU is already in use');
    if(barcode&&(db.prepare('SELECT id FROM menu_items WHERE barcode=?').get(barcode)||db.prepare('SELECT id FROM stock_packages WHERE barcode=? AND id!=?').get(barcode,cur.id)))return bad(res,'Barcode is already in use');
    db.prepare(`UPDATE stock_packages SET name=?,units_per_package=?,sku=?,barcode=?,purchase_cost=?,sale_price=?,saleable=?,active=? WHERE id=?`)
      .run(String(b.name??cur.name).trim(),units,sku,barcode,
        b.purchase_cost==null?cur.purchase_cost:Math.round(Number(b.purchase_cost||0)*100),
        b.sale_price==null?cur.sale_price:Math.round(Number(b.sale_price||0)*100),
        b.saleable==null?cur.saleable:(b.saleable?1:0),b.active==null?cur.active:(b.active?1:0),cur.id);
    audit(req.user,'stock.package.update',`${cur.name} #${cur.id}`);
    broadcast('stock');
    res.json(db.prepare('SELECT * FROM stock_packages WHERE id=?').get(cur.id));
  });

  app.post('/api/stock', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const { name, unit = 'pcs', qty = 0, min_qty = 0, cost = 0 } = req.body;
    if (!name) return bad(res, 'Name required');
    const initial=Number(qty)||0,costCents=Math.round(Number(cost)*100);
    const r = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost) VALUES(?,?,?,?,?)')
      .run(name.trim(), unit, initial, Number(min_qty) || 0, costCents);
    if(initial)stockLedger.record({stockItemId:Number(r.lastInsertRowid),delta:initial,movementType:'OPENING_STOCK',
      reason:'Opening stock',userId:req.user.id,referenceType:'stock_item',referenceId:Number(r.lastInsertRowid),
      unitCost:costCents,alreadyApplied:true});
    res.json(db.prepare('SELECT * FROM stock_items WHERE id=?').get(r.lastInsertRowid));
  });

  app.put('/api/stock/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const s = db.prepare('SELECT * FROM stock_items WHERE id=?').get(req.params.id);
    if (!s) return bad(res, 'Not found', 404);
    const nextQty=req.body.qty==null?s.qty:Number(req.body.qty);
    if(!Number.isFinite(nextQty))return bad(res,'Stock quantity must be a valid number');
    db.prepare('UPDATE stock_items SET name=?, unit=?, qty=?, min_qty=?, cost=? WHERE id=?')
      .run(req.body.name ?? s.name, req.body.unit ?? s.unit, nextQty,
        req.body.min_qty ?? s.min_qty, req.body.cost != null ? Math.round(Number(req.body.cost) * 100) : s.cost, s.id);
    const delta=Math.round((nextQty-s.qty)*1e6)/1e6;
    if(delta)stockLedger.record({stockItemId:s.id,delta,movementType:'ADJUSTMENT',reason:'Stock controls edit',
      userId:req.user.id,referenceType:'stock_item',referenceId:s.id,alreadyApplied:true});
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
    const requestedType=String(req.body.movement_type||'ADJUSTMENT').toUpperCase();
    const allowedTypes=['ADJUSTMENT','BREAKAGE','SPOILAGE','SUPPLIER_RETURN','TRANSFER_IN','TRANSFER_OUT'];
    if(!allowedTypes.includes(requestedType))return bad(res,'Invalid stock adjustment type');
    const movement=stockLedger.record({ stockItemId:s.id, delta, movementType:requestedType, reason,
      userId:req.user.id, referenceType:'adjustment', referenceCode:String(req.body.reference||'').trim()||null });
    audit(req.user, 'stock.adjust', `${requestedType} · ${s.name} ${delta > 0 ? '+' : ''}${delta} · ${movement.before} → ${movement.after} — ${reason}`);
    res.json(db.prepare('SELECT * FROM stock_items WHERE id=?').get(s.id));
  });
};

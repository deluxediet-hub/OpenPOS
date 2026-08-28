'use strict';

/** Product/category routes; existing stock/recipe creation transactions are preserved. */
module.exports = function register(app, {
  db, requireAuth, requireRole, getSetting, importRetailCsv, listMenu, stockLedger, audit, broadcast, bad
}) {
  /* ------------------------------- catalogue ------------------------------ */
  app.get('/api/menu', requireAuth, (req, res) => res.json(listMenu()));

  app.post('/api/products/import', requireAuth, requireRole('admin'), (req, res) => {
    if (getSetting('business_type') !== 'wines_spirits') return bad(res, 'CSV retail import is available in wines & spirits mode only');
    try {
      const result = importRetailCsv(req.body.csv, req.user.id);
      audit(req.user, 'products.csv_import', `${result.imported} products`);
      broadcast('menu'); broadcast('stock');
      res.json({ ok: true, ...result });
    } catch (e) { return bad(res, e.message); }
  });

  app.post('/api/menu-items', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const { name, category_id, price, cost = 0, station = 'bar', available = 1,
      sku = '', barcode = '', volume_ml = null, kra_item_code = '', tax_type = 'B',
      opening_qty = 0, min_qty = 0, unit = 'bottle', stock_mode = 'unit',
      source_stock_item_id = null, serving_ml = null, source_volume_ml = null } = req.body;
    if (!name || !category_id) return bad(res, 'Name and category required');
    const retail = getSetting('business_type') === 'wines_spirits';
    const effectiveStation = retail ? 'retail' : station;
    const mode = retail && stock_mode === 'pour' ? 'pour' : (retail && stock_mode === 'weighed' ? 'weighed' : 'unit');
    let sourceStock = null, deduction = 1;
    if (mode === 'pour') {
      sourceStock = db.prepare('SELECT * FROM stock_items WHERE id=?').get(Number(source_stock_item_id));
      const serving = Number(serving_ml || volume_ml), container = Number(source_volume_ml);
      if (!sourceStock) return bad(res, 'Choose the bottle or keg stock used for this pour');
      if (!(serving > 0) || !(container >= serving)) return bad(res, 'Serving and source container sizes are required');
      deduction = sourceStock.deduction_mode === 'count' ? serving / 1000 : serving / container;
    }
    if (barcode && db.prepare('SELECT id FROM menu_items WHERE barcode=?').get(String(barcode).trim())) return bad(res, 'Barcode already belongs to another product');
    if (sku && db.prepare('SELECT id FROM menu_items WHERE sku=?').get(String(sku).trim())) return bad(res, 'SKU already belongs to another product');
    let itemId;
    const tx = db.transaction(() => {
      const enteredCost = Math.round(Number(cost) * 100);
      const effectiveCost = mode === 'pour' && !enteredCost ? Math.round(sourceStock.cost * deduction) : enteredCost;
      itemId = db.prepare(`INSERT INTO menu_items(category_id,name,price,cost,station,available,sort_order,sku,barcode,volume_ml,stock_mode,serving_ml,sale_unit,kra_item_code,tax_type)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(category_id, name.trim(), Math.round(Number(price) * 100),
        effectiveCost, effectiveStation, available ? 1 : 0, 999, String(sku).trim() || null,
        String(barcode).trim() || null, Number(volume_ml) || null, mode, mode === 'pour' ? Number(serving_ml || volume_ml) : null,
        unit || (mode === 'pour' ? 'shot' : 'piece'), String(kra_item_code).trim() || null, tax_type || 'B').lastInsertRowid;
      if (retail && mode === 'pour') {
        db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,?)').run(itemId, sourceStock.id, deduction);
      } else if (retail) {
        const opening = Number(opening_qty) || 0;
        const stockUnit = mode === 'weighed' ? 'kg' : (unit || 'bottle');
        const deductionMode = mode === 'weighed' ? 'count' : 'auto';
        const capacity = mode === 'weighed' ? 1000 : (Number(volume_ml) || null);
        const stockId = db.prepare('INSERT INTO stock_items(name,unit,qty,min_qty,cost,deduction_mode,capacity_ml) VALUES(?,?,?,?,?,?,?)')
          .run(name.trim(), stockUnit, opening, Number(min_qty) || 0, effectiveCost, deductionMode, capacity).lastInsertRowid;
        db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,1)').run(itemId, stockId);
        if (opening) stockLedger.record({ stockItemId: stockId, delta: opening,
          movementType: 'OPENING_STOCK', reason: 'Opening stock', userId: req.user.id,
          referenceType: 'menu_item', referenceId: itemId, referenceCode: String(sku || '').trim() || null,
          unitCost: effectiveCost, alreadyApplied: true });
      }
    });
    try { tx(); } catch (e) { return bad(res, e.message); }
    audit(req.user, 'product.create', `${name} @ KSh${Number(price).toFixed(2)} sku=${sku || '-'} barcode=${barcode || '-'}`);
    broadcast('menu'); broadcast('stock');
    res.json(listMenu().find((m) => m.id === Number(itemId)));
  });

  app.put('/api/menu-items/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(req.params.id);
    if (!cur) return bad(res, 'Not found', 404);
    const b = req.body, barcode = b.barcode !== undefined ? String(b.barcode).trim() : cur.barcode,
      sku = b.sku !== undefined ? String(b.sku).trim() : cur.sku;
    if (barcode && db.prepare('SELECT id FROM menu_items WHERE barcode=? AND id!=?').get(barcode, cur.id)) return bad(res, 'Barcode already belongs to another product');
    if (sku && db.prepare('SELECT id FROM menu_items WHERE sku=? AND id!=?').get(sku, cur.id)) return bad(res, 'SKU already belongs to another product');
    const retail = getSetting('business_type') === 'wines_spirits';
    const effectiveStation = retail ? 'retail' : (b.station ?? cur.station);
    const mode = cur.stock_mode || 'unit';
    let pourSource = null, pourDeduction = null;
    if (retail && mode === 'pour') {
      const currentRecipe = db.prepare('SELECT * FROM recipes WHERE menu_item_id=? ORDER BY id LIMIT 1').get(cur.id);
      pourSource = db.prepare('SELECT * FROM stock_items WHERE id=?').get(Number(b.source_stock_item_id) || (currentRecipe || {}).stock_item_id);
      const serving = Number(b.serving_ml || b.volume_ml || cur.serving_ml || cur.volume_ml);
      const inferredContainer = currentRecipe && currentRecipe.qty ? serving / currentRecipe.qty : 0;
      const container = Number(b.source_volume_ml) || inferredContainer;
      if (!pourSource || !(serving > 0) || !(container >= serving)) return bad(res, 'Valid pour source and sizes are required');
      pourDeduction = pourSource.deduction_mode === 'count' ? serving / 1000 : serving / container;
    }
    const tx = db.transaction(() => {
      db.prepare(`UPDATE menu_items SET category_id=?,name=?,price=?,cost=?,station=?,available=?,sku=?,barcode=?,volume_ml=?,stock_mode=?,serving_ml=?,sale_unit=?,kra_item_code=?,tax_type=? WHERE id=?`)
        .run(b.category_id ?? cur.category_id, b.name ?? cur.name,
          b.price != null ? Math.round(Number(b.price) * 100) : cur.price,
          b.cost != null ? Math.round(Number(b.cost) * 100) : cur.cost,
          effectiveStation, b.available != null ? (b.available ? 1 : 0) : cur.available,
          sku || null, barcode || null, b.volume_ml !== undefined ? (Number(b.volume_ml) || null) : cur.volume_ml,
          mode, mode === 'pour' ? Number(b.serving_ml || b.volume_ml || cur.serving_ml || cur.volume_ml) : null,
          b.unit || cur.sale_unit || 'piece',
          b.kra_item_code !== undefined ? (String(b.kra_item_code).trim() || null) : cur.kra_item_code,
          b.tax_type ?? cur.tax_type, cur.id);
      const stock = db.prepare(`SELECT si.* FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id WHERE r.menu_item_id=? ORDER BY r.id LIMIT 1`).get(cur.id);
      if (retail && mode === 'pour') {
        db.prepare('DELETE FROM recipes WHERE menu_item_id=?').run(cur.id);
        db.prepare('INSERT INTO recipes(menu_item_id,stock_item_id,qty) VALUES(?,?,?)').run(cur.id, pourSource.id, pourDeduction);
      } else if (stock && retail) {
        const sourceCost = b.cost != null ? Math.round(Number(b.cost) * 100) : cur.cost;
        db.prepare('UPDATE stock_items SET name=?,cost=?,min_qty=COALESCE(?,min_qty),unit=COALESCE(?,unit),capacity_ml=COALESCE(?,capacity_ml) WHERE id=?')
          .run(b.name ?? cur.name, sourceCost, b.min_qty !== undefined ? Number(b.min_qty) : null, b.unit || null,
            mode === 'weighed' ? 1000 : (b.volume_ml !== undefined ? Number(b.volume_ml) || null : null), stock.id);
        if (b.cost != null) db.prepare(`UPDATE menu_items SET cost=ROUND(? *
          (SELECT r.qty FROM recipes r WHERE r.menu_item_id=menu_items.id AND r.stock_item_id=?))
          WHERE stock_mode='pour' AND id IN (SELECT menu_item_id FROM recipes WHERE stock_item_id=?)`)
          .run(sourceCost, stock.id, stock.id);
      }
    });
    try { tx(); } catch (e) { return bad(res, e.message); }
    audit(req.user, 'product.update', `${cur.name} sku=${sku || '-'} barcode=${barcode || '-'}`);
    broadcast('menu'); broadcast('stock');
    res.json(listMenu().find((m) => m.id === cur.id));
  });

  app.delete('/api/menu-items/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(req.params.id);
    if (!cur) return bad(res, 'Not found', 404);
    if(db.prepare('SELECT id FROM order_items WHERE menu_item_id=? LIMIT 1').get(cur.id))
      return bad(res,'Sold products cannot be deleted; mark the product unavailable instead',409);
    const linkedStock = db.prepare('SELECT stock_item_id FROM recipes WHERE menu_item_id=?').all(cur.id).map((r) => r.stock_item_id);
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM menu_items WHERE id=?').run(cur.id);
      if (getSetting('business_type') === 'wines_spirits') for (const stockId of linkedStock) {
        const stillUsed = db.prepare('SELECT id FROM recipes WHERE stock_item_id=? LIMIT 1').get(stockId);
        const history = db.prepare('SELECT id FROM goods_receipt_items WHERE stock_item_id=? LIMIT 1').get(stockId);
        if (!stillUsed && !history) db.prepare('DELETE FROM stock_items WHERE id=?').run(stockId);
      }
    });
    tx();
    audit(req.user, 'product.delete', cur.name);
    broadcast('menu');
    res.json({ ok: true });
  });

  app.post('/api/categories', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const { name, station = 'kitchen' } = req.body;
    if (!name) return bad(res, 'Name required');
    const effectiveStation = getSetting('business_type') === 'wines_spirits' ? 'retail' : station;
    const r = db.prepare('INSERT INTO categories(name,station,sort_order) VALUES(?,?,?)')
      .run(name.trim(), effectiveStation, db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 s FROM categories').get().s);
    broadcast('menu');
    res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(r.lastInsertRowid));
  });
  app.put('/api/categories/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const c = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
    if (!c) return bad(res, 'Not found', 404);
    const station = getSetting('business_type') === 'wines_spirits' ? 'retail' : (req.body.station ?? c.station);
    db.prepare('UPDATE categories SET name=?, station=? WHERE id=?')
      .run(req.body.name ?? c.name, station, c.id);
    broadcast('menu');
    res.json(db.prepare('SELECT * FROM categories WHERE id=?').get(c.id));
  });
  app.delete('/api/categories/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    if(db.prepare('SELECT id FROM menu_items WHERE category_id=? LIMIT 1').get(req.params.id))
      return bad(res,'Only empty categories can be deleted; move or archive their products first',409);
    db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
    broadcast('menu');
    res.json({ ok: true });
  });
};

'use strict';

/** Order/cart lifecycle. Payment and return transaction boundaries live separately. */
module.exports = function register(app, {
  db, domain, requireAuth, requireRole, getSetting, getSettings, ensureRetailTill,
  nextOrderNumber, nowLocal, decorate, readOrder, audit, broadcast, bad
}) {
  /* -------------------------------- orders -------------------------------- */
  app.get('/api/orders', requireAuth, (req, res) => {
    const status = req.query.status;
    const rows = status
      ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY opened_at DESC').all(status)
      : db.prepare("SELECT * FROM orders WHERE status IN ('open','billed') ORDER BY opened_at DESC").all();
    res.json(rows.map(decorate));
  });

  app.get('/api/orders/:id', requireAuth, (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    res.json(decorate(o));
  });

  app.post('/api/orders', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
    if (getSetting('business_type') === 'wines_spirits' && !ensureRetailTill(req.user))
      return bad(res, req.user.role === 'seller' ? 'Open the till before starting a sale' : 'Finish the current till reconciliation before starting another sale');
    const table_id = Number(req.body.table_id) || null;
    const people = Number(req.body.people) || Number(getSettings().default_people) || 1;
    /* Order channel (Phase 4) — how the sale reached us, and what an aggregator took. */
    const CHANNELS = ['dine_in', 'takeaway', 'delivery', 'uber_eats', 'bolt_food', 'glovo', 'phone'];
    const channel = CHANNELS.includes(req.body.channel) ? req.body.channel : (table_id ? 'dine_in' : 'takeaway');
    const commission = Math.max(0, Math.round(Number(req.body.commission || 0) * 100));
    if (table_id) {
      const busy = db.prepare("SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed')").get(table_id);
      if (busy) return bad(res, 'Table already has an open order');
    }
    const r = db.prepare('INSERT INTO orders(number,table_id,waiter_id,people,notes,channel,commission,tab_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(nextOrderNumber(), table_id, req.user.id, people, req.body.notes || null, channel, commission,
        req.body.tab_id || null);
    const o = decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid));
    audit(req.user, 'order.open', `#${o.number}${channel !== 'dine_in' ? ' (' + channel + ')' : ''}`);
    broadcast('orders'); broadcast('kitchen'); broadcast('tables');
    res.json(o);
  });

  app.post('/api/orders/:id/items', requireAuth, requireRole('seller', 'waiter', 'cashier', 'bartender', 'manager', 'admin'), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    if (o.status === 'closed' || o.status === 'void') return bad(res, 'Order is closed');
    const lines = Array.isArray(req.body.items) ? req.body.items : [req.body];
    /* Happy hour / daypart pricing is resolved once, at the moment of sale, and the
       resulting price is frozen onto the line so later rule edits can't rewrite history. */
    const dayparts = db.prepare('SELECT * FROM dayparts WHERE active = 1').all();
    const groups = db.prepare('SELECT * FROM modifier_groups').all();
    const options = db.prepare('SELECT * FROM modifier_options').all();
    const ins = db.prepare(`INSERT INTO order_items(order_id,menu_item_id,name,price,qty,note,station,added_by,modifiers,
      stock_factor,cost_snapshot,package_id,package_name,units_per_package)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const l of lines) {
        const m = db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(l.menu_item_id));
        if (!m) throw new Error('Menu item not found');
        if (!m.available && !['manager', 'admin'].includes(req.user.role)) throw new Error(`${m.name} is unavailable`);
        const requestedQty = Number(l.qty) || 1;
        if (getSetting('business_type') === 'wines_spirits' && (!Number.isInteger(requestedQty) || requestedQty <= 0))
          throw new Error('Retail sale quantity must be a positive whole number');
        const fullMl = Number(m.volume_ml) || 0;
        const measureMl = Number(l.measure_ml) || 0;
        const packageRow=l.package_id?db.prepare('SELECT * FROM stock_packages WHERE id=? AND active=1').get(Number(l.package_id)):null;
        if(l.package_id&&!packageRow)throw new Error('Sale package was not found');
        if(packageRow&&!packageRow.saleable)throw new Error(`${packageRow.name} is not enabled for sale`);
        if(packageRow&&measureMl)throw new Error('Choose either a measured amount or a sealed package');
        if(packageRow){
          const source=db.prepare('SELECT stock_item_id FROM recipes WHERE menu_item_id=? ORDER BY id LIMIT 1').get(m.id);
          if(!source||source.stock_item_id!==packageRow.stock_item_id)throw new Error('Package does not belong to this product stock');
        }
        if (measureMl && (!(fullMl > 0) || measureMl <= 0 || measureMl > fullMl))
          throw new Error('Measured sale must be greater than zero and no larger than the product size');
        const priceFactor = measureMl ? measureMl / fullMl : 1;
        const stockFactor = packageRow ? Number(packageRow.units_per_package)
          : measureMl ? (m.stock_mode === 'weighed' ? measureMl / 1000 : priceFactor) : 1;
        if (getSetting('business_type') === 'wines_spirits' && getSetting('prevent_negative_stock') === '1') {
          const tracked = db.prepare(`SELECT si.qty,r.qty deduction FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
            WHERE r.menu_item_id=? ORDER BY r.id LIMIT 1`).get(m.id);
          const already = db.prepare(`SELECT COALESCE(SUM(qty*stock_factor),0) q FROM order_items
            WHERE order_id=? AND menu_item_id=? AND status!='void'`).get(o.id, m.id).q;
          if (tracked && (already + requestedQty * stockFactor) * tracked.deduction > tracked.qty) {
            const servings = Math.floor(tracked.qty / (tracked.deduction * stockFactor));
            throw new Error(`${m.name}: only ${servings} measured sale unit(s) available`);
          }
        }

        /* base price, less any active daypart discount */
        const rule = domain.bestDiscountFor(m, dayparts);
        let price = rule ? domain.discountedPrice(m.price, rule.discount_pct) : m.price;
        if(packageRow)price=packageRow.sale_price>0?packageRow.sale_price:Math.round(price*packageRow.units_per_package);
        else if (priceFactor !== 1) price = Math.round(price * priceFactor);
        const effectiveName = packageRow ? `${m.name} — ${packageRow.name}`
          : measureMl ? `${m.name} — ${Number(measureMl.toFixed(2))}ml` : m.name;
        const chosen = [];

        /* modifiers: validate every one against the menu item's allowed groups */
        if (Array.isArray(l.modifiers) && l.modifiers.length) {
          const allowed = db.prepare('SELECT group_id FROM menu_item_modifiers WHERE menu_item_id=?').all(m.id)
            .map((g) => g.group_id);
          for (const mod of l.modifiers) {
            const opt = options.find((x) => x.id === Number(mod.id));
            if (!opt) throw new Error('Unknown modifier');
            if (!allowed.includes(opt.group_id)) throw new Error(`"${opt.name}" is not available on ${m.name}`);
            chosen.push({ id: opt.id, group_id: opt.group_id, name: opt.name, price: opt.price });
            price += opt.price;
          }
          /* enforce required groups */
          const requiredGroups = groups.filter((g) => g.required && allowed.includes(g.id));
          for (const g of requiredGroups) {
            if (!chosen.some((c) => c.group_id === g.id)) throw new Error(`Please choose: ${g.name}`);
          }
        } else {
          const requiredGroups = db.prepare(`SELECT g.* FROM modifier_groups g
            JOIN menu_item_modifiers mm ON mm.group_id = g.id
            WHERE mm.menu_item_id = ? AND g.required = 1`).all(m.id);
          if (requiredGroups.length) throw new Error(`Please choose: ${requiredGroups[0].name}`);
        }

        const qty = Number(l.qty) || 1;
        const modifierJson = chosen.length ? JSON.stringify(chosen.sort((a, b) => a.id - b.id)) : null;
        /* Retail baskets consolidate identical products instead of creating repeated rows. */
        const existing = getSetting('business_type') === 'wines_spirits' ? db.prepare(`SELECT id FROM order_items
          WHERE order_id=? AND menu_item_id=? AND name=? AND price=? AND stock_factor=? AND status='pending'
            AND COALESCE(note,'')=COALESCE(?,'') AND COALESCE(modifiers,'')=COALESCE(?,'')
          ORDER BY id LIMIT 1`).get(o.id, m.id, effectiveName, price, stockFactor, l.note || null, modifierJson) : null;
        if (existing) db.prepare('UPDATE order_items SET qty=qty+? WHERE id=?').run(qty, existing.id);
        else ins.run(o.id, m.id, effectiveName, price, qty, l.note || null, m.station, req.user.id,
          modifierJson, stockFactor, Math.round(m.cost * stockFactor),packageRow?packageRow.id:null,
          packageRow?packageRow.name:null,packageRow?packageRow.units_per_package:1);
      }
    });
    try { tx(); } catch (e) { return bad(res, e.message); }
    audit(req.user, 'order.add_items', `#${o.number} x${lines.length}`);
    broadcast('orders'); broadcast('kitchen');
    res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
  });

  app.patch('/api/orders/:id/items/:itemId/quantity', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    const item = db.prepare('SELECT * FROM order_items WHERE order_id=? AND id=?').get(req.params.id, req.params.itemId);
    if (!order || !item) return bad(res, 'Sale item not found', 404);
    if (!['open', 'billed'].includes(order.status) || item.status !== 'pending') return bad(res, 'Only pending sale items can change quantity');
    const qty = Number(req.body.qty);
    if (!(qty > 0)) return bad(res, 'Quantity must be greater than zero');
    if (getSetting('business_type') === 'wines_spirits' && !Number.isInteger(qty))
      return bad(res, 'Retail sale quantity must be a whole number');
    if (getSetting('business_type') === 'wines_spirits' && getSetting('prevent_negative_stock') === '1') {
      const tracked = db.prepare(`SELECT si.qty,r.qty deduction FROM recipes r JOIN stock_items si ON si.id=r.stock_item_id
        WHERE r.menu_item_id=? ORDER BY r.id LIMIT 1`).get(item.menu_item_id);
      const factor = Number(item.stock_factor) || 1;
      if (tracked && qty * factor * tracked.deduction > tracked.qty)
        return bad(res, `Only ${Math.floor(tracked.qty / (tracked.deduction * factor))} sale unit(s) available`);
    }
    db.prepare('UPDATE order_items SET qty=? WHERE id=?').run(qty, item.id);
    audit(req.user, 'order.quantity', `#${order.number} ${item.name} x${qty}`);
    broadcast('orders');
    res.json(decorate(readOrder(order.id)));
  });

  app.patch('/api/orders/:id/items/:itemId', requireAuth, requireRole('kitchen','bartender','manager','admin'), (req, res) => {
    const it = db.prepare('SELECT * FROM order_items WHERE order_id=? AND id=?').get(req.params.id, req.params.itemId);
    if (!it) return bad(res, 'Item not found', 404);
    const to = req.body.status;
    if (!['ready','void'].includes(to)) return bad(res, 'This endpoint only permits ready or void transitions');
    if (to === 'ready' && !['kitchen', 'bartender', 'manager', 'admin'].includes(req.user.role))
      return bad(res, 'Only kitchen/bar can mark ready', 403);
    /* Station isolation: the kitchen readies kitchen lines, the bar readies bar lines. */
    if (to === 'ready') {
      if (req.user.role === 'kitchen' && it.station !== 'kitchen')
        return bad(res, 'Kitchen can only ready kitchen items', 403);
      if (req.user.role === 'bartender' && it.station !== 'bar')
        return bad(res, 'Bar can only ready bar items', 403);
    }
    if (to === 'void' && !['manager', 'admin'].includes(req.user.role))
      return bad(res, 'Only a manager can void an item', 403);
    const sent = to === 'sent' ? nowLocal() : it.sent_at;
    db.prepare('UPDATE order_items SET status=?, sent_at=?, void_reason=? WHERE id=?')
      .run(to, sent, to === 'void' ? (req.body.reason || null) : null, it.id);
    if (to === 'void') audit(req.user, 'item.void', `#${req.params.id} ${it.name} — ${req.body.reason || ''}`);
    broadcast('orders'); broadcast('kitchen');
    res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id)));
  });

  app.delete('/api/orders/:id/items/:itemId', requireAuth, requireRole('seller','waiter','cashier','manager','admin'), (req, res) => {
    const it = db.prepare('SELECT * FROM order_items WHERE order_id=? AND id=?').get(req.params.id, req.params.itemId);
    if (!it) return bad(res, 'Item not found', 404);
    if (it.status !== 'pending' && !['manager', 'admin'].includes(req.user.role))
      return bad(res, 'Item already sent — ask a manager to void it', 403);
    if (it.status === 'pending') db.prepare('DELETE FROM order_items WHERE id=?').run(it.id);
    else {
      db.prepare("UPDATE order_items SET status='void', void_reason=? WHERE id=?")
        .run(req.body?.reason || 'Manager removal', it.id);
      audit(req.user, 'item.void', `${it.name} on #${req.params.id}`);
    }
    broadcast('orders'); broadcast('kitchen');
    res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id)));
  });

  // Send all pending lines to their station (fire ticket)
  app.post('/api/orders/:id/send', requireAuth, requireRole('seller', 'waiter', 'cashier', 'bartender', 'manager', 'admin'), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    const now = nowLocal();
    const n = db.prepare("UPDATE order_items SET status='sent', sent_at=? WHERE order_id=? AND status='pending'")
      .run(now, o.id).changes;
    if (!n) return bad(res, 'Nothing pending to send');
    audit(req.user, 'order.send', `#${o.number} (${n} lines)`);
    broadcast('orders'); broadcast('kitchen');
    res.json(decorate(readOrder(o.id)));
  });

  app.patch('/api/orders/:id/people', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    if (!['open', 'billed'].includes(o.status) || o.closed_out) return bad(res, 'Closed or void sales cannot be changed', 409);
    const people = Math.max(1, Math.min(200, Math.round(Number(req.body.people) || 1)));
    db.prepare('UPDATE orders SET people=? WHERE id=?').run(people, o.id);
    audit(req.user, 'order.people', `#${o.number} → ${people} guests`);
    broadcast('orders');
    res.json(decorate(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
  });

  app.post('/api/orders/:id/discount', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    if (!['open', 'billed'].includes(o.status) || o.closed_out)
      return bad(res, 'Closed or void sales cannot be discounted; use a return instead', 409);
    if (db.prepare("SELECT id FROM payments WHERE order_id=? AND kind='sale' LIMIT 1").get(o.id))
      return bad(res, 'Discounts cannot change after payment has started', 409);
    const requested = Number(req.body.amount);
    if (!Number.isFinite(requested) || requested < 0) return bad(res, 'Discount must be a valid non-negative amount');
    const amount = Math.round(requested * 100);
    const subtotal = db.prepare("SELECT COALESCE(SUM(price*qty),0) v FROM order_items WHERE order_id=? AND status!='void'").get(o.id).v;
    if (amount > subtotal) return bad(res, 'Discount cannot exceed the sale subtotal');
    db.prepare('UPDATE orders SET discount=?, discount_reason=? WHERE id=?')
      .run(amount, req.body.reason || null, o.id);
    audit(req.user, 'order.discount', `#${o.number} KSh${(amount / 100).toFixed(2)} — ${req.body.reason || ''}`);
    broadcast('orders');
    res.json(decorate(readOrder(o.id)));
  });

  app.post('/api/orders/:id/transfer', requireAuth, requireRole('seller', 'waiter', 'cashier', 'manager', 'admin'), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    const t = db.prepare('SELECT * FROM tables WHERE id=?').get(Number(req.body.table_id));
    if (!o || !t) return bad(res, 'Order or table not found', 404);
    if (!['open', 'billed'].includes(o.status) || o.closed_out) return bad(res, 'Closed or void sales cannot be transferred', 409);
    const busy = db.prepare("SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed') AND id != ?").get(t.id, o.id);
    if (busy) return bad(res, 'Destination table is occupied');
    db.prepare('UPDATE orders SET table_id=? WHERE id=?').run(t.id, o.id);
    audit(req.user, 'order.transfer', `#${o.number} -> ${t.name}`);
    broadcast('orders'); broadcast('tables');
    res.json(decorate(readOrder(o.id)));
  });

  app.post('/api/orders/:id/void', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    if (o.status === 'closed') return bad(res, 'Paid orders must be refunded, not voided');
    db.prepare("UPDATE order_items SET status='void', void_reason=? WHERE order_id=? AND status != 'void'")
      .run('Order voided', o.id);
    db.prepare("UPDATE orders SET status='void', closed_at=datetime('now','localtime'), closed_by=? WHERE id=?")
      .run(req.user.id, o.id);
    audit(req.user, 'order.void', `#${o.number} — ${req.body.reason || ''}`);
    broadcast('orders'); broadcast('kitchen'); broadcast('tables');
    res.json({ ok: true });
  });
};

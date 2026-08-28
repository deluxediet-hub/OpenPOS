'use strict';

/** Payment endpoint boundary. Existing request/response contracts and the single
 * SQLite transaction are intentionally preserved. */
module.exports = function registerPayments(app, {
  db, domain, requireAuth, requireRole, getSettings, ensureRetailTill,
  decorate, readOrder, computeTotals, closeOut, audit, broadcast, bad
}) {
  app.post('/api/orders/:id/pay', requireAuth, requireRole('seller', 'cashier', 'manager', 'admin'), (req, res) => {
    const idempotencyKey = String(req.body.idempotency_key || '').trim().slice(0, 100) || null;
    if (idempotencyKey) {
      const prior = db.prepare('SELECT * FROM payments WHERE idempotency_key=?').get(idempotencyKey);
      if (prior) {
        if (prior.order_id !== Number(req.params.id)) return bad(res, 'Payment key belongs to another sale', 409);
        const priorOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(prior.order_id);
        return res.json({ idempotent_replay: true, change: prior.change_given || 0, tendered: prior.tendered,
          paid: decorate(priorOrder).paid, order: decorate(priorOrder) });
      }
    }
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    if (!['open', 'billed'].includes(o.status) || o.closed_out) return bad(res, 'Sale is already closed or void', 409);
    const d = decorate(o);
    const s = getSettings();
    if (s.business_type === 'wines_spirits' && !ensureRetailTill(req.user))
      return bad(res, req.user.role === 'seller' ? 'The till is closed. Open it before taking payment.' : 'Finish the current till reconciliation before taking payment.');
    const method = req.body.method;
    const METHODS = ['cash', 'card', 'mpesa', 'giftcard', 'points'];
    if (!METHODS.includes(method)) return bad(res, 'Unknown payment method');
    const tip = Math.max(0, Math.round(Number(req.body.tip || 0) * 100));
    const amount = Math.round(Number(req.body.amount) * 100);
    if (!amount || amount <= 0) return bad(res, 'Amount must be greater than zero');
    const balance = d.totals.grand_total + tip - d.paid;
    if (method === 'mpesa' && !String(req.body.reference || '').trim())
      return bad(res, 'M-Pesa confirmation code is required');
    if (method === 'mpesa' && db.prepare("SELECT id FROM payments WHERE method='mpesa' AND upper(reference)=upper(?)").get(String(req.body.reference).trim()))
      return bad(res, 'That M-Pesa confirmation code has already been used');
    if (amount > balance)
      return bad(res, `Payment exceeds the balance due by ${((amount - balance) / 100).toFixed(2)}`);

    /* Cash: the amount tendered is what actually lands in the drawer, so the server
       must see it — the client alone cannot be trusted to work out the change. */
    let tendered = null, change = 0, reference = req.body.reference || null;
    if (method === 'cash') {
      if (req.body.tendered == null || isNaN(Number(req.body.tendered)))
        return bad(res, 'Cash tender amount is required');
      tendered = Math.round(Number(req.body.tendered) * 100);
      if (tendered < amount)
        return bad(res, `Short by ${((amount - tendered) / 100).toFixed(2)} — cannot settle in cash`);
      change = tendered - amount;
      reference = `Tendered ${(tendered / 100).toFixed(2)} · Change ${(change / 100).toFixed(2)}`;
    }

    /* Gift card: validate the code and that it holds enough value */
    let card = null;
    if (method === 'giftcard') {
      const code = String(req.body.reference || '').trim().toUpperCase();
      card = db.prepare('SELECT * FROM gift_cards WHERE code=?').get(code);
      if (!card) return bad(res, 'No gift card with that code');
      if (s.business_type === 'wines_spirits' && !card.funding_id) return bad(res, 'Gift card is not backed by a recorded funding payment');
      if (card.status !== 'active') return bad(res, `Gift card is ${card.status}`);
      if (card.balance < amount) return bad(res, `Gift card holds only ${(card.balance / 100).toFixed(2)}`);
      reference = `Gift card ${card.code}`;
    }

    /* Loyalty: a customer can be attached on ANY tender — earning points on a cash
       or card bill matters just as much as redeeming them. */
    let customer = null, pointsSpent = 0;
    const requestedCustomer = Number(req.body.customer_id) || null;
    if (requestedCustomer) {
      customer = db.prepare('SELECT * FROM customers WHERE id=?').get(requestedCustomer);
      if (!customer) return bad(res, 'Customer not found');
    }
    if (method === 'points') {
      if (!customer) return bad(res, 'A customer is required to redeem points');
      const perPoint = Number(s.loyalty_redeem_per) || 0;
      if (!perPoint) return bad(res, 'Point redemption value is not configured');
      pointsSpent = amount / (perPoint * 100);
      if (pointsSpent % 1 !== 0) return bad(res, 'Redemption must be a whole number of points');
      if (pointsSpent > customer.points) return bad(res, `Customer only has ${customer.points} points`);
      reference = `${pointsSpent} points redeemed`;
    }

    const openShift = db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    if (s.business_type === 'wines_spirits' && s.prevent_negative_stock === '1' && d.paid + amount >= d.totals.grand_total + tip) {
      const movements = domain.stockMovementsFor(d.items.map((i) => ({ ...i, qty: i.qty * (i.stock_factor || 1) })),
        db.prepare('SELECT * FROM recipes').all());
      for (const movement of movements) {
        const stock = db.prepare('SELECT name,qty FROM stock_items WHERE id=?').get(movement.stock_item_id);
        if (stock && stock.qty < movement.qty) return bad(res, `${stock.name}: only ${stock.qty} in stock; recount before payment`);
      }
    }

    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO payments(order_id,method,amount,reference,tip,cashier_id,shift_id,kind,idempotency_key,tendered,change_given)
        VALUES(?,?,?,?,?,?,?,'sale',?,?,?)`).run(o.id, method, amount, reference, tip, req.user.id,
        openShift ? openShift.id : null, idempotencyKey, tendered, change);

      if (card) {
        const left = card.balance - amount;
        db.prepare('UPDATE gift_cards SET balance=?, status=? WHERE id=?')
          .run(left, left <= 0 ? 'depleted' : 'active', card.id);
      }
      if (customer && pointsSpent) {
        db.prepare('UPDATE customers SET points = points - ? WHERE id=?').run(pointsSpent, customer.id);
        db.prepare('INSERT INTO loyalty_log(customer_id,order_id,points,reason) VALUES(?,?,?,?)')
          .run(customer.id, o.id, -pointsSpent, 'Redeemed at till');
      }
      if (tip) db.prepare('UPDATE orders SET tip = tip + ? WHERE id=?').run(tip, o.id);
      if (customer) db.prepare('UPDATE orders SET customer_id=? WHERE id=?').run(customer.id, o.id);

      // Finalise retail units without exposing hospitality preparation states.
      if (s.business_type === 'wines_spirits')
        db.prepare("UPDATE order_items SET status='sold' WHERE order_id=? AND status!='void'").run(o.id);
      else
        db.prepare("UPDATE order_items SET status='served' WHERE order_id=? AND status IN ('sent','ready')").run(o.id);
      const after = db.prepare('SELECT COALESCE(SUM(amount),0) p FROM payments WHERE order_id=?').get(o.id).p;

      if (after >= d.totals.grand_total + tip) {
        db.prepare(`UPDATE order_items SET cost_snapshot=ROUND(COALESCE((SELECT cost FROM menu_items m WHERE m.id=order_items.menu_item_id),0)*stock_factor)
          WHERE order_id=? AND cost_snapshot IS NULL`).run(o.id);
        const finalOrder = readOrder(o.id);
        const finalItems = db.prepare("SELECT * FROM order_items WHERE order_id=? AND status!='void' ORDER BY id").all(o.id);
        const totals = computeTotals(finalItems, finalOrder.discount, s, finalOrder.tip);
        let allocated = 0;
        finalItems.forEach((line, index) => {
          const share = index === finalItems.length - 1 ? totals.discount - allocated
            : Math.round(totals.discount * (line.price * line.qty) / Math.max(1, totals.subtotal));
          allocated += share;
          db.prepare('UPDATE order_items SET discount_allocated=? WHERE id=?').run(share, line.id);
        });
        const closed = db.prepare(`UPDATE orders SET status='closed',closed_out=1,closed_at=datetime('now','localtime'),closed_by=?,shift_id=?,
          subtotal_snapshot=?,service_snapshot=?,vat_snapshot=?,total_snapshot=?,grand_total_snapshot=?
          WHERE id=? AND status IN ('open','billed') AND closed_out=0`).run(req.user.id, openShift ? openShift.id : null,
          totals.subtotal, totals.service, totals.vat, totals.total, totals.grand_total, o.id);
        if (closed.changes !== 1) throw new Error('Sale was already closed by another request');
        closeOut(o.id, { ...d, totals }, s, req.user, customer ? customer.id : null);
      } else {
        db.prepare("UPDATE orders SET status='billed' WHERE id=? AND status='open'").run(o.id);
      }
    });
    tx();
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) p FROM payments WHERE order_id=?').get(o.id).p;
    audit(req.user, 'payment', `#${o.number} ${method} KSh${(amount / 100).toFixed(2)}` +
      (change ? ` (tendered ${(tendered / 100).toFixed(2)}, change ${(change / 100).toFixed(2)})` : ''));
    broadcast('orders'); broadcast('kitchen'); broadcast('tables'); broadcast('sales'); broadcast('stock');
    res.json({ change, tendered, paid, order: decorate(readOrder(o.id)) });
  });

  /**
   * Runs once an order is fully settled: deplete stock from recipes and award
   * loyalty points. Both are idempotent-ish by virtue of only running on the
   * transition into `closed`.
   *
   * customerId is passed in rather than read off the decorated order, because the
   * order row was snapshotted before the customer was attached to it.
   */
};

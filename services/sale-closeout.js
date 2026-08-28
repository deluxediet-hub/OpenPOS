'use strict';

/** Runs only inside the successful atomic order-close transaction. */
module.exports = function createSaleCloseOut({ db, domain, stockLedger }) {
  return function closeOut(orderId, decorated, settings, user, customerId) {
    const lines = db.prepare("SELECT * FROM order_items WHERE order_id=? AND status!='void'").all(orderId);
    const recipes = db.prepare('SELECT * FROM recipes').all();
    const stockLines = lines.map((line) => ({ ...line, qty: line.qty * (line.stock_factor || 1) }));
    for (const movement of domain.stockMovementsFor(stockLines, recipes)) {
      const stock = db.prepare('SELECT deduction_mode FROM stock_items WHERE id=?').get(movement.stock_item_id);
      if (stock && stock.deduction_mode === 'count') continue;
      stockLedger.record({ stockItemId:movement.stock_item_id, delta:-movement.qty,
        movementType:'SALE', reason:`Recipe usage — order #${orderId}`, userId:user ? user.id : null,
        referenceType:'order', referenceId:Number(orderId) });
    }

    const customer = customerId ? db.prepare('SELECT * FROM customers WHERE id=?').get(customerId) : null;
    if (settings.loyalty_enabled === '1' && customer) {
      const earned = domain.pointsEarned(decorated.totals.total, settings.loyalty_earn_per);
      if (earned > 0) {
        db.prepare('UPDATE customers SET points=points+?,total_spend=total_spend+?,visits=visits+1 WHERE id=?')
          .run(earned, decorated.totals.total, customer.id);
        db.prepare('INSERT INTO loyalty_log(customer_id,order_id,points,reason) VALUES(?,?,?,?)')
          .run(customer.id, orderId, earned, `Earned on ${(decorated.totals.total / 100).toFixed(2)}`);
      }
    }
  };
};

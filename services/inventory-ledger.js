'use strict';

const MOVEMENT_TYPES = Object.freeze([
  'PURCHASE', 'DELIVERY', 'SALE', 'SALE_REVERSAL', 'OPENING_STOCK', 'STOCKTAKE',
  'ADJUSTMENT', 'BREAKAGE', 'SPOILAGE', 'COMPLIMENTARY', 'TRANSFER_IN',
  'TRANSFER_OUT', 'RETURN', 'SUPPLIER_RETURN', 'LEGACY'
]);

module.exports = function createInventoryLedger({ db }) {
  function record({ stockItemId, delta, movementType, reason, userId = null,
    referenceType = null, referenceId = null, referenceCode = null,
    unitCost = null, idempotencyKey = null, alreadyApplied = false }) {
    const type = String(movementType || '').toUpperCase();
    if (!MOVEMENT_TYPES.includes(type)) throw new Error(`Unknown stock movement type: ${movementType}`);
    const change = Number(delta);
    if (!Number.isFinite(change) || change === 0) throw new Error('Stock movement must be a non-zero number');
    const stock = db.prepare('SELECT id,qty,cost FROM stock_items WHERE id=?').get(stockItemId);
    if (!stock) throw new Error('Stock item not found');
    let before, after;
    if (alreadyApplied) {
      after = Number(stock.qty);
      before = Math.round((after - change) * 1e6) / 1e6;
    } else {
      before = Number(stock.qty);
      after = Math.round((before + change) * 1e6) / 1e6;
      db.prepare('UPDATE stock_items SET qty=? WHERE id=?').run(after, stock.id);
    }
    const result = db.prepare(`INSERT INTO stock_moves(stock_item_id,delta,reason,user_id,movement_type,
      reference_type,reference_id,reference_code,qty_before,qty_after,unit_cost_snapshot,idempotency_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(stock.id, change, reason || null, userId, type,
      referenceType, referenceId, referenceCode, before, after,
      unitCost == null ? stock.cost : Math.round(Number(unitCost)), idempotencyKey);
    return { id: Number(result.lastInsertRowid), before, after, delta: change, movement_type: type };
  }

  return { record, MOVEMENT_TYPES };
};
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;

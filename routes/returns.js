'use strict';

/** Item-linked returns/refunds. Kept as one transaction boundary so money, stock,
 * return lines and the audit reference cannot be partially posted. */
module.exports = function registerReturns(app, {
  db, requireAuth, requireRole, getSetting, decorate, readOrder, audit, broadcast, bad
}) {
  app.post('/api/orders/:id/refund', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return bad(res, 'Order not found', 404);
    if (o.status !== 'closed' || !o.closed_out) return bad(res, 'Only a closed sale can be returned');
    const idem=String(req.body.idempotency_key||'').trim().slice(0,100)||null;
    if(idem){
      const prior=db.prepare(`SELECT r.* FROM payments p JOIN returns r ON r.id=p.return_id
        WHERE p.idempotency_key=? AND p.kind='refund'`).get(`return-${idem}`);
      if(prior){
        if(prior.order_id!==o.id)return bad(res,'Return key belongs to another sale',409);
        return res.json({idempotent_replay:true,return_record:prior,order:decorate(o)});
      }
    }
    const method = String(req.body.method || '').toLowerCase();
    if (!['cash','card','mpesa'].includes(method)) return bad(res, 'Refund method must be Cash, Card or M-Pesa');
    const reason = String(req.body.reason || '').trim();
    const externalReference=String(req.body.reference||'').trim().toUpperCase();
    if (!reason) return bad(res, 'Return reason is required');
    if(['card','mpesa'].includes(method)&&!externalReference) return bad(res, `${method.toUpperCase()} refund reference is required`);
    if(externalReference&&db.prepare('SELECT id FROM payments WHERE upper(reference)=upper(?)').get(externalReference))
      return bad(res,'That refund reference has already been used');
    const shift = db.prepare("SELECT * FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    if (getSetting('business_type') === 'wines_spirits' && !shift) return bad(res, 'Open the till before issuing a refund');
    const amount = Math.round(Number(req.body.amount) * 100);
    const refundable = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE order_id=? AND kind IN ('sale','refund')").get(o.id).v;
    if (!amount || amount <= 0) return bad(res, 'Amount must be greater than zero');
    if (amount > refundable) return bad(res, 'Refund exceeds the remaining paid amount');
    const methodRemaining=db.prepare("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE order_id=? AND method=? AND kind IN ('sale','refund')").get(o.id,method).v;
    if(amount>methodRemaining) return bad(res, `Refund exceeds the remaining ${method.toUpperCase()} amount of ${(methodRemaining/100).toFixed(2)}`);
    const requested = Array.isArray(req.body.items) ? req.body.items : [];
    if (!requested.length) return bad(res, 'Select at least one returned product');
    const seenLineIds = new Set();
    let lines;
    try { lines=requested.map((x) => {
      const lineId=Number(x.order_item_id),qty=Number(x.qty);
      if(!Number.isInteger(lineId)||seenLineIds.has(lineId)) throw new Error('Each returned sale line may be selected only once');
      seenLineIds.add(lineId);
      const line = db.prepare("SELECT * FROM order_items WHERE id=? AND order_id=? AND status!='void'").get(lineId, o.id);
      if (!line || !Number.isFinite(qty) || !(qty > 0)) throw new Error('Invalid returned product or quantity');
      const returned = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM return_items WHERE order_item_id=?').get(line.id).q;
      if (returned + qty > line.qty + 0.000001) throw new Error(`${line.name}: return exceeds sold quantity`);
      /* Allocate from each line's immutable net value after its share of the order
         discount. Using gross price here can make a later return line negative. */
      const lineNet=Math.max(0,line.price*line.qty-line.discount_allocated);
      const netValue=Math.max(0,Math.round(lineNet*qty/Math.max(1,line.qty)));
      return { line, qty, netValue };
    }); } catch(e){ return bad(res,e.message); }
    const selectedValue=lines.reduce((n,x)=>n+x.netValue,0);
    if (selectedValue <= 0) return bad(res, 'Selected products have no refundable value');
    if (amount > selectedValue) return bad(res, 'Refund exceeds selected product value');
    const restock = !!req.body.restock;
    const reference = String(req.body.reference || '').trim() || reason;
    let returnId;
    const tx = db.transaction(() => {
      returnId = db.prepare('INSERT INTO returns(order_id,amount,method,reason,restocked,shift_id,created_by) VALUES(?,?,?,?,?,?,?)')
        .run(o.id,amount,method,reason,restock?1:0,shift?shift.id:null,req.user.id).lastInsertRowid;
      const ins = db.prepare('INSERT INTO return_items(return_id,order_item_id,menu_item_id,item_name,qty,stock_factor,amount,cost) VALUES(?,?,?,?,?,?,?,?)');
      let allocatedRefund=0;
      for (const [index,x] of lines.entries()) {
        const lineAmount=index===lines.length-1?amount-allocatedRefund:Math.round(amount*x.netValue/selectedValue);
        if(lineAmount<0)throw new Error('Return allocation produced a negative line amount');
        allocatedRefund+=lineAmount;
        ins.run(returnId,x.line.id,x.line.menu_item_id,x.line.name,x.qty,x.line.stock_factor||1,lineAmount,
          Math.round((x.line.cost_snapshot||0)*x.qty));
        if (restock) {
          const recipes = db.prepare('SELECT * FROM recipes WHERE menu_item_id=?').all(x.line.menu_item_id);
          for (const recipe of recipes) {
            const stock = db.prepare('SELECT * FROM stock_items WHERE id=?').get(recipe.stock_item_id);
            const add = recipe.qty*x.qty*(x.line.stock_factor||1);
            if (!stock || stock.deduction_mode==='count') continue;
            db.prepare('UPDATE stock_items SET qty=ROUND(qty+?,6) WHERE id=?').run(add,stock.id);
            db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
              .run(stock.id,add,`Return #${returnId} · sale #${o.number}`,req.user.id);
          }
        }
      }
      db.prepare(`INSERT INTO payments(order_id,method,amount,reference,cashier_id,shift_id,kind,idempotency_key,return_id)
        VALUES(?,?,?,?,?,?,'refund',?,?)`).run(o.id,method,-amount,externalReference||reference,req.user.id,
          shift?shift.id:null,idem?`return-${idem}`:null,returnId);
    });
    try { tx(); } catch(e) { return bad(res,e.message); }
    audit(req.user,'return.issue',`#${o.number} ${method} KSh${(amount/100).toFixed(2)} · ${restock?'restocked':'not restocked'} · ${reason}`);
    broadcast('sales');broadcast('orders');broadcast('stock');
    res.json({ return_record:db.prepare('SELECT * FROM returns WHERE id=?').get(returnId),order:decorate(readOrder(o.id)) });
  });

  app.get('/api/returns/:id', requireAuth, requireRole('manager','admin'), (req,res) => {
    const r=db.prepare(`SELECT r.*,o.number order_number,u.name created_by_name FROM returns r JOIN orders o ON o.id=r.order_id
      LEFT JOIN users u ON u.id=r.created_by WHERE r.id=?`).get(req.params.id);
    if(!r) return bad(res,'Return not found',404);
    r.items=db.prepare('SELECT * FROM return_items WHERE return_id=? ORDER BY id').all(r.id);
    res.json(r);
  });
};

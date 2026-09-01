'use strict';

/** Immutable linked reversals for operational transactions. Originals are never
 * edited away: each correction gets one reversal document and offsetting ledger
 * entries so stock, till and audit history remain explainable. */
module.exports=function register(app,{db,requireAuth,requireRole,stockLedger,audit,broadcast,bad}){
  const allowed=new Set(['delivery','expense','complimentary','adjustment','supplier_payment']);
  app.get('/api/reversals',requireAuth,requireRole('manager','admin'),(req,res)=>res.json(db.prepare(`
    SELECT r.*,u.name reversed_by_name FROM transaction_reversals r
    LEFT JOIN users u ON u.id=r.reversed_by ORDER BY r.id DESC LIMIT 200`).all()));

  app.post('/api/reversals/:type/:id',requireAuth,requireRole('seller','manager','admin'),(req,res)=>{
    const type=String(req.params.type||'').toLowerCase(),targetId=Number(req.params.id);
    if(!allowed.has(type)||!Number.isInteger(targetId))return bad(res,'Unknown transaction to reverse');
    if(type==='adjustment'&&!['manager','admin'].includes(req.user.role))return bad(res,'Manager access required',403);
    const reason=String(req.body.reason||'').trim();
    if(reason.length<3)return bad(res,'A reversal reason is required');
    if(db.prepare('SELECT id FROM transaction_reversals WHERE transaction_type=? AND transaction_id=?').get(type,targetId))
      return bad(res,'This transaction already has a reversal',409);

    let label='';
    try{db.transaction(()=>{
      const reversalId=Number(db.prepare(`INSERT INTO transaction_reversals(transaction_type,transaction_id,reason,reversed_by)
        VALUES(?,?,?,?)`).run(type,targetId,reason,req.user.id).lastInsertRowid);
      if(type==='delivery'){
        const receipt=db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(targetId);
        if(!receipt)throw new Error('Delivery not found');
        const lines=db.prepare('SELECT * FROM goods_receipt_items WHERE receipt_id=?').all(targetId);
        for(const line of lines){
          const stock=db.prepare('SELECT qty FROM stock_items WHERE id=?').get(line.stock_item_id);
          if(!stock||Number(stock.qty)+1e-9<Number(line.qty))throw new Error('Delivery stock has already been sold or issued; use a counted stock correction instead');
          stockLedger.record({stockItemId:line.stock_item_id,delta:-Number(line.qty),movementType:'SUPPLIER_RETURN',
            reason:`Reversal of delivery ${receipt.invoice_no}: ${reason}`,userId:req.user.id,
            referenceType:'transaction_reversal',referenceId:reversalId,referenceCode:receipt.invoice_no});
        }
        if(receipt.payment_status==='paid'&&['cash','mpesa'].includes(receipt.payment_method)){
          const shift=db.prepare("SELECT id FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get();
          if(!shift)throw new Error('Open the till before reversing a paid Cash or M-Pesa delivery');
          db.prepare('INSERT INTO cash_payouts(shift_id,amount,reason,user_id,method) VALUES(?,?,?,?,?)')
            .run(shift.id,-receipt.total_cost,`Reversal of delivery ${receipt.invoice_no}: ${reason}`,req.user.id,receipt.payment_method);
        }
        label=`delivery ${receipt.invoice_no}`;
      }else if(type==='supplier_payment'){
        const receipt=db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(targetId);
        if(!receipt)throw new Error('Supplier delivery not found');
        if(receipt.payment_status!=='paid')throw new Error('Supplier payment is not marked paid');
        if(['cash','mpesa'].includes(receipt.payment_method)){
          const shift=db.prepare("SELECT id FROM shifts WHERE status IN ('open','reconciling') ORDER BY id DESC LIMIT 1").get();
          if(!shift)throw new Error('Open the till before reversing this supplier payment');
          db.prepare('INSERT INTO cash_payouts(shift_id,amount,reason,user_id,method) VALUES(?,?,?,?,?)')
            .run(shift.id,-receipt.total_cost,`Reversal of supplier payment ${receipt.invoice_no}: ${reason}`,req.user.id,receipt.payment_method);
        }
        db.prepare("UPDATE goods_receipts SET payment_status='unpaid',payment_method='pay_later' WHERE id=?").run(receipt.id);
        label=`supplier payment ${receipt.invoice_no}`;
      }else if(type==='expense'){
        const payout=db.prepare('SELECT * FROM cash_payouts WHERE id=?').get(targetId);
        if(!payout||payout.amount<=0)throw new Error('Expense not found');
        const shift=db.prepare("SELECT id FROM shifts WHERE id=? AND status IN ('open','reconciling')").get(payout.shift_id);
        if(!shift)throw new Error('Only an expense in the current open till can be reversed');
        db.prepare('INSERT INTO cash_payouts(shift_id,amount,reason,user_id,method) VALUES(?,?,?,?,?)')
          .run(payout.shift_id,-payout.amount,`Reversal of expense #${payout.id}: ${reason}`,req.user.id,payout.method);
        label=`expense #${payout.id}`;
      }else if(type==='complimentary'){
        const issue=db.prepare('SELECT * FROM complimentary_issues WHERE id=?').get(targetId);
        if(!issue)throw new Error('Complimentary issue not found');
        if(issue.deducted&&issue.stock_item_id)stockLedger.record({stockItemId:issue.stock_item_id,delta:Number(issue.stock_qty),
          movementType:'ADJUSTMENT',reason:`Reversal of complimentary #${issue.id}: ${reason}`,userId:req.user.id,
          referenceType:'transaction_reversal',referenceId:reversalId});
        label=`complimentary #${issue.id} (${issue.item_name})`;
      }else{
        const move=db.prepare("SELECT * FROM stock_moves WHERE id=? AND reference_type='adjustment'").get(targetId);
        if(!move)throw new Error('Stock adjustment not found');
        stockLedger.record({stockItemId:move.stock_item_id,delta:-Number(move.delta),movementType:'ADJUSTMENT',
          reason:`Reversal of adjustment #${move.id}: ${reason}`,userId:req.user.id,
          referenceType:'transaction_reversal',referenceId:reversalId,referenceCode:move.reference_code});
        label=`stock adjustment #${move.id}`;
      }
    })();}catch(e){return bad(res,e.message,409);}
    audit(req.user,`${type}.reverse`,`${label} — ${reason}`);broadcast('stock');broadcast('sales');
    res.json({ok:true,type,transaction_id:targetId,reason});
  });
};

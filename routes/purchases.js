'use strict';

/** Supplier and goods-receipt routes. Seller receiving/payment access is preserved. */
module.exports = function register(app, {
  db, requireAuth, requireRole, todayLocal, audit, broadcast, bad
}) {
  /* ---------------------- retail receiving & stocktakes --------------------- */
  app.get('/api/suppliers', requireAuth, (req, res) =>
    res.json(db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all()));

  app.post('/api/suppliers', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return bad(res, 'Supplier name required');
    const r = db.prepare('INSERT INTO suppliers(name,phone,email,kra_pin,address) VALUES(?,?,?,?,?)')
      .run(String(b.name).trim(), b.phone || null, b.email || null, b.kra_pin || null, b.address || null);
    audit(req.user, 'supplier.create', String(b.name).trim());
    res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(r.lastInsertRowid));
  });

  app.put('/api/suppliers/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const cur = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
    if (!cur) return bad(res, 'Supplier not found', 404);
    const b = req.body || {};
    db.prepare('UPDATE suppliers SET name=?,phone=?,email=?,kra_pin=?,address=?,active=? WHERE id=?')
      .run(b.name ?? cur.name, b.phone ?? cur.phone, b.email ?? cur.email, b.kra_pin ?? cur.kra_pin,
        b.address ?? cur.address, b.active !== undefined ? (b.active ? 1 : 0) : cur.active, cur.id);
    audit(req.user, 'supplier.update', cur.name);
    res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(cur.id));
  });

  app.get('/api/goods-receipts', requireAuth, (req, res) => res.json(db.prepare(`
    SELECT gr.*,s.name supplier_name,u.name received_by_name,
      (SELECT COUNT(*) FROM goods_receipt_items gi WHERE gi.receipt_id=gr.id) lines
    FROM goods_receipts gr LEFT JOIN suppliers s ON s.id=gr.supplier_id
    LEFT JOIN users u ON u.id=gr.received_by ORDER BY gr.id DESC LIMIT 100`).all()));

  app.post('/api/goods-receipts', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
    const b = req.body || {}, lines = Array.isArray(b.items) ? b.items : [];
    if (!lines.length) return bad(res, 'Add at least one delivered product');
    if (db.prepare("SELECT id FROM stock_counts WHERE status='open'").get())
      return bad(res, 'Finish the active stocktake before receiving a delivery');
    const paymentMethod = ['cash', 'mpesa', 'other', 'pay_later'].includes(b.payment_method) ? b.payment_method : 'pay_later';
    const paymentStatus = paymentMethod === 'pay_later' ? 'unpaid' : 'paid';
    const reference = String(b.invoice_no || '').trim() || `DEL-${todayLocal().replace(/-/g, '')}-${String(Date.now()).slice(-6)}`;
    if (['cash', 'mpesa'].includes(paymentMethod) && !db.prepare("SELECT id FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get())
      return bad(res, `Open the till before recording a ${paymentMethod === 'cash' ? 'cash' : 'M-Pesa'} stock payment`);
    let receiptId, total = 0;
    const tx = db.transaction(() => {
      receiptId = db.prepare(`INSERT INTO goods_receipts(supplier_id,invoice_no,notes,payment_method,payment_status,received_by)
        VALUES(?,?,?,?,?,?)`).run(Number(b.supplier_id) || null, reference, b.notes || null,
        paymentMethod, paymentStatus, req.user.id).lastInsertRowid;
      const ins = db.prepare('INSERT INTO goods_receipt_items(receipt_id,stock_item_id,qty,unit_cost,batch_no,expiry_date) VALUES(?,?,?,?,?,?)');
      for (const line of lines) {
        const stock = db.prepare('SELECT * FROM stock_items WHERE id=?').get(Number(line.stock_item_id));
        const qty = Number(line.qty);
        if (!stock || !(qty > 0)) throw new Error('Every delivery line needs a valid product and positive quantity');
        ins.run(receiptId, stock.id, qty, stock.cost, null, null);
        db.prepare('UPDATE stock_items SET qty=ROUND(qty+?,6) WHERE id=?').run(qty, stock.id);
        db.prepare('INSERT INTO stock_moves(stock_item_id,delta,reason,user_id) VALUES(?,?,?,?)')
          .run(stock.id, qty, `Delivery ${reference}`, req.user.id);
        total += qty * stock.cost;
      }
      total = Math.round(total);
      db.prepare('UPDATE goods_receipts SET total_cost=? WHERE id=?').run(total, receiptId);
      if (['cash', 'mpesa'].includes(paymentMethod)) {
        const shift = db.prepare("SELECT id FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get();
        db.prepare('INSERT INTO cash_payouts(shift_id,amount,reason,user_id,method) VALUES(?,?,?,?,?)')
          .run(shift.id, total, `Stock delivery ${reference}`, req.user.id, paymentMethod);
      }
    });
    try { tx(); } catch (e) { return bad(res, e.message); }
    audit(req.user, 'delivery.receive', `${reference} · ${lines.length} lines · KSh${(total / 100).toFixed(2)} · ${paymentMethod}`);
    broadcast('stock'); broadcast('sales');
    res.json({ id: receiptId, invoice_no: reference, total_cost: total, payment_method: paymentMethod, payment_status: paymentStatus, ok: true });
  });

  app.post('/api/goods-receipts/:id/pay', requireAuth, requireRole('seller', 'manager', 'admin'), (req, res) => {
    const receipt = db.prepare('SELECT * FROM goods_receipts WHERE id=?').get(req.params.id);
    if (!receipt) return bad(res, 'Delivery not found', 404);
    if (receipt.payment_status === 'paid') return bad(res, 'This delivery is already marked paid');
    const method = ['cash', 'mpesa', 'other'].includes(req.body.method) ? req.body.method : null;
    if (!method) return bad(res, 'Choose Cash, M-Pesa or Other');
    const shift = ['cash', 'mpesa'].includes(method)
      ? db.prepare("SELECT id FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1").get() : null;
    if (['cash', 'mpesa'].includes(method) && !shift) return bad(res, 'Open the till before paying from Cash or M-Pesa');
    const tx = db.transaction(() => {
      db.prepare("UPDATE goods_receipts SET payment_method=?,payment_status='paid' WHERE id=?").run(method, receipt.id);
      if (shift) db.prepare('INSERT INTO cash_payouts(shift_id,amount,reason,user_id,method) VALUES(?,?,?,?,?)')
        .run(shift.id, receipt.total_cost, `Stock delivery ${receipt.invoice_no}`, req.user.id, method);
    }); tx();
    audit(req.user, 'delivery.pay', `${receipt.invoice_no} · ${method} · KSh${(receipt.total_cost / 100).toFixed(2)}`);
    broadcast('sales');
    res.json({ ok: true, payment_method: method, payment_status: 'paid' });
  });
};

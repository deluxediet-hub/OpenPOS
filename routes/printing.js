'use strict';
const path = require('path');
const fs = require('fs');

/** Direct ESC/POS endpoints. Browser fallback remains client-side; this module owns
 * server payload generation, spooling and network delivery. */
module.exports = function registerPrinting(app, {
  db, escpos, requireAuth, requireRole, getSettings, decorate, audit, bad, spoolDir
}) {
  const printerTarget = (which) => {
    const settings = getSettings();
    const host = which === 'kitchen' ? settings.kitchen_printer_host : settings.printer_host;
    const port = which === 'kitchen' ? settings.kitchen_printer_port : settings.printer_port;
    return { enabled: settings.printer_enabled === '1', host, port: Number(port) || 9100 };
  };

  const waiterNameOf = (id) =>
    (db.prepare('SELECT name FROM users WHERE id=?').get(id) || {}).name || '-';

  function rotateSpool(){
    fs.mkdirSync(spoolDir,{recursive:true});
    const cutoff=Date.now()-30*86400000;
    const jobs=fs.readdirSync(spoolDir).filter((f)=>f.endsWith('.prn')).map((f)=>({f,path:path.join(spoolDir,f),mtime:fs.statSync(path.join(spoolDir,f)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
    for(const job of jobs)if(job.mtime<cutoff||jobs.indexOf(job)>=500){try{fs.unlinkSync(job.path);}catch{}}
  }

  async function deliverPrint(buf, kind, name, res, req) {
    const printer = printerTarget(kind);
    rotateSpool();
    const spoolPath = path.join(spoolDir, `${name}-${Date.now()}.prn`);
    escpos.writeToFile(spoolPath, buf);
    audit(req.user, 'print', `${kind} ${name} (${buf.length} bytes)`);
    if (!printer.enabled || !printer.host) {
      return res.json({ ok: true, sent: false, bytes: buf.length, spool: spoolPath,
        reason: 'No printer configured — job spooled to disk' });
    }
    try {
      await escpos.send(printer.host, printer.port, buf);
      res.json({ ok: true, sent: true, bytes: buf.length, printer: `${printer.host}:${printer.port}` });
    } catch (e) {
      res.status(502).json({ ok: false, sent: false, error: e.message, spool: spoolPath });
    }
  }

  app.get('/api/print/jobs',requireAuth,requireRole('manager','admin'),(req,res)=>{
    rotateSpool();const files=fs.readdirSync(spoolDir).filter((f)=>f.endsWith('.prn')).map((name)=>{
      const stat=fs.statSync(path.join(spoolDir,name));return{name,size:stat.size,created_at:stat.mtime.toISOString()};
    }).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,100);
    res.json({jobs:files,retention:'30 days / 500 jobs'});
  });

  app.post('/api/print/receipt/:id', requireAuth, requireRole('seller','cashier','manager','admin'), async (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return bad(res, 'Order not found', 404);
    const decorated = decorate(order);
    const table = order.table_id ? db.prepare('SELECT * FROM tables WHERE id=?').get(order.table_id) : null;
    const waiter = db.prepare('SELECT name FROM users WHERE id=?').get(order.waiter_id);
    const cashier = db.prepare('SELECT name FROM users WHERE id=?').get(order.closed_by);
    const customer = order.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(order.customer_id) : null;
    const settings = getSettings();
    if (req.query.kick !== '1') settings.drawer_kick_enabled = '0';
    const payload = {
      order: decorated, table, waiter, settings, items: decorated.items,
      cashier: (cashier || {}).name || req.user.name,
      customer_phone: customer ? customer.phone : null
    };
    const paid = order.status === 'closed' && req.query.paid !== '0';
    const partial = !paid && req.query.partial === '1' && decorated.paid > 0;
    const reprint=req.query.reprint==='1';
    if(reprint){settings.drawer_kick_enabled='0';const prior=db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='receipt.reprint' AND detail LIKE ?").get(`#${order.number}%`).n;
      audit(req.user,'receipt.reprint',`#${order.number} · copy ${prior+1}`);}

    const buf = escpos.buildReceipt(payload, { paid, partial, reprint });
    await deliverPrint(buf, 'till', `receipt-${order.number}`, res, req);
  });

  app.post('/api/print/return/:id',requireAuth,requireRole('manager','admin'),async(req,res)=>{
    const ret=db.prepare(`SELECT r.*,o.number order_number,u.name created_by_name FROM returns r JOIN orders o ON o.id=r.order_id
      LEFT JOIN users u ON u.id=r.created_by WHERE r.id=?`).get(req.params.id);
    if(!ret)return bad(res,'Return not found',404);
    ret.items=db.prepare('SELECT * FROM return_items WHERE return_id=? ORDER BY id').all(ret.id);
    const buf=escpos.buildReturnReceipt(ret,getSettings());
    await deliverPrint(buf,'till',`return-${ret.id}`,res,req);
  });

  app.post('/api/print/kitchen/:id', requireAuth, async (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return bad(res, 'Order not found', 404);
    const station = req.body.station || 'kitchen';
    const decorated = decorate(order);
    const lines = decorated.items.filter((item) => item.station === station && ['sent', 'ready'].includes(item.status));
    if (!lines.length) return bad(res, `No ${station} lines to print`);
    const table = order.table_id ? db.prepare('SELECT * FROM tables WHERE id=?').get(order.table_id) : null;
    const buf = escpos.buildKitchenTicket({ ...order, items: lines }, {
      table, waiter: waiterNameOf(order.waiter_id), station, settings: getSettings()
    });
    await deliverPrint(buf, 'kitchen', `kitchen-${order.number}-${station}`, res, req);
  });
};

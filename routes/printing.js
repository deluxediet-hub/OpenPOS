'use strict';
const path = require('path');

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

  async function deliverPrint(buf, kind, name, res, req) {
    const printer = printerTarget(kind);
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
    const buf = escpos.buildReceipt(payload, { paid, partial });
    await deliverPrint(buf, 'till', `receipt-${order.number}`, res, req);
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

'use strict';

/** Financial/operational reporting routes. Queries and response contracts remain unchanged. */
module.exports = function register(app, {
  db, requireAuth, requireRole, todayLocal, dayBounds, dayEnd, getSettings,
  setSetting, audit, broadcast
}) {
  /* -------------------------------- reports ------------------------------- */
  app.get('/api/reports/summary', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
    const from=req.query.from||todayLocal(),to=req.query.to||from,a=dayBounds(from),b=dayEnd(to);
    const g=(sql,p=[])=>db.prepare(sql).get(...p)||{};
    const paid=g("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE created_at BETWEEN ? AND ? AND kind='sale'",[a,b]).v||0;
    const refunded=-(g("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE created_at BETWEEN ? AND ? AND kind='refund'",[a,b]).v||0);
    const sales=g(`SELECT COALESCE(SUM(COALESCE(total_snapshot,(SELECT COALESCE(SUM(price*qty),0) FROM order_items oi WHERE oi.order_id=o.id AND oi.status!='void')-discount)),0) gross,
        COALESCE(SUM(COALESCE(vat_snapshot,0)),0) vat,COUNT(*) closed,COALESCE(SUM(people),0) covers,
        COALESCE(SUM(discount),0) discounts,COALESCE(SUM(tip),0) tips
      FROM orders o WHERE closed_at BETWEEN ? AND ? AND status='closed'`,[a,b]);
    const returnTax=g(`SELECT COALESCE(SUM(CASE WHEN o.total_snapshot>0 THEN r.amount*o.vat_snapshot/o.total_snapshot ELSE 0 END),0) v
      FROM returns r JOIN orders o ON o.id=r.order_id WHERE r.created_at BETWEEN ? AND ?`,[a,b]).v||0;
    const returnedCost=g(`SELECT COALESCE(SUM(ri.cost),0) v FROM return_items ri JOIN returns r ON r.id=ri.return_id
      WHERE r.restocked=1 AND r.created_at BETWEEN ? AND ?`,[a,b]).v||0;
    const inventoryLoss=g(`SELECT COALESCE(SUM(ri.cost),0) v FROM return_items ri JOIN returns r ON r.id=ri.return_id
      WHERE r.restocked=0 AND r.created_at BETWEEN ? AND ?`,[a,b]).v||0;
    const soldCost=g(`SELECT COALESCE(SUM(COALESCE(oi.cost_snapshot,m.cost*oi.stock_factor)*oi.qty),0) v FROM order_items oi
      JOIN orders o ON o.id=oi.order_id LEFT JOIN menu_items m ON m.id=oi.menu_item_id
      WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed' AND oi.status!='void'`,[a,b]).v||0;
    const gross=Math.round((sales.gross||0)-refunded),vatCollected=Math.max(0,Math.round((sales.vat||0)-returnTax));
    const netSales=gross-vatCollected,cogs=Math.round(soldCost-returnedCost),grossProfit=netSales-cogs;
    const voids=g("SELECT COUNT(*) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='void'",[a,b]).c||0;
    const comps=g(`SELECT COUNT(*) n,COALESCE(SUM(retail_value),0) retail,COALESCE(SUM(cost_value),0) cost FROM complimentary_issues WHERE created_at BETWEEN ? AND ?`,[a,b]);
    const byMethod=db.prepare(`SELECT method,COALESCE(SUM(amount),0) total,COUNT(*) n FROM payments WHERE created_at BETWEEN ? AND ? GROUP BY method ORDER BY total DESC`).all(a,b);
    res.json({from,to,gross,refunded,paid,net:netSales,vat_collected:vatCollected,orders_closed:sales.closed||0,orders_void:voids,covers:sales.covers||0,
      avg_ticket:sales.closed?Math.round(gross/sales.closed):0,avg_per_cover:sales.covers?Math.round(gross/sales.covers):0,
      discounts:sales.discounts||0,tips:sales.tips||0,complimentary_count:comps.n||0,complimentary_value:comps.retail||0,
      complimentary_cost:comps.cost||0,cogs,inventory_loss:inventoryLoss,gross_profit:grossProfit,
      margin:netSales?Math.round(grossProfit/netSales*1000)/10:0,by_method:byMethod});
  });

  app.get('/api/reports/items', requireAuth, requireRole('manager','admin','cashier'), (req,res)=>{
    const from=req.query.from||todayLocal(),to=req.query.to||from,a=dayBounds(from),b=dayEnd(to);
    res.json(db.prepare(`SELECT name,station,SUM(lines) lines,SUM(qty) qty,SUM(revenue) revenue,SUM(cogs) cogs FROM (
        SELECT oi.name,oi.station,1 lines,oi.qty qty,oi.price*oi.qty-oi.discount_allocated revenue,
          COALESCE(oi.cost_snapshot,m.cost*oi.stock_factor)*oi.qty cogs
        FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN menu_items m ON m.id=oi.menu_item_id
        WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed' AND oi.status!='void'
        UNION ALL
        SELECT ri.item_name,oi.station,0,-ri.qty,-ri.amount,
          CASE WHEN r.restocked=1 THEN -ri.cost ELSE 0 END FROM return_items ri JOIN returns r ON r.id=ri.return_id
          LEFT JOIN order_items oi ON oi.id=ri.order_item_id WHERE r.created_at BETWEEN ? AND ?
      ) GROUP BY name,station HAVING ABS(SUM(qty))>0.000001 OR SUM(revenue)!=0 OR SUM(cogs)!=0 ORDER BY revenue DESC LIMIT 100`).all(a,b,a,b));
  });

  app.get('/api/reports/waiters', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
    const from = req.query.from || todayLocal();
    const to = req.query.to || from;
    const a=dayBounds(from),b=dayEnd(to);
    res.json(db.prepare(`SELECT waiter,SUM(orders) orders,SUM(covers) covers,SUM(revenue) revenue FROM (
        SELECT u.name waiter,COUNT(DISTINCT o.id) orders,COALESCE(SUM(o.people),0) covers,
          COALESCE(SUM(COALESCE(o.total_snapshot,
            (SELECT SUM(p.amount-p.tip) FROM payments p WHERE p.order_id=o.id AND p.kind='sale'))),0) revenue
        FROM orders o LEFT JOIN users u ON u.id=o.waiter_id
        WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed' GROUP BY u.name
        UNION ALL
        SELECT u.name waiter,0 orders,0 covers,-COALESCE(SUM(r.amount),0) revenue
        FROM returns r JOIN orders o ON o.id=r.order_id LEFT JOIN users u ON u.id=o.waiter_id
        WHERE r.created_at BETWEEN ? AND ? GROUP BY u.name
      ) GROUP BY waiter ORDER BY revenue DESC`).all(a,b,a,b));
  });

  app.get('/api/reports/categories', requireAuth, requireRole('manager','admin','cashier'), (req,res)=>{
    const from=req.query.from||todayLocal(),to=req.query.to||from,a=dayBounds(from),b=dayEnd(to);
    res.json(db.prepare(`SELECT category,station,SUM(qty) qty,SUM(revenue) revenue FROM (
        SELECT c.name category,c.station,oi.qty,oi.price*oi.qty-oi.discount_allocated revenue
        FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN menu_items m ON m.id=oi.menu_item_id JOIN categories c ON c.id=m.category_id
        WHERE o.closed_at BETWEEN ? AND ? AND o.status='closed' AND oi.status!='void'
        UNION ALL
        SELECT COALESCE(c.name,'Archived product'),COALESCE(c.station,'retail'),-ri.qty,-ri.amount FROM return_items ri
          JOIN returns r ON r.id=ri.return_id LEFT JOIN menu_items m ON m.id=ri.menu_item_id LEFT JOIN categories c ON c.id=m.category_id
          WHERE r.created_at BETWEEN ? AND ?
      ) GROUP BY category,station HAVING ABS(SUM(qty))>0.000001 OR SUM(revenue)!=0 ORDER BY revenue DESC`).all(a,b,a,b));
  });

  app.get('/api/reports/expenses', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const from = req.query.from || todayLocal(), to = req.query.to || from;
    res.json(db.prepare(`SELECT cp.*,u.name user_name FROM cash_payouts cp
      LEFT JOIN users u ON u.id=cp.user_id WHERE cp.created_at BETWEEN ? AND ?
      ORDER BY cp.created_at DESC`).all(dayBounds(from), dayEnd(to)));
  });

  app.get('/api/reports/hourly', requireAuth, requireRole('manager', 'admin', 'cashier'), (req, res) => {
    const from = req.query.from || todayLocal();
    res.json(db.prepare(`
      SELECT substr(created_at,12,2) AS hour, COALESCE(SUM(amount),0) total, COUNT(*) n
      FROM payments WHERE method != 'refund' AND created_at BETWEEN ? AND ?
      GROUP BY hour ORDER BY hour`).all(dayBounds(from), dayEnd(from)));
  });

  app.get('/api/zreport', requireAuth, requireRole('seller', 'manager', 'admin', 'cashier'), (req, res) => {
    const day = req.query.date || todayLocal();
    const a = dayBounds(day), b = dayEnd(day);
    const sales = db.prepare(`SELECT method, COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments
      WHERE created_at BETWEEN ? AND ? GROUP BY method`).all(a, b);
    const orders = db.prepare("SELECT COUNT(*) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'").get(a, b).c;
    const voids = db.prepare("SELECT COUNT(*) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='void'").get(a, b).c;
    const tips = db.prepare("SELECT COALESCE(SUM(tip),0) c FROM orders WHERE closed_at BETWEEN ? AND ?").get(a, b).c;
    const discounts = db.prepare("SELECT COALESCE(SUM(discount),0) c FROM orders WHERE closed_at BETWEEN ? AND ?").get(a, b).c;
    const covers = db.prepare("SELECT COALESCE(SUM(people),0) c FROM orders WHERE closed_at BETWEEN ? AND ? AND status='closed'").get(a, b).c;
    const comps = db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(retail_value),0) retail,COALESCE(SUM(cost_value),0) cost
      FROM complimentary_issues WHERE created_at BETWEEN ? AND ?`).get(a, b);
    res.json({
      date: day, settings: getSettings(), by_method: sales, orders, voids, tips, discounts, covers,
      complimentary_count: comps.n, complimentary_value: comps.retail, complimentary_cost: comps.cost,
      net: sales.reduce((x,s)=>x+s.total,0)
    });
  });

  app.get('/api/audit', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
  });

  app.get('/api/settings', requireAuth, requireRole('manager', 'admin'), (req, res) => res.json(getSettings()));
  app.put('/api/settings', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (typeof v === 'boolean') setSetting(k, v ? '1' : '0');
      else if (v !== undefined) setSetting(k, v);
    }
    audit(req.user, 'settings.update', Object.keys(req.body || {}).join(','));
    broadcast('settings');
    res.json(getSettings());
  });
};

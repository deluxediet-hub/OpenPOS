'use strict';

/** Token-scoped guest ordering retained for configured hospitality mode. */
module.exports = function register(app, {
  db, domain, getSettings, listMenu, nextOrderNumber, decorate, readOrder,
  audit, broadcast, bad
}) {
  /* ====================== QR TABLE ORDERING (4.13) ====================== */
  /**
   * Public, token-scoped endpoints for guest self-ordering.
   * The token is a random 18-hex string per table, printed as a QR on the table.
   * Guests can read the menu and add items to that table's order; they cannot see
   * prices of other tables, pay, or change anything else.
   */
  const tableByToken = (token) => db.prepare('SELECT * FROM tables WHERE qr_token=?').get(String(token || ''));

  app.get('/api/qr/:token', (req, res) => {
    const t = tableByToken(req.params.token);
    if (!t) return bad(res, 'Unknown table code', 404);
    const s = getSettings();
    const dayparts = db.prepare('SELECT * FROM dayparts WHERE active=1').all();
    const active = domain.activeDayparts(dayparts);
    const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
    const menu = listMenu().filter((m) => m.available).map((m) => {
      const rule = domain.bestDiscountFor(m, active);
      return {
        id: m.id, name: m.name, category_id: m.category_id, station: m.station,
        price: rule ? domain.discountedPrice(m.price, rule.discount_pct) : m.price,
        was: rule ? m.price : null, rule: rule ? rule.name : null,
        groups: db.prepare('SELECT * FROM modifier_groups WHERE id IN (SELECT group_id FROM menu_item_modifiers WHERE menu_item_id=?)').all(m.id)
          .map((g) => ({ ...g, options: db.prepare('SELECT * FROM modifier_options WHERE group_id=? ORDER BY sort_order, name').all(g.id) }))
      };
    });
    const open = db.prepare("SELECT * FROM orders WHERE table_id=? AND status IN ('open','billed') ORDER BY id DESC LIMIT 1").get(t.id);
    res.json({
      table: { name: t.name, area: t.area }, business: s.business_name,
      currency_symbol: s.currency_symbol, categories: cats, menu,
      order: open ? { id: open.id, number: open.number, items: decorate(open).items } : null
    });
  });

  app.post('/api/qr/:token/items', (req, res) => {
    const t = tableByToken(req.params.token);
    if (!t) return bad(res, 'Unknown table code', 404);
    let order = db.prepare("SELECT * FROM orders WHERE table_id=? AND status IN ('open','billed') ORDER BY id DESC LIMIT 1").get(t.id);
    if (!order) {
      const r = db.prepare("INSERT INTO orders(number,table_id,waiter_id,people,notes,channel) VALUES(?,?,?,?,?,?)")
        .run(nextOrderNumber(), t.id, null, Number(req.body.people) || 1, 'Guest QR order', 'dine_in');
      order = db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
      audit(null, 'qr.order.open', `${t.name} #${order.number}`);
    }
    const lines = Array.isArray(req.body.items) ? req.body.items : [req.body];
    const dayparts = db.prepare('SELECT * FROM dayparts WHERE active=1').all();
    const ins = db.prepare(`INSERT INTO order_items(order_id,menu_item_id,name,price,qty,note,station,modifiers)
      VALUES(?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const l of lines) {
        const m = db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(l.menu_item_id));
        if (!m) throw new Error('No such menu item');
        if (!m.available) throw new Error(`${m.name} is currently unavailable`);
        const rule = domain.bestDiscountFor(m, dayparts);
        let price = rule ? domain.discountedPrice(m.price, rule.discount_pct) : m.price;
        const chosen = [];
        const allowed = db.prepare('SELECT group_id FROM menu_item_modifiers WHERE menu_item_id=?').all(m.id).map((g) => g.group_id);
        for (const mod of (Array.isArray(l.modifiers) ? l.modifiers : [])) {
          const opt = db.prepare('SELECT * FROM modifier_options WHERE id=?').get(Number(mod.id));
          if (!opt || !allowed.includes(opt.group_id)) throw new Error('Invalid option');
          chosen.push({ id: opt.id, group_id: opt.group_id, name: opt.name, price: opt.price });
          price += opt.price;
        }
        const reqGroups = db.prepare(`SELECT g.* FROM modifier_groups g JOIN menu_item_modifiers mm ON mm.group_id=g.id
          WHERE mm.menu_item_id=? AND g.required=1`).all(m.id);
        for (const g of reqGroups) if (!chosen.some((c) => c.group_id === g.id)) throw new Error(`Please choose: ${g.name}`);
        ins.run(order.id, m.id, m.name, price, Number(l.qty) || 1, l.note || null, m.station,
          chosen.length ? JSON.stringify(chosen) : null);
      }
    });
    try { tx(); } catch (e) { return bad(res, e.message); }
    audit(null, 'qr.order.add', `${t.name} #${order.number} x${lines.length}`);
    broadcast('orders'); broadcast('kitchen'); broadcast('tables');
    res.json(decorate(readOrder(order.id)));
  });
};

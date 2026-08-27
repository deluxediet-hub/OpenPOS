/* manager.js — dashboard, reports, menu, stock, staff, settings, audit */
'use strict';

const Manager = (() => {
  let top = 'dashboard';
  let sub = null;
  const range = { from: today(), to: today() };
  const canEdit = () => ['seller', 'manager', 'admin'].includes(State.user.role);
  const canManage = () => ['manager', 'admin'].includes(State.user.role);

  /* Eight top-level groups over the SAME existing screens (presentation only). */
  const TOP = [
    ['dashboard', 'Dashboard',   [['dashboard', 'Overview']]],
    ['reports',   'Reports',     [['sales', 'Sales'], ['labour', 'Labour'], ['audit', 'Audit log']]],
    ['menu',      'Products & Pricing', [['menu', 'Products'], ['modifiers', 'Options'], ['recipes', 'Recipes'], ['dayparts', 'Happy Hour']]],
    ['stock',     'Stock',       [['stock', 'Inventory'], ['stocktakes', 'Stocktakes'], ['deliveries', 'Deliveries'], ['suppliers', 'Suppliers']]],
    ['money',     'Cash & Loyalty', [['drawer', 'Cash Drawer'], ['loyalty', 'Loyalty']]],
    ['bookings',  'Bookings',    [['bookings', 'Reservations']]],
    ['team',      'Team',        [['staff', 'Staff']]],
    ['settings',  'Settings',    [['settings', 'Business'], ['printer', 'Printer'], ['integrations', 'eTIMS / M-Pesa']]],
  ];
  const LOCAL = { dashboard, sales, menu, stock, staff, settings, audit };
  const EXT2 = {
    modifiers: 'modifiers', recipes: 'recipes', dayparts: 'dayparts', drawer: 'drawer',
    bookings: 'reservations', loyalty: 'loyalty', labour: 'labour',
    integrations: 'integrations', printer: 'printer'
  };

  function render(host) {
    const retail = State.settings.business_type === 'wines_spirits';
    const retailTop = TOP.filter(([k]) => k !== 'bookings').map(([k, label, children]) => {
      if (k === 'reports') children = children.filter(([id]) => ['sales', 'audit'].includes(id));
      if (k === 'menu') children = children.filter(([id]) => id === 'menu');
      return [k, label, children];
    });
    const sellerTop = TOP.filter(([k]) => ['stock', 'money'].includes(k)).map(([k, label, children]) =>
      [k, k === 'money' ? 'Till & Expenses' : label, k === 'money' ? children.filter(([id]) => id === 'drawer') : children]);
    const visibleTop = State.user.role === 'seller' ? sellerTop : (retail ? retailTop : TOP);
    if (!visibleTop.some(([k]) => k === top)) top = visibleTop[0][0];
    const group = visibleTop.find(([k]) => k === top) || visibleTop[0];
    if (!group[2].some(([k]) => k === sub)) sub = group[2][0][0];
    host.innerHTML = `
      <div class="tabs">${visibleTop.map(([k, l]) =>
        `<button class="tab${top === k ? ' active' : ''}" data-top="${k}">${l}</button>`).join('')}</div>
      ${group[2].length > 1 ? `<div class="tabs subtabs">${group[2].map(([k, l]) =>
        `<button class="tab sub${sub === k ? ' active' : ''}" data-sub="${k}">${l}</button>`).join('')}</div>` : ''}
      <div id="mbody"></div>`;
    host.querySelectorAll('[data-top]').forEach((b) => b.onclick = () => { top = b.dataset.top; sub = null; render(host); });
    host.querySelectorAll('[data-sub]').forEach((b) => b.onclick = () => { sub = b.dataset.sub; render(host); });
    const body = host.querySelector('#mbody');
    if (LOCAL[sub]) LOCAL[sub](body);
    else if (['stocktakes', 'deliveries', 'suppliers'].includes(sub)) Retail[sub](body);
    else Manager2[EXT2[sub]](body);
  }

  /* ---------------------------- dashboard ---------------------------- */
  async function dashboard(body) {
    const retail = State.settings.business_type === 'wines_spirits';
    body.innerHTML = '<div class="empty">Loading dashboard…</div>';
    const [s, items, z, shifts] = await Promise.all([
      api(`/api/reports/summary?from=${range.from}&to=${range.to}`),
      api(`/api/reports/items?from=${range.from}&to=${range.to}`),
      api('/api/zreport?date=' + range.from), api('/api/shifts')
    ]);
    const latestReconciliation = shifts.find((x) => x.status === 'closed');
    const st = await api('/api/stock');
    const low = st.filter((x) => x.qty <= x.min_qty);
    const hourly = await api(`/api/reports/hourly?from=${range.from}`);
    const peak = Math.max(1, ...hourly.map((h) => h.total));

    body.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <span class="muted small">Business date</span>
        <input class="inp" type="date" id="dz" value="${range.from}" style="width:auto">
        <span class="grow"></span>
        <button class="btn ghost" id="zbtn">🖨 Print Z-report</button>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:14px">
        ${stat('Net sales', fmt(s.gross), `${s.orders_closed} receipts`)}
        ${stat('Average ticket', fmt(s.avg_ticket), retail ? `${s.orders_closed} completed sales` : `${s.covers} covers`)}
        ${retail ? stat('Units sold', items.reduce((n, i) => n + i.qty, 0), 'products across completed sales') : stat('Per cover', fmt(s.avg_per_cover), 'guests served')}
        ${stat('Gross profit', fmt(s.gross_profit), s.margin + '% margin · COGS ' + fmt(s.cogs))}
        ${stat('VAT collected', fmt(s.vat_collected), `${State.settings.vat_rate}% (${State.settings.tax_mode})`)}
        ${stat('Discounts & voids', fmt(s.discounts), s.orders_void + (retail ? ' voided sales' : ' voided checks'), 'warn')}
        ${retail ? stat('Complimentary', fmt(s.complimentary_value), `${s.complimentary_count} issue(s) · cost ${fmt(s.complimentary_cost)}`, s.complimentary_cost ? 'warn' : '') : ''}
        ${retail && latestReconciliation ? stat('Latest reconciliation', fmt(latestReconciliation.overall_variance), latestReconciliation.reconciliation_status || 'Closed',
          latestReconciliation.reconciliation_status === 'FULLY BALANCED' ? '' : 'warn') : ''}
      </div>
      <div class="grid" style="grid-template-columns:1.25fr 1fr">
        <div class="card"><div class="card-h"><h3>Sales by hour — ${range.from}</h3></div>
          <div class="card-b">
            <div class="bar-chart">
              ${Array.from({ length: 24 }, (_, h) => {
                const r = hourly.find((x) => Number(x.hour) === h) || { total: 0 };
                return `<div class="b" style="height:${Math.max(2, (r.total / peak) * 100)}%" title="${h}:00 — ${fmt(r.total)}"><span>${h % 3 === 0 ? h : ''}</span></div>`;
              }).join('')}
            </div>
          </div>
        </div>
        <div class="card"><div class="card-h"><h3>Payment methods</h3></div>
          <div class="card-b">
            ${z.by_method.length ? z.by_method.map((m) => {
              const pct = s.gross ? Math.round((m.total / s.gross) * 100) : 0;
              return `<div style="margin-bottom:11px">
                <div class="row" style="justify-content:space-between;font-size:12.5px;margin-bottom:4px">
                  <span>${(m.method || '').toUpperCase()} <span class="muted tiny">(${m.n})</span></span>
                  <b class="mono">${fmt(m.total)}</b></div>
                <div class="pbar"><i style="width:${Math.max(0, m.method === 'refund' ? 0 : pct)}%"></i></div>
                <div class="tiny muted" style="margin-top:3px">${pct}% of takings</div></div>`;
            }).join('') : '<div class="empty">No payments recorded yet today.</div>'}
          </div>
        </div>
      </div>
      <div class="grid" style="grid-template-columns:1.25fr 1fr;margin-top:14px">
        <div class="card"><div class="card-h"><h3>${retail ? 'Top products today' : 'Top sellers today'}</h3></div>
          <div style="max-height:300px;overflow:auto">
            <table class="tbl"><thead><tr><th>#</th><th>Product</th>${retail ? '' : '<th>Station</th>'}<th class="right">Qty</th><th class="right">Revenue</th></tr></thead>
            <tbody>${items.slice(0, retail ? 5 : 12).map((i, n) => `<tr>
              <td class="muted">${n + 1}</td><td><b>${esc(i.name)}</b></td>
              ${retail ? '' : `<td><span class="tag ${i.station}">${i.station}</span></td>`}
              <td class="right mono">${i.qty}</td><td class="right mono">${fmt(i.revenue)}</td></tr>`).join('')
              || `<tr><td colspan="${retail ? 4 : 5}" class="empty">No sales yet.</td></tr>`}</tbody></table>
          </div>
        </div>
        <div class="card"><div class="card-h"><h3>Low stock alerts</h3></div>
          <div style="max-height:300px;overflow:auto">
            ${low.length ? `<table class="tbl"><tbody>${low.map((x) => `<tr>
              <td><b>${esc(x.name)}</b><div class="tiny muted">min ${x.min_qty} ${esc(x.unit)}</div></td>
              <td class="right"><span class="tag ${x.qty <= 0 ? 'bad' : 'warn'}">${esc(stockQtyLabel(x.qty, x.unit, x.capacity_ml))}</span></td></tr>`).join('')}</tbody></table>`
              : '<div class="empty">All stock levels healthy ✓</div>'}
          </div>
        </div>
      </div>`;

    body.querySelector('#dz').onchange = (e) => { range.from = range.to = e.target.value; dashboard(body); };
    body.querySelector('#zbtn').onclick = () => printZReport(z);
  }

  const stat = (l, v, d, tone = '') => `<div class="stat"><div class="l">${l}</div>
    <div class="v" style="${tone === 'warn' ? 'color:var(--red)' : ''}">${v}</div><div class="d">${d}</div></div>`;

  /* ----------------------------- reports ----------------------------- */
  async function sales(body) {
    const retail = State.settings.business_type === 'wines_spirits';
    body.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <label class="fld" style="margin:0">From</label><input class="inp" type="date" id="rf" value="${range.from}" style="width:auto">
        <label class="fld" style="margin:0">To</label><input class="inp" type="date" id="rt" value="${range.to}" style="width:auto">
        ${['today', 'yesterday', '7d', '30d', 'this-month'].map((q) =>
          `<button class="btn sm ghost" data-q="${q}">${q === '7d' ? 'Last 7 days' : q === '30d' ? 'Last 30 days' : q === 'this-month' ? 'This month' : q[0].toUpperCase() + q.slice(1)}</button>`).join('')}
        <span class="grow"></span>
        <button class="btn ghost" id="exp">⬇ Export CSV</button>
        <button class="btn" id="spdf">🖨 Build PDF</button>
      </div>
      <div id="rpt"><div class="empty">Loading…</div></div>`;
    let last = null;
    body.querySelector('#spdf').onclick = () => {
      if (!last) return toast('Run the report first', 'err');
      const options = [
        ['summary', 'Sales summary', 'Sales, refunds, VAT, receipts and average ticket'],
        ['payments', 'Payment methods', 'Cash, Card and M-Pesa totals'],
        ['top', 'Top 5 products', 'Five highest-revenue products'],
        ['itemsall', 'All product sales', 'Quantity, revenue, COGS and margin for every sold product'],
        ['sellers', 'Sales by seller', 'Sales and revenue attributed to each person'],
        ['categories', 'Sales by category', 'Units and revenue by category'],
        ['low', 'Low stock only', 'Products at or below their reorder level'],
        ['expenses', 'Expenses only', 'Cash and M-Pesa expenses for the period'],
        ['complimentary', 'Complimentary issues', 'Owner, staff, friends, tasting and promotion stock'],
        ['stocktake', 'Latest stocktake', 'Expected, counted, quantity variance and financial impact'],
        ['reconciliation', 'Latest reconciliation', 'Cash, M-Pesa, Card, stock and overall operational variance'],
        ['stock', 'Full stock position', 'On-hand quantity and inventory value'],
        ['products', 'Product catalogue', 'Categories, sizes, prices, cost, margin and availability'],
        ['deliveries', 'Stock deliveries', 'Supplier, payment status, lines and delivery value'],
        ['suppliers', 'Supplier directory', 'Contacts, address and KRA PIN'],
        ['stockmoves', 'Stock movement log', 'Sales, deliveries, counts and corrections'],
        ['shifts', 'Till history', 'Opening, closing and overall reconciliation status'],
        ['loyalty', 'Customer loyalty', 'Customer points, visits and total spend'],
        ['giftcards', 'Gift cards', 'Issued value, current balance and liability'],
        ['staff', 'Staff list', 'Role and active status; PINs are never printed'],
        ['audit', 'Audit log', 'Owner-visible operational actions for the selected period']
      ];
      modal({ title: 'Build PDF report', wide: true,
        body: `<p class="muted" style="margin-top:0">Nothing is selected by default. Choose only the sections this PDF should contain.</p>
          <div class="grid2">${options.map(([id, title, help]) => `<label class="card" style="cursor:pointer"><div class="card-b row" style="align-items:flex-start">
            <input type="checkbox" data-pdf="${id}"><span><b>${title}</b><br><span class="tiny muted">${help}</span></span></div></label>`).join('')}</div>`,
        footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Generate selected PDF</button>' });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        const selected = new Set([...ov.querySelectorAll('[data-pdf]:checked')].map((x) => x.dataset.pdf));
        if (!selected.size) return toast('Select at least one report section', 'err');
        const { q, t, s: sm, items, waiters, cats, comps } = last;
        try {
          const [stock, expenses, stocktakes, reconciliations, products, deliveries, suppliers, stockMoves, staff, auditRows, customers, giftCards] = await Promise.all([
            selected.has('low') || selected.has('stock') ? api('/api/stock') : Promise.resolve([]),
            selected.has('expenses') ? api(`/api/reports/expenses?from=${q}&to=${t}`) : Promise.resolve([]),
            selected.has('stocktake') ? api('/api/stock-counts') : Promise.resolve([]),
            selected.has('reconciliation') || selected.has('shifts') ? api('/api/shifts') : Promise.resolve([]),
            selected.has('products') ? api('/api/menu') : Promise.resolve([]),
            selected.has('deliveries') ? api('/api/goods-receipts') : Promise.resolve([]),
            selected.has('suppliers') ? api('/api/suppliers') : Promise.resolve([]),
            selected.has('stockmoves') ? api('/api/stock-moves?limit=500') : Promise.resolve([]),
            selected.has('staff') ? api('/api/users') : Promise.resolve([]),
            selected.has('audit') ? api('/api/audit?limit=1000') : Promise.resolve([]),
            selected.has('loyalty') ? api('/api/customers') : Promise.resolve([]),
            selected.has('giftcards') ? api('/api/gift-cards') : Promise.resolve([])
          ]);
          const inPeriod = (value) => String(value || '').slice(0, 10) >= q && String(value || '').slice(0, 10) <= t;
          const latestReconciliation = reconciliations.find((x) => x.status === 'closed' && inPeriod(x.closed_at));
          const periodShifts = reconciliations.filter((x) => inPeriod(x.closed_at || x.opened_at));
          const periodDeliveries = deliveries.filter((x) => inPeriod(x.received_at));
          const periodMoves = stockMoves.filter((x) => inPeriod(x.created_at));
          const periodAudit = auditRows.filter((x) => inPeriod(x.created_at));
          const latestCount = stocktakes.find((x) => x.status === 'completed' && (x.completed_at || '').slice(0, 10) >= q && (x.completed_at || '').slice(0, 10) <= t);
          const stocktake = latestCount ? await api('/api/stock-counts/' + latestCount.id) : null;
          const tables = [];
          if (selected.has('summary')) tables.push({ title: 'Sales summary', head: ['Metric', 'Value'], right: [1], rows: [
            ['Net sales', fmt(sm.gross)], ['Gross takings', fmt(sm.paid)], ['Refunds', '-' + fmt(sm.refunded)],
            ['VAT included', fmt(sm.vat_collected)], ['Discounts', fmt(sm.discounts)], ['Receipts closed', String(sm.orders_closed)],
            [retail ? 'Units sold' : 'Covers', String(retail ? items.reduce((n, i) => n + Number(i.qty || 0), 0) : sm.covers)],
            ['Average ticket', fmt(sm.avg_ticket)],
            ...(retail ? [['Complimentary retail value', fmt(sm.complimentary_value)], ['Complimentary inventory cost', fmt(sm.complimentary_cost)]] : []) ] });
          if (selected.has('payments')) tables.push({ title: 'Payment methods', head: ['Method', 'Transactions', 'Total'], right: [1, 2],
            rows: sm.by_method.map((m) => [m.method.toUpperCase(), String(m.n), (m.total / 100).toFixed(2)]),
            footer: ['TOTAL', String(sm.by_method.reduce((n, m) => n + m.n, 0)), (sm.by_method.reduce((n, m) => n + m.total, 0) / 100).toFixed(2)] });
          if (selected.has('top')) { const top = items.slice(0, 5); tables.push({ title: 'Top 5 products', head: ['Product', 'Qty', 'Revenue'], right: [1, 2],
            rows: top.map((i) => [i.name, String(i.qty), (i.revenue / 100).toFixed(2)]),
            footer: ['TOP 5 TOTAL', String(top.reduce((n, i) => n + Number(i.qty), 0)), (top.reduce((n, i) => n + i.revenue, 0) / 100).toFixed(2)] }); }
          if (selected.has('itemsall')) tables.push({ title: 'All product sales',
            head: ['Product', 'Qty', 'Revenue', 'COGS', 'Margin'], right: [1,2,3,4],
            rows: items.map((x) => [x.name, String(x.qty), (x.revenue/100).toFixed(2), ((x.cogs||0)/100).toFixed(2),
              x.revenue ? Math.round((x.revenue-(x.cogs||0))/x.revenue*100)+'%' : '—']),
            footer: ['TOTAL', String(items.reduce((n,x) => n+Number(x.qty),0)), (items.reduce((n,x)=>n+x.revenue,0)/100).toFixed(2),
              (items.reduce((n,x)=>n+(x.cogs||0),0)/100).toFixed(2), ''] });
          if (selected.has('sellers')) tables.push({ title: 'Sales by seller', head: ['Seller', 'Sales', 'Revenue'], right: [1, 2],
            rows: waiters.map((w) => [w.waiter || 'Unassigned', String(w.orders), (w.revenue / 100).toFixed(2)]),
            footer: ['TOTAL', String(waiters.reduce((n, w) => n + w.orders, 0)), (waiters.reduce((n, w) => n + w.revenue, 0) / 100).toFixed(2)] });
          if (selected.has('categories')) tables.push({ title: 'Sales by category', head: ['Category', 'Qty', 'Revenue'], right: [1, 2],
            rows: cats.map((c) => [c.category, String(c.qty), (c.revenue / 100).toFixed(2)]),
            footer: ['TOTAL', String(cats.reduce((n, c) => n + Number(c.qty), 0)), (cats.reduce((n, c) => n + c.revenue, 0) / 100).toFixed(2)] });
          if (selected.has('low')) { const low = stock.filter((x) => x.qty <= x.min_qty); tables.push({ title: 'Low stock',
            head: ['Product', 'On hand', 'Reorder at', 'Unit cost', 'Stock value'], right: [1, 2, 3, 4],
            rows: low.map((x) => [x.name, stockQtyLabel(x.qty, x.unit, x.capacity_ml), `${roundStock(x.min_qty)} ${x.unit}`,
              (x.cost / 100).toFixed(2), (x.qty * x.cost / 100).toFixed(2)]),
            footer: [`${low.length} LOW PRODUCT(S)`, '', '', '', (low.reduce((n, x) => n + x.qty * x.cost, 0) / 100).toFixed(2)] }); }
          if (selected.has('expenses')) tables.push({ title: 'Expenses', head: ['Date', 'Paid via', 'Amount', 'Reason', 'Recorded by'], right: [2],
            rows: expenses.map((x) => [(x.created_at || '').slice(0, 16), String(x.method || 'cash').toUpperCase(),
              (x.amount / 100).toFixed(2), x.reason || '', x.user_name || '—']),
            footer: ['TOTAL', '', (expenses.reduce((n, x) => n + x.amount, 0) / 100).toFixed(2), '', ''] });
          if (selected.has('complimentary')) tables.push({ title: 'Complimentary issues',
            head: ['Date', 'Product', 'Qty', 'Recipient', 'Reason', 'Recorded / Authorized', 'Reference', 'Retail / Cost'], right: [2, 7],
            rows: comps.map((x) => [(x.created_at || '').slice(0, 16), x.item_name, String(x.qty), x.recipient || '—', x.reason,
              `${x.created_by_name || '—'} / ${x.authorized_by_name || '—'}`, x.authorization_reference || '—',
              `${(x.retail_value / 100).toFixed(2)} / ${(x.cost_value / 100).toFixed(2)}`]),
            footer: ['TOTAL', '', String(comps.reduce((n, x) => n + Number(x.qty), 0)), '', '', '', '',
              `${(comps.reduce((n, x) => n + x.retail_value, 0) / 100).toFixed(2)} / ${(comps.reduce((n, x) => n + x.cost_value, 0) / 100).toFixed(2)}`] });
          if (selected.has('stocktake')) {
            tables.push({ title: stocktake ? `Stocktake — ${stocktake.reference}` : 'Stocktake',
              head: ['Product', 'Expected (system + added)', 'Counted', 'Variance', 'Cost impact', 'Retail impact'], right: [1, 2, 3, 4, 5],
              rows: stocktake ? stocktake.items.map((x) => [x.name,
                  `${roundStock(x.expected)} + ${roundStock(x.added_qty || 0)} = ${stockQtyLabel(x.expected + (x.added_qty || 0), x.unit, x.capacity_ml)}`,
                  stockQtyLabel(x.counted, x.unit, x.capacity_ml),
                  `${x.variance > 0 ? '+' : ''}${roundStock(x.variance, 4)} ${x.unit}`, (x.cost_variance / 100).toFixed(2), (x.retail_variance / 100).toFixed(2)])
                : [['No completed stocktake in this period', '', '', '', '', '']],
              footer: stocktake ? ['TOTAL FINANCIAL IMPACT', '', '', '', (stocktake.cost_variance / 100).toFixed(2), (stocktake.retail_variance / 100).toFixed(2)] : null });
          }
          if (selected.has('reconciliation')) tables.push({ title: 'Latest operational reconciliation', head: ['Metric', 'Value'], right: [1],
            rows: latestReconciliation ? [
              ['Cash variance', fmt(latestReconciliation.variance)], ['M-Pesa variance', fmt(latestReconciliation.mpesa_variance)],
              ['Card/EDC variance', fmt(latestReconciliation.card_variance)], ['Total tender variance', fmt(latestReconciliation.tender_variance)],
              ['Stock variance at retail', fmt(latestReconciliation.stock_retail_variance)],
              ['Overall operational variance', fmt(latestReconciliation.overall_variance)],
              ['Status', latestReconciliation.reconciliation_status || '—'], ['Note', latestReconciliation.reconciliation_note || '—']
            ] : [['No closed reconciliation in this period', '']] });
          if (selected.has('stock')) tables.push({ title: 'Stock position', head: ['Product', 'On hand', 'Unit cost', 'Value'], right: [1, 2, 3],
            rows: stock.map((x) => [x.name, stockQtyLabel(x.qty, x.unit, x.capacity_ml), (x.cost / 100).toFixed(2), (x.qty * x.cost / 100).toFixed(2)]),
            footer: [`TOTAL · ${stock.length} PRODUCT(S)`, '', '', (stock.reduce((n, x) => n + x.qty * x.cost, 0) / 100).toFixed(2)] });
          if (selected.has('products')) tables.push({ title: 'Product catalogue',
            head: ['Product', 'Category', 'Size', 'Selling price', 'Cost', 'Margin', 'Status'], right: [2, 3, 4, 5],
            rows: products.map((x) => [x.name, x.category_name, x.volume_ml ? `${x.volume_ml}ml` : '—',
              (x.price / 100).toFixed(2), (x.cost / 100).toFixed(2), x.price ? Math.round((x.price - x.cost) / x.price * 100) + '%' : '—', x.available ? 'Available' : 'Unavailable']),
            footer: [`TOTAL · ${products.length} PRODUCT(S)`, '', '', '', '', '', `${products.filter((x) => x.available).length} available`] });
          if (selected.has('deliveries')) tables.push({ title: 'Stock deliveries',
            head: ['Date', 'Reference', 'Supplier', 'Payment', 'Lines', 'Value', 'Received by'], right: [4, 5],
            rows: periodDeliveries.map((x) => [(x.received_at || '').slice(0,16), x.invoice_no, x.supplier_name || 'Not listed',
              x.payment_method === 'pay_later' ? 'PAY LATER' : String(x.payment_method || '').toUpperCase(), String(x.lines),
              (x.total_cost / 100).toFixed(2), x.received_by_name || '—']),
            footer: [`TOTAL · ${periodDeliveries.length} DELIVERY(IES)`, '', '', '', String(periodDeliveries.reduce((n,x) => n + x.lines, 0)),
              (periodDeliveries.reduce((n,x) => n + x.total_cost, 0) / 100).toFixed(2), ''] });
          if (selected.has('suppliers')) tables.push({ title: 'Supplier directory',
            head: ['Supplier', 'Phone', 'Email', 'KRA PIN', 'Address'], rows: suppliers.map((x) => [x.name, x.phone || '—', x.email || '—', x.kra_pin || '—', x.address || '—']),
            footer: [`TOTAL · ${suppliers.length} SUPPLIER(S)`, '', '', '', ''] });
          if (selected.has('stockmoves')) tables.push({ title: 'Stock movement log',
            head: ['Date', 'Product', 'Change', 'Reason', 'By'], right: [2],
            rows: periodMoves.map((x) => [(x.created_at || '').slice(0,16), x.name, `${x.delta > 0 ? '+' : ''}${roundStock(x.delta,4)} ${x.unit}`, x.reason || '—', x.user_name || 'system']),
            footer: [`TOTAL · ${periodMoves.length} MOVEMENT(S)`, '', '', '', ''] });
          if (selected.has('shifts')) tables.push({ title: 'Till and reconciliation history',
            head: ['Closed', 'By', 'Cash var.', 'M-Pesa var.', 'Card var.', 'Stock retail var.', 'Overall', 'Status'], right: [2,3,4,5,6],
            rows: periodShifts.map((x) => [(x.closed_at || x.opened_at || '').slice(0,16), x.closed_by_name || x.opened_by_name || '—',
              ((x.variance || 0)/100).toFixed(2), ((x.mpesa_variance || 0)/100).toFixed(2), ((x.card_variance || 0)/100).toFixed(2),
              ((x.stock_retail_variance || 0)/100).toFixed(2), ((x.overall_variance || 0)/100).toFixed(2), x.reconciliation_status || x.status]),
            footer: [`TOTAL · ${periodShifts.length} TILL(S)`, '', '', '', '', '', (periodShifts.reduce((n,x) => n + (x.overall_variance || 0),0)/100).toFixed(2), ''] });
          if (selected.has('loyalty')) { const redeem = Number(State.settings.loyalty_redeem_per) || 1; tables.push({ title: 'Customer loyalty',
            head: ['Customer', 'Phone', 'Points', 'Points value', 'Visits', 'Total spend'], right: [2,3,4,5],
            rows: customers.map((x) => [x.name, x.phone || '—', String(x.points), (x.points*redeem).toFixed(2), String(x.visits), (x.total_spend/100).toFixed(2)]),
            footer: [`TOTAL · ${customers.length} CUSTOMER(S)`, '', String(customers.reduce((n,x)=>n+x.points,0)),
              (customers.reduce((n,x)=>n+x.points*redeem,0)).toFixed(2), String(customers.reduce((n,x)=>n+x.visits,0)),
              (customers.reduce((n,x)=>n+x.total_spend,0)/100).toFixed(2)] }); }
          if (selected.has('giftcards')) tables.push({ title: 'Gift cards',
            head: ['Code', 'Holder', 'Issued value', 'Balance', 'Issued', 'Status'], right: [2,3],
            rows: giftCards.map((x) => [x.code, x.customer_name || '—', (x.value/100).toFixed(2), (x.balance/100).toFixed(2), (x.created_at||'').slice(0,10), x.status]),
            footer: [`TOTAL · ${giftCards.length} CARD(S)`, '', (giftCards.reduce((n,x)=>n+x.value,0)/100).toFixed(2),
              (giftCards.filter((x)=>x.status==='active').reduce((n,x)=>n+x.balance,0)/100).toFixed(2), '', 'ACTIVE LIABILITY'] });
          if (selected.has('staff')) tables.push({ title: 'Staff list', head: ['Name', 'Role', 'Status'],
            rows: staff.map((x) => [x.name, x.role, x.active ? 'Active' : 'Disabled']),
            footer: [`TOTAL · ${staff.length} ACCOUNT(S)`, '', `${staff.filter((x) => x.active).length} active`] });
          if (selected.has('audit')) tables.push({ title: 'Audit log', head: ['Date', 'Who', 'Action', 'Detail'],
            rows: periodAudit.map((x) => [x.created_at, x.user_name || 'system', x.action, x.detail || '']),
            footer: [`TOTAL · ${periodAudit.length} EVENT(S)`, '', '', ''] });
          closeModal();
          printReport({ title: 'Custom Management Report', subtitle: `Period ${q} to ${t}`, tables, signature: false });
        } catch (e) { toast(e.message, 'err'); }
      };
    };

    const go = async () => {
      const q = body.querySelector('#rf').value, t = body.querySelector('#rt').value;
      const [s, items, waiters, cats, comps] = await Promise.all([
        api(`/api/reports/summary?from=${q}&to=${t}`),
        api(`/api/reports/items?from=${q}&to=${t}`),
        api(`/api/reports/waiters?from=${q}&to=${t}`),
        api(`/api/reports/categories?from=${q}&to=${t}`),
        retail ? api(`/api/complimentaries?from=${q}&to=${t}`) : Promise.resolve([])
      ]);
      last = { q, t, s, items, waiters, cats, comps };
      body.querySelector('#rpt').innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px">
          ${stat('Net sales', fmt(s.gross), s.orders_closed + ' receipts')}
          ${stat('Gross takings', fmt(s.paid), 'before refunds')}
          ${stat('Refunds', '−' + fmt(s.refunded), 'returned to customers', s.refunded ? 'warn' : '')}
          ${stat('VAT', fmt(s.vat_collected), State.settings.vat_rate + '%')}
          ${stat('Tips', fmt(s.tips), 'staff gratuities')}
          ${stat('Discounts', fmt(s.discounts), s.orders_void + ' voids')}
          ${retail ? stat('Complimentary', fmt(s.complimentary_value), `${s.complimentary_count} issue(s) · cost ${fmt(s.complimentary_cost)}`, s.complimentary_cost ? 'warn' : '') : ''}
        </div>
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <div class="card"><div class="card-h"><h3>Sales by ${retail ? 'seller' : 'waiter'}</h3></div>
            <table class="tbl"><thead><tr><th>${retail ? 'Seller' : 'Waiter'}</th><th class="right">${retail ? 'Sales' : 'Checks'}</th>${retail ? '' : '<th class="right">Covers</th>'}<th class="right">Revenue</th></tr></thead>
            <tbody>${waiters.map((w) => `<tr><td><b>${esc(w.waiter || 'Unassigned')}</b></td>
              <td class="right mono">${w.orders}</td>${retail ? '' : `<td class="right mono">${w.covers}</td>`}
              <td class="right mono"><b>${fmt(w.revenue)}</b></td></tr>`).join('') || `<tr><td colspan="${retail ? 3 : 4}" class="empty">No data.</td></tr>`}</tbody></table>
          </div>
          <div class="card"><div class="card-h"><h3>Sales by category</h3></div>
            <table class="tbl"><thead><tr><th>Category</th>${retail ? '' : '<th>Station</th>'}<th class="right">Qty</th><th class="right">Revenue</th></tr></thead>
            <tbody>${cats.map((c) => `<tr><td><b>${esc(c.category)}</b></td>
              ${retail ? '' : `<td><span class="tag ${c.station}">${c.station}</span></td>`}
              <td class="right mono">${c.qty}</td><td class="right mono"><b>${fmt(c.revenue)}</b></td></tr>`).join('')
              || `<tr><td colspan="${retail ? 3 : 4}" class="empty">No data.</td></tr>`}</tbody></table>
          </div>
        </div>
        <div class="card" style="margin-top:14px"><div class="card-h"><h3>Item performance</h3>
          <span class="grow"></span><span class="muted tiny">${items.length} items sold</span></div>
          <div class="scroll-x"><table class="tbl">
            <thead><tr><th>${retail ? 'Product' : 'Item'}</th>${retail ? '' : '<th>Station</th>'}<th class="right">Lines</th><th class="right">Qty</th>
            <th class="right">COGS</th><th class="right">Revenue</th><th class="right">Margin</th></tr></thead>
            <tbody>${items.map((i) => {
              const marg = i.revenue ? Math.round(((i.revenue - (i.cogs || 0)) / i.revenue) * 100) : 0;
              return `<tr><td><b>${esc(i.name)}</b></td>${retail ? '' : `<td><span class="tag ${i.station}">${i.station}</span></td>`}
                <td class="right mono">${i.lines}</td><td class="right mono">${i.qty}</td>
                <td class="right mono muted">${fmt(i.cogs || 0)}</td>
                <td class="right mono"><b>${fmt(i.revenue)}</b></td>
                <td class="right"><span class="tag ${marg >= 60 ? 'ok' : marg >= 40 ? 'warn' : 'bad'}">${marg}%</span></td></tr>`;
            }).join('') || `<tr><td colspan="${retail ? 6 : 7}" class="empty">No sales in this range.</td></tr>`}</tbody></table></div>
        </div>
        ${retail ? `<div class="card" style="margin-top:14px"><div class="card-h"><h3>Complimentary issues</h3><span class="grow"></span><span class="muted tiny">No cash is expected; inventory cost is tracked separately</span></div>
          <div class="scroll-x"><table class="tbl"><thead><tr><th>When</th><th>Product</th><th>Qty</th><th>Recipient</th><th>Reason</th><th>Recorded by</th><th>Authorized by</th><th>Reference</th><th class="right">Retail value</th><th class="right">Cost</th></tr></thead>
          <tbody>${comps.map((x) => `<tr><td class="nowrap muted">${(x.created_at || '').slice(0,16)}</td><td><b>${esc(x.item_name)}</b></td><td>${x.qty}</td>
            <td>${esc(x.recipient || '—')}</td><td>${esc(x.reason)}</td><td>${esc(x.created_by_name || '—')}</td><td><b>${esc(x.authorized_by_name || '—')}</b></td>
            <td>${esc(x.authorization_reference || '—')}</td><td class="right">${fmt(x.retail_value)}</td><td class="right">${fmt(x.cost_value)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">No complimentary stock issued in this period.</td></tr>'}</tbody></table></div></div>` : ''}`;
      window.__rptCsv = { s, items, waiters, cats, q, t };
    };

    body.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => {
      const d = new Date();
      const iso = (x) => { const q = (n) => String(n).padStart(2, '0');
        return `${x.getFullYear()}-${q(x.getMonth() + 1)}-${q(x.getDate())}`; };  // local, not UTC
      if (b.dataset.q === 'today') { range.from = range.to = iso(d); }
      if (b.dataset.q === 'yesterday') { d.setDate(d.getDate() - 1); range.from = range.to = iso(d); }
      if (b.dataset.q === '7d') { range.to = iso(d); d.setDate(d.getDate() - 6); range.from = iso(d); }
      if (b.dataset.q === '30d') { range.to = iso(d); d.setDate(d.getDate() - 29); range.from = iso(d); }
      if (b.dataset.q === 'this-month') { range.to = iso(d); range.from = iso(new Date(d.getFullYear(), d.getMonth(), 1)); }
      body.querySelector('#rf').value = range.from; body.querySelector('#rt').value = range.to; go();
    });
    body.querySelector('#rf').onchange = (e) => { range.from = e.target.value; go(); };
    body.querySelector('#rt').onchange = (e) => { range.to = e.target.value; go(); };
    body.querySelector('#exp').onclick = () => {
      const r = window.__rptCsv; if (!r) return toast('Load a report first', 'err');
      const rows = retail
        ? [['Product', 'Qty', 'Revenue', 'COGS'], ...r.items.map((i) => [i.name, i.qty, (i.revenue / 100).toFixed(2), ((i.cogs || 0) / 100).toFixed(2)])]
        : [['Item', 'Station', 'Qty', 'Revenue', 'COGS'], ...r.items.map((i) => [i.name, i.station, i.qty, (i.revenue / 100).toFixed(2), ((i.cogs || 0) / 100).toFixed(2)])];
      const csv = rows.map((x) => x.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `sales-${r.q}-to-${r.t}.csv`; a.click();
    };
    go();
  }

  /* ------------------------------ menu ------------------------------- */
  let menuCat = null, menuSearch = '', menuSearchTimer = null;
  function menu(body) {
    const cats = State.categories, retail = State.settings.business_type === 'wines_spirits';
    if (menuCat === null && cats.length) menuCat = cats[0].id;
    const items = State.menu.filter((m) =>
      (menuCat === null || m.category_id === menuCat) &&
      (!menuSearch || [m.name, m.sku, m.barcode].some((v) => String(v || '').toLowerCase().includes(menuSearch.toLowerCase()))));

    body.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <input class="inp" id="ms" placeholder="Search products…" value="${esc(menuSearch)}" style="max-width:240px">
        <span class="grow"></span>
        ${canEdit() ? `${State.user.role === 'admin' && retail ? '<button class="btn ghost" id="csvTemplate">CSV template</button><button class="btn ghost" id="csvImport">Import CSV</button>' : ''}
          <button class="btn ghost" id="addCat">+ Category</button>
          <button class="btn primary" id="add">+ New product</button>` : '<span class="tag info">Read only</span>'}
      </div>
      <div class="pos catalogue-admin" style="grid-template-columns:230px 1fr;height:auto">
        <div class="card category-panel" style="align-self:start">
          <div class="card-h"><h3>Categories</h3></div>
          <div style="padding:8px">
            <button class="btn sm ${menuCat === null ? 'primary' : 'ghost'}" data-c="null" style="width:100%;justify-content:flex-start;margin-bottom:4px">All (${State.menu.length})</button>
            ${cats.map((c) => `<button class="btn sm ${menuCat === c.id ? 'primary' : 'ghost'}" data-c="${c.id}"
              style="width:100%;justify-content:flex-start;margin-bottom:4px">
              ${esc(c.name)} <span class="muted tiny">${State.menu.filter((m) => m.category_id === c.id).length}</span></button>`).join('')}
          </div>
        </div>
        <div class="card"><div class="card-h"><h3>${menuCat === null ? 'All products' : esc((cats.find((c) => c.id === menuCat) || {}).name)}</h3>
          <span class="grow"></span><span class="muted tiny">${items.length} products</span></div>
          <div class="scroll-x"><table class="tbl">
            <thead><tr><th>Product / code</th><th>Category</th><th class="right">Stock</th><th class="right">Cost</th>
            <th class="right">Price</th><th class="right">Margin</th><th>Avail</th><th></th></tr></thead>
            <tbody>${items.map((m) => {
              const marg = m.price ? Math.round(((m.price - m.cost) / m.price) * 100) : 0;
              return `<tr>
                <td><b>${esc(m.name)}</b><div class="tiny muted mono">${esc(m.sku || '')}${m.sku && m.barcode ? ' · ' : ''}${esc(m.barcode || '')}</div></td>
                <td class="muted small">${esc(m.category_name)}</td>
                <td class="right mono"><span class="tag ${m.stock_qty <= 0 ? 'bad' : m.stock_qty <= m.stock_min_qty ? 'warn' : 'ok'}">${m.stock_mode === 'pour' && m.stock_deduction ? `${Math.floor(m.stock_qty / m.stock_deduction)} servings` : stockQtyLabel(m.stock_qty, m.stock_unit || 'unit', m.stock_capacity_ml)}</span></td>
                <td class="right mono muted">${fmt(m.cost)}</td>
                <td class="right mono"><b>${fmt(m.price)}</b></td>
                <td class="right"><span class="tag ${marg >= 60 ? 'ok' : marg >= 40 ? 'warn' : 'bad'}">${marg}%</span></td>
                <td>${canEdit() ? `<button class="btn xs ${m.available ? 'green' : 'red'}" data-avail="${m.id}">${m.available ? 'Available' : (retail ? 'Unavailable' : '86')}</button>`
                  : `<span class="tag ${m.available ? 'ok' : 'bad'}">${m.available ? 'yes' : (retail ? 'unavailable' : '86')}</span>`}</td>
                <td class="right nowrap">${canEdit() ? `<button class="btn xs ghost" data-e="${m.id}">Edit</button>
                  <button class="btn xs red" data-d="${m.id}">×</button>` : ''}</td>
              </tr>`;
            }).join('') || '<tr><td colspan="8" class="empty">No items.</td></tr>'}</tbody></table></div>
        </div>
      </div>`;

    const menuSearchInput = body.querySelector('#ms');
    menuSearchInput.oninput = (e) => {
      menuSearch = e.target.value; clearTimeout(menuSearchTimer);
      menuSearchTimer = setTimeout(() => menu(body), 120);
    };
    if (menuSearch) setTimeout(() => { const i = body.querySelector('#ms'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0);
    body.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => {
      menuCat = b.dataset.c === 'null' ? null : Number(b.dataset.c); menu(body);
    });
    if (canEdit()) {
      body.querySelector('#csvTemplate')?.addEventListener('click', downloadProductCsvTemplate);
      body.querySelector('#csvImport')?.addEventListener('click', () => {
        modal({ title: 'Bulk import products', body: `<p class="muted" style="margin-top:0">Upload the OpenPOS CSV template. The entire file is validated and imported as one transaction—an invalid row imports nothing.</p>
          <label class="fld">Product CSV</label><input class="inp" type="file" id="productCsvFile" accept=".csv,text/csv">
          <div class="tiny muted" style="margin-top:10px">Required: name, category, size_ml and price. Optional columns support stock, barcode, weighed kegs and pours linked by source_sku.</div>`,
          footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Import products</button>' });
        const ov = document.querySelector('#modalRoot .ov');
        ov.querySelector('[data-no]').onclick = closeModal;
        ov.querySelector('[data-yes]').onclick = async () => {
          const file = ov.querySelector('#productCsvFile').files[0];
          if (!file) return toast('Choose a CSV file', 'err');
          try {
            const result = await api('/api/products/import', { body: { csv: await file.text() } });
            closeModal(); await reload(); menu(body); toast(`${result.imported} products imported`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      });
      body.querySelector('#add').onclick = () => itemForm(null, body);
      body.querySelector('#addCat').onclick = () => catForm(body);
      body.querySelectorAll('[data-avail]').forEach((b) => b.onclick = async () => {
        const m = State.menu.find((x) => x.id === Number(b.dataset.avail));
        await api('/api/menu-items/' + m.id, { method: 'PUT', body: { available: m.available ? 0 : 1 } });
        await reload(); menu(body); toast(m.available ? m.name + ' marked unavailable' : m.name + ' is available again', 'ok');
      });
      body.querySelectorAll('[data-e]').forEach((b) => b.onclick = () =>
        itemForm(State.menu.find((x) => x.id === Number(b.dataset.e)), body));
      body.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => {
        const m = State.menu.find((x) => x.id === Number(b.dataset.d));
        confirmBox('Delete ' + m.name, 'This removes the item from the menu. Past sales keep their name.', {
          danger: true, okLabel: 'Delete', onOk: async () => {
            await api('/api/menu-items/' + m.id, { method: 'DELETE' }); await reload(); menu(body); toast('Deleted', 'ok');
          } });
      });
    }
  }

  function catForm(body) {
    const retail = State.settings.business_type === 'wines_spirits';
    modal({
      title: 'New category',
      body: `<label class="fld">Category name</label><input class="inp" id="cn" placeholder="${retail ? 'e.g. Whisky, Wine, Beer & Cider' : 'e.g. Weekend Brunch'}">
        ${retail ? '<p class="tiny muted" style="margin-top:10px">Categories group products on the till and in sales reports.</p>' : `<div style="margin-top:12px"><label class="fld">Preparation station</label>
          <select class="inp" id="cs"><option value="kitchen">Kitchen</option><option value="bar">Bar</option></select></div>`}`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Create category</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const name = ov.querySelector('#cn').value.trim();
      if (!name) return toast('Category name is required', 'err');
      try {
        await api('/api/categories', { body: { name, station: retail ? 'retail' : ov.querySelector('#cs').value } });
        closeModal(); await reload(); menu(body); toast('Category added', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function itemForm(m, body) {
    const isNew = !m, retail = State.settings.business_type === 'wines_spirits';
    if (!State.categories.length) return toast('Create a category before adding products', 'err');
    m = m || { name: '', price: 0, cost: 0, station: retail ? 'retail' : 'kitchen', available: 1,
      category_id: menuCat || State.categories[0].id, volume_ml: 750, stock_unit: 'bottle', stock_min_qty: 4 };
    const sizes = [25, 30, 35, 50, 100, 125, 150, 175, 200, 250, 300, 330, 350, 375, 500, 700, 750,
      1000, 1500, 2000, 3000, 4500, 5000, 10000, 20000, 30000, 50000];
    const currentSize = Number(m.volume_ml) || 750;
    const sizeOptions = [...(!sizes.includes(currentSize) ? [currentSize] : []), ...sizes]
      .map((v) => `<option value="${v}" ${v === currentSize ? 'selected' : ''}>${v >= 1000 ? (v / 1000) + ' L' : v + ' ml'}</option>`).join('');
    const unit = m.sale_unit && m.sale_unit !== 'piece' ? m.sale_unit
      : (m.stock_mode === 'pour' ? (m.stock_unit === 'keg' ? 'glass' : 'shot') : (m.stock_unit || 'bottle'));
    const stockMode = m.stock_mode || 'unit';
    const sourceContainerMl = stockMode === 'pour' && m.stock_deduction
      ? Math.round((m.serving_ml || m.volume_ml || 1) / m.stock_deduction) : 750;
    const sourceOptions = State.stock.map((x) => `<option value="${x.id}" ${x.id === m.stock_item_id ? 'selected' : ''}>${esc(x.name)} · ${esc(stockQtyLabel(x.qty, x.unit, x.capacity_ml))}</option>`).join('');
    const retailIdentity = `<div class="grid3" style="margin-top:12px">
      <div><label class="fld">Size</label><select class="inp" id="ivol">${sizeOptions}</select></div>
      <div><label class="fld">Category</label><select class="inp" id="icat">${State.categories.map((c) =>
        `<option value="${c.id}" ${c.id === m.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label class="fld">Selling unit</label><select class="inp" id="iunit">${['bottle','can','pack','crate','carton','piece','keg','kg','shot','glass'].map((u) =>
        `<option value="${u}" ${u === unit ? 'selected' : ''}>${u[0].toUpperCase() + u.slice(1)}</option>`).join('')}</select></div>
    </div>`;
    const legacyIdentity = `<div class="grid3" style="margin-top:12px">
      <div><label class="fld">Category</label><select class="inp" id="icat">${State.categories.map((c) =>
        `<option value="${c.id}" ${c.id === m.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label class="fld">Station</label><select class="inp" id="ist"><option value="kitchen" ${m.station === 'kitchen' ? 'selected' : ''}>Kitchen</option><option value="bar" ${m.station === 'bar' ? 'selected' : ''}>Bar</option></select></div>
      <div><label class="fld">Volume (ml)</label><input class="inp" id="ivol" type="number" min="0" value="${m.volume_ml || ''}"></div>
    </div>`;
    modal({
      title: isNew ? 'New product' : 'Edit — ' + m.name,
      body: `<label class="fld">Product name</label><input class="inp" id="in" value="${esc(m.name)}" placeholder="e.g. Jameson Irish Whiskey">
        ${retail ? retailIdentity : legacyIdentity}
        ${retail ? `<div class="card" style="margin-top:12px;background:#101820"><div class="card-b">
          <div class="grid2"><div><label class="fld">Stock deduction</label><select class="inp" id="imode" ${isNew ? '' : 'disabled'}>
            <option value="unit" ${stockMode === 'unit' ? 'selected' : ''}>Whole unit — bottle, can, pack or keg</option>
            <option value="weighed" ${stockMode === 'weighed' ? 'selected' : ''}>Weighed keg source — adjust actual kg at stocktake</option>
            <option value="pour" ${stockMode === 'pour' ? 'selected' : ''}>Pour / shot from a tracked bottle or keg</option></select></div>
            <div class="tiny muted" style="align-self:end;padding-bottom:10px">Pour mode deducts only the serving fraction from its source stock.</div></div>
          <div class="grid2 ${stockMode === 'pour' ? '' : 'hidden'}" id="pourFields" style="margin-top:12px">
            <div><label class="fld">Source bottle or keg</label><select class="inp" id="isource"><option value="">Choose tracked stock…</option>${sourceOptions}</select></div>
            <div><label class="fld">Full source size (ml)</label><input class="inp" id="isourcevol" type="number" min="1" value="${sourceContainerMl}" placeholder="750 bottle or 20000 keg"></div>
          </div>
        </div></div>` : ''}
        <div class="grid3" style="margin-top:12px">
          <div><label class="fld">SKU / shop code</label><input class="inp mono" id="isku" value="${esc(m.sku || '')}" placeholder="WHI-JAM-750"></div>
          <div><label class="fld">Barcode</label><input class="inp mono" id="ibar" value="${esc(m.barcode || '')}" inputmode="numeric" placeholder="Scan or type EAN/UPC"></div>
          <div><label class="fld">KRA classification</label><input class="inp mono" id="ikra" value="${esc(m.kra_item_code || '')}" placeholder="For live eTIMS"></div>
        </div>
        <div class="grid3" style="margin-top:12px">
          <div><label class="fld">Selling price (${sym()}, VAT incl.)</label><input class="inp" id="ip" type="number" min="0" step="0.01" value="${(m.price/100).toFixed(2)}"></div>
          <div><label class="fld" id="costLabel">${stockMode === 'weighed' ? 'Cost per kg' : 'Unit cost'} (${sym()})</label><input class="inp" id="ic" type="number" min="0" step="0.01" value="${(m.cost/100).toFixed(2)}"></div>
          <div><label class="fld">Gross margin</label><input class="inp" id="im" disabled></div>
        </div>
        ${retail ? `<div class="grid2 ${stockMode === 'pour' ? 'hidden' : ''}" id="ownStockFields" style="margin-top:12px">
          ${isNew ? '<div><label class="fld">Opening stock</label><input class="inp" id="ioq" type="number" min="0" step="1" value="0"></div>' : ''}
          <div><label class="fld">Low-stock alert at</label><input class="inp" id="imin" type="number" min="0" step="1" value="${m.stock_min_qty ?? 4}"></div>
        </div>` : ''}
        <div style="margin-top:14px"><label class="row" style="gap:8px;cursor:pointer">
          <input type="checkbox" id="ia" ${m.available ? 'checked' : ''}> Available for sale</label></div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>${isNew ? 'Create product' : 'Save changes'}</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    const modeSelect = ov.querySelector('#imode');
    const toggleStockMode = () => {
      const pour = modeSelect && modeSelect.value === 'pour';
      const weighed = modeSelect && modeSelect.value === 'weighed';
      ov.querySelector('#pourFields')?.classList.toggle('hidden', !pour);
      ov.querySelector('#ownStockFields')?.classList.toggle('hidden', pour);
      if (pour && ov.querySelector('#iunit') && !['shot', 'glass'].includes(ov.querySelector('#iunit').value)) ov.querySelector('#iunit').value = 'shot';
      if (weighed && ov.querySelector('#iunit')) ov.querySelector('#iunit').value = 'kg';
      if (ov.querySelector('#costLabel')) ov.querySelector('#costLabel').textContent = (weighed ? 'Cost per kg' : 'Unit cost') + ` (${sym()})`;
      if (weighed && isNew && ov.querySelector('#ia')) ov.querySelector('#ia').checked = false;
      if (pour && isNew && Number(ov.querySelector('#ivol')?.value) > 250) ov.querySelector('#ivol').value = '50';
    };
    if (modeSelect) modeSelect.onchange = toggleStockMode;
    toggleStockMode();
    const upd = () => {
      const price = Number(ov.querySelector('#ip').value) || 0, cost = Number(ov.querySelector('#ic').value) || 0;
      ov.querySelector('#im').value = price ? Math.round(((price - cost) / price) * 100) + '%' : '—';
    };
    ov.querySelector('#ip').oninput = upd; ov.querySelector('#ic').oninput = upd; upd();
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const volume = Number(ov.querySelector('#ivol').value) || null;
      let productName = ov.querySelector('#in').value.trim();
      if (retail && volume) {
        productName = productName.replace(/\s*\d+(?:\.\d+)?\s*(?:ml|l)\s*$/i, '').trim();
        productName += ' ' + (volume >= 1000 ? `${volume / 1000}L` : `${volume}ml`);
      }
      const payload = {
        name: productName, price: Number(ov.querySelector('#ip').value),
        cost: Number(ov.querySelector('#ic').value), category_id: Number(ov.querySelector('#icat').value),
        station: retail ? 'retail' : ov.querySelector('#ist').value,
        sku: ov.querySelector('#isku').value.trim(), barcode: ov.querySelector('#ibar').value.trim(),
        volume_ml: volume,
        kra_item_code: ov.querySelector('#ikra').value.trim(), opening_qty: Number(ov.querySelector('#ioq')?.value || 0),
        min_qty: Number(ov.querySelector('#imin')?.value || 0), unit: ov.querySelector('#iunit')?.value || 'piece',
        stock_mode: ov.querySelector('#imode')?.value || 'unit',
        source_stock_item_id: Number(ov.querySelector('#isource')?.value) || null,
        serving_ml: volume, source_volume_ml: Number(ov.querySelector('#isourcevol')?.value) || null,
        available: ov.querySelector('#ia').checked ? 1 : 0
      };
      if (!payload.name) return toast('Product name is required', 'err');
      if (!payload.category_id) return toast('Choose a category', 'err');
      if (!(payload.price >= 0)) return toast('Enter a valid selling price', 'err');
      if (payload.stock_mode === 'pour' && (!payload.source_stock_item_id || !(payload.source_volume_ml >= payload.serving_ml)))
        return toast('Choose source stock and enter its full bottle/keg size', 'err');
      try {
        if (isNew) await api('/api/menu-items', { body: payload });
        else await api('/api/menu-items/' + m.id, { method: 'PUT', body: payload });
        closeModal(); await reload(); menu(body); toast('Product saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ------------------------------ stock ------------------------------ */
  async function stock(body) {
    const [st, moves] = await Promise.all([api('/api/stock'), api('/api/stock-moves?limit=40')]);
    State.stock = st;
    const low = st.filter((x) => x.qty <= x.min_qty);
    const value = st.reduce((a, x) => a + x.qty * x.cost, 0);
    body.innerHTML = `
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:14px">
        ${stat('Stock value', fmt(value), st.length + ' tracked items')}
        ${stat('Low stock', low.length, low.length ? 'needs reordering' : 'all healthy', low.length ? 'warn' : '')}
        ${stat('Out of stock', st.filter((x) => x.qty <= 0).length, 'items at zero')}
        <span class="grow"></span>
        ${canManage() && State.settings.business_type !== 'wines_spirits' ? '<button class="btn primary" id="addS" style="align-self:center">+ New stock item</button>' : ''}
      </div>
      <div class="card"><div class="card-h"><h3>Inventory</h3><span class="grow"></span>
        <span class="muted tiny">${State.settings.business_type === 'wines_spirits' ? 'Use Deliveries for received stock and Stocktakes for end-of-day counts' : 'Received = add stock · Adjust = count correction / wastage'}</span></div>
        <div class="scroll-x"><table class="tbl">
          <thead><tr><th>Item</th><th>Unit</th><th class="right">On hand</th><th class="right">Min</th>
          <th class="right">Unit cost</th><th class="right">Value</th><th>Status</th><th></th></tr></thead>
          <tbody>${st.map((x) => `<tr>
            <td><b>${esc(x.name)}</b></td><td class="muted small">${esc(x.unit)}</td>
            <td class="right"><b class="mono">${roundStock(x.qty)}</b><div class="tiny muted">${x.capacity_ml && x.unit !== 'kg' ? stockQtyLabel(x.qty, x.unit, x.capacity_ml).split(' · ')[1] || '' : x.unit}</div></td><td class="right mono muted">${roundStock(x.min_qty)}</td>
            <td class="right mono muted">${fmt(x.cost)}</td>
            <td class="right mono">${fmt(x.qty * x.cost)}</td>
            <td>${x.qty <= 0 ? '<span class="tag bad">Out</span>' : x.qty <= x.min_qty ? '<span class="tag warn">Low</span>' : '<span class="tag ok">OK</span>'}</td>
            <td class="right nowrap">${canManage() ? `${State.settings.business_type === 'wines_spirits' ? '' : `<button class="btn xs green" data-rec="${x.id}">Quick receive</button>`}
              <button class="btn xs ghost" data-adj="${x.id}">Quick correction</button>
              <button class="btn xs ghost" data-se="${x.id}">Edit controls</button>` : '<span class="tiny muted">Owner controlled</span>'}</td>
          </tr>`).join('')}</tbody></table></div>
      </div>
      <div class="card" style="margin-top:14px"><div class="card-h"><h3>Recent stock movement</h3><span class="grow"></span><span class="tiny muted">Sales, deliveries and counts</span></div>
        <div class="scroll-x" style="max-height:300px"><table class="tbl"><thead><tr><th>When</th><th>Product</th><th class="right">Change</th><th>Reason</th><th>By</th></tr></thead>
        <tbody>${moves.map((m) => `<tr><td class="nowrap muted small">${esc(m.created_at)}</td><td><b>${esc(m.name)}</b></td>
          <td class="right mono"><span class="tag ${m.delta < 0 ? 'warn' : 'ok'}">${m.delta > 0 ? '+' : ''}${roundStock(m.delta, 4)} ${esc(m.unit)}</span></td>
          <td class="small">${esc(m.reason || '—')}</td><td>${esc(m.user_name || 'system')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No stock movement yet.</td></tr>'}</tbody></table></div></div>`;

    if (!canManage()) return;
    const addStock = body.querySelector('#addS');
    if (addStock) addStock.onclick = () => stockForm(null, body);
    body.querySelectorAll('[data-se]').forEach((b) => b.onclick = () =>
      stockForm(State.stock.find((x) => x.id === Number(b.dataset.se)), body));
    body.querySelectorAll('[data-rec]').forEach((b) => b.onclick = () => adjust(State.stock.find((x) => x.id === Number(b.dataset.rec)), body, 'receive'));
    body.querySelectorAll('[data-adj]').forEach((b) => b.onclick = () => adjust(State.stock.find((x) => x.id === Number(b.dataset.adj)), body, 'adjust'));
  }

  function adjust(x, body, mode) {
    modal({
      title: (mode === 'receive' ? 'Stock received — ' : 'Stock count — ') + x.name,
      body: `<p class="muted" style="margin-top:0">Current level: <b>${esc(stockQtyLabel(x.qty, x.unit, x.capacity_ml))}</b></p>
        <label class="fld">${mode === 'receive' ? 'Quantity received' : 'Actual quantity counted'}</label>
        <input class="inp" id="aq" type="number" step="0.5" value="${mode === 'receive' ? '' : x.qty}" placeholder="${mode === 'receive' ? 'e.g. 25' : 'e.g. 9'}">
        <div style="margin-top:12px"><label class="fld">Reason</label>
          <input class="inp" id="ar" placeholder="${mode === 'receive' ? 'Supplier delivery / invoice no.' : 'Full count, breakage found, correction…'}"></div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      let d = Number(ov.querySelector('#aq').value) || 0;
      if (mode === 'receive') d = Math.abs(d);
      else d -= x.qty;
      const reason = ov.querySelector('#ar').value.trim();
      if (!d) return toast('The count matches the current stock', 'err');
      if (!reason) return toast('Enter a reason or count reference', 'err');
      try {
        await api(`/api/stock/${x.id}/adjust`, { body: { delta: d, reason } });
        closeModal(); stock(body); toast('Stock updated', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function stockForm(x, body) {
    const isNew = !x;
    x = x || { name: '', unit: 'kg', qty: 0, min_qty: 0, cost: 0 };
    modal({
      title: isNew ? 'New stock item' : 'Edit — ' + x.name,
      body: `<label class="fld">Name</label><input class="inp" id="sn" value="${esc(x.name)}">
        <div class="grid2" style="margin-top:12px">
          <div><label class="fld">Unit</label><input class="inp" id="su" value="${esc(x.unit)}" placeholder="kg / L / crate / pcs"></div>
          <div><label class="fld">Unit cost (${sym()})</label><input class="inp" id="sc" type="number" step="0.01" value="${(x.cost/100).toFixed(2)}"></div>
          <div><label class="fld">Quantity on hand</label><input class="inp" id="sq" type="number" step="0.5" value="${x.qty}"></div>
          <div><label class="fld">Reorder minimum</label><input class="inp" id="sm" type="number" step="0.5" value="${x.min_qty}"></div>
        </div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const p = {
        name: ov.querySelector('#sn').value.trim(), unit: ov.querySelector('#su').value.trim() || 'pcs',
        cost: Number(ov.querySelector('#sc').value), qty: Number(ov.querySelector('#sq').value),
        min_qty: Number(ov.querySelector('#sm').value)
      };
      if (!p.name) return toast('Name required', 'err');
      try {
        if (isNew) await api('/api/stock', { body: p });
        else await api('/api/stock/' + x.id, { method: 'PUT', body: p });
        closeModal(); stock(body); toast('Saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ------------------------------ staff ------------------------------ */
  async function staff(body) {
    const users = await api('/api/users');
    const ROLES = ['seller', 'admin'];
    const CAN = { admin: 'Unlimited access: settings, reports, products, staff, stock, refunds and audit',
      seller: 'Sales, payments, receipts, cash drawer and stock taking' };
    body.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <h3 style="margin:0;font-size:14px">Team (${users.length})</h3><span class="grow"></span>
        ${canEdit() ? '<button class="btn primary" id="addU">+ Add staff member</button>' : ''}
      </div>
      <div class="card"><div class="scroll-x"><table class="tbl">
        <thead><tr><th>Name</th><th>Role</th><th>Permissions</th><th>PIN</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td><b>${esc(u.name)}</b></td>
          <td><span class="tag ${['admin','manager'].includes(u.role) ? 'warn' : 'info'}">${u.role}</span></td>
          <td class="muted small">${CAN[u.role] || ''}</td>
          <td class="mono muted" title="PINs are stored hashed and are never shown here">••••</td>
          <td>${u.active ? '<span class="tag ok">Active</span>' : '<span class="tag bad">Disabled</span>'}</td>
          <td class="right nowrap">${canEdit() ? `<button class="btn xs ghost" data-ue="${u.id}">Edit</button>
            <button class="btn xs ${u.active ? 'red' : 'green'}" data-ut="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div></div>`;

    if (!canEdit()) return;
    body.querySelector('#addU').onclick = () => userForm(null, body, ROLES);
    body.querySelectorAll('[data-ue]').forEach((b) => b.onclick = () =>
      userForm(users.find((x) => x.id === Number(b.dataset.ue)), body, ROLES));
    body.querySelectorAll('[data-ut]').forEach((b) => b.onclick = async () => {
      const u = users.find((x) => x.id === Number(b.dataset.ut));
      try { await api('/api/users/' + u.id, { method: 'PUT', body: { active: u.active ? 0 : 1 } }); staff(body); }
      catch (e) { toast(e.message, 'err'); }
    });
  }

  function userForm(u, body, ROLES) {
    const isNew = !u;
    u = u || { name: '', pin: '', role: 'seller', active: 1 };
    const pinLabel = isNew ? 'PIN (4-6 digits)' : 'PIN (4-6 digits) - leave blank to keep';
    const pinAttrs = isNew ? 'required placeholder="New PIN"' : 'placeholder="New PIN"';
    modal({
      title: isNew ? 'Add staff member' : 'Edit - ' + u.name,
      body: `<label class="fld">Full name</label><input class="inp" id="un" value="${esc(u.name)}" placeholder="e.g. Wanjiru K.">
        <div class="grid2" style="margin-top:12px">
          <div><label class="fld">${pinLabel}</label>
            <input class="inp mono" id="up" value="" maxlength="6" inputmode="numeric" ${pinAttrs}></div>
          <div><label class="fld">Role</label>
            <select class="inp" id="ur">${ROLES.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        </div>`,
      footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>`
    });
    const ov = document.querySelector('#modalRoot .ov');
    ov.querySelector('[data-no]').onclick = closeModal;
    ov.querySelector('[data-yes]').onclick = async () => {
      const p = { name: ov.querySelector('#un').value.trim(), pin: ov.querySelector('#up').value.trim(), role: ov.querySelector('#ur').value };
      if (!p.name) return toast('Name is required', 'err');
      if (isNew && !p.pin) return toast('A PIN is required for a new staff member', 'err');
      try {
        let created = null;
        if (isNew) created = await api('/api/users', { body: p });
        else { const r = await api('/api/users/' + u.id, { method: 'PUT', body: p }); if (r.pin) created = r; }
        closeModal(); staff(body);
        if (created && created.pin) revealPin(created); else toast('Saved', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /** Show a freshly-set PIN exactly once; afterwards it is stored hashed only. */
  function revealPin(u) {
    modal({
      title: 'PIN for ' + u.name,
      body: `<div class="center" style="padding:16px">
        <div class="mono" style="font-size:26px;font-weight:700;letter-spacing:4px">${esc(u.pin)}</div>
        <p class="tiny muted" style="margin-top:14px">Write this down — it is shown only once.
        From now on it is stored as a salted hash and cannot be recovered.</p></div>`,
      footer: `<button class="btn primary" data-no>Done</button>`
    });
    document.querySelector('#modalRoot .ov [data-no]').onclick = closeModal;
  }

  /* ----------------------------- settings ---------------------------- */
  function settings(body) {
    const s = State.settings;
    const hasMenu = State.menu.length > 0;
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-b row">
        <div style="min-width:220px"><b>Starter template</b>
          <div class="tiny muted" style="margin-top:4px">Load a Kenyan wines &amp; spirits starter catalogue
          (products, selling prices, costs and bottle stock) as a starting point. Never overwrites existing data.</div></div>
        <span class="grow"></span>
        <button class="btn" id="loadSample" ${hasMenu ? 'disabled title="Products already exist"' : ''}>Load starter products</button>
      </div></div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card"><div class="card-h"><h3>Business details</h3></div><div class="card-b">
          <label class="fld">Business name</label><input class="inp" id="s_bn" value="${esc(s.business_name)}">
          <div style="margin-top:10px"><label class="fld">Address</label><input class="inp" id="s_ad" value="${esc(s.address)}"></div>
          <div style="margin-top:10px"><label class="fld">Phone</label><input class="inp" id="s_ph" value="${esc(s.phone)}"></div>
          <div style="margin-top:10px"><label class="fld">KRA PIN</label><input class="inp mono" id="s_kra" value="${esc(s.kra_pin)}"></div>
          ${s.business_type === 'wines_spirits' ? `<div class="grid2" style="margin-top:10px">
            <div><label class="fld">Alcohol licence number</label><input class="inp mono" id="s_lic" value="${esc(s.licence_number || '')}"></div>
            <div><label class="fld">Licence expiry</label><input class="inp" type="date" id="s_lice" value="${esc(s.licence_expiry || '')}"></div>
          </div>` : ''}
        </div></div>
        <div class="card"><div class="card-h"><h3>Tax &amp; charges</h3></div><div class="card-b">
          <div class="grid2">
            <div><label class="fld">Currency</label><input class="inp" id="s_cur" value="${esc(s.currency)}"></div>
            <div><label class="fld">Symbol</label><input class="inp" id="s_sym" value="${esc(s.currency_symbol)}"></div>
            <div><label class="fld">VAT rate (%)</label><input class="inp" id="s_vat" type="number" step="0.5" value="${s.vat_rate}"></div>
            <div><label class="fld">Tax mode</label>
              <select class="inp" id="s_mode">
                <option value="inclusive" ${s.tax_mode === 'inclusive' ? 'selected' : ''}>VAT included in selling price (recommended)</option>
                <option value="exclusive" ${s.tax_mode === 'exclusive' ? 'selected' : ''}>Add VAT on top</option>
              </select></div>
            <div><label class="fld">Service charge (%)</label><input class="inp" id="s_sc" type="number" step="0.5" value="${s.service_charge_rate}"></div>
            <div><label class="fld">Apply service charge</label>
              <select class="inp" id="s_sce"><option value="1" ${s.service_charge_enabled ? 'selected' : ''}>Yes</option>
                <option value="0" ${!s.service_charge_enabled ? 'selected' : ''}>No</option></select></div>
          </div>
          <p class="tiny muted" style="margin-top:12px">Retail selling prices normally already contain VAT. With inclusive mode, a product entered at KSh 200 sells for exactly KSh 200; the VAT portion is extracted for reporting, not added again. Service charge should remain disabled.</p>
        </div></div>
      </div>
      ${s.business_type === 'wines_spirits' ? `<div class="card" style="margin-top:14px"><div class="card-h"><h3>Retail safeguards &amp; scanner</h3></div><div class="card-b grid3">
        <div><label class="fld">Receipt age notice</label><input class="inp" id="s_age" type="number" min="18" value="${esc(s.minimum_sale_age || 18)}"><div class="tiny muted" style="margin-top:5px">Printed on receipts only; checkout has no age prompt.</div></div>
        <div><label class="fld">Prevent negative stock</label><select class="inp" id="s_neg"><option value="1" ${s.prevent_negative_stock === '1' ? 'selected' : ''}>Yes</option><option value="0" ${s.prevent_negative_stock !== '1' ? 'selected' : ''}>No</option></select></div>
        <div><label class="fld">Barcode scanner</label><select class="inp" id="s_scan"><option value="0" ${s.barcode_scanner_enabled !== '1' ? 'selected' : ''}>Disabled</option><option value="1" ${s.barcode_scanner_enabled === '1' ? 'selected' : ''}>Enabled everywhere</option></select>
          <div class="tiny muted" style="margin-top:5px">Use a USB/Bluetooth scanner in keyboard mode with Enter suffix. Scanning from any normal page opens the sale and adds the product.</div></div>
      </div></div>
      <div class="card" style="margin-top:14px"><div class="card-h"><h3>Reconciliation controls</h3></div><div class="card-b grid2">
        <div><label class="fld">Balanced tolerance (${sym()})</label><input class="inp" id="s_tol" type="number" min="0" step="1" value="${esc(s.reconciliation_tolerance || 20)}"><div class="tiny muted" style="margin-top:5px">Overall differences within this amount can be classified as reconciled.</div></div>
        <div><label class="fld">Critical variance (${sym()})</label><input class="inp" id="s_crit" type="number" min="0" step="1" value="${esc(s.reconciliation_critical_threshold || 500)}"><div class="tiny muted" style="margin-top:5px">Larger unexplained shortages or overages are marked critical.</div></div>
      </div></div>` : ''}
      <div class="card" style="margin-top:14px"><div class="card-h"><h3>Receipt</h3></div><div class="card-b">
        <label class="fld">Footer message</label><input class="inp" id="s_ft" value="${esc(s.receipt_footer)}">
      </div></div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" id="saveS">Save settings</button>
        <span class="muted tiny">Changes apply to new totals immediately; closed receipts keep their original figures.</span>
      </div>
      ${s.business_type !== 'wines_spirits' ? `<div class="card" style="margin-top:22px"><div class="card-h"><h3>Floor layout</h3>
        <span class="grow"></span><button class="btn ghost sm" id="addT">+ Add table</button></div>
        <div class="scroll-x"><table class="tbl">
          <thead><tr><th>Table</th><th>Area</th><th>Seats</th><th>Status</th><th></th></tr></thead>
          <tbody>${State.tables.map((t) => {
            const o = tableStatus(t.id);
            return `<tr><td><b>${esc(t.name)}</b></td><td class="muted small">${esc(t.area)}</td>
              <td class="mono">${t.seats}</td>
              <td>${o ? `<span class="tag warn">In use · #${o.number}</span>` : '<span class="tag ok">Free</span>'}</td>
              <td class="right nowrap"><button class="btn xs ghost" data-te="${t.id}">Edit</button>
                <button class="btn xs red" data-td="${t.id}">×</button></td></tr>`;
          }).join('')}</tbody></table></div>
      </div>` : ''}`;

    const ls = body.querySelector('#loadSample');
    if (ls) ls.onclick = () => confirmBox('Load starter products',
      'Adds a starter wines and spirits catalogue with matching bottle stock. Your existing data is untouched.', {
        okLabel: 'Load sample', onOk: async () => {
          try { await api('/api/setup/sample', { body: {} }); await Manager.reload();
            settings(body); toast('Starter products loaded', 'ok'); }
          catch (e) { toast(e.message, 'err'); }
        } });

    body.querySelector('#saveS').onclick = async () => {
      try {
        State.settings = await api('/api/settings', { method: 'PUT', body: {
          business_name: body.querySelector('#s_bn').value, address: body.querySelector('#s_ad').value,
          phone: body.querySelector('#s_ph').value, kra_pin: body.querySelector('#s_kra').value,
          currency: body.querySelector('#s_cur').value, currency_symbol: body.querySelector('#s_sym').value,
          vat_rate: body.querySelector('#s_vat').value, tax_mode: body.querySelector('#s_mode').value,
          service_charge_rate: body.querySelector('#s_sc').value,
          service_charge_enabled: body.querySelector('#s_sce').value,
          receipt_footer: body.querySelector('#s_ft').value,
          licence_number: body.querySelector('#s_lic')?.value || '', licence_expiry: body.querySelector('#s_lice')?.value || '',
          minimum_sale_age: body.querySelector('#s_age')?.value || s.minimum_sale_age || 18,
          age_verification_required: '0',
          prevent_negative_stock: body.querySelector('#s_neg')?.value || s.prevent_negative_stock || '1',
          barcode_scanner_enabled: body.querySelector('#s_scan')?.value || '0',
          reconciliation_tolerance: body.querySelector('#s_tol')?.value || '20',
          reconciliation_critical_threshold: body.querySelector('#s_crit')?.value || '500'
        } });
        toast('Settings saved', 'ok');
        if (typeof updateScannerState === 'function') updateScannerState();
        document.getElementById('lgName') && (document.getElementById('lgName').textContent = State.settings.business_name);
      } catch (e) { toast(e.message, 'err'); }
    };

    const tableForm = (t) => {
      modal({
        title: t ? 'Edit table ' + t.name : 'Add table',
        body: `<div class="grid3">
          <div><label class="fld">Name</label><input class="inp" id="tn" value="${esc((t||{}).name||'')}"></div>
          <div><label class="fld">Area</label><input class="inp" id="ta" value="${esc((t||{}).area||'Restaurant')}" list="areas">
            <datalist id="areas">${[...new Set(State.tables.map((x) => x.area))].map((a) => `<option value="${esc(a)}">`).join('')}</datalist></div>
          <div><label class="fld">Seats</label><input class="inp" id="ts" type="number" min="1" value="${(t||{}).seats||4}"></div>
        </div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>`
      });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        const p = { name: ov.querySelector('#tn').value.trim(), area: ov.querySelector('#ta').value.trim(), seats: Number(ov.querySelector('#ts').value) || 1 };
        if (!p.name || !p.area) return toast('Name and area required', 'err');
        try {
          if (t) await api('/api/tables/' + t.id, { method: 'PUT', body: p });
          else await api('/api/tables', { body: p });
          closeModal(); await reload(); settings(body); toast('Saved', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    body.querySelector('#addT')?.addEventListener('click', () => tableForm(null));
    body.querySelectorAll('[data-te]').forEach((b) => b.onclick = () => tableForm(State.tables.find((x) => x.id === Number(b.dataset.te))));
    body.querySelectorAll('[data-td]').forEach((b) => b.onclick = () => {
      const t = State.tables.find((x) => x.id === Number(b.dataset.td));
      confirmBox('Delete table ' + t.name, 'The table will be removed from the floor plan.', {
        danger: true, okLabel: 'Delete', onOk: async () => {
          try { await api('/api/tables/' + t.id, { method: 'DELETE' }); await reload(); settings(body); toast('Deleted', 'ok'); }
          catch (e) { toast(e.message, 'err'); }
        } });
    });
  }

  /* ------------------------------ audit ------------------------------ */
  async function audit(body) {
    const rows = await api('/api/audit?limit=400');
    body.innerHTML = `
      <div class="card"><div class="card-h"><h3>Audit log</h3><span class="grow"></span>
        <span class="muted tiny">Every void, discount, refund, price change and login is recorded here.</span></div>
        <div class="scroll-x" style="max-height:70vh;overflow:auto"><table class="tbl">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td class="nowrap muted small">${r.created_at}</td>
            <td><b>${esc(r.user_name || '—')}</b></td>
            <td><span class="tag ${r.action.includes('void') || r.action.includes('refund') ? 'bad'
              : r.action.includes('discount') ? 'warn' : 'info'}">${esc(r.action)}</span></td>
            <td class="small muted">${esc(r.detail || '')}</td></tr>`).join('')
            || '<tr><td colspan="4" class="empty">Nothing logged yet.</td></tr>'}</tbody></table></div>
      </div>`;
  }

  async function reload() {
    await loadBootstrap();
    State.orders = await api('/api/orders');
  }

  return { render, reload, set tab(v) { top = v; sub = null; } };
})();

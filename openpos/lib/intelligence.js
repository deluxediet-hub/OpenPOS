'use strict';
// ---------------------------------------------------------------------------
// intelligence.js — the owner's questions, answered from the book (Phase 29).
//
// Every function here is a REAL QUERY with a THRESHOLD and a PLAIN SENTENCE.
// There is no assistant, no model and no advice that is not a number: an owner
// is told what is true, what it costs, and what to do about it — and the row
// it came from is in the answer so it can be checked.
// ---------------------------------------------------------------------------

const DAY = 864e5;

const iso = (t) => new Date(t).toISOString();
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const num = (v) => Number(v || 0);

function money(n) {
  return `Ksh ${Math.round(num(n)).toLocaleString('en-KE')}`;
}

// ---- 1. cash tied up in stock ----------------------------------------------

/** Stock × cost, weighted by how long it has been sitting there. */
function cashTiedUp(d, { limit = 12 } = {}) {
  const rows = d
    .prepare(
      `SELECT p.id, p.name, p.sku, p.cost, p.price,
              COALESCE(SUM(s.qty), 0) AS qty,
              COALESCE(SUM(s.qty), 0) * COALESCE(p.cost, 0) AS value,
              (SELECT MAX(sm.created_at) FROM stock_moves sm WHERE sm.variant_id = v.id AND sm.qty < 0) AS last_sold_at,
              p.created_at
         FROM products p
         JOIN variants v ON v.product_id = p.id AND COALESCE(v.axes_key, '{}') = '{}'
         LEFT JOIN stock s ON s.variant_id = v.id
        WHERE p.active = 1
        GROUP BY p.id
        ORDER BY value DESC
        LIMIT ?`
    )
    .all(limit);
  const now = Date.now();
  const items = rows
    .filter((r) => num(r.qty) > 0)
    .map((r) => {
      const lastSold = r.last_sold_at ? new Date(r.last_sold_at).getTime() : new Date(r.created_at || now).getTime();
      const ageDays = Math.max(0, Math.round((now - lastSold) / DAY));
      return {
        product_id: r.id, name: r.name, sku: r.sku,
        qty: num(r.qty), cost: num(r.cost),
        value: Math.round(num(r.value)),
        age_days: ageDays,
        stale: ageDays >= 30
      };
    });
  const total = items.reduce((s, i) => s + i.value, 0);
  const stale = items.filter((i) => i.stale);
  return {
    question: "what's tying up the most cash?",
    threshold: 'flagged when a line has not sold in 30 days',
    total_value: total,
    stale_value: stale.reduce((s, i) => s + i.value, 0),
    items,
    alerts: stale.slice(0, 5).map((i) => ({
      severity: i.age_days >= 60 ? 'high' : 'medium',
      text: `${i.name}: ${money(i.value)} of stock, nothing sold in ${i.age_days} days`
    })),
    sentence: stale.length
      ? `${money(total)} is on the shelf; ${money(stale.reduce((s, i) => s + i.value, 0))} of it has not moved in 30 days — ${stale[0].name} is the biggest of those.`
      : `${money(total)} is on the shelf, and all of it has sold within the last 30 days.`
  };
}

// ---- 2. branch performance vs its own history ------------------------------

function branchPerformance(d, { days = 7 } = {}) {
  const since = daysAgo(days);
  const prev = daysAgo(days * 2);
  const rows = d
    .prepare(
      `SELECT b.id, b.name,
              (SELECT COALESCE(SUM(s.gross), 0) FROM sales s WHERE s.branch_id = b.id AND s.status = 'paid' AND s.created_at >= ?) AS revenue,
              (SELECT COALESCE(SUM(s.gross), 0) FROM sales s WHERE s.branch_id = b.id AND s.status = 'paid' AND s.created_at >= ? AND s.created_at < ?) AS prev_revenue,
              (SELECT COUNT(*) FROM sales s WHERE s.branch_id = b.id AND s.status = 'paid' AND s.created_at >= ?) AS sales_count,
              (SELECT COALESCE(SUM(s.discount), 0) FROM sales s WHERE s.branch_id = b.id AND s.status = 'paid' AND s.created_at >= ?) AS discounts,
              (SELECT COALESCE(SUM(sh.variance), 0) FROM shifts sh WHERE sh.branch_id = b.id AND sh.closed_at IS NOT NULL AND sh.closed_at >= ?) AS variance
         FROM branches b
        ORDER BY revenue DESC`
    )
    .all(since, prev, since, since, since, since);
  const items = rows.map((r) => {
    const rev = num(r.revenue);
    const before = num(r.prev_revenue);
    const change = before > 0 ? Math.round(((rev - before) / before) * 100) : null;
    return {
      branch_id: r.id, name: r.name, revenue: rev, prev_revenue: before,
      change_pct: change,
      sales_count: num(r.sales_count),
      discounts: num(r.discounts),
      variance: num(r.variance),
      flag: change !== null && change <= -15 ? 'down' : (change !== null && change >= 20 ? 'up' : 'flat')
    };
  });
  const worst = items.filter((i) => i.flag === 'down');
  return {
    question: 'which branch is underperforming — against its own history?',
    threshold: 'flagged when a branch is 15% below its previous equivalent period',
    window_days: days,
    items,
    alerts: worst.map((i) => ({
      severity: i.change_pct <= -30 ? 'high' : 'medium',
      text: `${i.name} is ${Math.abs(i.change_pct)}% down on the previous ${days} days (${money(i.revenue)} vs ${money(i.prev_revenue)})`
    })),
    sentence: worst.length
      ? `${worst[0].name} is the one to look at: ${Math.abs(worst[0].change_pct)}% down on its own previous ${days} days.`
      : (items.length ? 'No branch is more than 15% below its own recent history.' : 'One branch, one book.')
  };
}

// ---- 3. actual profit yesterday -------------------------------------------

function profit(d, { dayOffset = 1 } = {}) {
  const start = new Date(Date.now() - dayOffset * DAY);
  start.setHours(0, 0, 0, 0);
  const from = iso(start.getTime());
  const to = iso(start.getTime() + DAY);
  const sales = d
    .prepare(`SELECT COALESCE(SUM(gross), 0) AS gross, COALESCE(SUM(discount), 0) AS discount, COALESCE(SUM(tax), 0) AS tax, COUNT(*) AS n
                FROM sales WHERE status = 'paid' AND created_at >= ? AND created_at < ?`)
    .get(from, to);
  const cogs = d
    .prepare(`SELECT COALESCE(SUM(si.qty * COALESCE(p.cost, 0)), 0) AS cogs
                FROM sale_items si
                JOIN sales s ON s.id = si.sale_id
                JOIN products p ON p.id = si.product_id
               WHERE s.status = 'paid' AND s.created_at >= ? AND s.created_at < ?`)
    .get(from, to);
  const expenses = d
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS spend FROM expenses WHERE expense_date >= ? AND expense_date < ?`)
    .get(from, to).spend || 0;
  const gross = num(sales.gross);
  const cost = num(cogs.cogs);
  const net = gross - num(sales.tax);
  const profit = net - cost - expenses;
  const margin = gross > 0 ? Math.round((profit / gross) * 100) : 0;
  return {
    question: 'what did the shop actually make yesterday?',
    threshold: 'flagged when the day is a loss, or margin is under 8%',
    date: from.slice(0, 10),
    sales_count: num(sales.n),
    revenue: gross,
    vat: num(sales.tax),
    discounts: num(sales.discount),
    cogs: cost,
    expenses: num(expenses),
    profit: Math.round(profit),
    margin_pct: margin,
    alerts: profit <= 0
      ? [{ severity: 'high', text: `${from.slice(0, 10)} was a loss-making day: ${money(profit)} after stock and expenses` }]
      : (margin < 8 ? [{ severity: 'medium', text: `margin was ${margin}% — under the 8% floor` }] : []),
    sentence: `${from.slice(0, 10)}: ${money(gross)} sold, ${money(cost)} of stock, ${money(expenses)} out — profit ${money(profit)} (${margin}%).`
  };
}

// ---- 4. why is variance high at this branch? -------------------------------

function varianceDrill(d, { branchId = null, days = 30 } = {}) {
  const since = daysAgo(days);
  const where = ['sh.closed_at IS NOT NULL', 'sh.closed_at >= ?'];
  const args = [since];
  if (branchId) { where.push('sh.branch_id = ?'); args.push(branchId); }
  const shifts = d
    .prepare(`SELECT sh.*, u.name AS cashier FROM shifts sh LEFT JOIN users u ON u.id = sh.user_id WHERE ${where.join(' AND ')} ORDER BY sh.closed_at DESC`)
    .all(...args);
  const total = shifts.reduce((s, x) => s + num(x.variance), 0);
  const byCashier = {};
  for (const s of shifts) {
    const k = s.cashier || `#${s.user_id}`;
    byCashier[k] = byCashier[k] || { variance: 0, shifts: 0 };
    byCashier[k].variance += num(s.variance);
    byCashier[k].shifts += 1;
  }
  const voids = d
    .prepare(`SELECT COALESCE(SUM(s.gross), 0) AS g, COUNT(*) AS n FROM sales s WHERE s.status = 'voided' AND s.created_at >= ?${branchId ? ' AND s.branch_id = ?' : ''}`)
    .get(...(branchId ? [since, branchId] : [since]));
  const refunds = d
    .prepare(`SELECT COALESCE(SUM(p.amount), 0) AS g, COUNT(*) AS n FROM payments p JOIN sales s ON s.id = p.sale_id WHERE p.refunded = 1${branchId ? ' AND s.branch_id = ?' : ''}`)
    .get(...(branchId ? [branchId] : []));
  const discounts = d
    .prepare(`SELECT COALESCE(SUM(s.discount), 0) AS g FROM sales s WHERE s.status = 'paid' AND s.created_at >= ?${branchId ? ' AND s.branch_id = ?' : ''}`)
    .get(...(branchId ? [since, branchId] : [since]));
  const cashiers = Object.entries(byCashier)
    .map(([name, v]) => ({ cashier: name, variance: Math.round(v.variance), shifts: v.shifts, per_shift: Math.round(v.variance / Math.max(1, v.shifts)) }))
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  return {
    question: 'why is cash variance high here?',
    threshold: 'flagged when a cashier averages more than 200 a shift, or the branch is short overall',
    window_days: days,
    branch_id: branchId,
    total_variance: Math.round(total),
    shifts: shifts.length,
    by_cashier: cashiers,
    root_causes: [
      { cause: 'voided sales', amount: Math.round(num(voids.g)), count: num(voids.n) },
      { cause: 'refunds', amount: Math.round(num(refunds.g)), count: num(refunds.n) },
      { cause: 'discounts given', amount: Math.round(num(discounts.g)), count: null }
    ],
    alerts: cashiers
      .filter((c) => Math.abs(c.per_shift) > 200)
      .map((c) => ({ severity: 'high', text: `${c.cashier}: averages ${money(Math.abs(c.per_shift))} of variance a shift over ${c.shifts} shifts` })),
    sentence: shifts.length
      ? `${money(total)} of variance over ${shifts.length} closed shifts. ${cashiers.length ? `${cashiers[0].cashier} accounts for the largest share (${money(cashiers[0].variance)}).` : ''} Voids ${money(voids.g)}, refunds ${money(refunds.g)}.`
      : 'No closed shifts in this window, so there is no variance to explain.'
  };
}

// ---- 5. what to reorder now ------------------------------------------------

function reorderNow(d, { limit = 20 } = {}) {
  const since = daysAgo(30);
  const rows = d
    .prepare(
      `SELECT p.id, p.name, p.sku, p.cost, p.price, p.reorder_level,
              COALESCE(SUM(s.qty), 0) AS qty,
              (SELECT COALESCE(SUM(-sm.qty), 0) FROM stock_moves sm
                WHERE sm.variant_id = v.id AND sm.qty < 0 AND sm.created_at >= ?) AS sold_30d,
              (SELECT MAX(sm.created_at) FROM stock_moves sm WHERE sm.variant_id = v.id AND sm.qty > 0) AS last_received_at
         FROM products p
         JOIN variants v ON v.product_id = p.id AND COALESCE(v.axes_key, '{}') = '{}'
         LEFT JOIN stock s ON s.variant_id = v.id
        WHERE p.active = 1
        GROUP BY p.id
        HAVING qty <= MAX(COALESCE(p.reorder_level, 0), 1) OR (p.reorder_level > 0 AND qty <= p.reorder_level)
        ORDER BY (qty - COALESCE(p.reorder_level, 0)) ASC, sold_30d DESC
        LIMIT ?`
    )
    .all(since, limit);
  const items = rows.map((r) => {
    const sold = num(r.sold_30d);
    const daily = sold / 30;
    const qty = num(r.qty);
    const daysLeft = daily > 0 ? Math.round(qty / daily) : (qty > 0 ? 999 : 0);
    return {
      product_id: r.id, name: r.name, sku: r.sku,
      qty, reorder_level: num(r.reorder_level), cost: num(r.cost),
      sold_30d: sold,
      days_left: daysLeft,
      order_qty: Math.max(num(r.reorder_level) * 2 - qty, Math.ceil(daily * 14) || 0),
      urgency: daysLeft <= 3 ? 'now' : (daysLeft <= 10 ? 'soon' : 'watch')
    };
  }).sort((a, b) => (a.days_left === b.days_left ? b.sold_30d - a.sold_30d : a.days_left - b.days_left));
  return {
    question: 'what should I reorder today?',
    threshold: 'at or below the reorder level; "now" when under 3 days of cover',
    items,
    alerts: items.filter((i) => i.urgency === 'now').map((i) => ({
      severity: 'high',
      text: `${i.name}: ${i.qty} left, about ${i.days_left} day(s) of cover — order about ${i.order_qty}`
    })),
    sentence: items.length
      ? `${items.filter((i) => i.urgency === 'now').length} line(s) need ordering today; ${items[0].name} is the most urgent (${items[0].days_left} day(s) of cover).`
      : 'Nothing is at its reorder level.'
  };
}

// ---- 6. who over-discounts? ------------------------------------------------

function discountWatch(d, { days = 30, limit = 10 } = {}) {
  const since = daysAgo(days);
  const rows = d
    .prepare(
      `SELECT u.id, u.name,
              COUNT(DISTINCT s.id) AS sales,
              COALESCE(SUM(s.gross), 0) AS gross,
              COALESCE(SUM(s.discount), 0) AS discount
         FROM sales s JOIN users u ON u.id = s.user_id
        WHERE s.status = 'paid' AND s.created_at >= ?
        GROUP BY u.id
        HAVING sales > 0
        ORDER BY (CASE WHEN SUM(s.gross) > 0 THEN SUM(s.discount) * 1.0 / SUM(s.gross) ELSE 0 END) DESC
        LIMIT ?`
    )
    .all(since, limit);
  const items = rows.map((r) => {
    const gross = num(r.gross);
    const disc = num(r.discount);
    return {
      user_id: r.id, name: r.name, sales: num(r.sales), gross, discount: disc,
      discount_pct: gross > 0 ? Math.round((disc / gross) * 1000) / 10 : 0
    };
  });
  const avg = items.length ? items.reduce((s, i) => s + i.discount_pct, 0) / items.length : 0;
  const outliers = items.filter((i) => i.discount_pct > Math.max(3, avg * 2) && i.discount > 0);
  return {
    question: 'which cashier gives away the most?',
    threshold: `flagged above ${Math.max(3, Math.round(avg * 2))}% of their own sales (the shop average is ${Math.round(avg * 10) / 10}%)`,
    window_days: days,
    average_pct: Math.round(avg * 10) / 10,
    items,
    alerts: outliers.map((i) => ({
      severity: i.discount_pct > 10 ? 'high' : 'medium',
      text: `${i.name} discounted ${money(i.discount)} — ${i.discount_pct}% of their own ${money(i.gross)}`
    })),
    sentence: outliers.length
      ? `${outliers[0].name} gives the most away: ${outliers[0].discount_pct}% of their sales, against a shop average of ${Math.round(avg * 10) / 10}%.`
      : 'No cashier is discounting meaningfully more than the rest.'
  };
}

// ---- 7. what has not sold in 60 days? --------------------------------------

function deadStock(d, { days = 60, limit = 20 } = {}) {
  const since = daysAgo(days);
  const rows = d
    .prepare(
      `SELECT p.id, p.name, p.sku, p.cost, p.price,
              COALESCE(SUM(s.qty), 0) AS qty,
              (SELECT MAX(sm.created_at) FROM stock_moves sm WHERE sm.variant_id = v.id AND sm.qty < 0) AS last_sold_at
         FROM products p
         JOIN variants v ON v.product_id = p.id AND COALESCE(v.axes_key, '{}') = '{}'
         LEFT JOIN stock s ON s.variant_id = v.id
        WHERE p.active = 1
        GROUP BY p.id
       HAVING qty > 0 AND (last_sold_at IS NULL OR last_sold_at < ?)
        ORDER BY (qty * COALESCE(p.cost, 0)) DESC
        LIMIT ?`
    )
    .all(since, limit);
  const items = rows.map((r) => ({
    product_id: r.id, name: r.name, sku: r.sku,
    qty: num(r.qty), cost: num(r.cost),
    value: Math.round(num(r.qty) * num(r.cost)),
    last_sold_at: r.last_sold_at || null,
    idle_days: r.last_sold_at ? Math.round((Date.now() - new Date(r.last_sold_at).getTime()) / DAY) : null
  }));
  const total = items.reduce((s, i) => s + i.value, 0);
  return {
    question: `what has not sold in ${days} days?`,
    threshold: `${days} days without a sale`,
    items,
    total_value: total,
    alerts: items.slice(0, 5).map((i) => ({
      severity: i.value > 5000 ? 'high' : 'medium',
      text: `${i.name}: ${i.qty} unsold for ${i.idle_days == null ? 'as long as you have had it' : `${i.idle_days} days`} — ${money(i.value)} sitting still`
    })),
    sentence: items.length
      ? `${items.length} line(s), ${money(total)} of stock, have not sold in ${days} days. ${items[0].name} is the largest.`
      : `Everything on the shelf has sold in the last ${days} days.`
  };
}

// ---- 8. anomaly flags (z-scores) -------------------------------------------

function zscores(values) {
  const n = values.length;
  if (n < 2) return values.map(() => 0);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const vars = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(vars);
  return values.map((v) => (sd > 0 ? (v - mean) / sd : 0));
}

/**
 * Four things drift in a shop: discounts, refunds, cash variance and how fast
 * stock moves. Each is measured per day against its own 30-day behaviour — a
 * shop that always discounts 5% is not anomalous; the day it does 25% is.
 */
function anomalies(d, { days = 30 } = {}) {
  const since = daysAgo(days);
  const daily = (sql, args = []) => {
    const rows = d.prepare(sql).all(since, ...args);
    const byDay = {};
    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
      byDay[day] = 0;
    }
    for (const r of rows) {
      const day = String(r.day).slice(0, 10);
      if (byDay[day] !== undefined) byDay[day] = num(r.value);
    }
    return Object.entries(byDay).sort().map(([day, value]) => ({ day, value }));
  };

  const series = {
    discounts: daily(`SELECT substr(created_at, 1, 10) AS day, SUM(discount) AS value FROM sales WHERE status = 'paid' AND created_at >= ? GROUP BY day`),
    refunds: daily(`SELECT substr(updated_at, 1, 10) AS day, SUM(amount) AS value FROM payments WHERE refunded = 1 AND updated_at >= ? GROUP BY day`),
    variance: daily(`SELECT substr(closed_at, 1, 10) AS day, SUM(ABS(variance)) AS value FROM shifts WHERE closed_at IS NOT NULL AND closed_at >= ? GROUP BY day`),
    velocity: daily(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS value FROM sales WHERE status = 'paid' AND created_at >= ? GROUP BY day`)
  };

  const out = {};
  const alerts = [];
  for (const [key, rows] of Object.entries(series)) {
    const zs = zscores(rows.map((r) => r.value));
    const flagged = rows
      .map((r, i) => ({ ...r, z: Math.round(zs[i] * 10) / 10 }))
      .filter((r) => Math.abs(r.z) >= 2)
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    out[key] = { series: rows, flagged: flagged.slice(0, 5) };
    for (const f of flagged.slice(0, 3)) {
      alerts.push({
        severity: Math.abs(f.z) >= 3 ? 'high' : 'medium',
        metric: key,
        day: f.day,
        z: f.z,
        text: `${key} on ${f.day} was ${f.z > 0 ? 'unusually high' : 'unusually low'} (z ${f.z}, ${key === 'velocity' ? `${f.value} sales` : money(f.value)})`
      });
    }
  }
  return {
    question: 'what is out of the ordinary?',
    threshold: '|z| ≥ 2 against the last 30 days of the same measure',
    window_days: days,
    metrics: out,
    alerts: alerts.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 8),
    sentence: alerts.length
      ? `${alerts.length} unusual day(s) in the last ${days}: ${alerts[0].text}.`
      : `Nothing in the last ${days} days is more than two standard deviations from normal.`
  };
}

// ---- the digest ------------------------------------------------------------

function digest(d, { days = 7 } = {}) {
  const cash = cashTiedUp(d, { limit: 8 });
  const branches = branchPerformance(d, { days });
  const day = profit(d, { dayOffset: 1 });
  const reorder = reorderNow(d, { limit: 8 });
  const dead = deadStock(d, { days: 60, limit: 8 });
  const discounts = discountWatch(d, { days: 30, limit: 6 });
  const odd = anomalies(d, { days: 30 });
  const alerts = [
    ...day.alerts, ...reorder.alerts.slice(0, 2), ...cash.alerts.slice(0, 1),
    ...branches.alerts.slice(0, 1), ...dead.alerts.slice(0, 1),
    ...discounts.alerts.slice(0, 1), ...odd.alerts.slice(0, 2)
  ];
  const lines = alerts.filter((a) => a.severity === 'high').slice(0, 5).map((a) => `• ${a.text}`);
  const body = [
    `Yesterday: ${day.sentence}`,
    lines.length ? '' : 'Nothing is on fire.',
    ...lines,
    `Cash on the shelf: ${money(cash.total_value)}. Reorder today: ${reorder.items.filter((i) => i.urgency === 'now').length} line(s).`
  ];
  const text = body.filter(Boolean).join('\n');
  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    sections: { profit: day, cash_tied_up: cash, branches, reorder, dead_stock: dead, discounts, anomalies: odd },
    alerts,
    high_count: alerts.filter((a) => a.severity === 'high').length,
    text
  };
}

module.exports = {
  cashTiedUp, branchPerformance, profit, varianceDrill,
  reorderNow, discountWatch, deadStock, anomalies, digest,
  money
};

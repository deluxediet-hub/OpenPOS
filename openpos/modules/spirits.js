'use strict';
// ---------------------------------------------------------------------------
// spirits.js — Wines & Spirits industry module (Phase 19; framework from 18).
//
// What a wine shop needs that a duka does not:
//   • bottle / pack / case / carton economics — what a case really earns
//   • premium & high-value control — a cashier may not ring up a 5 500 bottle
//   • credit (deni) controls — premium stock does not leave on a promise
//   • weekend demand — Friday/Saturday are the trade's real peak
//   • shrinkage focus — a missing case is a missing week's profit
//   • stock-counting priority — count the expensive shelf first
// ---------------------------------------------------------------------------
const kit = require('./_kit');

module.exports = {
  id: 'spirits',
  name: 'Wines & Spirits',
  nameSw: 'Waini na maziwa',
  version: 2,
  trades: ['spirits'],
  description: 'Bottle & case economics, premium-line control, weekend demand and shrinkage focus.',
  descriptionSw: 'Uchumi wa chupa na keesi, udhibiti wa bidhaa za thamani, mahitaji ya wikendi.',

  capabilities: ['packs'],

  schema: `
    CREATE TABLE IF NOT EXISTS spirits_premium_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL DEFAULT 1,
      sale_id INTEGER,
      branch_id INTEGER,
      product_id INTEGER,
      variant_id INTEGER,
      product_name TEXT NOT NULL DEFAULT '',
      qty REAL NOT NULL DEFAULT 0,
      gross INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER,
      user_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spirits_premium_sale ON spirits_premium_log(sale_id);
  `,

  productFields: [
    { key: 'abv', label: 'ABV %', labelSw: 'Kiasi cha pombe (ABV %)', type: 'number', appliesTo: 'variant' },
    { key: 'bottle_ml', label: 'Bottle size (ml)', labelSw: 'Ukubwa wa chupa (ml)', type: 'number', appliesTo: 'variant' },
    { key: 'case_size', label: 'Units per case', labelSw: 'Idadi kwa keesi', type: 'number', appliesTo: 'variant' },
    { key: 'premium', label: 'Premium line (manager only)', labelSw: 'Bidhaa ya thamani (meneja tu)', type: 'boolean', appliesTo: 'product' },
    { key: 'high_value', label: 'High-value stock (audit every unit)', labelSw: 'Bidhaa ghali (kagua kila moja)', type: 'boolean', appliesTo: 'product' }
  ],

  permissions: [
    {
      perm: 'spirits.premium',
      label: 'Ring up premium lines',
      labelSw: 'Uza bidhaa za thamani',
      roles: ['owner', 'manager']
    }
  ],

  checkout: {
    validateLine({ item, product, variant, user, helpers }) {
      const flag = (k) => helpers.flag(product, variant, k);
      const restricted = flag('premium') || flag('high_value');
      if (restricted && !user) {
        throw helpers.block(401, `${product.name}: sign in to sell a restricted line`);
      }
      if (restricted && !helpers.hasPerm(user, 'spirits.premium')) {
        throw helpers.block(403, `${product.name} is a premium line — a manager must ring it up`);
      }
      // A high-value bottle is never sold without the bottle being scanned as
      // itself: no open-price fudging on a 5 500 line.
      if (flag('high_value') && product.open_priced) {
        throw helpers.block(400, `${product.name} is high-value stock — it must be sold at its price, not weighed`);
      }
    },

    beforeCommit({ d, sale, lines, user, ctx, helpers }) {
      const ins = d.prepare(`
        INSERT INTO spirits_premium_log
          (business_id, sale_id, branch_id, product_id, variant_id, product_name, qty, gross, user_id, user_name, created_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const L of lines || []) {
        const restricted = helpers.flag(L.product, L.variant, 'premium') || helpers.flag(L.product, L.variant, 'high_value');
        if (!restricted) continue;
        ins.run(
          sale.id, ctx.branchId || null, L.product.id, L.variant.id, L.product.name,
          L.qty, L.gross || 0, user ? user.id : null, user ? user.name : '', helpers.now()
        );
      }
      // Deni control: premium stock does not leave the shop on a promise above
      // the business's own credit comfort (default 5 000).
      const restrictedTotal = (lines || [])
        .filter((L) => helpers.flag(L.product, L.variant, 'premium') || helpers.flag(L.product, L.variant, 'high_value'))
        .reduce((s2, L) => s2 + (L.gross || 0), 0);
      if (restrictedTotal > 0 && sale.tender) {
        let onCredit = 0;
        try {
          const tender = typeof sale.tender === 'string' ? JSON.parse(sale.tender || '[]') : (sale.tender || []);
          for (const p of tender) if (p && (p.method === 'credit' || p.method === 'deni')) onCredit += Number(p.amount || 0);
        } catch (_) { /* unparseable tender: treat as no credit */ }
        const limit = Number((helpers.setting('spirits', {}) || {}).deni_limit) || 5000;
        const creditOnRestricted = Math.min(onCredit, restrictedTotal);
        if (creditOnRestricted > limit) {
          throw helpers.block(403, `premium stock worth ${creditOnRestricted} cannot go on credit — the limit is ${limit}`);
        }
      }
    }
  },

  reports: [
    {
      id: 'premium_sales',
      title: 'Premium line sales',
      titleSw: 'Mauzo ya bidhaa za thamani',
      perm: 'reports.view',
      columns: ['product_name', 'qty', 'gross', 'sales', 'last_sold_by'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        return {
          rows: d.prepare(`
            SELECT l.product_name, SUM(l.qty) AS qty, SUM(l.gross) AS gross,
                   COUNT(DISTINCT l.sale_id) AS sales,
                   (SELECT user_name FROM spirits_premium_log x
                     WHERE x.product_id = l.product_id ORDER BY x.id DESC LIMIT 1) AS last_sold_by
              FROM spirits_premium_log l
             WHERE l.branch_id IN (${ph}) AND l.created_at >= ? AND l.created_at <= ?
             GROUP BY l.product_id, l.product_name
             ORDER BY gross DESC
          `).all(...list, from, to)
        };
      }
    },
    {
      id: 'price_per_litre',
      title: 'Price per litre (bottle economics)',
      titleSw: 'Bei kwa lita (uchumi wa chupa)',
      perm: 'reports.view',
      columns: ['product_name', 'variant_name', 'bottle_ml', 'abv', 'price', 'price_per_litre', 'margin'],
      run(d) {
        const rows = d.prepare(`
          SELECT p.id AS product_id, p.name AS product_name, p.cost AS product_cost, p.price AS product_price, p.meta AS product_meta,
                 v.id AS variant_id, v.name AS variant_name, v.price, v.cost, v.meta AS variant_meta
            FROM products p JOIN variants v ON v.product_id = p.id AND v.active = 1
           WHERE p.active = 1
        `).all();
        const out = [];
        for (const r of rows) {
          const meta = { ...kit.parse(r.product_meta), ...kit.parse(r.variant_meta) };
          const ml = Number(meta.bottle_ml || 0);
          if (!ml) continue;                       // only bottled lines have a litre price
          // A variant only carries a price when it overrides the product's.
          const unit = Number(r.price != null ? r.price : r.product_price) || 0;
          const cost = Number(r.cost != null ? r.cost : r.product_cost) || 0;
          out.push({
            product_name: r.product_name,
            variant_name: r.variant_name || '',
            bottle_ml: ml,
            abv: meta.abv || '',
            price: unit,
            price_per_litre: Math.round((unit * 1000) / ml),
            margin: unit - cost
          });
        }
        return { rows: out.sort((a, b) => b.price_per_litre - a.price_per_litre) };
      }
    },
    {
      id: 'case_economics',
      title: 'Case & carton economics',
      titleSw: 'Uchumi wa keesi na katoni',
      perm: 'reports.view',
      columns: ['product_name', 'case_size', 'bottle_price', 'case_price', 'case_margin', 'case_margin_pct', 'per_bottle_saving'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        const variants = d.prepare(`
          SELECT p.id AS product_id, p.name AS product_name, p.cost AS product_cost, p.price AS product_price,
                 p.meta AS product_meta, v.id AS variant_id, v.name AS variant_name, v.price, v.cost, v.meta AS variant_meta
            FROM products p JOIN variants v ON v.product_id = p.id AND v.active = 1
           WHERE p.active = 1
        `).all();
        const packs = d.prepare('SELECT * FROM packs WHERE active = 1').all();
        const out = [];
        for (const r of variants) {
          const meta = { ...kit.parse(r.product_meta), ...kit.parse(r.variant_meta) };
          const caseSize = Number(meta.case_size || 0);
          const bottle = Number(r.price != null ? r.price : r.product_price) || 0;
          const cost = Number(r.cost != null ? r.cost : r.product_cost) || 0;
          const pack = packs.find((pk) => pk.variant_id === r.variant_id && pk.multiple > 1);
          const caseUnits = caseSize || (pack ? pack.multiple : 0);
          if (!caseUnits) continue;
          const casePrice = pack && pack.price ? Number(pack.price) : Math.round(bottle * caseUnits);
          const caseCost = cost * caseUnits;
          out.push({
            product_name: r.product_name + (r.variant_name ? ` — ${r.variant_name}` : ''),
            case_size: caseUnits,
            bottle_price: bottle,
            case_price: casePrice,
            case_margin: casePrice - caseCost,
            case_margin_pct: kit.marginPct(casePrice, caseCost),
            per_bottle_saving: bottle ? Math.round(bottle - casePrice / caseUnits) : 0
          });
        }
        return { rows: out.sort((a, b) => b.case_margin - a.case_margin), meta: { branches: list } };
      }
    },
    {
      id: 'weekend_demand',
      title: 'Weekend demand (peak trading)',
      titleSw: 'Mahitaji ya wikendi',
      perm: 'reports.view',
      columns: ['product_name', 'weekday_qty', 'weekend_qty', 'weekend_share_pct', 'gross'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT si.product_id, p.name AS product_name,
                 SUM(CASE WHEN CAST(strftime('%w', s.created_at) AS INTEGER) IN (0,5,6) THEN si.qty ELSE 0 END) AS weekend_qty,
                 SUM(CASE WHEN CAST(strftime('%w', s.created_at) AS INTEGER) IN (0,5,6) THEN 0 ELSE si.qty END) AS weekday_qty,
                 SUM(si.gross) AS gross
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN products p ON p.id = si.product_id
           WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
             AND s.created_at >= ? AND s.created_at <= ?
           GROUP BY si.product_id, p.name
          HAVING weekend_qty > 0
           ORDER BY weekend_qty DESC
           LIMIT 100
        `).all(...list, from, to);
        return {
          rows: rows.map((r) => ({
            ...r,
            weekend_share_pct: (r.weekend_qty + r.weekday_qty)
              ? Math.round((r.weekend_qty * 100) / (r.weekend_qty + r.weekday_qty))
              : 0
          }))
        };
      }
    },
    {
      id: 'shrinkage_focus',
      title: 'Shrinkage on high-value stock',
      titleSw: 'Upotevu wa bidhaa ghali',
      perm: 'reports.view',
      columns: ['product_name', 'lost_qty', 'value', 'incidents', 'last_reason'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        return {
          rows: d.prepare(`
            SELECT p.name AS product_name, SUM(-m.qty) AS lost_qty,
                   SUM(-m.qty * COALESCE(m.unit_cost, p.cost, 0)) AS value,
                   COUNT(*) AS incidents,
                   (SELECT m2.reason FROM stock_moves m2
                     WHERE m2.product_id = m.product_id AND m2.branch_id = m.branch_id AND m2.qty < 0
                       AND m2.type IN ('damage','expiry_writeoff','adjustment','stocktake')
                     ORDER BY m2.id DESC LIMIT 1) AS last_reason
              FROM stock_moves m
              JOIN products p ON p.id = m.product_id
             WHERE m.branch_id IN (${ph}) AND m.qty < 0
               AND m.type IN ('damage','expiry_writeoff','adjustment','stocktake')
               AND m.created_at >= ? AND m.created_at <= ?
             GROUP BY m.product_id, p.name
            HAVING value > 0
             ORDER BY value DESC
             LIMIT 100
          `).all(...list, from, to)
        };
      }
    },
    {
      id: 'count_priority',
      title: 'Stock-count priority (count the expensive shelf first)',
      titleSw: 'Kipaumbele cha kuhesabu (anza na ghali)',
      perm: 'reports.view',
      columns: ['product_name', 'qty', 'unit_cost', 'value', 'priority'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT p.name AS product_name, SUM(st.qty) AS qty,
                 COALESCE(v.cost, p.cost, 0) AS unit_cost,
                 SUM(st.qty) * COALESCE(v.cost, p.cost, 0) AS value
            FROM stock st
            JOIN variants v ON v.id = st.variant_id
            JOIN products p ON p.id = v.product_id
            JOIN locations l ON l.id = st.location_id
           WHERE l.branch_id IN (${ph}) AND st.qty > 0 AND p.active = 1
           GROUP BY v.id, p.name
           ORDER BY value DESC
           LIMIT 100
        `).all(...list);
        const top = rows.length ? rows[0].value : 0;
        return {
          rows: rows.map((r, i) => ({
            ...r,
            priority: top && r.value >= top * 0.5 ? 'A' : (i < 20 ? 'B' : 'C')
          }))
        };
      }
    }
  ],

  ui: [
    {
      id: 'spirits-panel',
      mount: 'manager',
      script: '/modules/spirits.js',
      label: 'spirits_tab',
      labelSw: 'Waini na maziwa',
      i18n: {
        en: {
          spirits_tab: 'Wines & Spirits',
          premium_lines: 'Premium lines (manager only)',
          premium_hint: 'Cashiers are blocked from ringing these up — a manager or the owner must be signed in.',
          bottle_economics: 'Price per litre',
          bottle_hint: 'Set “Bottle size (ml)” on a variant to see what the shop really charges per litre.',
          no_premium: 'No products are marked as premium lines yet.',
          per_litre: 'per litre',
          run_report: 'Open report'
        },
        sw: {
          spirits_tab: 'Waini na maziwa',
          premium_lines: 'Bidhaa za thamani (meneja tu)',
          premium_hint: 'Wauzaji hawaruhusiwi kuuza hizi — meneja au mwenyeji lazima awe ameingia.',
          bottle_economics: 'Bei kwa lita',
          bottle_hint: 'Weka “Ukubwa wa chupa (ml)” kwenye aina ili kuona bei halisi kwa lita.',
          no_premium: 'Hakuna bidhaa zilizowekwa kama za thamani bado.',
          per_litre: 'kwa lita',
          run_report: 'Fungua ripoti'
        }
      }
    }
  ]
};

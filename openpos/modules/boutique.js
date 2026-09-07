'use strict';
// ---------------------------------------------------------------------------
// boutique.js — Boutique / Fashion industry module (Phase 20).
//
// Fashion is variant-first: a dress is not a product, it is a size × colour
// matrix, and the shop lives or dies by sell-through and markdowns.
//   • a matrix product must be sold AS a variant, never as its parent row
//   • markdown / clearance is a first-class, reversible act (a price rule, not
//     a destructive price edit — the core pricing engine resolves it)
//   • size and colour sell-through show which sizes to reorder
//   • dead fashion stock is fashion's version of dead stock: season-aware
// ---------------------------------------------------------------------------
const kit = require('./_kit');

const SEASONS = ['SS', 'AW', 'resort', 'core'];

module.exports = {
  id: 'boutique',
  name: 'Boutique / Fashion',
  nameSw: 'Butiki / Mavazi',
  version: 1,
  trades: ['boutique'],
  description: 'Size × colour matrix, markdowns & clearance, sell-through and dead fashion stock.',
  descriptionSw: 'Mchanganyiko wa ukubwa × rangi, punguzo la msimu, mauzo ya ukubwa na bidhaa zilizokwama.',

  capabilities: ['variants'],

  productFields: [
    { key: 'brand', label: 'Brand', labelSw: 'Chapa', type: 'text', appliesTo: 'product' },
    { key: 'season', label: 'Season', labelSw: 'Msimu', type: 'select', options: SEASONS.join(','), appliesTo: 'product' },
    { key: 'collection', label: 'Collection', labelSw: 'Mkusanyiko', type: 'text', appliesTo: 'product' },
    { key: 'supplier_sku', label: 'Supplier style code', labelSw: 'Namba ya muuzaji', type: 'text', appliesTo: 'variant' },
    { key: 'on_markdown', label: 'On markdown', labelSw: 'Ime punguzwa', type: 'boolean', appliesTo: 'product' }
  ],

  permissions: [
    { perm: 'boutique.markdown', label: 'Run markdowns & clearance', labelSw: 'Endesha punguzo la msimu', roles: ['owner', 'manager'] }
  ],

  checkout: {
    // A matrix product has real variants; the implicit parent row is a
    // bookkeeping device, not something you can sell. Fashion shops lose hours
    // to stock that lands on the parent instead of the size that was sold.
    validateLine({ d, product, variant, helpers }) {
      if (!variant) return;
      const isParent = !variant.axes_key || variant.axes_key === '{}' || variant.axes_key === '';
      if (!isParent) return;
      const n = d.prepare('SELECT COUNT(*) AS n FROM variants WHERE product_id = ? AND active = 1').get(product.id).n;
      if (n > 1) {
        throw helpers.block(400, `${product.name}: pick a size/colour — this line has ${n} variants`);
      }
    }
  },

  commands: [
    {
      id: 'markdown',
      title: 'Mark down a line (season / collection / category)',
      titleSw: 'Punguza bei ya bidhaa',
      perm: 'boutique.markdown',
      params: [
        { name: 'percent', label: 'Markdown %', type: 'number', required: true },
        { name: 'code', label: 'Markdown code (e.g. SALE30)', type: 'text', required: true },
        { name: 'season', label: 'Season', type: 'text' },
        { name: 'category_id', label: 'Category', type: 'number' },
        { name: 'ends_at', label: 'Ends on (date)', type: 'date' }
      ],
      run(d, { params, user, helpers }) {
        const pct = Number(params.percent);
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw helpers.block(400, 'markdown % must be between 1 and 99');
        const season = String(params.season || '').trim();
        const catId = params.category_id ? Number(params.category_id) : null;
        if (!season && !catId) throw helpers.block(400, 'choose a season or a category to mark down');

        const rows = d.prepare(`
          SELECT v.id AS variant_id, v.price, v.cost, p.price AS product_price, p.cost AS product_cost, p.meta AS product_meta
            FROM variants v JOIN products p ON p.id = v.product_id
           WHERE v.active = 1 AND p.active = 1 ${catId ? 'AND p.category_id = ?' : ''}
        `).all(...(catId ? [catId] : []));
        const targets = rows.filter((r) => !season || String((kit.parse(r.product_meta).season || '')).toLowerCase() === season.toLowerCase());
        if (!targets.length) throw helpers.block(404, 'no products match that markdown filter');

        const floor = Number((helpers.setting('pricing', {}) || {}).min_margin_pct) || 0;
        const now = new Date().toISOString();
        const ends = params.ends_at ? String(params.ends_at).slice(0, 10) : null;
        const ins = d.prepare(`
          INSERT INTO price_rules (business_id, variant_id, promo_code, price, valid_to, note, active, created_by, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT DO NOTHING
        `);
        let applied = 0, skipped = 0;
        for (const t of targets) {
          const current = Number(t.price != null ? t.price : t.product_price) || 0;
          const cost = Number(t.cost != null ? t.cost : t.product_cost) || 0;
          const next = Math.max(1, Math.round(current * (100 - pct) / 100));
          if (floor > 0 && kit.marginPct(next, cost) < floor) { skipped++; continue; }
          ins.run(t.variant_id, String(params.code), next, ends, `${pct}% markdown`, user ? user.id : null, now, now);
          d.prepare("UPDATE products SET meta = ? WHERE id = (SELECT product_id FROM variants WHERE id = ?)")
            .run(JSON.stringify({ ...kit.parse(t.product_meta), on_markdown: 1 }), t.variant_id);
          applied++;
        }
        return { summary: { applied, skipped, code: params.code }, applied, skipped, floor };
      }
    },
    {
      id: 'clear_markdown',
      title: 'End a markdown (restore original prices)',
      titleSw: 'Maliza punguzo',
      perm: 'boutique.markdown',
      params: [{ name: 'code', label: 'Markdown code', type: 'text', required: true }],
      run(d, { params }) {
        const r = d.prepare('UPDATE price_rules SET active = 0, updated_at = ? WHERE promo_code = ? AND active = 1')
          .run(new Date().toISOString(), String(params.code));
        return { summary: { ended: r.changes }, ended: r.changes };
      }
    }
  ],

  reports: [
    {
      id: 'size_sell_through',
      title: 'Size sell-through',
      titleSw: 'Mauzo kwa ukubwa',
      perm: 'reports.view',
      columns: ['size', 'sold', 'on_hand', 'gross', 'sell_through_pct'],
      run(d, { from, to, branches, branchId }) {
        return sellThroughByAxis(d, { from, to, branches, branchId }, 'size');
      }
    },
    {
      id: 'colour_sell_through',
      title: 'Colour sell-through',
      titleSw: 'Mauzo kwa rangi',
      perm: 'reports.view',
      columns: ['colour', 'sold', 'on_hand', 'gross', 'sell_through_pct'],
      run(d, { from, to, branches, branchId }) {
        return sellThroughByAxis(d, { from, to, branches, branchId }, 'colour');
      }
    },
    {
      id: 'dead_fashion_stock',
      title: 'Dead fashion stock (nothing sold in 60 days)',
      titleSw: 'Bidhaa za mavazi zilizokwama',
      perm: 'reports.view',
      columns: ['product_name', 'variant_name', 'brand', 'season', 'on_hand', 'value', 'last_sold'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const since = new Date(Date.now() - 60 * 86400000).toISOString();
        return {
          rows: d.prepare(`
            SELECT p.name AS product_name, v.name AS variant_name, p.meta AS product_meta,
                   p.brand, COALESCE(SUM(st.qty), 0) AS on_hand,
                   COALESCE(SUM(st.qty), 0) * COALESCE(v.cost, p.cost, 0) AS value,
                   (SELECT MAX(s.created_at) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                     WHERE si.variant_id = v.id AND s.status IN ('paid','partial')) AS last_sold
              FROM variants v
              JOIN products p ON p.id = v.product_id
              JOIN stock st ON st.variant_id = v.id
              JOIN locations l ON l.id = st.location_id
             WHERE l.branch_id IN (${ph}) AND v.active = 1 AND p.active = 1
               AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                                WHERE si.variant_id = v.id AND s.status IN ('paid','partial') AND s.created_at >= ?)
             GROUP BY v.id
            HAVING on_hand > 0
             ORDER BY value DESC
             LIMIT 200
          `).all(...list, since).map((r) => ({
            ...r,
            brand: r.brand || kit.parse(r.product_meta).brand || '',
            season: kit.parse(r.product_meta).season || ''
          }))
        };
      }
    },
    {
      id: 'markdowns',
      title: 'Active markdowns',
      titleSw: 'Punguzo zinazoendelea',
      perm: 'reports.view',
      columns: ['code', 'variant_id', 'product_name', 'price', 'valid_to'],
      run(d) {
        return {
          rows: d.prepare(`
            SELECT r.promo_code AS code, r.variant_id, r.price, r.valid_to,
                   p.name AS product_name, v.name AS variant_name
              FROM price_rules r
              JOIN variants v ON v.id = r.variant_id
              JOIN products p ON p.id = v.product_id
             WHERE r.active = 1 AND r.promo_code IS NOT NULL
             ORDER BY r.promo_code, r.id
          `).all()
        };
      }
    }
  ],

  ui: [
    {
      id: 'boutique-panel',
      mount: 'manager',
      script: '/modules/boutique.js',
      label: 'boutique_tab',
      labelSw: 'Butiki',
      i18n: {
        en: {
          boutique_tab: 'Boutique',
          sell_through: 'Sell-through by size',
          sell_through_hint: 'Sizes that sell out fast are the sizes to reorder; sizes sitting still are next season’s markdown.',
          dead_fashion: 'Dead fashion stock',
          dead_hint: 'Nothing sold in 60 days — markdown or return to supplier.',
          markdowns: 'Active markdowns',
          size: 'Size',
          sold: 'Sold',
          on_hand: 'On hand',
          none: 'Nothing to show yet.'
        },
        sw: {
          boutique_tab: 'Butiki',
          sell_through: 'Mauzo kwa ukubwa',
          sell_through_hint: 'Ukubwa unaouzwa haraka ndio wa kuagiza; usiouzwa ni punguzo la msimu ujao.',
          dead_fashion: 'Bidhaa zilizokwama',
          dead_hint: 'Hakuna kilichouzwa kwa siku 60 — punguza bei au rudisha kwa muuzaji.',
          markdowns: 'Punguzo zinazoendelea',
          size: 'Ukubwa',
          sold: 'Imeuzwa',
          on_hand: 'Ipo',
          none: 'Hakuna cha kuonyesha bado.'
        }
      }
    }
  ],
  receipt: [
    { en: 'Exchange within 7 days with this receipt — goods unworn.',
      sw: 'Badilisha ndani ya siku 7 na risiti hii — bidhaa isiyovaliwa.' }
  ]
};

// ---- helpers ---------------------------------------------------------------

/** Sell-through grouped by one variant axis (size / colour). */
function sellThroughByAxis(d, { from, to, branches, branchId }, axis) {
  const list = branchId ? [branchId] : branches;
  if (!list.length) return { rows: [] };
  const ph = list.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT si.variant_id, SUM(si.qty) AS sold, SUM(si.gross) AS gross, v.axes, v.name AS variant_name,
           p.name AS product_name
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN variants v ON v.id = si.variant_id
      JOIN products p ON p.id = v.product_id
     WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
       AND s.created_at >= ? AND s.created_at <= ?
     GROUP BY si.variant_id
  `).all(...list, from, to);
  const stock = kit.stockByVariant(d, list);
  const byKey = new Map();
  for (const r of rows) {
    const key = kit.axis({ axes: r.axes }, axis) || '(unspecified)';
    const cur = byKey.get(key) || { key, sold: 0, gross: 0, on_hand: 0 };
    cur.sold += r.sold;
    cur.gross += r.gross;
    cur.on_hand += Number((stock.get(r.variant_id) || {}).qty || 0);
    byKey.set(key, cur);
  }
  const out = [...byKey.values()].map((r) => ({
    [axis]: r.key,
    sold: r.sold,
    on_hand: r.on_hand,
    gross: r.gross,
    sell_through_pct: (r.sold + r.on_hand) ? Math.round((r.sold * 100) / (r.sold + r.on_hand)) : 0
  }));
  return { rows: out.sort((a, b) => b.sold - a.sold) };
}

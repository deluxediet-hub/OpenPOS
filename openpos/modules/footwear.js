'use strict';
// ---------------------------------------------------------------------------
// footwear.js — Footwear industry module (Phase 23).
//
// Shoes are sold as a size × colour × width matrix, in pairs:
//   • the parent row is not sellable — the size must be chosen (same rule as
//     boutique, different trade)
//   • broken sizes are the money: a 42 with no 41 beside it stops selling
//   • each variant needs its own barcode, or the shop scans the wrong pair
// ---------------------------------------------------------------------------
const kit = require('./_kit');

module.exports = {
  id: 'footwear',
  name: 'Footwear / Shoe shop',
  nameSw: 'Duka la viatu',
  version: 1,
  trades: ['footwear'],
  description: 'Size × colour × width matrix, per-variant barcodes and broken-size detection.',
  descriptionSw: 'Mchanganyiko wa ukubwa × rangi × upana, barkodi kwa kila aina na ukubwa uliovunjika.',

  capabilities: ['variants'],

  template: {
    categories: [
      { name: "Men's Footwear", name_sw: 'Viatu vya wanaume' },
      { name: "Women's Footwear", name_sw: 'Viatu vya wanawake' },
      { name: "Kids' Footwear", name_sw: 'Viatu vya watoto' },
      { name: 'Shoe Care', name_sw: 'Utunzaji wa viatu' }
    ],
    products: [
      { sku: 'FTW-001', barcode: '600941000301', name: "Men's Leather Shoe", name_sw: 'Kiatu cha ngozi', unit: 'pair', cost: 2200, price: 3500, taxType: 'std', kraItemCode: '640399000001', categoryId: 1 },
      { sku: 'FTW-002', barcode: '600941000302', name: "Men's Sneaker", name_sw: 'Kiatu cha michezo', unit: 'pair', cost: 2800, price: 4200, taxType: 'std', kraItemCode: '640411000001', categoryId: 1 },
      { sku: 'FTW-003', barcode: '600941000303', name: "Men's Sandal", name_sw: 'Sandali ya kiume', unit: 'pair', cost: 1200, price: 1900, taxType: 'std', kraItemCode: '640299000001', categoryId: 1 },
      { sku: 'FTW-004', barcode: '600941000304', name: "Women's Heel", name_sw: 'Kiatu cha kisigino', unit: 'pair', cost: 1800, price: 2900, taxType: 'std', kraItemCode: '640399000002', categoryId: 2 },
      { sku: 'FTW-005', barcode: '600941000305', name: "Women's Flat Shoe", name_sw: 'Kiatu bapa', unit: 'pair', cost: 1600, price: 2500, taxType: 'std', kraItemCode: '640399000003', categoryId: 2 },
      { sku: 'FTW-006', barcode: '600941000306', name: "Women's Sandal", name_sw: 'Sandali ya kike', unit: 'pair', cost: 1100, price: 1800, taxType: 'std', kraItemCode: '640299000002', categoryId: 2 },
      { sku: 'FTW-007', barcode: '600941000307', name: "Kids' School Shoe", name_sw: 'Kiatu cha shule', unit: 'pair', cost: 1500, price: 2400, taxType: 'std', kraItemCode: '640351000001', categoryId: 3 },
      { sku: 'FTW-008', barcode: '600941000308', name: "Kids' Sandal", name_sw: 'Sandali ya watoto', unit: 'pair', cost: 700, price: 1200, taxType: 'std', kraItemCode: '640299000003', categoryId: 3 },
      { sku: 'FTW-009', barcode: '600941000309', name: 'Shoe Polish', name_sw: 'Rangi ya viatu', unit: 'pcs', cost: 150, price: 300, taxType: 'std', kraItemCode: '340510000001', categoryId: 4 },
      { sku: 'FTW-010', barcode: '600941000310', name: 'Shoe Brush', name_sw: 'Brashi ya viatu', unit: 'pcs', cost: 200, price: 350, taxType: 'std', kraItemCode: '960340000001', categoryId: 4 }
    ]
  },

  productFields: [
    { key: 'brand', label: 'Brand', labelSw: 'Chapa', type: 'text', appliesTo: 'product' },
    { key: 'style_code', label: 'Style code', labelSw: 'Namba ya mtindo', type: 'text', appliesTo: 'product' },
    { key: 'gender', label: 'Gender', labelSw: 'Jinsia', type: 'select', options: 'men,women,unisex,kids', appliesTo: 'product' },
    { key: 'size_scale', label: 'Size scale', labelSw: 'Mfumo wa ukubwa', type: 'select', options: 'EU,UK,US', appliesTo: 'product' }
  ],

  checkout: {
    validateLine({ d, product, variant, helpers }) {
      if (!variant) return;
      const isParent = !variant.axes_key || variant.axes_key === '{}' || variant.axes_key === '';
      if (!isParent) return;
      const n = d.prepare('SELECT COUNT(*) AS n FROM variants WHERE product_id = ? AND active = 1').get(product.id).n;
      if (n > 1) {
        throw helpers.block(400, `${product.name}: pick a size — this style has ${n} size/colour variants`);
      }
    }
  },

  reports: [
    {
      id: 'shoe_size_sell_through',
      title: 'Size sell-through',
      titleSw: 'Mauzo ya ukubwa',
      perm: 'reports.view',
      columns: ['size', 'sold', 'on_hand', 'gross', 'sell_through_pct'],
      run(d, { from, to, branches, branchId }) {
        return axisSellThrough(d, { from, to, branches, branchId }, ['size', 'ukubwa']);
      }
    },
    {
      id: 'broken_sizes',
      title: 'Broken sizes (a size with no neighbours)',
      titleSw: 'Ukubwa uliovunjika',
      perm: 'reports.view',
      columns: ['product_name', 'sizes_on_hand', 'sizes_sold', 'gap'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT v.id AS variant_id, v.product_id, v.name AS variant_name, v.axes, p.name AS product_name,
                 COALESCE(SUM(st.qty), 0) AS on_hand
            FROM variants v
            JOIN products p ON p.id = v.product_id
            LEFT JOIN stock st ON st.variant_id = v.id
            LEFT JOIN locations l ON l.id = st.location_id AND l.branch_id IN (${ph})
           WHERE v.active = 1 AND p.active = 1
           GROUP BY v.id
        `).all(...list);
        const byProduct = new Map();
        for (const r of rows) {
          const cur = byProduct.get(r.product_id) || { product_name: r.product_name, sizes: [] };
          const size = kit.axis({ axes: r.axes }, 'size') || kit.axis({ axes: r.axes }, 'ukubwa') || r.variant_name;
          cur.sizes.push({ size, on_hand: r.on_hand });
          byProduct.set(r.product_id, cur);
        }
        const out = [];
        for (const [, v] of byProduct) {
          const present = v.sizes.filter((s) => s.on_hand > 0).map((s) => Number(s.size)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
          const missing = [];
          for (let i = 0; i < present.length - 1; i++) {
            const step = v.sizes.length && /EU|IT/.test(present.join()) ? 1 : 1;
            for (let s = present[i] + step; s < present[i + 1]; s += step) missing.push(s);
          }
          if (!missing.length) continue;
          out.push({
            product_name: v.product_name,
            sizes_on_hand: present.join(', '),
            sizes_sold: v.sizes.filter((s) => s.on_hand <= 0).map((s) => s.size).join(', ') || '—',
            gap: missing.join(', ')
          });
        }
        return { rows: out };
      }
    },
    {
      id: 'barcode_gaps',
      title: 'Variants without their own barcode',
      titleSw: 'Aina zisizo na barkodi',
      perm: 'reports.view',
      columns: ['product_name', 'variant_name', 'barcode'],
      run(d) {
        // A shoe shop scans sizes. A size with no barcode of its own is a
        // mis-scanned pair waiting to happen, so it gets listed.
        const rows = d.prepare(`
          SELECT v.id, v.name AS variant_name, v.axes, p.name AS product_name,
                 (SELECT MIN(b.barcode) FROM variant_barcodes b WHERE b.variant_id = v.id AND b.active = 1) AS barcode
            FROM variants v JOIN products p ON p.id = v.product_id
           WHERE v.active = 1 AND p.active = 1
             AND NOT EXISTS (SELECT 1 FROM variant_barcodes b WHERE b.variant_id = v.id AND b.active = 1)
           ORDER BY p.name
        `).all();
        return {
          rows: rows
            .filter((r) => r.axes && r.axes !== '{}')
            .map((r) => ({ product_name: r.product_name, variant_name: r.variant_name || '', barcode: r.barcode || '' }))
        };
      }
    }
  ],

  ui: [
    {
      id: 'footwear-panel',
      mount: 'manager',
      script: '/modules/footwear.js',
      label: 'footwear_tab',
      labelSw: 'Viatu',
      i18n: {
        en: {
          footwear_tab: 'Footwear',
          sizes: 'Size sell-through',
          sizes_hint: 'Pairs sold against pairs on hand — the size curve tells you what to reorder.',
          broken: 'Broken sizes',
          broken_hint: 'A style missing the sizes around the ones in stock stops selling.',
          none: 'Nothing to show yet.',
          sold: 'Sold',
          on_hand: 'On hand'
        },
        sw: {
          footwear_tab: 'Viatu',
          sizes: 'Mauzo ya ukubwa',
          sizes_hint: 'Viatu vilivyouzwa dhidi ya vilivyopo — mkondo wa ukubwa unaonyesha uagize nini.',
          broken: 'Ukubwa uliovunjika',
          broken_hint: 'Mtindo usio na ukubwa wa karibu huacha kuuzwa.',
          none: 'Hakuna cha kuonyesha bado.',
          sold: 'Imeuzwa',
          on_hand: 'Ipo'
        }
      }
    }
  ],
  receipt: [
    { en: 'Exchange within 7 days with this receipt — unworn, in the box.',
      sw: 'Badilisha ndani ya siku 7 na risiti hii — bila kuvaa, kwenye sanduku.' }
  ]
};

/** Sell-through grouped by size, tolerating an English or Swahili axis name. */
function axisSellThrough(d, { from, to, branches, branchId }, keys) {
  const list = branchId ? [branchId] : branches;
  if (!list.length) return { rows: [] };
  const ph = list.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT si.variant_id, SUM(si.qty) AS sold, SUM(si.gross) AS gross, v.axes, v.name AS variant_name
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN variants v ON v.id = si.variant_id
     WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
       AND s.created_at >= ? AND s.created_at <= ?
     GROUP BY si.variant_id
  `).all(...list, from, to);
  const stock = kit.stockByVariant(d, list);
  const map = new Map();
  for (const r of rows) {
    let key = '';
    for (const k of keys) { key = kit.axis({ axes: r.axes }, k); if (key) break; }
    key = key || r.variant_name || '(unspecified)';
    const cur = map.get(key) || { sold: 0, gross: 0, on_hand: 0 };
    cur.sold += r.sold; cur.gross += r.gross;
    cur.on_hand += Number((stock.get(r.variant_id) || {}).qty || 0);
    map.set(key, cur);
  }
  return {
    rows: [...map.entries()].map(([k, v]) => ({
      size: k, sold: v.sold, on_hand: v.on_hand, gross: v.gross,
      sell_through_pct: (v.sold + v.on_hand) ? Math.round((v.sold * 100) / (v.sold + v.on_hand)) : 0
    })).sort((a, b) => b.sold - a.sold)
  };
}

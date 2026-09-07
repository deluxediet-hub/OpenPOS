'use strict';
// ---------------------------------------------------------------------------
// cosmetics.js — Cosmetics industry module (Phase 23).
//
// Cosmetics is shade-driven and expiry-aware:
//   • a shade is a variant axis, and shade sell-through decides the next order
//   • bundles (gift sets) are packs the core already understands
//   • creams and serums expire; selling an expired one is a liability
// ---------------------------------------------------------------------------
const kit = require('./_kit');

const OUTBOUND = new Set(['sale', 'return_out', 'transfer_out', 'adjustment']);

module.exports = {
  id: 'cosmetics',
  name: 'Cosmetics',
  nameSw: 'Vipodozi',
  version: 1,
  trades: ['cosmetics'],
  description: 'Shade & size sell-through, bundles, and an expiry guard on creams.',
  descriptionSw: 'Mauzo ya rangi na ukubwa, vifurushi, na ulinzi wa tarehe ya mwisho.',

  capabilities: ['variants', 'batches', 'packs'],

  template: {
    categories: [
      { name: 'Skincare', name_sw: 'Utunzaji wa ngozi' },
      { name: 'Hair', name_sw: 'Nywele' },
      { name: 'Makeup', name_sw: 'Vipodozi vya uso' },
      { name: 'Fragrance', name_sw: 'Manukato' }
    ],
    products: [
      { sku: 'COS-001', barcode: '600941000201', name: 'Face Cream 100ml', name_sw: 'Krimu ya uso', unit: 'pcs', cost: 350, price: 550, taxType: 'std', kraItemCode: '330499000001', categoryId: 1, trackBatches: 1 },
      { sku: 'COS-002', barcode: '600941000202', name: 'Sunscreen SPF50', name_sw: 'Kinga ya jua', unit: 'pcs', cost: 900, price: 1400, taxType: 'std', kraItemCode: '330491000001', categoryId: 1, trackBatches: 1 },
      { sku: 'COS-003', barcode: '600941000203', name: 'Body Lotion 400ml', name_sw: 'Mafuta ya mwili', unit: 'pcs', cost: 450, price: 700, taxType: 'std', kraItemCode: '330499000002', categoryId: 1, trackBatches: 1 },
      { sku: 'COS-004', barcode: '600941000204', name: 'Vitamin C Serum', name_sw: 'Seramu ya vitamini C', unit: 'pcs', cost: 1600, price: 2300, taxType: 'std', kraItemCode: '330499000003', categoryId: 1, trackBatches: 1 },
      { sku: 'COS-005', barcode: '600941000205', name: 'Shampoo 400ml', name_sw: 'Shampoo', unit: 'pcs', cost: 380, price: 600, taxType: 'std', kraItemCode: '330510000001', categoryId: 2 },
      { sku: 'COS-006', barcode: '600941000206', name: 'Hair Conditioner 400ml', name_sw: 'Kilainisha nywele', unit: 'pcs', cost: 420, price: 650, taxType: 'std', kraItemCode: '330590000001', categoryId: 2 },
      { sku: 'COS-007', barcode: '600941000207', name: 'Hair Oil 200ml', name_sw: 'Mafuta ya nywele', unit: 'pcs', cost: 350, price: 550, taxType: 'std', kraItemCode: '330590000002', categoryId: 2 },
      { sku: 'COS-008', barcode: '600941000208', name: 'Lipstick', name_sw: 'Rangi ya midomo', unit: 'pcs', cost: 550, price: 900, taxType: 'std', kraItemCode: '330410000001', categoryId: 3 },
      { sku: 'COS-009', barcode: '600941000209', name: 'Foundation', name_sw: 'Msingi wa uso', unit: 'pcs', cost: 1200, price: 1800, taxType: 'std', kraItemCode: '330491000002', categoryId: 3 },
      { sku: 'COS-010', barcode: '600941000210', name: 'Mascara', name_sw: 'Rangi ya kope', unit: 'pcs', cost: 700, price: 1100, taxType: 'std', kraItemCode: '330420000001', categoryId: 3 },
      { sku: 'COS-011', barcode: '600941000211', name: 'Perfume 100ml', name_sw: 'Manukato', unit: 'btl', cost: 2200, price: 3200, taxType: 'std', kraItemCode: '330300000001', categoryId: 4 },
      { sku: 'COS-012', barcode: '600941000212', name: 'Deodorant', name_sw: 'Dawa ya jasho', unit: 'pcs', cost: 350, price: 550, taxType: 'std', kraItemCode: '330720000001', categoryId: 4 }
    ]
  },

  productFields: [
    { key: 'brand', label: 'Brand', labelSw: 'Chapa', type: 'text', appliesTo: 'product' },
    { key: 'shade', label: 'Shade', labelSw: 'Rangi', type: 'text', appliesTo: 'variant' },
    { key: 'size_ml', label: 'Size (ml / g)', labelSw: 'Ukubwa (ml / g)', type: 'number', appliesTo: 'variant' },
    { key: 'skin_type', label: 'Skin / hair type', labelSw: 'Aina ya ngozi/nywele', type: 'text', appliesTo: 'product' },
    { key: 'bundle', label: 'Bundle / gift set', labelSw: 'Kifurushi', type: 'boolean', appliesTo: 'product' },
    { key: 'perishable', label: 'Expires (creams, serums)', labelSw: 'Huisha muda', type: 'boolean', appliesTo: 'product' }
  ],

  stock: {
    // Same guard as the chemist, for the lines that actually perish.
    rule({ type, qty, batch, lots, product, helpers }) {
      if (qty >= 0) return;
      if (!OUTBOUND.has(type)) return;
      if (type === 'damage' || type === 'expiry_writeoff') return;
      if (!kit.parse(product && product.meta).perishable) return;
      const today = new Date().toISOString().slice(0, 10);
      const guard = (b) => {
        if (!b || !b.expiry_date || String(b.expiry_date) > today) return;
        throw helpers.block(409, `${product.name}: batch ${b.batch_no || b.id} expired on ${b.expiry_date}`);
      };
      if (batch) return guard(batch);
      let remaining = Math.abs(qty);
      for (const lot of lots || []) {
        if (remaining <= 1e-9) break;
        guard(lot);
        remaining -= lot.qty;
      }
    }
  },

  reports: [
    {
      id: 'shade_sell_through',
      title: 'Shade sell-through',
      titleSw: 'Mauzo ya rangi',
      perm: 'reports.view',
      columns: ['shade', 'sold', 'on_hand', 'gross', 'sell_through_pct'],
      run(d, { from, to, branches, branchId }) {
        return byAxis(d, { from, to, branches, branchId }, 'shade');
      }
    },
    {
      id: 'pack_size_sell_through',
      title: 'Size sell-through',
      titleSw: 'Mauzo ya ukubwa',
      perm: 'reports.view',
      columns: ['size_ml', 'sold', 'on_hand', 'gross'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT si.variant_id, SUM(si.qty) AS sold, SUM(si.gross) AS gross, v.meta AS variant_meta
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN variants v ON v.id = si.variant_id
           WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
             AND s.created_at >= ? AND s.created_at <= ?
           GROUP BY si.variant_id
        `).all(...list, from, to);
        const stock = kit.stockByVariant(d, list);
        const bySize = new Map();
        for (const r of rows) {
          const size = kit.parse(r.variant_meta).size_ml || 'unspecified';
          const cur = bySize.get(size) || { size_ml: size, sold: 0, gross: 0, on_hand: 0 };
          cur.sold += r.sold; cur.gross += r.gross;
          cur.on_hand += Number((stock.get(r.variant_id) || {}).qty || 0);
          bySize.set(size, cur);
        }
        return { rows: [...bySize.values()].sort((a, b) => b.sold - a.sold) };
      }
    },
    {
      id: 'bundle_performance',
      title: 'Bundles & gift sets',
      titleSw: 'Vifurushi',
      perm: 'reports.view',
      columns: ['product_name', 'sold', 'gross', 'margin_pct'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT p.id AS product_id, p.name AS product_name, p.meta AS product_meta, p.cost,
                 SUM(si.qty) AS sold, SUM(si.gross) AS gross
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN products p ON p.id = si.product_id
           WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
             AND s.created_at >= ? AND s.created_at <= ?
           GROUP BY p.id
        `).all(...list, from, to);
        return {
          rows: rows
            .filter((r) => kit.parse(r.product_meta).bundle)
            .map((r) => ({ ...r, margin_pct: r.sold ? kit.marginPct(r.gross / r.sold, r.cost) : 0 }))
            .sort((a, b) => b.gross - a.gross)
        };
      }
    },
    {
      id: 'cosmetics_expiry',
      title: 'Expiry watch (perishables)',
      titleSw: 'Uangalizi wa muda wa matumizi',
      perm: 'reports.view',
      columns: ['product_name', 'batch_no', 'expiry_date', 'days_left', 'bucket', 'qty'],
      run(d, { branches, branchId, days }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const within = Math.min(Math.max(Number(days) || 90, 1), 365);
        const rows = d.prepare(`
          SELECT p.name AS product_name, p.meta AS product_meta, b.batch_no, b.expiry_date, b.qty,
                 CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_left
            FROM batches b JOIN products p ON p.id = b.product_id
           WHERE b.branch_id IN (${ph}) AND b.qty > 0 AND b.expiry_date IS NOT NULL
             AND date(b.expiry_date) <= date('now', '+' || ? || ' days')
           ORDER BY b.expiry_date ASC LIMIT 300
        `).all(...list, within);
        return {
          rows: rows
            .filter((r) => kit.parse(r.product_meta).perishable)
            .map((r) => ({ ...r, bucket: kit.expiryBucket(r.days_left) }))
        };
      }
    }
  ],

  ui: [
    {
      id: 'cosmetics-panel',
      mount: 'manager',
      script: '/modules/cosmetics.js',
      label: 'cosmetics_tab',
      labelSw: 'Vipodozi',
      i18n: {
        en: {
          cosmetics_tab: 'Cosmetics',
          shades: 'Shade sell-through',
          shades_hint: 'Which shades move and which sit — the fastest-selling shade is the one to reorder.',
          expiry: 'Expiry watch',
          none: 'Nothing to show yet.',
          sold: 'Sold',
          on_hand: 'On hand'
        },
        sw: {
          cosmetics_tab: 'Vipodozi',
          shades: 'Mauzo ya rangi',
          shades_hint: 'Rangi zinazouzwa na zinazokaa — inayouzwa haraka ndio ya kuagiza.',
          expiry: 'Uangalizi wa muda',
          none: 'Hakuna cha kuonyesha bado.',
          sold: 'Imeuzwa',
          on_hand: 'Ipo'
        }
      }
    }
  ],
  receipt: [
    { en: 'Do a patch test before first use.',
      sw: 'Jaribu kidogo kabla ya kutumia kwa mara ya kwanza.' }
  ]
};

/** Sell-through grouped by one variant axis (shade). */
function byAxis(d, { from, to, branches, branchId }, axis) {
  const list = branchId ? [branchId] : branches;
  if (!list.length) return { rows: [] };
  const ph = list.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT si.variant_id, SUM(si.qty) AS sold, SUM(si.gross) AS gross, v.axes
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
    const key = kit.axis({ axes: r.axes }, axis) || '(unspecified)';
    const cur = map.get(key) || { sold: 0, gross: 0, on_hand: 0 };
    cur.sold += r.sold; cur.gross += r.gross;
    cur.on_hand += Number((stock.get(r.variant_id) || {}).qty || 0);
    map.set(key, cur);
  }
  return {
    rows: [...map.entries()].map(([k, v]) => ({
      [axis]: k, sold: v.sold, on_hand: v.on_hand, gross: v.gross,
      sell_through_pct: (v.sold + v.on_hand) ? Math.round((v.sold * 100) / (v.sold + v.on_hand)) : 0
    })).sort((a, b) => b.sold - a.sold)
  };
}

'use strict';
// ---------------------------------------------------------------------------
// mini_mart.js — General retail / mini-mart industry module (Phase 22).
//
// A mini-mart is a volume business: loose produce weighed at the scale, bulk
// packs, PLU codes, fast checkout and reorder discipline.
//   • scale items (open-priced) must carry a sane weight, not a typo
//   • PLU codes let a cashier key "401" instead of hunting for tomatoes
//   • reorder rules are driven by real velocity, not a feeling
//   • fast-checkout mode is a till-side setting the module declares
// ---------------------------------------------------------------------------
const kit = require('./_kit');

module.exports = {
  id: 'mini_mart',
  name: 'Mini-mart / General retail',
  nameSw: 'Duka kuu / Rejareja',
  version: 1,
  trades: ['mini_mart'],
  description: 'Scale & PLU selling, bulk packs, reorder rules and fast checkout.',
  descriptionSw: 'Uuzaji wa mizani na PLU, vifurushi, kanuni za kuagiza na ukaguzi wa haraka.',

  capabilities: ['open_priced', 'promotions'],

  template: {
    categories: [
      { name: 'Groceries', name_sw: 'Vyakula' },
      { name: 'Fresh Produce', name_sw: 'Mazao mapya' },
      { name: 'Beverages', name_sw: 'Vinywaji' },
      { name: 'Household', name_sw: 'Vya nyumbani' }
    ],
    products: [
      { sku: 'MAR-001', barcode: '600941000401', name: 'Sugar 2kg', name_sw: 'Sukari 2kg', unit: 'pcs', cost: 320, price: 400, taxType: 'std', kraItemCode: '170199000001', categoryId: 1 },
      { sku: 'MAR-002', barcode: '600941000402', name: 'Rice 5kg', name_sw: 'Wali 5kg', unit: 'pcs', cost: 1500, price: 1850, taxType: 'std', kraItemCode: '100630000001', categoryId: 1 },
      { sku: 'MAR-003', barcode: '600941000403', name: 'Wheat Flour 2kg', name_sw: 'Unga 2kg', unit: 'pcs', cost: 190, price: 250, taxType: 'std', kraItemCode: '110100000001', categoryId: 1 },
      { sku: 'MAR-004', barcode: '600941000404', name: 'Cooking Oil 2L', name_sw: 'Mafuta 2L', unit: 'pcs', cost: 620, price: 780, taxType: 'std', kraItemCode: '151190000001', categoryId: 1 },
      { sku: 'MAR-005', barcode: '600941000405', name: 'Salt 1kg', name_sw: 'Chumvi', unit: 'pcs', cost: 60, price: 100, taxType: 'exempt', kraItemCode: '250100000001', categoryId: 1 },
      { sku: 'MAR-006', barcode: '600941000406', name: 'Tomatoes (per kg)', name_sw: 'Nyanya', unit: 'kg', cost: 120, price: 180, taxType: 'exempt', kraItemCode: '070200000001', categoryId: 2, openPriced: 1 },
      { sku: 'MAR-007', barcode: '600941000407', name: 'Onions (per kg)', name_sw: 'Vitunguu', unit: 'kg', cost: 140, price: 200, taxType: 'exempt', kraItemCode: '070310000001', categoryId: 2, openPriced: 1 },
      { sku: 'MAR-008', barcode: '600941000408', name: 'Potatoes (per kg)', name_sw: 'Viazi', unit: 'kg', cost: 90, price: 140, taxType: 'exempt', kraItemCode: '070190000001', categoryId: 2, openPriced: 1 },
      { sku: 'MAR-009', barcode: '600941000409', name: 'Milk 1L', name_sw: 'Maziwa', unit: 'pcs', cost: 130, price: 180, taxType: 'exempt', kraItemCode: '040110000001', categoryId: 3 },
      { sku: 'MAR-010', barcode: '600941000410', name: 'Soda 500ml', name_sw: 'Soda', unit: 'btl', cost: 90, price: 130, taxType: 'std', kraItemCode: '220210000001', categoryId: 3 },
      { sku: 'MAR-011', barcode: '600941000411', name: 'Water 1.5L', name_sw: 'Maji', unit: 'btl', cost: 45, price: 70, taxType: 'std', kraItemCode: '220190000001', categoryId: 3 },
      { sku: 'MAR-012', barcode: '600941000412', name: 'Bread', name_sw: 'Mkate', unit: 'pcs', cost: 55, price: 80, taxType: 'exempt', kraItemCode: '190590000001', categoryId: 1 },
      { sku: 'MAR-013', barcode: '600941000413', name: 'Washing Detergent 1kg', name_sw: 'Sabuni ya unga', unit: 'pcs', cost: 380, price: 500, taxType: 'std', kraItemCode: '340220000001', categoryId: 4 },
      { sku: 'MAR-014', barcode: '600941000414', name: 'Toilet Paper (4-pack)', name_sw: 'Karatasi ya choo', unit: 'pack', cost: 260, price: 350, taxType: 'std', kraItemCode: '481810000001', categoryId: 4 }
    ]
  },

  productFields: [
    { key: 'plu', label: 'PLU code (scale / quick key)', labelSw: 'Namba ya PLU', type: 'text', appliesTo: 'variant' },
    { key: 'bulk', label: 'Bulk / repacked line', labelSw: 'Bidhaa ya kufungashwa', type: 'boolean', appliesTo: 'product' },
    { key: 'shelf_life_days', label: 'Shelf life (days)', labelSw: 'Muda wa dukani (siku)', type: 'number', appliesTo: 'product' },
    { key: 'max_weight_kg', label: 'Max weight per line (kg)', labelSw: 'Uzito wa juu (kg)', type: 'number', appliesTo: 'product' }
  ],

  permissions: [
    { perm: 'mart.repack', label: 'Repack bulk into sell units', labelSw: 'Fungasha bidhaa kwa kuuza', roles: ['owner', 'manager'] }
  ],

  checkout: {
    // Scale lines are where a mini-mart loses money: 50 instead of 0.5 kg, or a
    // 200 kg "bag of rice". Both are typos, and both are caught at the till.
    validateLine({ item, product, variant, helpers }) {
      if (!product.open_priced) return;
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw helpers.block(400, `${product.name}: enter a weight/quantity greater than zero`);
      }
      const maxKg = Number(kit.metaOf(product, variant).max_weight_kg || 0);
      const cap = maxKg > 0 ? maxKg : 100;
      if (qty > cap) {
        throw helpers.block(400, `${product.name}: ${qty} is above the ${cap} limit — check the scale reading`);
      }
    }
  },

  commands: [
    {
      id: 'repack',
      title: 'Repack bulk into sell units',
      titleSw: 'Fungasha bidhaa',
      perm: 'mart.repack',
      params: [
        { name: 'bulk_product_id', label: 'Bulk product', type: 'number', required: true },
        { name: 'sell_product_id', label: 'Sell unit product', type: 'number', required: true },
        { name: 'units', label: 'Units produced', type: 'number', required: true },
        { name: 'unit_size', label: 'Size per unit (in bulk UoM)', type: 'number', required: true }
      ],
      run(d, { params, user, helpers }) {
        const bulkId = Number(params.bulk_product_id);
        const sellId = Number(params.sell_product_id);
        const units = Number(params.units);
        const size = Number(params.unit_size);
        if (!(units > 0) || !(size > 0)) throw helpers.block(400, 'units and unit size must be positive');
        const bulk = d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(bulkId);
        const sell = d.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(sellId);
        if (!bulk || !sell) throw helpers.block(404, 'unknown product');

        const now = new Date().toISOString();
        const bulkVariant = d.prepare("SELECT * FROM variants WHERE product_id = ? AND axes_key = '{}' AND active = 1").get(bulkId);
        const sellVariant = d.prepare("SELECT * FROM variants WHERE product_id = ? AND axes_key = '{}' AND active = 1").get(sellId);
        if (!bulkVariant || !sellVariant) throw helpers.block(400, 'both products need their base variant');
        const loc = d.prepare('SELECT id FROM locations WHERE is_default = 1 AND active = 1 LIMIT 1').get();
        if (!loc) throw helpers.block(400, 'no selling location');
        const needed = units * size;
        const have = d.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock WHERE variant_id = ? AND location_id = ?').get(bulkVariant.id, loc.id).q;
        if (have + 1e-9 < needed) {
          throw helpers.block(400, `not enough bulk stock: ${have} on hand, ${needed} needed`);
        }
        const move = d.prepare(`
          INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref, unit_cost, user_id, note, created_at)
          VALUES (?, ?, 1, ?, ?, 'conversion', 'conversion', ?, ?, ?, ?, ?)
        `);
        move.run(bulkId, bulkVariant.id, loc.id, -needed, `REPACK-${sellId}`, Number(bulk.cost || 0), user ? user.id : null, `repack into ${sell.name}`, now);
        move.run(sellId, sellVariant.id, loc.id, units, `REPACK-${sellId}`, Number(sell.cost || 0), user ? user.id : null, `repacked from ${bulk.name}`, now);
        const bump = d.prepare(`
          INSERT INTO stock (variant_id, location_id, qty) VALUES (?, ?, ?)
          ON CONFLICT(variant_id, location_id) DO UPDATE SET qty = qty + excluded.qty
        `);
        bump.run(bulkVariant.id, loc.id, -needed);
        bump.run(sellVariant.id, loc.id, units);
        return { summary: { units, used: needed }, units, used: needed };
      }
    }
  ],

  reports: [
    {
      id: 'plu_sheet',
      title: 'PLU sheet (scale & quick keys)',
      titleSw: 'Orodha ya PLU',
      perm: 'reports.view',
      columns: ['plu', 'product_name', 'variant_name', 'unit', 'price', 'stock'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT p.id AS product_id, p.name AS product_name, p.unit, p.open_priced,
                 v.id AS variant_id, v.name AS variant_name, v.price, v.meta AS variant_meta, p.price AS product_price
            FROM products p JOIN variants v ON v.product_id = p.id AND v.active = 1
           WHERE p.active = 1
        `).all().map((r) => {
          const meta = kit.parse(r.variant_meta);
          return { ...r, plu: meta.plu || '' };
        }).filter((r) => r.plu || r.open_priced);
        const stock = kit.stockByVariant(d, list);
        return {
          rows: rows.map((r) => ({
            plu: r.plu,
            product_name: r.product_name,
            variant_name: r.variant_name || '',
            unit: r.unit,
            price: Number(r.price != null ? r.price : r.product_price) || 0,
            stock: Number((stock.get(r.variant_id) || {}).qty || 0)
          })).sort((a, b) => String(a.plu).localeCompare(String(b.plu)))
        };
      }
    },
    {
      id: 'reorder_now',
      title: 'Reorder now (below reorder level)',
      titleSw: 'Agiza sasa',
      perm: 'reports.view',
      columns: ['product_name', 'supplier_name', 'on_hand', 'reorder_level', 'sold_30d', 'suggest'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const rows = d.prepare(`
          SELECT p.id AS product_id, p.name AS product_name, p.reorder_level, p.supplier_id,
                 s.name AS supplier_name,
                 COALESCE(SUM(st.qty), 0) AS on_hand
            FROM products p
            LEFT JOIN suppliers s ON s.id = p.supplier_id
            LEFT JOIN variants v ON v.product_id = p.id AND v.active = 1
            LEFT JOIN stock st ON st.variant_id = v.id
            LEFT JOIN locations l ON l.id = st.location_id AND l.branch_id IN (${ph})
           WHERE p.active = 1 AND p.reorder_level > 0
           GROUP BY p.id
          HAVING on_hand <= p.reorder_level
           ORDER BY (p.reorder_level - on_hand) DESC
        `).all(...list);
        const sold = d.prepare(`
          SELECT si.product_id, SUM(si.qty) AS qty
            FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial') AND s.created_at >= ?
           GROUP BY si.product_id
        `).all(...list, since);
        const soldMap = new Map(sold.map((r) => [r.product_id, r.qty]));
        return {
          rows: rows.map((r) => {
            const velocity = soldMap.get(r.product_id) || 0;
            const deficit = Math.max(0, Number(r.reorder_level) - Number(r.on_hand));
            return {
              ...r,
              sold_30d: velocity,
              suggest: Math.max(deficit, Math.round(velocity))
            };
          })
        };
      }
    },
    {
      id: 'bulk_movers',
      title: 'Bulk & repacked lines',
      titleSw: 'Bidhaa za kufungashwa',
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
            .filter((r) => kit.parse(r.product_meta).bulk)
            .map((r) => ({ ...r, margin_pct: r.sold ? kit.marginPct(r.gross / r.sold, r.cost) : 0 }))
            .sort((a, b) => b.gross - a.gross)
        };
      }
    }
  ],

  ui: [
    {
      id: 'minimart-panel',
      mount: 'manager',
      script: '/modules/mini_mart.js',
      label: 'minimart_tab',
      labelSw: 'Duka kuu',
      i18n: {
        en: {
          minimart_tab: 'Mini-mart',
          plu_sheet: 'PLU sheet',
          plu_hint: 'Quick keys for the scale and the keyboard — set a PLU on a variant to list it here.',
          reorder: 'Reorder now',
          reorder_hint: 'Products at or below their reorder level, with what 30 days of real sales suggest.',
          none: 'Nothing to show yet.',
          plu: 'PLU',
          on_hand: 'On hand',
          suggest: 'Suggested'
        },
        sw: {
          minimart_tab: 'Duka kuu',
          plu_sheet: 'Orodha ya PLU',
          plu_hint: 'Namba za haraka za mizani — weka PLU kwenye aina ya bidhaa.',
          reorder: 'Agiza sasa',
          reorder_hint: 'Bidhaa zilizo kwenye kiwango cha kuagiza, na pendekezo kutoka mauzo ya siku 30.',
          none: 'Hakuna cha kuonyesha bado.',
          plu: 'PLU',
          on_hand: 'Ipo',
          suggest: 'Pendekezo'
        }
      }
    }
  ]
};

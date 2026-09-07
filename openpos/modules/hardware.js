'use strict';
// ---------------------------------------------------------------------------
// hardware.js — Hardware store industry module (Phase 23).
//
// Hardware sells by measure: metres of cable, kilos of nails, sheets, rolls.
// The till must accept fractions, and a cut-from-roll line has to leave a
// remnant behind — otherwise the roll silently grows or shrinks.
// ---------------------------------------------------------------------------
const kit = require('./_kit');

const UOMS = ['piece', 'metre', 'kg', 'roll', 'sheet', 'box', 'bag'];

module.exports = {
  id: 'hardware',
  name: 'Hardware store',
  nameSw: 'Duka la vifaa',
  version: 1,
  trades: ['hardware'],
  description: 'Cut-from-roll, metres/kg/sheets, remnant tracking and minimum cut lengths.',
  descriptionSw: 'Kukata kwa roll, mita/kilo/mabati, na kufuatilia mabaki.',

  capabilities: ['open_priced'],

  productFields: [
    { key: 'uom', label: 'Unit of measure', labelSw: 'Kipimo', type: 'select', options: UOMS.join(','), appliesTo: 'product' },
    { key: 'roll_length', label: 'Full roll length (m)', labelSw: 'Urefu wa roll (m)', type: 'number', appliesTo: 'variant' },
    { key: 'min_cut', label: 'Minimum cut (m/kg)', labelSw: 'Kipande cha chini', type: 'number', appliesTo: 'variant' },
    { key: 'cut_from_roll', label: 'Cut from roll', labelSw: 'Hukatwa kutoka roll', type: 'boolean', appliesTo: 'product' }
  ],

  checkout: {
    validateLine({ item, product, variant, helpers }) {
      const meta = kit.metaOf(product, variant);
      if (!meta.cut_from_roll) return;
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw helpers.block(400, `${product.name}: enter the length/weight being cut`);
      }
      const minCut = Number(meta.min_cut || 0);
      if (minCut > 0 && qty < minCut) {
        throw helpers.block(400, `${product.name}: the minimum cut is ${minCut} — selling ${qty} leaves an unusable offcut`);
      }
      const rollLength = Number(meta.roll_length || 0);
      if (rollLength > 0 && qty > rollLength) {
        throw helpers.block(400, `${product.name}: ${qty} is longer than a full roll (${rollLength})`);
      }
    }
  },

  stock: {
    // Fractional quantities are legal here — but a cut can never take more than
    // is physically on the shelf, and never below zero (R-S8 stands).
    rule({ type, qty, product, helpers }) {
      if (qty >= 0) return;
      if (!kit.parse(product && product.meta).cut_from_roll) return;
      if (!['sale', 'transfer_out', 'adjustment'].includes(type)) return;
      if (!Number.isFinite(qty)) {
        throw helpers.block(400, 'a cut must be a number (metres or kilos)');
      }
    }
  },

  reports: [
    {
      id: 'remnants',
      title: 'Roll & sheet remnants',
      titleSw: 'Mabaki ya roll na mabati',
      perm: 'reports.view',
      columns: ['product_name', 'variant_name', 'uom', 'on_hand', 'full_length', 'remnant_pct'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT p.name AS product_name, p.meta AS product_meta, v.id AS variant_id, v.name AS variant_name,
                 v.meta AS variant_meta, COALESCE(SUM(st.qty), 0) AS on_hand
            FROM stock st
            JOIN variants v ON v.id = st.variant_id
            JOIN products p ON p.id = v.product_id
            JOIN locations l ON l.id = st.location_id
           WHERE l.branch_id IN (${ph}) AND p.active = 1 AND st.qty > 0
           GROUP BY v.id
        `).all(...list);
        return {
          rows: rows
            .map((r) => {
              const meta = { ...kit.parse(r.product_meta), ...kit.parse(r.variant_meta) };
              const full = Number(meta.roll_length || 0);
              return {
                product_name: r.product_name,
                variant_name: r.variant_name || '',
                uom: meta.uom || '',
                on_hand: Math.round(r.on_hand * 1000) / 1000,
                full_length: full || null,
                remnant_pct: full ? Math.round((r.on_hand * 100) / full) : null
              };
            })
            .filter((r) => r.uom === 'roll' || r.uom === 'sheet' || r.full_length)
            .filter((r) => r.remnant_pct === null || r.remnant_pct < 100)
            .sort((a, b) => (a.remnant_pct || 0) - (b.remnant_pct || 0))
        };
      }
    },
    {
      id: 'measure_sales',
      title: 'Sold by measure (m / kg / sheets)',
      titleSw: 'Mauzo ya kipimo',
      perm: 'reports.view',
      columns: ['product_name', 'uom', 'qty', 'gross', 'avg_cut'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT p.name AS product_name, p.meta AS product_meta, SUM(si.qty) AS qty,
                 SUM(si.gross) AS gross, COUNT(*) AS lines
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN products p ON p.id = si.product_id
           WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
             AND s.created_at >= ? AND s.created_at <= ?
           GROUP BY p.id
        `).all(...list, from, to);
        return {
          rows: rows
            .map((r) => ({ ...r, uom: kit.parse(r.product_meta).uom || '', avg_cut: r.lines ? Math.round((r.qty / r.lines) * 1000) / 1000 : 0 }))
            .filter((r) => ['metre', 'kg', 'roll', 'sheet'].includes(r.uom))
            .sort((a, b) => b.gross - a.gross)
        };
      }
    }
  ],

  ui: [
    {
      id: 'hardware-panel',
      mount: 'manager',
      script: '/modules/hardware.js',
      label: 'hardware_tab',
      labelSw: 'Vifaa',
      i18n: {
        en: {
          hardware_tab: 'Hardware',
          remnants: 'Roll & sheet remnants',
          remnants_hint: 'Part-used rolls and sheets — the stock that hides in the yard.',
          measure: 'Sold by measure',
          none: 'Nothing to show yet.',
          on_hand: 'On hand',
          full: 'Full roll'
        },
        sw: {
          hardware_tab: 'Vifaa',
          remnants: 'Mabaki ya roll',
          remnants_hint: 'Roll zilizotumika kwa sehemu — bidhaa inayojificha uani.',
          measure: 'Mauzo ya kipimo',
          none: 'Hakuna cha kuonyesha bado.',
          on_hand: 'Ipo',
          full: 'Roll kamili'
        }
      }
    }
  ]
};

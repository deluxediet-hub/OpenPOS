'use strict';
// ---------------------------------------------------------------------------
// spirits.js — Wines & Spirits industry module (Phase 18 demo, Phase 19 ready).
//
// Everything a wine shop needs that the core must NOT know about:
//   • premium lines a cashier may not ring up (checkout.validateLine)
//   • bottle / case economics fields (productFields → variant meta, R-M2)
//   • a module-owned premium log written at commit (checkout.beforeCommit)
//   • reports the core renders through one generic door
//   • a manager panel the shell mounts by name
//
// Adding this industry cost one file. Nothing in server.js mentions spirits.
// ---------------------------------------------------------------------------

module.exports = {
  id: 'spirits',
  name: 'Wines & Spirits',
  nameSw: 'Waini na maziwa',
  version: 1,
  trades: ['spirits'],
  description: 'Bottle & case economics, premium-line control and a premium sales report.',
  descriptionSw: 'Uchumi wa chupa na keesi, udhibiti wa bidhaa za thamani na ripoti ya mauzo ya thamani.',

  // R-C4: enabling this module turns the packs capability on (bottle → case).
  capabilities: ['packs'],

  // Module-owned table. Created on activation, additive, never touched by core.
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

  // Extra product/variant fields — stored as variant/product meta (R-M2).
  // The core renders them in the product form; it never reads them.
  productFields: [
    { key: 'abv', label: 'ABV %', labelSw: 'Kiasi cha pombe (ABV %)', type: 'number', appliesTo: 'variant' },
    { key: 'bottle_ml', label: 'Bottle size (ml)', labelSw: 'Ukubwa wa chupa (ml)', type: 'number', appliesTo: 'variant' },
    { key: 'case_size', label: 'Units per case', labelSw: 'Idadi kwa keesi', type: 'number', appliesTo: 'variant' },
    { key: 'premium', label: 'Premium line (manager only)', labelSw: 'Bidhaa ya thamani (meneja tu)', type: 'boolean', appliesTo: 'product' }
  ],

  // A permission this module adds to the system (hook 5). Owner & manager get
  // it by default; an owner can grant it to a trusted cashier.
  permissions: [
    {
      perm: 'spirits.premium',
      label: 'Ring up premium lines',
      labelSw: 'Uza bidhaa za thamani',
      roles: ['owner', 'manager']
    }
  ],

  checkout: {
    // Runs for every cart line, in every sale path (sale, held-sale pay,
    // exchange replacement). Throwing blocks the line with its own message.
    validateLine({ item, product, variant, user, helpers }) {
      const premium = helpers.flag(product, variant, 'premium');
      if (premium && !helpers.hasPerm(user, 'spirits.premium')) {
        throw helpers.block(403, `${product.name} is a premium line — a manager must ring it up`);
      }
      // A premium line may still be sold, but never anonymously: the approval
      // is the fact that a holder of spirits.premium is signed in.
      if (premium && !user) {
        throw helpers.block(401, `${product.name}: sign in to sell a premium line`);
      }
    },

    // Last look before the sale commits: the module keeps its own evidence.
    beforeCommit({ d, sale, lines, user, ctx, helpers }) {
      const ins = d.prepare(`
        INSERT INTO spirits_premium_log
          (business_id, sale_id, branch_id, product_id, variant_id, product_name, qty, gross, user_id, user_name, created_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const L of lines || []) {
        if (!helpers.flag(L.product, L.variant, 'premium')) continue;
        ins.run(
          sale.id, ctx.branchId || null, L.product.id, L.variant.id, L.product.name,
          L.qty, L.gross || 0, user ? user.id : null, user ? user.name : '', helpers.now()
        );
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
          const meta = { ...parseMeta(r.product_meta), ...parseMeta(r.variant_meta) };
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
            margin: unit - Math.round((cost * 1000) / ml) === 0 ? 0 : unit - cost
          });
        }
        return { rows: out.sort((a, b) => b.price_per_litre - a.price_per_litre) };
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

function parseMeta(s) {
  try { return JSON.parse(s || '{}') || {}; } catch { return {}; }
}

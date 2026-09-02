'use strict';
// ---------------------------------------------------------------------------
// capabilities.js — the business capability set (R-C, ARCHITECTURE.md §3.0).
// Capabilities are DATA (flags on the business), not deployments. Enabling one
// may run a small seed (e.g. create a warehouse location) — never a migration.
// ---------------------------------------------------------------------------

const CAPABILITIES = [
  { id: 'staff_roles',     label: 'Staff & roles',          sw: 'Wafanyakazi na wadhifa',
    desc: 'Add cashiers/managers with PINs and permissions.',
    swDesc: 'Ongeza wafanyakazi kwa PIN na ruhusa.' },
  { id: 'multi_location',  label: 'Multiple locations',     sw: 'Maeneo marenda',
    desc: 'Run more than one physical site under this branch.',
    swDesc: 'Uza zaidi ya sehemu moja chini ya shamba hili.' },
  { id: 'multi_branch',    label: 'Multiple branches',      sw: 'Shamba marenda',
    desc: 'Independently priced, staffed and reported branches.',
    swDesc: 'Shamba ambayo hujiendesha na kupitishwa tofauti.' },
  { id: 'warehouse',       label: 'Warehouse / store room', sw: 'Ghala / sehemu ya bidhaa',
    desc: 'A non-selling storage location for your stock.',
    swDesc: 'Sehemu ya kuhifadhi bidhaa isiyouzwa moja kwa moja.' },
  { id: 'departments',     label: 'Departments',            sw: 'Witengo',
    desc: 'Slice your business into departments for reporting.',
    swDesc: 'Gawanya biashara yako kwa vitengo vya ripoti.' },
  { id: 'purchasing',      label: 'Purchasing & suppliers', sw: 'Ununuzi na washirika',
    desc: 'Suppliers, purchase orders and goods receiving.',
    swDesc: 'Washirika, odha za ununuzi na kukipokea bidhaa.' },
  { id: 'deni',            label: 'Customer credit (deni)', sw: 'Akiba ya wateja (deni)',
    desc: 'Sell on account: limits, ledgers, statements.',
    swDesc: 'Uza kwa deni: mipimo, rejista, riporti.' },
  { id: 'price_levels',    label: 'Price levels',           sw: 'Viwango vya bei',
    desc: 'Wholesale / member pricing alongside retail.',
    swDesc: 'Bei ya taji/mwanachama kando ya bei ya kawaida.' },
  { id: 'promotions',      label: 'Promotions',             sw: 'Maudhara',
    desc: 'Discounts, BOGO, bundles and coupons.',
    swDesc: 'Punguzo, BOGO, pakeji na coupons.' },
  { id: 'loyalty',         label: 'Loyalty points',         sw: 'Pointi za kufuata',
    desc: 'Earn and redeem points with customers.',
    swDesc: 'Pata na kutumia pointi na wateja.' },
  { id: 'variants',        label: 'Product variants',       sw: 'Aina tofauti za bidhaa',
    desc: 'Size / colour / shade as separate stock-keeping lines.',
    swDesc: 'Ukubwa/rangi/kivuli kama mistari tofauti.' },
  { id: 'packs',           label: 'Packs & cases',          sw: 'Pakeji na keesi',
    desc: 'Sell the same stock as bottles, 6-packs or cases.',
    swDesc: 'Uza bidhaa hiyo kama boti, 6-packs au keesi.' },
  { id: 'batches',         label: 'Batches & expiry (FEFO)',sw: 'Batchi na tarehe ya mwisho',
    desc: 'Track lots and expiry dates; oldest expiry sells first.',
    swDesc: 'Fuatilia batchi na tarehe; iliyopita kwanza huuza kwanza.' },
  { id: 'serials',         label: 'Serial / IMEI tracking', sw: 'Ufuatiliaji wa IMEI',
    desc: 'One serial number per unit, bound to its customer.',
    swDesc: 'Namba moja ya serial kwa kila kiti, inayoshikiliwa na mteja.' },
  { id: 'open_priced',     label: 'Weigh & measure items',  sw: 'Bidhaa za kupima',
    desc: 'Sell by weight / length / volume at the till.',
    swDesc: 'Uza kwa uzito/urefu/kiasi kwenye taa.' },
  { id: 'expenses',        label: 'Expenses & finance',     sw: 'Matumizi na fedha',
    desc: 'Track money out: categories, petty cash, P&L-lite.',
    swDesc: 'Fuatilia pesa zinazotoka: kundi, fedha ndogo, P&L.' },
  { id: 'stocktake_pro',   label: 'Advanced stock counts',  sw: 'Kuhesabu bidhaa kwa kina',
    desc: 'Blind counts, shrinkage analysis, recounts.',
    swDesc: 'Kuhesabu gizani, uchambuzi wa upotevu, kuhesabu tena.' },
  { id: 'comms',           label: 'WhatsApp & SMS',         sw: 'WhatsApp na SMS',
    desc: 'Digital receipts, statements and notifications.',
    swDesc: 'Risiti za kidijitali, riporti na arifa.' }
];

// Core capabilities are always on and never stored (ARCHITECTURE.md §3.0):
// products & selling, stock levels, sales history & receipts, owner account,
// settings, simple stock adjust.

// Trade templates seed these at onboarding (R-C4). Owner may toggle any later.
const TRADE_SEEDS = {
  duka:        ['deni'],
  chemist:     ['batches'],
  spirits:     ['packs'],
  boutique:    ['variants'],
  hardware:    ['open_priced'],
  electronics: ['serials'],
  mini_mart:   ['open_priced', 'promotions'],
  cosmetics:   ['variants'],
  footwear:    ['variants'],
  restaurant:  []
};

const CAP_IDS = CAPABILITIES.map((c) => c.id);

function isCap(id) {
  return CAP_IDS.includes(id);
}

function capById(id) {
  return CAPABILITIES.find((c) => c.id === id) || null;
}

/**
 * Suggestion rules (R-C5): the system proposes, never forces, never silently enables.
 * Returns [{capability, reason}] for the default business.
 */
function getSuggestions(d) {
  const out = [];
  const caps = getCapabilityMap(d);

  // A second till in one location often means a second site.
  if (!caps.multi_location) {
    const rows = d
      .prepare(
        `SELECT r.location_id, COUNT(*) AS n
           FROM registers r JOIN locations l ON l.id = r.location_id
          WHERE l.active = 1
          GROUP BY r.location_id
          HAVING n >= 2`
      )
      .all();
    if (rows.length > 0) {
      out.push({
        capability: 'multi_location',
        reason: 'You have two tills in one location — is this a second shop?',
        reasonSw: 'Una taa mbili sehemu moja — je ni duka la pili?'
      });
    }
  }

  // Several out-of-stock products suggests supplier purchasing.
  if (!caps.purchasing) {
    const n = d
      .prepare(
        `SELECT COUNT(DISTINCT v.product_id) AS n
           FROM stock s
           JOIN variants v ON v.id = s.variant_id
           JOIN products p ON p.id = v.product_id
          WHERE p.active = 1 AND s.qty <= 0`
      )
      .get().n;
    if (n >= 3) {
      out.push({
        capability: 'purchasing',
        reason: `${n} products are out of stock — set up suppliers and purchase orders.`,
        reasonSw: `Bidhaa ${n} zimeisha — weka washirika na odha za ununuzi.`
      });
    }
  }

  // First deni-style situation: a customer ledger with balance (Phase 11 populates).
  if (!caps.deni) {
    const n = d
      .prepare(
        `SELECT COUNT(*) AS n FROM customer_ledger cl JOIN customers c ON c.id = cl.customer_id
          WHERE cl.type = 'credit_sale'`
      )
      .get().n;
    if (n > 0) {
      out.push({
        capability: 'deni',
        reason: 'You have credit sales — want limits, ledgers and automatic statements?',
        reasonSw: 'Una mauzo ya deni — unataka mipimo, rejista na riporti otomatiki?'
      });
    }
  }

  return out.slice(0, 3);
}

function getCapabilityMap(d) {
  const rows = d.prepare('SELECT capability, enabled FROM business_capabilities').all();
  const map = {};
  for (const r of rows) map[r.capability] = !!r.enabled;
  return map;
}

function ensureCapabilityRows(d) {
  const ins = d.prepare(
    'INSERT OR IGNORE INTO business_capabilities (capability, enabled, enabled_at) VALUES (?, 0, NULL)'
  );
  for (const c of CAP_IDS) ins.run(c);
}

function seedForTrade(d, trade) {
  // Setup-only: enable the trade template's capabilities. Upsert so it works
  // whether or not the default rows already exist (ensureCapabilityRows).
  const seeds = TRADE_SEEDS[trade] || [];
  const up = d.prepare(
    `INSERT INTO business_capabilities (capability, enabled, enabled_at) VALUES (?, 1, ?)
     ON CONFLICT(business_id, capability) DO UPDATE SET enabled = 1, enabled_at = excluded.enabled_at`
  );
  const now = new Date().toISOString();
  for (const c of seeds) if (isCap(c)) up.run(c, now);
}

// Seeds that run when a capability is first enabled (R-C3: data, not migration).
function runSeed(d, cap, userId) {
  if (cap === 'warehouse') {
    const branch = d.prepare('SELECT id, name FROM branches WHERE is_default = 1 LIMIT 1').get();
    if (branch) {
      const exists = d
        .prepare('SELECT id FROM locations WHERE branch_id = ? AND is_warehouse = 1')
        .get(branch.id);
      if (!exists) {
        d.prepare(
          `INSERT INTO locations (branch_id, name, is_warehouse, is_default, active, created_at)
           VALUES (?, 'Store Room', 1, 0, 1, ?)`
        ).run(branch.id, new Date().toISOString());
      }
    }
  }
  // (future capability seeds go here)
}

module.exports = {
  CAPABILITIES, CAP_IDS, TRADE_SEEDS, isCap, capById,
  getSuggestions, getCapabilityMap, ensureCapabilityRows, seedForTrade, runSeed
};

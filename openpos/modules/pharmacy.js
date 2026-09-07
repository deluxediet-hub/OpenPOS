'use strict';
// ---------------------------------------------------------------------------
// pharmacy.js — Chemist / Pharmacy industry module (Phase 18 demo, Phase 21 ready).
//
// Proves the two hook points the spirits module does not use:
//   • stock.rule      — an expired batch can never leave the shelf
//   • permissions     — a controlled drug needs a licence-holder, not a PIN pad
//
// The Rx gate that used to sit hardcoded in the core (server.js said
// "requires a prescription (pharmacy workflow)" with no way to satisfy it)
// now lives here, and it is satisfiable: the dispenser records the
// prescription reference, which is kept as evidence.
// ---------------------------------------------------------------------------

const OUTBOUND = new Set(['sale', 'return_out', 'transfer_out', 'damage', 'expiry_writeoff', 'adjustment']);

module.exports = {
  id: 'pharmacy',
  name: 'Chemist / Pharmacy',
  nameSw: 'Duka la dawa',
  version: 1,
  trades: ['chemist'],
  description: 'Prescription capture, controlled-drug register and an expiry block at the till.',
  descriptionSw: 'Kumbukumbu ya preshengeni, rejista ya dawa zilizodhibitiwa na kuzuia dawa zilizoisha.',

  capabilities: ['batches'],

  // Module-owned: the prescription evidence + the controlled-drug register.
  // `prescriptions` exists from the Day-0 schema; this module adopts it and
  // adds the columns it needs. Additive only (see loader.addColIfMissing).
  columns: [
    { table: 'prescriptions', column: 'rx_ref', def: "TEXT NOT NULL DEFAULT ''" },
    { table: 'prescriptions', column: 'product_id', def: 'INTEGER' },
    { table: 'prescriptions', column: 'variant_id', def: 'INTEGER' },
    { table: 'prescriptions', column: 'qty', def: 'REAL' },
    { table: 'prescriptions', column: 'branch_id', def: 'INTEGER' },
    { table: 'prescriptions', column: 'sale_item_id', def: 'INTEGER' }
  ],

  schema: `
    CREATE INDEX IF NOT EXISTS idx_rx_ref ON prescriptions(rx_ref);
    CREATE INDEX IF NOT EXISTS idx_rx_sale ON prescriptions(sale_id);
  `,

  productFields: [
    { key: 'generic_name', label: 'Generic name', labelSw: 'Jina la kikemia', type: 'text', appliesTo: 'product' },
    { key: 'strength', label: 'Strength (e.g. 500mg)', labelSw: 'Nguvu (mf. 500mg)', type: 'text', appliesTo: 'variant' },
    { key: 'ppb_no', label: 'PPB registration no.', labelSw: 'Namba ya usajili wa PPB', type: 'text', appliesTo: 'product' },
    { key: 'cold_chain', label: 'Cold chain', labelSw: 'Mnyororo baridi', type: 'boolean', appliesTo: 'product' }
  ],

  permissions: [
    {
      perm: 'pharmacy.dispense',
      label: 'Dispense prescription & controlled drugs',
      labelSw: 'Toa dawa za preshengeni na zilizodhibitiwa',
      roles: ['owner', 'manager']
    }
  ],

  checkout: {
    validateLine({ d, item, product, variant, user, helpers }) {
      // R-M2: the product carries the flags; this module decides what they mean.
      if (product.requires_rx) {
        if (!helpers.hasPerm(user, 'pharmacy.dispense')) {
          throw helpers.block(403, `${product.name} needs a dispenser — ask the pharmacist on duty`);
        }
        const rx = String(item.rx_ref || '').trim();
        if (!rx) {
          throw helpers.block(400, `${product.name}: prescription reference required (Rx no.)`);
        }
        // One prescription reference dispenses one line once (repeat-dispense fraud guard).
        const used = d.prepare(
          'SELECT id FROM prescriptions WHERE rx_ref = ? AND product_id = ? AND filled_at IS NOT NULL'
        ).get(rx, product.id);
        if (used) {
          throw helpers.block(409, `prescription ${rx} for ${product.name} has already been dispensed`);
        }
        // Returned data is stored opaquely on the sale line and handed back at
        // commit — the evidence outlives the request.
        return {
          rx_ref: rx,
          prescriber: String(item.prescriber || '').trim(),
          rx_note: String(item.rx_note || '').trim()
        };
      }
      if (product.is_controlled && !helpers.hasPerm(user, 'pharmacy.dispense')) {
        throw helpers.block(403, `${product.name} is a controlled drug — a licensed dispenser must ring it up`);
      }
    },

    beforeCommit({ d, sale, lines, user, ctx, helpers }) {
      const insRx = d.prepare(`
        INSERT INTO prescriptions
          (customer_id, prescriber, note, created_by, created_at, filled_at, sale_id,
           rx_ref, product_id, variant_id, qty, branch_id, sale_item_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insCtl = d.prepare(`
        INSERT INTO controlled_register (product_id, branch_id, batch_id, direction, qty, sale_id, user_id, note, created_at)
        VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?)
      `);
      const now = helpers.now();
      for (const L of lines || []) {
        // What validateLine returned for this line, kept opaquely by the core.
        const src = (L.moduleData && L.moduleData.pharmacy) || {};
        const rx = String(src.rx_ref || '').trim();
        if (L.product.requires_rx && rx) {
          const r = insRx.run(
            sale.customer_id || null,
            String((src && src.prescriber) || '').trim(),
            String((src && src.rx_note) || '').trim(),
            user ? user.id : null, now, now, sale.id,
            rx, L.product.id, L.variant ? L.variant.id : null, L.qty, ctx.branchId || null,
            L.saleItemId || null
          );
          L.rxPrescriptionId = Number(r.lastInsertRowid);
        }
        if (L.product.is_controlled) {
          insCtl.run(
            L.product.id, ctx.branchId || null, L.batchId || null, L.qty, sale.id,
            user ? user.id : null, `dispensed${rx ? ` on Rx ${rx}` : ''}`, now
          );
        }
      }
    }
  },

  stock: {
    // Called for every move (the core's only door for quantities). Blocks an
    // expired batch from leaving the shelf — writing it off is the only way out,
    // and that path is exempt here so the write-off itself is not blocked.
    rule({ type, batch, lots, qty, helpers }) {
      if (qty >= 0) return;                       // inbound moves are fine
      if (!OUTBOUND.has(type)) return;
      if (type === 'expiry_writeoff' || type === 'damage') return;   // the lawful way to remove it
      const today = new Date().toISOString().slice(0, 10);
      const guard = (b) => {
        if (!b || !b.expiry_date) return;
        if (String(b.expiry_date) > today) return;
        throw helpers.block(
          409,
          `batch ${b.batch_no || b.id} expired on ${b.expiry_date} — write it off, do not sell it`
        );
      };
      // A sale issues by FEFO: check every lot the move would actually consume.
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
      id: 'expiry_watch',
      title: 'Expiry watch',
      titleSw: 'Uangalizi wa tarehe ya mwisho',
      perm: 'reports.view',
      columns: ['product_name', 'batch_no', 'expiry_date', 'days_left', 'qty', 'value'],
      run(d, { branches, branchId, days }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const within = Math.min(Math.max(Number(days) || 90, 1), 365);
        return {
          rows: d.prepare(`
            SELECT p.name AS product_name, b.batch_no, b.expiry_date,
                   CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_left,
                   b.qty, b.qty * COALESCE(b.cost, p.cost, 0) AS value
              FROM batches b
              JOIN products p ON p.id = b.product_id
             WHERE b.branch_id IN (${ph}) AND b.qty > 0 AND b.expiry_date IS NOT NULL
               AND date(b.expiry_date) <= date('now', '+' || ? || ' days')
             ORDER BY b.expiry_date ASC
             LIMIT 500
          `).all(...list, within).map((r) => ({ ...r, expired: r.days_left < 0 }))
        };
      }
    },
    {
      id: 'controlled_register',
      title: 'Controlled drug register',
      titleSw: 'Rejista ya dawa zilizodhibitiwa',
      perm: 'pharmacy.dispense',
      columns: ['created_at', 'product_name', 'direction', 'qty', 'user_name', 'note'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        return {
          rows: d.prepare(`
            SELECT c.created_at, p.name AS product_name, c.direction, c.qty,
                   u.name AS user_name, c.note
              FROM controlled_register c
              JOIN products p ON p.id = c.product_id
              LEFT JOIN users u ON u.id = c.user_id
             WHERE c.branch_id IN (${ph}) AND c.created_at >= ? AND c.created_at <= ?
             ORDER BY c.id DESC
             LIMIT 500
          `).all(...list, from, to)
        };
      }
    }
  ],

  ui: [
    {
      id: 'pharmacy-panel',
      mount: 'manager',
      script: '/modules/pharmacy.js',
      label: 'pharmacy_tab',
      labelSw: 'Duka la dawa',
      i18n: {
        en: {
          pharmacy_tab: 'Pharmacy',
          expiry_watch: 'Expiry watch',
          expiry_hint: 'Batches expiring in the next 90 days — expired batches cannot be sold.',
          expired: 'EXPIRED',
          days: 'days',
          controlled: 'Controlled drugs dispensed',
          controlled_hint: 'Every controlled line leaves a row in the register with the dispenser’s name.',
          rx_lines: 'Prescription lines',
          none: 'Nothing to show yet.',
          open_report: 'Open report'
        },
        sw: {
          pharmacy_tab: 'Dawa',
          expiry_watch: 'Uangalizi wa tarehe ya mwisho',
          expiry_hint: 'Batchi zinazoisha katika siku 90 — batchi zilizoisha haziuzwi.',
          expired: 'IMEISHA',
          days: 'siku',
          controlled: 'Dawa zilizodhibitiwa zilizotolewa',
          controlled_hint: 'Kila dawa iliyodhibitiwa huacha rekodi na jina la aliyeitoa.',
          rx_lines: 'Mistari ya preshengeni',
          none: 'Hakuna cha kuonyesha bado.',
          open_report: 'Fungua ripoti'
        }
      }
    }
  ]
};

'use strict';
// ---------------------------------------------------------------------------
// pharmacy.js — Chemist / Pharmacy industry module (Phase 21; framework from 18).
//
// A chemist is expiry-and-evidence driven:
//   • FEFO is enforced at the till — an expired batch cannot leave the shelf
//   • expiry alerts at 90 / 60 / 30 days, so stock is moved before it dies
//   • a recall drill answers "who got batch X?" in one command
//   • controlled drugs carry a register row with the dispenser's name
//   • prescriptions are captured, and one Rx is dispensed exactly once
//   • insurance claims (SHA / NHIF) are captured on the sale, not on paper
//   • cold-chain and PPB registration are tracked per product
// ---------------------------------------------------------------------------
const kit = require('./_kit');

const OUTBOUND = new Set(['sale', 'return_out', 'transfer_out', 'damage', 'expiry_writeoff', 'adjustment']);

module.exports = {
  id: 'pharmacy',
  name: 'Chemist / Pharmacy',
  nameSw: 'Duka la dawa',
  version: 2,
  trades: ['chemist'],
  description: 'Prescription capture, controlled register, recall drill, expiry alerts and insurance claims.',
  descriptionSw: 'Kumbukumbu ya dawa, rejista iliyodhibitiwa, zoezi la kurejesha, arifa za mwisho wa matumizi.',

  capabilities: ['batches'],

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

    -- Insurance claims (SHA / NHIF): captured at the till, reconciled later.
    CREATE TABLE IF NOT EXISTS pharmacy_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL DEFAULT 1,
      sale_id INTEGER,
      branch_id INTEGER,
      insurer TEXT NOT NULL DEFAULT '',
      member_no TEXT NOT NULL DEFAULT '',
      claim_no TEXT NOT NULL DEFAULT '',
      patient_name TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','approved','rejected')),
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_claims_status ON pharmacy_claims(status, created_at);

    -- Recall drill results are kept: who was told, what came back.
    CREATE TABLE IF NOT EXISTS pharmacy_recalls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL DEFAULT 1,
      batch_no TEXT NOT NULL DEFAULT '',
      product_id INTEGER,
      reason TEXT NOT NULL DEFAULT '',
      units_outstanding REAL NOT NULL DEFAULT 0,
      customers_affected INTEGER NOT NULL DEFAULT 0,
      sales_affected INTEGER NOT NULL DEFAULT 0,
      run_by INTEGER,
      created_at TEXT NOT NULL
    );
  `,

  productFields: [
    { key: 'generic_name', label: 'Generic name', labelSw: 'Jina la kikemia', type: 'text', appliesTo: 'product' },
    { key: 'strength', label: 'Strength (e.g. 500mg)', labelSw: 'Nguvu (mf. 500mg)', type: 'text', appliesTo: 'variant' },
    { key: 'ppb_no', label: 'PPB registration no.', labelSw: 'Namba ya usajili wa PPB', type: 'text', appliesTo: 'product' },
    { key: 'cold_chain', label: 'Cold chain', labelSw: 'Mnyororo baridi', type: 'boolean', appliesTo: 'product' },
    { key: 'form', label: 'Form (tablet/syrup/vial)', labelSw: 'Aina (kidonge/siro)', type: 'text', appliesTo: 'variant' }
  ],

  permissions: [
    {
      perm: 'pharmacy.dispense',
      label: 'Dispense prescription & controlled drugs',
      labelSw: 'Toa dawa za preshengeni na zilizodhibitiwa',
      roles: ['owner', 'manager']
    },
    {
      perm: 'pharmacy.claims',
      label: 'Capture & submit insurance claims',
      labelSw: 'Rekodi madai ya bima',
      roles: ['owner', 'manager']
    }
  ],

  checkout: {
    validateLine({ d, item, product, variant, user, helpers }) {
      if (product.requires_rx) {
        if (!helpers.hasPerm(user, 'pharmacy.dispense')) {
          throw helpers.block(403, `${product.name} needs a dispenser — ask the pharmacist on duty`);
        }
        const rx = String(item.rx_ref || '').trim();
        if (!rx) {
          throw helpers.block(400, `${product.name}: prescription reference required (Rx no.)`);
        }
        const used = d.prepare(
          'SELECT id FROM prescriptions WHERE rx_ref = ? AND product_id = ? AND filled_at IS NOT NULL'
        ).get(rx, product.id);
        if (used) {
          throw helpers.block(409, `prescription ${rx} for ${product.name} has already been dispensed`);
        }
        return {
          rx_ref: rx,
          prescriber: String(item.prescriber || '').trim(),
          rx_note: String(item.rx_note || '').trim()
        };
      }
      if (product.is_controlled && !helpers.hasPerm(user, 'pharmacy.dispense')) {
        throw helpers.block(403, `${product.name} is a controlled drug — a licensed dispenser must ring it up`);
      }
      // Insurance: the claim belongs to the sale, captured once per line set.
      const insurer = String(item.insurer || '').trim();
      if (insurer) {
        if (!helpers.hasPerm(user, 'pharmacy.claims')) {
          throw helpers.block(403, `insurance claims need the pharmacy.claims permission`);
        }
        if (!String(item.member_no || '').trim()) {
          throw helpers.block(400, `${insurer} claim needs the member number`);
        }
        return {
          insurer,
          member_no: String(item.member_no || '').trim(),
          claim_no: String(item.claim_no || '').trim(),
          patient_name: String(item.patient_name || '').trim()
        };
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
      const insClaim = d.prepare(`
        INSERT INTO pharmacy_claims
          (business_id, sale_id, branch_id, insurer, member_no, claim_no, patient_name, amount, status, created_by, created_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);
      const now = helpers.now();
      let insurerSeen = null;
      for (const L of lines || []) {
        const src = (L.moduleData && L.moduleData.pharmacy) || {};
        const rx = String(src.rx_ref || '').trim();
        if (L.product.requires_rx && rx) {
          const r = insRx.run(
            sale.customer_id || null,
            String(src.prescriber || '').trim(),
            String(src.rx_note || '').trim(),
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
        if (src.insurer && !insurerSeen) {
          insurerSeen = src;
        }
      }
      if (insurerSeen) {
        const covered = (lines || [])
          .filter((L) => (L.moduleData && L.moduleData.pharmacy && L.moduleData.pharmacy.insurer))
          .reduce((s2, L) => s2 + (L.gross || 0), 0);
        insClaim.run(
          sale.id, ctx.branchId || null, insurerSeen.insurer, insurerSeen.member_no,
          insurerSeen.claim_no, insurerSeen.patient_name, covered, user ? user.id : null, now
        );
      }
    }
  },

  stock: {
    // FEFO is core; refusing to sell an expired batch is this industry's rule.
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
      if (batch) return guard(batch);
      let remaining = Math.abs(qty);
      for (const lot of lots || []) {
        if (remaining <= 1e-9) break;
        guard(lot);
        remaining -= lot.qty;
      }
    }
  },

  commands: [
    {
      id: 'recall_drill',
      title: 'Recall drill — who received this batch?',
      titleSw: 'Zoezi la kurejesha — nani alipata batchi hii?',
      perm: 'pharmacy.dispense',
      params: [
        { name: 'batch_no', label: 'Batch no.', type: 'text', required: true },
        { name: 'reason', label: 'Reason', type: 'text' }
      ],
      run(d, { params, user, branches }) {
        const no = String(params.batch_no || '').trim();
        const batches = d.prepare("SELECT * FROM batches WHERE batch_no = ?").all(no);
        if (!batches.length) throw new Error(`no batch found with number ${no}`);
        const productIds = [...new Set(batches.map((b) => b.product_id))];
        const ph = productIds.map(() => '?').join(',');
        const branchPh = branches.map(() => '?').join(',');
        // Every sale line that drew from the batch, and who bought it.
        const sales = d.prepare(`
          SELECT si.sale_id, si.product_id, si.qty, s.customer_id, s.created_at, s.branch_id,
                 c.name AS customer_name, c.phone AS customer_phone, p.name AS product_name
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN products p ON p.id = si.product_id
            LEFT JOIN customers c ON c.id = s.customer_id
           WHERE si.batch_id IN (SELECT id FROM batches WHERE batch_no = ?)
             AND s.status IN ('paid','partial')
             AND (${branches.length ? `s.branch_id IN (${branchPh})` : '1=1'})
           ORDER BY s.created_at DESC
        `).all(no, ...branches);
        const stock = d.prepare(`
          SELECT b.id, b.qty, b.location_id, p.name AS product_name
            FROM batches b JOIN products p ON p.id = b.product_id
           WHERE b.batch_no = ? AND b.qty > 0
        `).all(no);
        const customers = [...new Map(sales.filter((s2) => s2.customer_id)
          .map((s2) => [s2.customer_id, { id: s2.customer_id, name: s2.customer_name, phone: s2.customer_phone }]))
          .values()];
        const outstanding = stock.reduce((s2, b) => s2 + Number(b.qty || 0), 0);
        d.prepare(`
          INSERT INTO pharmacy_recalls (business_id, batch_no, product_id, reason, units_outstanding, customers_affected, sales_affected, run_by, created_at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(no, productIds[0] || null, String(params.reason || '').trim(), outstanding,
          customers.length, sales.length, user ? user.id : null, new Date().toISOString());
        return {
          summary: { batch: no, sales: sales.length, customers: customers.length, outstanding },
          batch: no,
          units_outstanding: outstanding,
          sales_affected: sales.length,
          customers,
          sales: sales.slice(0, 200),
          stock_on_hand: stock
        };
      }
    },
    {
      id: 'writeoff_expired',
      title: 'Write off everything already expired',
      titleSw: 'Futa bidhaa zilizoisha muda',
      perm: 'pharmacy.dispense',
      params: [{ name: 'branch_id', label: 'Branch', type: 'number' }],
      run(d, { params, user, branches }) {
        const list = params.branch_id ? [Number(params.branch_id)] : branches;
        if (!list.length) throw new Error('no branch in scope');
        const ph = list.map(() => '?').join(',');
        const expired = d.prepare(`
          SELECT * FROM batches
           WHERE branch_id IN (${ph}) AND qty > 0 AND expiry_date IS NOT NULL
             AND date(expiry_date) <= date('now')
        `).all(...list);
        // Moves go through the module's own stock rule, which exempts write-offs.
        let written = 0, units = 0;
        for (const b of expired) {
          d.prepare(`
            INSERT INTO stock_moves (product_id, variant_id, branch_id, location_id, qty, type, reason, ref,
                                     batch_id, unit_cost, user_id, note, created_at)
            VALUES (?, ?, ?, ?, ?, 'expiry_writeoff', 'expired', ?, ?, ?, ?, ?, ?)
          `).run(b.product_id, b.variant_id, b.branch_id, b.location_id, -Math.abs(b.qty),
            `RECALL:${b.batch_no || b.id}`, b.id, b.cost || 0, user ? user.id : null, 'module: pharmacy write-off', new Date().toISOString());
          d.prepare('UPDATE batches SET qty = 0 WHERE id = ?').run(b.id);
          d.prepare(`
            UPDATE stock SET qty = qty - ? WHERE variant_id = ? AND location_id = ?
          `).run(Math.abs(b.qty), b.variant_id, b.location_id);
          written++; units += Math.abs(b.qty);
        }
        return { summary: { batches: written, units }, written, units };
      }
    },
    {
      id: 'submit_claims',
      title: 'Mark insurance claims as submitted',
      titleSw: 'Tuma madai ya bima',
      perm: 'pharmacy.claims',
      params: [
        { name: 'insurer', label: 'Insurer (SHA/NHIF/other)', type: 'text', required: true },
        { name: 'claim_nos', label: 'Claim numbers (comma separated)', type: 'text' }
      ],
      run(d, { params }) {
        const insurer = String(params.insurer || '').trim();
        const now = new Date().toISOString();
        const r = d.prepare(`
          UPDATE pharmacy_claims SET status = 'submitted', updated_at = ?
           WHERE insurer = ? AND status = 'pending'
             AND (? = '' OR claim_no IN (SELECT value FROM json_each(?)))
        `).run(now, insurer, String(params.claim_nos || ''), JSON.stringify(String(params.claim_nos || '').split(',').map((s2) => s2.trim()).filter(Boolean)));
        return { summary: { submitted: r.changes }, submitted: r.changes };
      }
    }
  ],

  reports: [
    {
      id: 'expiry_watch',
      title: 'Expiry watch (90 / 60 / 30)',
      titleSw: 'Uangalizi wa tarehe ya mwisho',
      perm: 'reports.view',
      columns: ['product_name', 'batch_no', 'expiry_date', 'days_left', 'bucket', 'qty', 'value'],
      run(d, { branches, branchId, days }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const within = Math.min(Math.max(Number(days) || 90, 1), 365);
        const rows = d.prepare(`
          SELECT p.name AS product_name, b.batch_no, b.expiry_date,
                 CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_left,
                 b.qty, b.qty * COALESCE(b.cost, p.cost, 0) AS value
            FROM batches b
            JOIN products p ON p.id = b.product_id
           WHERE b.branch_id IN (${ph}) AND b.qty > 0 AND b.expiry_date IS NOT NULL
             AND date(b.expiry_date) <= date('now', '+' || ? || ' days')
           ORDER BY b.expiry_date ASC
           LIMIT 500
        `).all(...list, within);
        return {
          rows: rows.map((r) => ({ ...r, bucket: kit.expiryBucket(r.days_left), expired: r.days_left < 0 })),
          alerts: {
            expired: rows.filter((r) => r.days_left < 0).length,
            d30: rows.filter((r) => r.days_left >= 0 && r.days_left <= 30).length,
            d60: rows.filter((r) => r.days_left > 30 && r.days_left <= 60).length,
            d90: rows.filter((r) => r.days_left > 60 && r.days_left <= 90).length
          }
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
    },
    {
      id: 'insurance_claims',
      title: 'Insurance claims (SHA / NHIF)',
      titleSw: 'Madai ya bima',
      perm: 'pharmacy.claims',
      columns: ['created_at', 'insurer', 'member_no', 'claim_no', 'patient_name', 'amount', 'status'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT created_at, insurer, member_no, claim_no, patient_name, amount, status, sale_id
            FROM pharmacy_claims
           WHERE branch_id IN (${ph}) AND created_at >= ? AND created_at <= ?
           ORDER BY id DESC LIMIT 500
        `).all(...list, from, to);
        const total = rows.reduce((s2, r) => s2 + Number(r.amount || 0), 0);
        return { rows, total, outstanding: rows.filter((r) => r.status !== 'approved').reduce((s2, r) => s2 + Number(r.amount || 0), 0) };
      }
    },
    {
      id: 'cold_chain',
      title: 'Cold-chain stock',
      titleSw: 'Bidhaa za mnyororo baridi',
      perm: 'reports.view',
      columns: ['product_name', 'qty', 'value', 'locations'],
      run(d, { branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        const rows = d.prepare(`
          SELECT p.id AS product_id, p.name AS product_name, p.meta AS product_meta,
                 SUM(st.qty) AS qty, SUM(st.qty) * COALESCE(p.cost, 0) AS value,
                 GROUP_CONCAT(DISTINCT l.name) AS locations
            FROM stock st
            JOIN variants v ON v.id = st.variant_id
            JOIN products p ON p.id = v.product_id
            JOIN locations l ON l.id = st.location_id
           WHERE l.branch_id IN (${ph}) AND p.active = 1 AND st.qty > 0
           GROUP BY p.id
        `).all(...list);
        return { rows: rows.filter((r) => kit.parse(r.product_meta).cold_chain) };
      }
    },
    {
      id: 'ppb_register',
      title: 'PPB registration tracking',
      titleSw: 'Ufuatiliaji wa usajili wa PPB',
      perm: 'reports.view',
      columns: ['product_name', 'ppb_no', 'status'],
      run(d) {
        const rows = d.prepare('SELECT id, name, meta FROM products WHERE active = 1').all();
        return {
          rows: rows.map((p) => {
            const meta = kit.parse(p.meta);
            return {
              product_name: p.name,
              ppb_no: meta.ppb_no || '',
              status: meta.ppb_no ? 'registered' : 'MISSING'
            };
          }).filter((r) => r.status === 'MISSING' || r.ppb_no).sort((a, b) => (a.status === b.status ? 0 : (a.status === 'MISSING' ? -1 : 1)))
        };
      }
    },
    {
      id: 'wholesale_sales',
      title: 'Wholesale (tier) pharmacy sales',
      titleSw: 'Mauzo ya jumla',
      perm: 'reports.view',
      columns: ['product_name', 'qty', 'gross', 'retail_equivalent', 'discount_given'],
      run(d, { from, to, branches, branchId }) {
        const list = branchId ? [branchId] : branches;
        if (!list.length) return { rows: [] };
        const ph = list.map(() => '?').join(',');
        return {
          rows: d.prepare(`
            SELECT p.name AS product_name, SUM(si.qty) AS qty, SUM(si.gross) AS gross,
                   SUM(si.qty * p.price) AS retail_equivalent,
                   SUM(si.qty * p.price) - SUM(si.gross) AS discount_given
              FROM sale_items si
              JOIN sales s ON s.id = si.sale_id
              JOIN products p ON p.id = si.product_id
              JOIN customers c ON c.id = s.customer_id
             WHERE s.branch_id IN (${ph}) AND s.status IN ('paid','partial')
               AND s.created_at >= ? AND s.created_at <= ?
               AND c.tier IN ('wholesale','member')
             GROUP BY si.product_id, p.name
             ORDER BY gross DESC
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
  ],
  // A medicine receipt carries the warnings a chemist is required to give.
  receipt: [
    { en: 'Check the expiry date before use.',
      sw: 'Angalia tarehe ya mwisho kabla ya kutumia.' },
    { en: 'Keep all medicines out of reach of children.',
      sw: 'Weka dawa mbali na watoto.' },
    { en: 'Medicines once sold are not returnable.',
      sw: 'Dawa zilizouzwa hazirudishwi.' }
  ]
};

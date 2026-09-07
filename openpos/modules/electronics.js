'use strict';
// ---------------------------------------------------------------------------
// electronics.js — Electronics industry module (Phase 23).
//
// An electronics shop sells identities, not quantities: a phone is an IMEI.
//   • a serial-tracked line cannot be sold without scanning its serials
//   • the sale binds each serial to the customer who bought it (warranty proof)
//   • warranties expire on a date, not "sometime"
//   • repair jobs are their own lifecycle in and out of the shop
// ---------------------------------------------------------------------------
const kit = require('./_kit');

module.exports = {
  id: 'electronics',
  name: 'Electronics',
  nameSw: 'Vifaa vya umeme',
  version: 1,
  trades: ['electronics'],
  description: 'Serial / IMEI binding at the till, warranties, repair jobs and customer ownership.',
  descriptionSw: 'Kufunga IMEI wakati wa mauzo, dhamana, kazi za ukarabati na umiliki wa mteja.',

  capabilities: ['serials'],

  // The core has never heard of this trade, so the module brings its own
  // starter shelf: setup appends it and the trade appears in the picker.
  template: {
    categories: [
      { name: 'Phones & Tablets', name_sw: 'Simu na kompyuta ndogo' },
      { name: 'Accessories', name_sw: 'Vifaa vya ziada' },
      { name: 'TV & Audio', name_sw: 'TV na sauti' },
      { name: 'Power & Solar', name_sw: 'Umeme na sola' },
      { name: 'Repairs', name_sw: 'Ukarabati' }
    ],
    products: [
      { sku: 'ELE-001', barcode: '600941000101', name: 'Smartphone A15 128GB', name_sw: 'Simu A15', unit: 'pcs', cost: 18000, price: 22500, taxType: 'std', kraItemCode: '851712000001', categoryId: 1, trackSerials: 1 },
      { sku: 'ELE-002', barcode: '600941000102', name: 'Smartphone X5 256GB', name_sw: 'Simu X5', unit: 'pcs', cost: 32000, price: 39500, taxType: 'std', kraItemCode: '851712000002', categoryId: 1, trackSerials: 1 },
      { sku: 'ELE-003', barcode: '600941000103', name: 'Feature Phone K2', name_sw: 'Simu ya kawaida', unit: 'pcs', cost: 1800, price: 2500, taxType: 'std', kraItemCode: '851712000003', categoryId: 1, trackSerials: 1 },
      { sku: 'ELE-004', barcode: '600941000104', name: 'Tablet 10"', name_sw: 'Kompyuta ndogo', unit: 'pcs', cost: 15500, price: 19000, taxType: 'std', kraItemCode: '847130000001', categoryId: 1, trackSerials: 1 },
      { sku: 'ELE-005', barcode: '600941000105', name: 'Charger 20W', name_sw: 'Chaja', unit: 'pcs', cost: 450, price: 800, taxType: 'std', kraItemCode: '850440000001', categoryId: 2 },
      { sku: 'ELE-006', barcode: '600941000106', name: 'USB-C Cable 1m', name_sw: 'Kebo ya USB', unit: 'pcs', cost: 250, price: 500, taxType: 'std', kraItemCode: '854442000001', categoryId: 2 },
      { sku: 'ELE-007', barcode: '600941000107', name: 'Earbuds', name_sw: 'Vifaa vya masikioni', unit: 'pcs', cost: 1200, price: 2000, taxType: 'std', kraItemCode: '851830000001', categoryId: 2 },
      { sku: 'ELE-008', barcode: '600941000108', name: 'Phone Case', name_sw: 'Kesi ya simu', unit: 'pcs', cost: 200, price: 500, taxType: 'std', kraItemCode: '392690000001', categoryId: 2 },
      { sku: 'ELE-009', barcode: '600941000109', name: 'Smart TV 32"', name_sw: 'TV inchi 32', unit: 'pcs', cost: 18500, price: 23000, taxType: 'std', kraItemCode: '852872000001', categoryId: 3, trackSerials: 1 },
      { sku: 'ELE-010', barcode: '600941000110', name: 'Bluetooth Speaker', name_sw: 'Spika', unit: 'pcs', cost: 2200, price: 3200, taxType: 'std', kraItemCode: '851822000001', categoryId: 3 },
      { sku: 'ELE-011', barcode: '600941000111', name: 'Power Bank 20000mAh', name_sw: 'Betri kubebeka', unit: 'pcs', cost: 2600, price: 3600, taxType: 'std', kraItemCode: '850760000001', categoryId: 4 },
      { sku: 'ELE-012', barcode: '600941000112', name: 'Solar Panel 100W', name_sw: 'Paneli ya sola', unit: 'pcs', cost: 6500, price: 8500, taxType: 'std', kraItemCode: '854140000001', categoryId: 4 },
      { sku: 'ELE-013', barcode: '600941000113', name: 'Screen Replacement', name_sw: 'Kubadilisha skrini', unit: 'job', cost: 6000, price: 9000, taxType: 'std', kraItemCode: '000000000000', categoryId: 5 },
      { sku: 'ELE-014', barcode: '600941000114', name: 'Repair Labour (hour)', name_sw: 'Kazi ya ukarabati', unit: 'hr', cost: 800, price: 1500, taxType: 'std', kraItemCode: '000000000000', categoryId: 5 }
    ]
  },

  schema: `
    CREATE TABLE IF NOT EXISTS electronics_repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL DEFAULT 1,
      ref TEXT NOT NULL,
      serial_id INTEGER,
      serial_no TEXT NOT NULL DEFAULT '',
      product_id INTEGER,
      customer_id INTEGER,
      fault TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','in_progress','waiting_parts','done','collected','cancelled')),
      quoted INTEGER NOT NULL DEFAULT 0,
      charged INTEGER NOT NULL DEFAULT 0,
      booked_by INTEGER,
      booked_at TEXT NOT NULL,
      completed_at TEXT,
      collected_at TEXT,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_repairs_status ON electronics_repairs(status, booked_at);
  `,

  productFields: [
    { key: 'brand', label: 'Brand', labelSw: 'Chapa', type: 'text', appliesTo: 'product' },
    { key: 'model', label: 'Model', labelSw: 'Modeli', type: 'text', appliesTo: 'variant' },
    { key: 'warranty_months', label: 'Warranty (months)', labelSw: 'Dhamana (miezi)', type: 'number', appliesTo: 'product' },
    { key: 'spec', label: 'Key spec (RAM/Storage)', labelSw: 'Sifa kuu', type: 'text', appliesTo: 'variant' }
  ],

  permissions: [
    { perm: 'electronics.repairs', label: 'Book & close repair jobs', labelSw: 'Fungua na funga kazi za ukarabati', roles: ['owner', 'manager', 'cashier'] }
  ],

  checkout: {
    // The till cannot take a phone without its IMEI: the serial is the proof of
    // ownership, the warranty and the police report, all in one string.
    validateLine({ d, item, product, variant, helpers }) {
      if (!product.track_serials) return;
      const qty = Number(item.qty);
      if (!Number.isInteger(qty)) throw helpers.block(400, `${product.name} is serial-tracked — whole units only`);
      const list = Array.isArray(item.serials) ? item.serials.map((s) => String(s).trim()).filter(Boolean) : [];
      if (list.length !== qty) {
        throw helpers.block(400, `${product.name}: scan ${qty} serial number(s) — got ${list.length}`);
      }
      for (const s of list) {
        const row = d.prepare('SELECT * FROM serials WHERE variant_id = ? AND serial_no = ?').get(variant.id, s);
        if (!row) throw helpers.block(404, `${product.name}: serial ${s} is not registered in stock`);
        if (row.status !== 'in_stock') throw helpers.block(409, `${product.name}: serial ${s} is ${row.status}`);
      }
      return { serials: list };
    },

    beforeCommit({ d, sale, lines, user, helpers }) {
      const now = helpers.now();
      const upd = d.prepare(`
        UPDATE serials SET status = 'sold', sale_id = ?, customer_id = ?, note = ?, location_id = NULL
         WHERE variant_id = ? AND serial_no = ?
      `);
      for (const L of lines || []) {
        const src = (L.moduleData && L.moduleData.electronics) || {};
        if (!src.serials || !L.variant) continue;
        for (const s of src.serials) {
          upd.run(sale.id, sale.customer_id || null, `sold on ${sale.invoice_no || sale.id}`, L.variant.id, s);
        }
      }
      return null;
    }
  },

  commands: [
    {
      id: 'book_repair',
      title: 'Book a repair job',
      titleSw: 'Fungua kazi ya ukarabati',
      perm: 'electronics.repairs',
      params: [
        { name: 'serial_no', label: 'Serial / IMEI', type: 'text', required: true },
        { name: 'fault', label: 'Reported fault', type: 'text', required: true },
        { name: 'quoted', label: 'Quoted amount', type: 'number' },
        { name: 'customer_id', label: 'Customer', type: 'number' }
      ],
      run(d, { params, user, helpers }) {
        const no = String(params.serial_no || '').trim();
        const row = d.prepare('SELECT * FROM serials WHERE serial_no = ?').get(no);
        if (!row) throw helpers.block(404, `serial ${no} is not known to this shop`);
        const ref = `REP-${String(Date.now()).slice(-6)}`;
        const r = d.prepare(`
          INSERT INTO electronics_repairs
            (business_id, ref, serial_id, serial_no, product_id, customer_id, fault, status, quoted, booked_by, booked_at, note)
          VALUES (1, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, '')
        `).run(ref, row.id, no, row.variant_id, params.customer_id ? Number(params.customer_id) : null,
          String(params.fault || '').trim(), Math.round(Number(params.quoted) || 0),
          user ? user.id : null, helpers.now());
        return { summary: { ref }, id: r.lastInsertRowid, ref };
      }
    },
    {
      id: 'complete_repair',
      title: 'Complete & hand over a repair',
      titleSw: 'Kamilisha ukarabati',
      perm: 'electronics.repairs',
      params: [
        { name: 'ref', label: 'Job reference', type: 'text', required: true },
        { name: 'charged', label: 'Amount charged', type: 'number' }
      ],
      run(d, { params, helpers }) {
        const job = d.prepare('SELECT * FROM electronics_repairs WHERE ref = ?').get(String(params.ref || '').trim());
        if (!job) throw helpers.block(404, 'repair job not found');
        if (job.status === 'collected') throw helpers.block(409, 'this job was already handed over');
        const now = helpers.now();
        d.prepare(`
          UPDATE electronics_repairs SET status = 'collected', charged = ?, completed_at = ?, collected_at = ? WHERE id = ?
        `).run(Math.round(Number(params.charged) || 0), now, now, job.id);
        return { summary: { ref: job.ref, charged: Math.round(Number(params.charged) || 0) }, ref: job.ref };
      }
    },
    {
      id: 'warranty_check',
      title: 'Check a warranty',
      titleSw: 'Hakiki dhamana',
      perm: 'reports.view',
      params: [{ name: 'serial_no', label: 'Serial / IMEI', type: 'text', required: true }],
      run(d, { params }) {
        const no = String(params.serial_no || '').trim();
        const row = d.prepare('SELECT * FROM serials WHERE serial_no = ?').get(no);
        if (!row) throw new Error(`serial ${no} is not known to this shop`);
        const sale = row.sale_id ? d.prepare('SELECT * FROM sales WHERE id = ?').get(row.sale_id) : null;
        const product = d.prepare('SELECT * FROM products WHERE id = (SELECT product_id FROM variants WHERE id = ?)').get(row.variant_id);
        const months = Number(kit.parse(product && product.meta).warranty_months || 0);
        let expiry = null, inWarranty = false;
        if (sale && months > 0) {
          const sold = new Date(sale.created_at);
          expiry = new Date(sold.getTime() + months * 30.44 * 86400000).toISOString().slice(0, 10);
          inWarranty = new Date(expiry) >= new Date();
        }
        return {
          summary: { serial: no, inWarranty },
          serial_no: no,
          product: product ? product.name : '',
          sold_at: sale ? sale.created_at : null,
          customer: row.customer_id || null,
          warranty_months: months,
          warranty_expires: expiry,
          in_warranty: inWarranty
        };
      }
    }
  ],

  reports: [
    {
      id: 'warranty_expiring',
      title: 'Warranties expiring in 30 days',
      titleSw: 'Dhamana zinazoisha',
      perm: 'reports.view',
      columns: ['serial_no', 'product_name', 'customer_name', 'sold_at', 'warranty_expires'],
      run(d, { branches, branchId }) {
        const rows = d.prepare(`
          SELECT s2.serial_no, s2.sale_id, s2.customer_id, s2.variant_id,
                 p.name AS product_name, p.meta AS product_meta,
                 sa.created_at AS sold_at, c.name AS customer_name, c.phone AS customer_phone
            FROM serials s2
            JOIN variants v ON v.id = s2.variant_id
            JOIN products p ON p.id = v.product_id
            LEFT JOIN sales sa ON sa.id = s2.sale_id
            LEFT JOIN customers c ON c.id = s2.customer_id
           WHERE s2.status = 'sold' AND s2.sale_id IS NOT NULL
        `).all();
        const soon = new Date(Date.now() + 30 * 86400000);
        return {
          rows: rows.map((r) => {
            const months = Number(kit.parse(r.product_meta).warranty_months || 0);
            const exp = new Date(new Date(r.sold_at).getTime() + months * 30.44 * 86400000);
            return {
              serial_no: r.serial_no,
              product_name: r.product_name,
              customer_name: r.customer_name || '',
              sold_at: r.sold_at,
              warranty_expires: months ? exp.toISOString().slice(0, 10) : null
            };
          }).filter((r) => r.warranty_expires && new Date(r.warranty_expires) <= soon)
            .sort((a, b) => String(a.warranty_expires).localeCompare(String(b.warranty_expires)))
        };
      }
    },
    {
      id: 'repair_jobs',
      title: 'Repair jobs',
      titleSw: 'Kazi za ukarabati',
      perm: 'electronics.repairs',
      columns: ['ref', 'serial_no', 'product_name', 'fault', 'status', 'quoted', 'charged', 'booked_at'],
      run(d, { branches, branchId }) {
        return {
          rows: d.prepare(`
            SELECT r.ref, r.serial_no, r.fault, r.status, r.quoted, r.charged, r.booked_at,
                   p.name AS product_name
              FROM electronics_repairs r
              LEFT JOIN products p ON p.id = r.product_id
             ORDER BY r.id DESC LIMIT 200
          `).all()
        };
      }
    },
    {
      id: 'serial_trace',
      title: 'Serial ownership trace',
      titleSw: 'Ufuatiliaji wa umiliki',
      perm: 'reports.view',
      columns: ['serial_no', 'product_name', 'status', 'customer_name', 'sale_id', 'sold_at'],
      run(d) {
        return {
          rows: d.prepare(`
            SELECT s2.serial_no, s2.status, s2.sale_id, sa.created_at AS sold_at,
                   p.name AS product_name, c.name AS customer_name, c.phone AS customer_phone
              FROM serials s2
              JOIN variants v ON v.id = s2.variant_id
              JOIN products p ON p.id = v.product_id
              LEFT JOIN sales sa ON sa.id = s2.sale_id
              LEFT JOIN customers c ON c.id = s2.customer_id
             ORDER BY s2.id DESC LIMIT 300
          `).all()
        };
      }
    }
  ],

  ui: [
    {
      id: 'electronics-panel',
      mount: 'manager',
      script: '/modules/electronics.js',
      label: 'electronics_tab',
      labelSw: 'Umeme',
      i18n: {
        en: {
          electronics_tab: 'Electronics',
          repairs: 'Repair jobs',
          repairs_hint: 'Booked, in progress and collected — every job tied to a serial.',
          warranty: 'Warranties expiring in 30 days',
          none: 'Nothing to show yet.',
          status: 'Status',
          serial: 'Serial / IMEI'
        },
        sw: {
          electronics_tab: 'Umeme',
          repairs: 'Kazi za ukarabati',
          repairs_hint: 'Zilizofunguliwa, zinaendelea na zilizochukuliwa — kila kazi na serial yake.',
          warranty: 'Dhamana zinazoisha siku 30',
          none: 'Hakuna cha kuonyesha bado.',
          status: 'Hali',
          serial: 'Serial / IMEI'
        }
      }
    }
  ],
  receipt: [
    { en: 'Warranty is 12 months from this date — keep this receipt.',
      sw: 'Dhamana ni miezi 12 kuanzia leo — hifadhi risiti hii.' },
    { en: 'Serial / IMEI numbers above identify your unit.',
      sw: 'Namba za seriali / IMEI hapo juu zinatambua kifaa chako.' }
  ]
};

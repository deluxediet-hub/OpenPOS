'use strict';

/** Configuration inspection and dry-run payload routes; no live transport is added. */
module.exports = function register(app, {
  db, integrations, requireAuth, requireRole, getSettings, computeTotals, decorate, nowLocal
}) {
  /* ================= INTEGRATION CONFIG (eTIMS/M-Pesa) =================== */
  app.get('/api/integrations', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const s = getSettings();
    const etims = integrations.checkConfig(s, 'etims');
    const mpesa = integrations.checkConfig(s, 'mpesa');
    /* never send secrets back to the browser in full */
    const mask = (v) => (v ? String(v).slice(0, 4) + '••••' + String(v).slice(-2) : '');
    res.json({
      etims: { ...etims, endpoint: s.etims_endpoint, username: s.etims_username,
        password: mask(s.etims_password), branch_code: s.etims_branch_code,
        device_serial: s.etims_device_serial, receipt_prefix: s.etims_receipt_prefix,
        offline_queue_hours: s.etims_offline_queue_hours },
      mpesa: { ...mpesa, env: s.mpesa_env, consumer_key: mask(s.mpesa_consumer_key),
        consumer_secret: mask(s.mpesa_consumer_secret), shortcode: s.mpesa_shortcode,
        callback_url: s.mpesa_callback_url, paybill_account: s.mpesa_paybill_account },
      required: { etims: integrations.REQUIRED_ETIMS, mpesa: integrations.REQUIRED_MPESA },
      status: 'config_only'
    });
  });
  /** Dry-run: shapes a real payload without sending it, so config can be validated. */
  app.post('/api/integrations/dry-run', requireAuth, requireRole('manager', 'admin'), (req, res) => {
    const s = getSettings();
    if (req.body.target === 'mpesa') {
      const r = integrations.buildStkRequest({
        phone: req.body.phone || '0712345678', amount: Number(req.body.amount) || 100,
        settings: s, reference: 'DRYRUN'
      });
      return res.json({ ok: r.valid, phone: r.valid ? r.body.PartyA : null,
        invalid: !r.valid ? r.invalidPhone : undefined, endpoint: r.baseUrl + '/mpesa/stkpush/v1/processrequest',
        payload: { ...r.body, Password: '••••' }, config: integrations.checkConfig(s, 'mpesa') });
    }
    const o = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 1").get();
    /* On a fresh install there are no orders yet — shape a representative sample so
       an admin can still validate credentials before the first sale. */
    const d = o ? decorate(o) : {
      ...{ number: 0, people: 2, opened_at: nowLocal(), payments: [] },
      totals: computeTotals([{ price: 100000, qty: 2 }], 0, s, 0),
      items: [{ name: 'Sample item', qty: 2, price: 100000, kra_item_code: null, tax_class: 'A' }]
    };
    res.json({
      sample: !o,
      config: integrations.checkConfig(s, 'etims'),
      endpoint: s.etims_endpoint,
      payload: integrations.buildEtimsInvoice(d, { items: d.items, settings: s })
    });
  });
};

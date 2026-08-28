/* manager-system.js — printer and integration configuration panels */
'use strict';

const ManagerSystem = (() => {
  async function integrations(body) {
    const r = await api('/api/integrations');
    const badge = (c) => c.enabled
      ? (c.configured ? '<span class="tag warn">Enabled · awaiting client</span>' : '<span class="tag bad">Enabled but incomplete</span>')
      : '<span class="tag info">Disabled</span>';
    body.innerHTML = `
      <div class="card" style="border-left:3px solid var(--amber);margin-bottom:16px"><div class="card-b">
        <b>Configuration only.</b>
        <p class="muted small" style="margin:8px 0 0">Credentials you save here are stored per business and used by the
          integration layer in <code>lib/integrations.js</code>. Neither KRA eTIMS transmission nor live M-Pesa STK push is
          wired up yet — until it is, keep collecting the M-Pesa confirmation code by hand and issue tax invoices through
          the KRA portal or mobile app. The <b>Dry run</b> buttons shape a real payload without sending it, so you can
          verify credentials and endpoint URLs in advance.</p>
      </div></div>

      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card"><div class="card-h"><h3>KRA eTIMS</h3><span class="grow"></span>${badge(r.etims)}</div>
          <div class="card-b">
            <label class="row" style="gap:8px;cursor:pointer;margin-bottom:12px">
              <input type="checkbox" id="et_en" ${r.etims.enabled ? 'checked' : ''}> Enabled</label>
            <label class="fld">API endpoint</label><input class="inp" id="et_ep" value="${esc(r.etims.endpoint)}">
            <div class="grid2" style="margin-top:10px">
              <div><label class="fld">Username</label><input class="inp" id="et_un" value="${esc(r.etims.username)}"></div>
              <div><label class="fld">Password</label><input class="inp" id="et_pw" type="password" placeholder="(saved — retype to change)"></div>
              <div><label class="fld">Branch code</label><input class="inp" id="et_br" value="${esc(r.etims.branch_code)}"></div>
              <div><label class="fld">Device serial</label><input class="inp" id="et_ds" value="${esc(r.etims.device_serial)}"></div>
              <div><label class="fld">Receipt prefix</label><input class="inp" id="et_rp" value="${esc(r.etims.receipt_prefix)}"></div>
              <div><label class="fld">Offline queue (hrs)</label><input class="inp" id="et_oh" type="number" value="${esc(String(r.etims.offline_queue_hours))}"></div>
            </div>
            ${r.etims.missing.length ? `<p class="tiny" style="color:var(--red);margin-top:10px">Still needed: ${r.etims.missing.join(', ')}</p>` : ''}
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="etSave">Save eTIMS</button>
              <button class="btn ghost" id="etDry">Dry run invoice</button></div>
          </div>
        </div>

        <div class="card"><div class="card-h"><h3>Safaricom Daraja (M-Pesa)</h3><span class="grow"></span>${badge(r.mpesa)}</div>
          <div class="card-b">
            <label class="row" style="gap:8px;cursor:pointer;margin-bottom:12px">
              <input type="checkbox" id="mp_en" ${r.mpesa.enabled ? 'checked' : ''}> Enabled</label>
            <div class="grid2">
              <div><label class="fld">Environment</label><select class="inp" id="mp_env">
                <option value="sandbox" ${r.mpesa.env === 'sandbox' ? 'selected' : ''}>Sandbox</option>
                <option value="production" ${r.mpesa.env === 'production' ? 'selected' : ''}>Production</option></select></div>
              <div><label class="fld">Shortcode / Paybill</label><input class="inp" id="mp_sc" value="${esc(r.mpesa.shortcode)}"></div>
              <div><label class="fld">Consumer key</label><input class="inp" id="mp_ck" type="password" placeholder="(saved)"></div>
              <div><label class="fld">Consumer secret</label><input class="inp" id="mp_cs" type="password" placeholder="(saved)"></div>
            </div>
            <div style="margin-top:10px"><label class="fld">Passkey</label><input class="inp" id="mp_pk" type="password" placeholder="(saved)"></div>
            <div style="margin-top:10px"><label class="fld">Callback URL (must be public HTTPS)</label>
              <input class="inp" id="mp_cb" value="${esc(r.mpesa.callback_url)}" placeholder="https://yourdomain.com/api/mpesa/callback"></div>
            <div style="margin-top:10px"><label class="fld">Account reference</label>
              <input class="inp" id="mp_ac" value="${esc(r.mpesa.paybill_account)}"></div>
            ${r.mpesa.missing.length ? `<p class="tiny" style="color:var(--red);margin-top:10px">Still needed: ${r.mpesa.missing.join(', ')}</p>` : ''}
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="mpSave">Save M-Pesa</button>
              <button class="btn ghost" id="mpDry">Dry run STK</button></div>
          </div>
        </div>
      </div>
      <div id="intOut"></div>`;

    const out = body.querySelector('#intOut');
    const show = (o) => { out.innerHTML = `<div class="card" style="margin-top:14px">
      <div class="card-h"><h3>Dry-run output</h3><span class="grow"></span><button class="btn xs ghost" id="clr">Clear</button></div>
      <div class="card-b"><pre style="margin:0;font-size:11.5px;overflow:auto;max-height:340px">${esc(JSON.stringify(o, null, 2))}</pre></div></div>`;
      out.querySelector('#clr').onclick = () => { out.innerHTML = ''; }; };

    body.querySelector('#etSave').onclick = async () => {
      const p = { etims_enabled: body.querySelector('#et_en').checked ? '1' : '0',
        etims_endpoint: body.querySelector('#et_ep').value, etims_username: body.querySelector('#et_un').value,
        etims_branch_code: body.querySelector('#et_br').value, etims_device_serial: body.querySelector('#et_ds').value,
        etims_receipt_prefix: body.querySelector('#et_rp').value, etims_offline_queue_hours: body.querySelector('#et_oh').value };
      const pw = body.querySelector('#et_pw').value;
      if (pw) p.etims_password = pw;
      await api('/api/settings', { method: 'PUT', body: p });
      toast('eTIMS settings saved', 'ok'); integrations(body);
    };
    body.querySelector('#mpSave').onclick = async () => {
      const p = { mpesa_enabled: body.querySelector('#mp_en').checked ? '1' : '0',
        mpesa_env: body.querySelector('#mp_env').value, mpesa_shortcode: body.querySelector('#mp_sc').value,
        mpesa_callback_url: body.querySelector('#mp_cb').value, mpesa_paybill_account: body.querySelector('#mp_ac').value };
      const ck = body.querySelector('#mp_ck').value, cs = body.querySelector('#mp_cs').value, pk = body.querySelector('#mp_pk').value;
      if (ck) p.mpesa_consumer_key = ck;
      if (cs) p.mpesa_consumer_secret = cs;
      if (pk) p.mpesa_passkey = pk;
      await api('/api/settings', { method: 'PUT', body: p });
      toast('M-Pesa settings saved', 'ok'); integrations(body);
    };
    body.querySelector('#etDry').onclick = async () => {
      try { show(await api('/api/integrations/dry-run', { body: { target: 'etims' } })); }
      catch (e) { toast(e.message, 'err'); }
    };
    body.querySelector('#mpDry').onclick = () => {
      modal({ title: 'Dry-run STK push',
        body: `<div class="grid2"><div><label class="fld">Phone</label><input class="inp" id="dp" value="0712345678"></div>
          <div><label class="fld">Amount (${sym()})</label><input class="inp" id="da" type="number" value="100"></div></div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Run</button>` });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        const res = await api('/api/integrations/dry-run', { body: { target: 'mpesa',
          phone: ov.querySelector('#dp').value, amount: Number(ov.querySelector('#da').value) } });
        closeModal(); show(res);
      };
    };
  }

  /* --------------------------- PRINTER UI --------------------------- */
  function printer(body) {
    const s = State.settings, retail = s.business_type === 'wines_spirits';
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-h"><h3>Thermal printer</h3>
        <span class="grow"></span>${s.printer_enabled === '1' ? '<span class="tag ok">Enabled</span>' : '<span class="tag info">Disabled</span>'}</div>
        <div class="card-b">
          <p class="muted small" style="margin-top:0">Network (ESC/POS) printers listen on port 9100. Find the printer's IP
            from its self-test page. Every job is also spooled to <code>spool/</code> as a reprint archive. With printing
            disabled the app falls back to the browser's print dialog.</p>
          <label class="row" style="gap:8px;cursor:pointer;margin-bottom:12px">
            <input type="checkbox" id="pr_en" ${s.printer_enabled === '1' ? 'checked' : ''}> Send jobs to a network printer</label>
          <div class="grid2">
            <div><label class="fld">Receipt printer host</label><input class="inp mono" id="pr_h" value="${esc(s.printer_host)}" placeholder="192.168.1.50"></div>
            <div><label class="fld">Port</label><input class="inp mono" id="pr_p" value="${esc(s.printer_port)}"></div>
            ${retail ? '' : `<div><label class="fld">Kitchen printer host (optional)</label><input class="inp mono" id="pr_kh" value="${esc(s.kitchen_printer_host)}" placeholder="defaults to receipt printer"></div>
            <div><label class="fld">Kitchen port</label><input class="inp mono" id="pr_kp" value="${esc(s.kitchen_printer_port)}"></div>`}
            <div><label class="fld">Characters per line</label><input class="inp" id="pr_c" type="number" value="${esc(s.printer_chars)}">
              <div class="tiny muted" style="margin-top:4px">42 for 80mm paper, 32 for 58mm</div></div>
            <div><label class="fld">Cash drawer</label><select class="inp" id="pr_d">
              <option value="1" ${s.drawer_kick_enabled === '1' ? 'selected' : ''}>Kick open on cash sale</option>
              <option value="0" ${s.drawer_kick_enabled !== '1' ? 'selected' : ''}>No drawer attached</option></select></div>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" id="prSave">Save</button>
            <button class="btn ghost" id="prTest">Print test receipt</button></div>
          <div id="prOut" class="tiny muted" style="margin-top:10px"></div>
        </div>
      </div>`;

    body.querySelector('#prSave').onclick = async () => {
      State.settings = await api('/api/settings', { method: 'PUT', body: {
        printer_enabled: body.querySelector('#pr_en').checked ? '1' : '0',
        printer_host: body.querySelector('#pr_h').value.trim(),
        printer_port: body.querySelector('#pr_p').value,
        kitchen_printer_host: body.querySelector('#pr_kh')?.value.trim() || '',
        kitchen_printer_port: body.querySelector('#pr_kp')?.value || '9100',
        printer_chars: body.querySelector('#pr_c').value,
        drawer_kick_enabled: body.querySelector('#pr_d').value } });
      toast('Printer settings saved', 'ok'); printer(body);
    };
    body.querySelector('#prTest').onclick = async () => {
      const o = State.orders[0] || (await api('/api/orders?status=closed'))[0];
      const out = body.querySelector('#prOut');
      if (!o) { out.innerHTML = '<span style="color:var(--red)">No order exists yet to print.</span>'; return; }
      try {
        const r = await api('/api/print/receipt/' + o.id, { method: 'POST' });
        out.innerHTML = r.sent
          ? `<span style="color:var(--green)">Sent ${r.bytes} bytes to ${esc(r.printer)}</span>`
          : `<span style="color:var(--amber)">${esc(r.reason || 'Not sent')} — ${r.bytes} bytes spooled</span>`;
      } catch (e) { out.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
    };
  }

  return { integrations, printer };
})();

/* manager-loyalty.js — customer loyalty and funded gift-card panels */
'use strict';

const ManagerLoyalty = (() => {
  let sub = 'customers';
  async function loyalty(body) {
    body.innerHTML = `
      <div class="tabs" style="margin-bottom:14px">
        <button class="tab ${sub === 'customers' ? 'active' : ''}" data-s="customers">Customers</button>
        <button class="tab ${sub === 'cards' ? 'active' : ''}" data-s="cards">Gift cards</button>
      </div><div id="loyBody"></div>`;
    body.querySelectorAll('[data-s]').forEach((b) => b.onclick = () => { sub = b.dataset.s; loyalty(body); });
    const host = body.querySelector('#loyBody');
    if (sub === 'customers') return customers(host);
    return cards(host);
  }

  async function customers(host) {
    const list = await api('/api/customers');
    host.innerHTML = `
      <div class="row" style="margin-bottom:12px"><input class="inp" id="cs" placeholder="Search name or phone…" style="max-width:260px">
        <span class="grow"></span><button class="btn primary" id="addC">+ New customer</button></div>
      <div class="card"><div class="scroll-x"><table class="tbl">
        <thead><tr><th>Name</th><th>Phone</th><th class="right">Points</th><th class="right">Value</th>
          <th class="right">Visits</th><th class="right">Total spend</th></tr></thead>
        <tbody id="crows">${rows(list)}</tbody></table></div></div>`;
    function rows(l) {
      const per = Number(State.settings.loyalty_redeem_per) || 1;
      return l.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="small muted">${esc(c.phone || '')}</td>
        <td class="right mono"><b>${c.points}</b></td><td class="right mono muted">${fmt(c.points * per * 100)}</td>
        <td class="right mono">${c.visits}</td><td class="right mono">${fmt(c.total_spend)}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">No customers yet.</td></tr>';
    }
    host.querySelector('#cs').oninput = async (e) => {
      const r = await api('/api/customers?q=' + encodeURIComponent(e.target.value));
      host.querySelector('#crows').innerHTML = rows(r);
    };
    host.querySelector('#addC').onclick = () => {
      modal({ title: 'New customer',
        body: `<label class="fld">Name</label><input class="inp" id="cn">
          <div class="grid2" style="margin-top:12px">
            <div><label class="fld">Phone</label><input class="inp" id="cph"></div>
            <div><label class="fld">Email</label><input class="inp" id="ce"></div></div>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Save</button>` });
      const ov = document.querySelector('#modalRoot .ov');
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        try {
          await api('/api/customers', { body: { name: ov.querySelector('#cn').value,
            phone: ov.querySelector('#cph').value, email: ov.querySelector('#ce').value } });
          closeModal(); customers(host); toast('Customer added', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    };
  }

  async function cards(host) {
    const list = await api('/api/gift-cards');
    host.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div class="stat" style="flex:1;min-width:140px"><div class="l">Outstanding liability</div>
          <div class="v">${fmt(list.reduce((a, c) => a + (c.status === 'active' ? c.balance : 0), 0))}</div>
          <div class="d">unredeemed gift card value</div></div>
        <span class="grow"></span>
        <button class="btn primary" id="addGc">+ Issue gift card</button></div>
      <div class="card"><div class="scroll-x"><table class="tbl">
        <thead><tr><th>Code</th><th>Holder</th><th class="right">Value</th><th class="right">Balance</th><th>Issued</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr>
          <td class="mono"><b>${esc(c.code)}</b></td><td class="small">${esc(c.customer_name || '—')}</td>
          <td class="right mono">${fmt(c.value)}</td><td class="right mono"><b>${fmt(c.balance)}</b></td>
          <td class="small muted">${c.created_at.slice(0, 10)}</td>
          <td><span class="tag ${c.status === 'active' ? 'ok' : c.status === 'void' ? 'bad' : 'info'}">${c.status}</span></td>
          <td class="right">${c.status === 'active' ? `<button class="btn xs red" data-v="${c.id}">Void</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">No gift cards issued.</td></tr>'}</tbody></table></div></div>`;

    host.querySelector('#addGc').onclick = () => {
      modal({ title: 'Issue gift card',
        body: `<label class="fld">Value (${sym()})</label><input class="inp" id="gv" type="number" step="0.01" placeholder="e.g. 2000">
          <div class="grid2" style="margin-top:12px"><div><label class="fld">Funding payment</label><select class="inp" id="gm"><option value="cash">Cash</option><option value="card">Card</option><option value="mpesa">M-Pesa</option></select></div>
            <div><label class="fld">Card/M-Pesa reference</label><input class="inp mono" id="gr" placeholder="Required for non-cash"></div></div>
          <div style="margin-top:12px"><label class="fld">Code (leave blank to auto-generate)</label>
            <input class="inp mono" id="gc" placeholder="${State.settings.giftcard_prefix || 'SRN'}-XXXX-XXXX-XXXX"></div>
          <p class="tiny muted">The card activates only after this funding payment is recorded against the open till.</p>`,
        footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Issue</button>` });
      const ov = document.querySelector('#modalRoot .ov');
      const fundingKey = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `gift-${Date.now()}-${Math.random()}`;
      ov.querySelector('[data-no]').onclick = closeModal;
      ov.querySelector('[data-yes]').onclick = async () => {
        try {
          const res = await api('/api/gift-cards', { body: { value: Number(ov.querySelector('#gv').value),
            code: ov.querySelector('#gc').value, payment_method: ov.querySelector('#gm').value,
            reference: ov.querySelector('#gr').value.trim(), idempotency_key: fundingKey } });
          closeModal(); cards(host);
          modal({ title: 'Gift card issued', body: `<div class="center" style="padding:16px">
            <div class="mono" style="font-size:22px;font-weight:700;letter-spacing:2px">${esc(res.code)}</div>
            <div class="muted" style="margin-top:8px">${fmt(res.value)}</div>
            <p class="tiny muted" style="margin-top:16px">Write this down — it is the only time the full code is shown.</p></div>`,
            footer: `<button class="btn primary" data-no>Done</button>` });
          const o2 = document.querySelector('#modalRoot .ov');
          o2.querySelector('[data-no]').onclick = closeModal;
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    host.querySelectorAll('[data-v]').forEach((b) => b.onclick = () =>
      confirmBox('Void gift card', 'The card will no longer be accepted at the till.', {
        danger: true, okLabel: 'Void card', onOk: async () => {
          await api(`/api/gift-cards/${b.dataset.v}/void`, {}); cards(host); toast('Voided', 'ok');
        } }));
  }

  /* ------------------------ LABOUR & USAGE ------------------------- */

  return { loyalty };
})();

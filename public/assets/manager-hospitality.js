/* manager-hospitality.js — reusable reservation and labour panels */
'use strict';

const ManagerHospitality = (() => {
  async function reservations(body) {
    const day = today();
    const load = async (d) => {
      const list = await api('/api/reservations?date=' + d);
      body.innerHTML = `
        <div class="row" style="margin-bottom:14px">
          <label class="fld" style="margin:0">Date</label>
          <input class="inp" type="date" id="rd" value="${d}" style="width:auto">
          <span class="grow"></span>
          <button class="btn primary" id="addRv">+ New reservation</button>
        </div>
        <div class="card"><div class="scroll-x"><table class="tbl">
          <thead><tr><th>Time</th><th>Name</th><th>Phone</th><th class="right">Guests</th><th>Table</th><th>Status</th><th>Notes</th><th></th></tr></thead>
          <tbody>${list.map((r) => `<tr>
            <td class="mono"><b>${r.res_time}</b></td><td><b>${esc(r.name)}</b></td>
            <td class="small muted">${esc(r.phone || '')}</td><td class="right mono">${r.people}</td>
            <td class="small">${esc(r.table_name || '—')}</td>
            <td><span class="tag ${r.status === 'seated' ? 'ok' : r.status === 'cancelled' ? 'bad' : r.status === 'no_show' ? 'warn' : 'info'}">${r.status}</span></td>
            <td class="small muted">${esc(r.notes || '')}</td>
            <td class="right nowrap">
              ${r.status === 'booked' ? `<button class="btn xs green" data-s="${r.id}">Seat</button>` : ''}
              <button class="btn xs red" data-c="${r.id}">Cancel</button></td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty">No reservations for this date.</td></tr>'}</tbody></table></div></div>`;

      body.querySelector('#rd').onchange = (e) => load(e.target.value);
      body.querySelector('#addRv').onclick = () => {
        modal({
          title: 'New reservation',
          body: `<div class="grid2">
              <div><label class="fld">Name</label><input class="inp" id="rn"></div>
              <div><label class="fld">Phone</label><input class="inp" id="rp"></div>
              <div><label class="fld">Date</label><input class="inp" type="date" id="rdate" value="${d}"></div>
              <div><label class="fld">Time</label><input class="inp" type="time" id="rt" value="19:00"></div>
              <div><label class="fld">Guests</label><input class="inp" type="number" id="rg" min="1" value="2"></div>
              <div><label class="fld">Table</label><select class="inp" id="rtb"><option value="">Unassigned</option>
                ${State.tables.map((t) => `<option value="${t.id}">${esc(t.name)} · ${esc(t.area)}</option>`).join('')}</select></div>
            </div>
            <div style="margin-top:12px"><label class="fld">Notes</label><input class="inp" id="rno" placeholder="e.g. birthday, window seat"></div>`,
          footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Book</button>`
        });
        const ov = document.querySelector('#modalRoot .ov');
        ov.querySelector('[data-no]').onclick = closeModal;
        ov.querySelector('[data-yes]').onclick = async () => {
          try {
            await api('/api/reservations', { body: {
              name: ov.querySelector('#rn').value, phone: ov.querySelector('#rp').value,
              res_date: ov.querySelector('#rdate').value, res_time: ov.querySelector('#rt').value,
              people: Number(ov.querySelector('#rg').value), table_id: Number(ov.querySelector('#rtb').value) || null,
              notes: ov.querySelector('#rno').value } });
            closeModal(); load(d); toast('Reservation booked', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      };
      body.querySelectorAll('[data-s]').forEach((b) => b.onclick = async () => {
        await api('/api/reservations/' + b.dataset.s, { method: 'PUT', body: { status: 'seated' } }); load(d);
      });
      body.querySelectorAll('[data-c]').forEach((b) => b.onclick = async () => {
        await api('/api/reservations/' + b.dataset.c, { method: 'DELETE' }); load(d); toast('Cancelled', 'ok');
      });
    };
    load(day);
  }

  /* --------------------- LOYALTY & GIFT CARDS ---------------------- */
  async function labour(body) {
    const t = today();
    const [lab, usage] = await Promise.all([
      api(`/api/reports/labour?from=${t}&to=${t}`),
      api(`/api/reports/stock-usage?from=${t}&to=${t}`)
    ]);
    body.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h3 style="margin:0;font-size:14px">Labour &amp; usage</h3>
        <span class="grow"></span><button class="btn" id="labpdf">🖨 PDF</button></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:14px">
        <div class="stat"><div class="l">Hours worked today</div><div class="v">${lab.hours}</div></div>
        <div class="stat"><div class="l">Labour cost</div><div class="v">${fmt(lab.cost)}</div></div>
        <div class="stat"><div class="l">Labour % of sales</div>
          <div class="v" style="color:${lab.pct > lab.target_pct ? 'var(--red)' : 'var(--green)'}">${lab.pct}%</div>
          <div class="d">target ${lab.target_pct}%</div></div>
        <div class="stat"><div class="l">Net sales</div><div class="v">${fmt(lab.sales)}</div></div>
      </div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card"><div class="card-h"><h3>Staff on the clock</h3></div>
          <table class="tbl"><thead><tr><th>Name</th><th class="right">Hours</th><th class="right">Cost</th></tr></thead>
          <tbody>${lab.by_user.map((u) => `<tr><td><b>${esc(u.name)}</b></td>
            <td class="right mono">${u.hours}</td><td class="right mono">${fmt(u.cost)}</td></tr>`).join('')
            || '<tr><td colspan="3" class="empty">No completed punches today.</td></tr>'}</tbody></table>
        </div>
        <div class="card"><div class="card-h"><h3>Theoretical stock usage</h3>
          <span class="grow"></span><span class="tiny muted">from recipes × items sold</span></div>
          <div style="max-height:320px;overflow:auto"><table class="tbl">
            <thead><tr><th>Ingredient</th><th class="right">Used</th><th class="right">On hand</th></tr></thead>
            <tbody>${usage.filter((u) => u.theoretical > 0).map((u) => `<tr>
              <td><b>${esc(u.name)}</b></td><td class="right mono">${Math.round(u.theoretical * 100) / 100} ${esc(u.unit)}</td>
              <td class="right mono">${esc(stockQtyLabel(u.on_hand, u.unit, u.capacity_ml))}</td></tr>`).join('')
              || '<tr><td colspan="3" class="empty">Nothing sold against a recipe today.</td></tr>'}</tbody></table></div>
        </div>
      </div>`;
    body.querySelector('#labpdf').onclick = () => printReport({
      title: 'Labour & Stock-Usage Report', subtitle: `Date ${t}`,
      tables: [
        { title: 'Labour', head: ['Metric', 'Value'], right: [1], rows: [
          ['Hours worked', String(lab.hours)], ['Labour cost', fmt(lab.cost)],
          ['Labour % of sales', lab.pct + '% (target ' + lab.target_pct + '%)'], ['Net sales', fmt(lab.sales)] ] },
        { title: 'Staff on the clock', head: ['Name', 'Hours', 'Cost'], right: [1, 2],
          rows: lab.by_user.map((u) => [u.name, String(u.hours), fmt(u.cost)]),
          footer: ['TOTAL', String(lab.hours), fmt(lab.cost)] },
        { title: 'Theoretical stock usage', head: ['Ingredient', 'Used', 'On hand'], right: [1, 2],
          rows: usage.filter((u) => u.theoretical > 0).map((u) => [u.name, (Math.round(u.theoretical * 100) / 100) + ' ' + u.unit, stockQtyLabel(u.on_hand, u.unit, u.capacity_ml)]) }
      ]
    });
  }

  /* ------------------------ INTEGRATIONS UI ------------------------ */

  return { reservations, labour };
})();

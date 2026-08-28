/* manager-reconciliation.js — till, expenses and reconciliation */
'use strict';

const ManagerReconciliation = (() => {
  async function drawer(body) {
    const cur = await api('/api/shifts/current');
    const [list, counts] = await Promise.all([api('/api/shifts'), State.settings.business_type === 'wines_spirits' ? api('/api/stock-counts') : Promise.resolve([])]);
    const openCount = counts.find((c) => c.status === 'open');
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>${cur.shift ? (cur.shift.status === 'reconciling' ? 'End-of-day reconciliation' : 'Till open') : 'Till closed'}</h3><span class="grow"></span>
          ${cur.shift ? `<span class="tiny muted">opened ${cur.shift.opened_at}</span>` : ''}</div>
        <div class="card-b">
          ${cur.shift ? (() => {
            const d = cur.drawer;
            return `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
              <div class="stat"><div class="l">Opening float</div><div class="v">${fmt(cur.shift.opening_float)}</div></div>
              <div class="stat"><div class="l">Cash sales</div><div class="v" style="color:var(--green)">${fmt(d.cash_sales)}</div></div>
              <div class="stat"><div class="l">M-Pesa sales</div><div class="v" style="color:var(--green)">${fmt(d.mpesa_sales || 0)}</div></div>
              <div class="stat"><div class="l">Card sales</div><div class="v" style="color:var(--green)">${fmt(d.card_sales || 0)}</div></div>
              <div class="stat"><div class="l">Cash expenses</div><div class="v" style="color:var(--red)">−${fmt(d.cash_expenses || 0)}</div></div>
              <div class="stat"><div class="l">M-Pesa expenses</div><div class="v" style="color:var(--red)">−${fmt(d.mpesa_expenses || 0)}</div></div>
              <div class="stat"><div class="l">Expected cash</div><div class="v">${fmt(d.expected)}</div></div>
              <div class="stat"><div class="l">Expected M-Pesa</div><div class="v">${fmt(d.expected_mpesa || 0)}</div></div>
              <div class="stat"><div class="l">Expected Card/EDC</div><div class="v">${fmt(d.expected_card || 0)}</div></div>
            </div>
            ${cur.stocktake ? `<div class="card" style="margin-top:12px;background:#101820"><div class="card-b">
              <div class="row"><b>Stock count variance · ${esc(cur.stock_coverage||'partial')}</b><span class="grow"></span><span class="tag ${cur.stocktake.cost_variance < 0 ? 'bad' : cur.stocktake.cost_variance > 0 ? 'warn' : 'ok'}">${esc(cur.stocktake.reference)}</span></div>
              <div class="grid2" style="margin-top:9px"><div class="tline"><span>At inventory cost</span><b>${fmt(cur.stocktake.cost_variance)}</b></div>
                <div class="tline"><span>At potential retail</span><b>${fmt(cur.stocktake.retail_variance)}</b></div></div>
              <div class="tiny muted" style="margin-top:7px">Recorded separately from expected cash. Changing expected cash would hide whether the difference came from an unrecorded sale, breakage, theft or a counting error.</div>
            </div></div>` : ''}
            <div class="row" style="margin-top:14px">
              <button class="btn ghost" id="payout">+ Record expense</button>
              <span class="grow"></span>
              ${openCount ? `<button class="btn primary" id="continueStocktake">Continue stocktake</button>` : `<button class="btn primary" id="closeShift">Close till &amp; reconcile</button>`}
            </div>`;
          })() : `<p class="muted">Open the till each morning. Enter the physical cash float and current M-Pesa business balance before selling.</p>
            <div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));max-width:920px">
              <div><label class="fld">Opening cash (${sym()})</label><input class="inp" id="fl" type="number" step="0.01" value="5000"></div>
              <div><label class="fld">Opening M-Pesa balance (${sym()})</label><input class="inp" id="fmp" type="number" step="0.01" value="0"></div>
              <div><label class="fld">Opening Card/EDC batch (${sym()})</label><input class="inp" id="fcard" type="number" step="0.01" value="0"></div>
              <div style="align-self:end"><button class="btn primary" id="openShift">Open till for sales</button></div>
            </div>`}
        </div>
      </div>
      <div class="card"><div class="card-h"><h3>Shift history</h3></div>
        <div class="scroll-x"><table class="tbl">
          <thead><tr><th>Opened</th><th>Closed</th><th>By</th><th class="right">Cash float</th>
            <th class="right">Cash expected</th><th class="right">Cash counted</th><th class="right">Cash variance</th>
            <th class="right">M-Pesa expected</th><th class="right">M-Pesa actual</th><th class="right">M-Pesa variance</th>
            <th class="right">Card expected</th><th class="right">Card actual</th><th class="right">Card variance</th>
            <th class="right">Stock retail variance</th><th class="right">Overall</th><th>Status</th></tr></thead>
          <tbody>${list.map((s) => `<tr>
            <td class="small mono">${s.opened_at}</td>
            <td class="small mono">${s.closed_at || '<i>open</i>'}</td>
            <td class="small">${esc(s.closed_by_name || s.opened_by_name || '—')}</td>
            <td class="right mono">${fmt(s.opening_float)}</td>
            <td class="right mono">${s.expected_cash == null ? '—' : fmt(s.expected_cash)}</td>
            <td class="right mono">${s.counted_cash == null ? '—' : fmt(s.counted_cash)}</td>
            <td class="right">${s.variance == null ? '—' : `<span class="tag ${s.variance === 0 ? 'ok' : Math.abs(s.variance) > 5000 ? 'bad' : 'warn'}">
              ${s.variance > 0 ? '+' : ''}${fmt(s.variance)}</span>`}</td>
            <td class="right mono">${s.expected_mpesa == null ? '—' : fmt(s.expected_mpesa)}</td>
            <td class="right mono">${s.counted_mpesa == null ? '—' : fmt(s.counted_mpesa)}</td>
            <td class="right">${s.mpesa_variance == null ? '—' : `<span class="tag ${s.mpesa_variance === 0 ? 'ok' : 'warn'}">${s.mpesa_variance > 0 ? '+' : ''}${fmt(s.mpesa_variance)}</span>`}</td>
            <td class="right mono">${s.expected_card == null ? '—' : fmt(s.expected_card)}</td><td class="right mono">${s.counted_card == null ? '—' : fmt(s.counted_card)}</td>
            <td class="right mono">${s.card_variance == null ? '—' : fmt(s.card_variance)}</td><td class="right mono">${s.stock_retail_variance == null ? '—' : fmt(s.stock_retail_variance)}</td>
            <td class="right mono"><b>${s.overall_variance == null ? '—' : fmt(s.overall_variance)}</b></td>
            <td><span class="tag ${s.reconciliation_status === 'FULLY BALANCED' || (s.reconciliation_status||'').startsWith('TENDERS BALANCED') ? 'ok' : (s.reconciliation_status||'').includes('RECONCILED') ? 'warn' : 'bad'}">${esc(s.reconciliation_status || (s.status === 'open' ? 'OPEN' : '—'))}</span></td>
          </tr>`).join('') || '<tr><td colspan="16" class="empty">No shifts recorded.</td></tr>'}</tbody></table></div>
      </div>`;

    if (cur.shift) {
      body.querySelector('#payout').onclick = () => {
        modal({ title: 'Record business expense', body: `<p class="muted" style="margin-top:0">The amount is deducted from the expected Cash or M-Pesa balance for this till.</p>
          <div class="grid2"><div><label class="fld">Paid from</label><select class="inp" id="exMethod"><option value="cash">Cash drawer</option><option value="mpesa">M-Pesa business account</option></select></div>
          <div><label class="fld">Amount (${sym()})</label><input class="inp" id="exAmount" type="number" min="0.01" step="0.01"></div></div>
          <div style="margin-top:12px"><label class="fld">Reason / receipt reference</label><input class="inp" id="exReason" placeholder="Supplier, transport, airtime, bank deposit…"></div>`,
          footer: '<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Record expense</button>' });
        const ov = document.querySelector('#modalRoot .ov');
        ov.querySelector('[data-no]').onclick = closeModal;
        ov.querySelector('[data-yes]').onclick = async () => {
          try {
            await api(`/api/shifts/${cur.shift.id}/payout`, { body: { amount: Number(ov.querySelector('#exAmount').value),
              method: ov.querySelector('#exMethod').value, reason: ov.querySelector('#exReason').value.trim() } });
            closeModal(); drawer(body); toast('Expense recorded', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      };
      const continueStocktake = body.querySelector('#continueStocktake');
      if (continueStocktake) continueStocktake.onclick = () => Retail.stocktakes(body);
      const closeShift = body.querySelector('#closeShift');
      if (closeShift) closeShift.onclick = () => {
        const d=cur.drawer,stockRetail=cur.stocktake?cur.stocktake.retail_variance:null;
        const stockCoverage=cur.stock_coverage||'none';
        const tolerance = Math.max(0, Number(State.settings.reconciliation_tolerance || 20) * 100);
        modal({
          title: 'Close shift / till — reconcile operations', wide: true,
          body: `<div class="grid3">
              <div><label class="fld">Expected cash</label><input class="inp mono" value="${(d.expected / 100).toFixed(2)}" disabled>
                <label class="fld" style="margin-top:8px">Cash physically counted</label><input class="inp mono" id="cnt" type="number" step="0.01" value="${(d.expected / 100).toFixed(2)}"></div>
              <div><label class="fld">Expected M-Pesa balance</label><input class="inp mono" value="${((d.expected_mpesa || 0) / 100).toFixed(2)}" disabled>
                <label class="fld" style="margin-top:8px">Actual M-Pesa balance</label><input class="inp mono" id="cntMpesa" type="number" step="0.01" value="${((d.expected_mpesa || 0) / 100).toFixed(2)}"></div>
              <div><label class="fld">Expected Card/EDC batch</label><input class="inp mono" value="${((d.expected_card || 0) / 100).toFixed(2)}" disabled>
                <label class="fld" style="margin-top:8px">Actual Card/EDC batch</label><input class="inp mono" id="cntCard" type="number" step="0.01" value="${((d.expected_card || 0) / 100).toFixed(2)}"></div>
            </div>
            <div class="card" style="background:#101820;margin-top:12px"><div class="card-b">
              <div class="grid3"><div class="tline"><span>Cash variance</span><b id="vr">—</b></div>
                <div class="tline"><span>M-Pesa variance</span><b id="vrMpesa">—</b></div>
                <div class="tline"><span>Card variance</span><b id="vrCard">—</b></div></div>
              <div class="tline" style="margin-top:8px"><span>Total tender variance</span><b id="vrTender">—</b></div>
              <div class="tline"><span>Stock variance at retail (${esc(stockCoverage)})</span><b id="vrStock">${stockRetail==null?'NOT COUNTED':fmt(stockRetail)}</b></div>
              <div class="tline total"><span>${stockCoverage==='full'?'Overall operational variance':'Scoped overall variance'}</span><b id="vrOverall">—</b></div>
              <div class="center" style="margin-top:10px"><span class="tag" id="vrStatus">—</span></div>
              <p class="tiny muted" style="margin:9px 0 0">Overall = Cash + M-Pesa + Card variance + stock variance at retail. Offsetting differences can reveal sales that were made but not entered.</p>
            </div></div>
            <div style="margin-top:12px"><label class="fld">Reconciliation note <span id="noteRequired" style="color:var(--red)"></span></label>
              <input class="inp" id="sn" placeholder="Required when anything differs — e.g. likely missed sales during rush"></div>`,
          footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Close till</button>`
        });
        const ov = document.querySelector('#modalRoot .ov');
        const cnt = ov.querySelector('#cnt'), cntMpesa = ov.querySelector('#cntMpesa'), cntCard = ov.querySelector('#cntCard');
        let current = null;
        const paintVariance=(el,value)=>{
          if(value==null){el.textContent='NOT AVAILABLE';el.style.color='var(--dim)';return;}
          el.textContent=(value>0?'+':value<0?'−':'')+fmt(Math.abs(value));
          el.style.color=Math.abs(value)<=tolerance?'var(--green)':'var(--red)';
        };
        let previewSequence=0;
        const upd=async()=>{
          const sequence=++previewSequence;
          try{const result=await api(`/api/shifts/${cur.shift.id}/reconciliation-preview`,{body:{
            counted_cash:Number(cnt.value)||0,counted_mpesa:Number(cntMpesa.value)||0,counted_card:Number(cntCard.value)||0}});
            if(sequence!==previewSequence)return;current=result;
            paintVariance(ov.querySelector('#vr'),current.cash_variance);paintVariance(ov.querySelector('#vrMpesa'),current.mpesa_variance);
            paintVariance(ov.querySelector('#vrCard'),current.card_variance);paintVariance(ov.querySelector('#vrTender'),current.tender_variance);
            paintVariance(ov.querySelector('#vrStock'),current.stock_retail_variance);paintVariance(ov.querySelector('#vrOverall'),current.overall_variance);
            const status=ov.querySelector('#vrStatus');status.textContent=current.status;
            status.className='tag '+(current.status==='FULLY BALANCED'||current.status.startsWith('TENDERS BALANCED')?'ok':current.status.includes('RECONCILED')?'warn':'bad');
            ov.querySelector('#noteRequired').textContent=current.requires_note?'* required':'(optional)';
          }catch(e){toast(e.message,'err');}
        };
        cnt.oninput=upd;cntMpesa.oninput=upd;cntCard.oninput=upd;upd();
        ov.querySelector('[data-no]').onclick = closeModal;
        ov.querySelector('[data-yes]').onclick = async () => {
          const note = ov.querySelector('#sn').value.trim();
          if(!current)await upd();
          if(!current)return toast('Could not calculate reconciliation','err');
          if (current.requires_note && !note) return toast('Add a reconciliation note for the variance', 'err');
          try {
            const res = await api(`/api/shifts/${cur.shift.id}/close`, { body: {
              counted_cash: Number(cnt.value), counted_mpesa: Number(cntMpesa.value), counted_card: Number(cntCard.value),
              reconciliation_note: note, notes: note } });
            closeModal(); await loadBootstrap(); drawer(body);
            toast(`Till closed · ${res.reconciliation.status} · ${res.reconciliation.overall_variance==null?'stock overall not available':'overall '+fmt(res.reconciliation.overall_variance)}`,
              res.reconciliation.requires_note ? 'err' : 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      };
    } else {
      body.querySelector('#openShift').onclick = async () => {
        try {
          await api('/api/shifts', { body: { opening_float: Number(body.querySelector('#fl').value),
            opening_mpesa: Number(body.querySelector('#fmp').value), opening_card: Number(body.querySelector('#fcard').value) } });
          await loadBootstrap(); toast('Till opened — ready for sales', 'ok');
          if (State.user.role === 'seller') navigate('tables'); else drawer(body);
        } catch (e) { toast(e.message, 'err'); }
      };
    }
  }

  /* -------------------------- RESERVATIONS -------------------------- */

  return { drawer };
})();

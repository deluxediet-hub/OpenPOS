/* kds.js — kitchen & bar display screens */
'use strict';

const KDS = (() => {
  const LATE_MINS = 12, WARN_MINS = 6;

  function tickets() {
    const out = [];
    for (const o of State.orders) {
      if (!['open', 'billed'].includes(o.status)) continue;
      for (const st of ['kitchen', 'bar']) {
        const lines = o.items.filter((i) => i.station === st && ['sent', 'ready'].includes(i.status));
        if (lines.length) out.push({ order: o, station: st, lines, age: mins(o.items.find((i) => i.station === st && ['sent', 'ready'].includes(i.status)).sent_at) });
      }
    }
    return out.sort((a, b) => a.age - b.age || a.order.id - b.order.id);
  }

  function render(host, { stationFilter } = {}) {
    const all = tickets();
    const stations = ['kitchen', 'bar'];
    host.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Active tickets</div><div class="v">${all.length}</div></div>
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Running late</div><div class="v" style="color:var(--red)">${all.filter(t=>t.age>=LATE_MINS).length}</div></div>
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Kitchen lines</div><div class="v">${all.filter(t=>t.station==='kitchen').reduce((a,t)=>a+t.lines.length,0)}</div></div>
        <div class="stat" style="flex:1;min-width:120px"><div class="l">Bar lines</div><div class="v">${all.filter(t=>t.station==='bar').reduce((a,t)=>a+t.lines.length,0)}</div></div>
        <span class="grow"></span>
        <a class="btn ghost" href="/kds" target="_blank" rel="noopener">⛶ Open full screen</a>
      </div>
      <div class="kds-cols">
        ${stations.map((st) => {
          const list = all.filter((t) => t.station === st);
          return `<div>
            <h3 style="font-size:13px;color:${st === 'bar' ? 'var(--teal)' : 'var(--amber)'};margin:0 0 10px;letter-spacing:.6px">
              ${st === 'bar' ? '🍸 BAR' : '🔥 KITCHEN'} <span class="muted small">(${list.length})</span></h3>
            ${list.length ? list.map((t) => ticketCard(t)).join('') :
              `<div class="empty" style="border:1px dashed #2c3947;border-radius:10px">Nothing on the ${st}. ✨</div>`}
          </div>`;
        }).join('')}
      </div>`;

    host.querySelectorAll('[data-ready]').forEach((b) => b.onclick = () => ready(Number(b.dataset.ready), 'all'));
    host.querySelectorAll('[data-readyline]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation(); ready(Number(b.dataset.ready), Number(b.dataset.readyline));
    });
  }

  /* Kitchen staff ready kitchen lines; the bar readies bar lines; managers oversee both.
     (The server enforces the same rule.) */
  const canReady = (station) => {
    const r = State.user && State.user.role;
    if (r === 'manager' || r === 'admin') return true;
    if (r === 'kitchen') return station === 'kitchen';
    if (r === 'bartender') return station === 'bar';
    return false;
  };

  function ticketCard(t) {
    const cls = t.age >= LATE_MINS ? 'late' : '';
    const o = t.order;
    const tbl = orderTable(o);
    const allowed = canReady(t.station);
    const allReady = t.lines.every((l) => l.status === 'ready');
    return `<div class="ticket ${t.station === 'bar' ? 'bar' : ''} ${cls}">
      <div class="ticket-h">
        <span>#${o.number} · ${tbl ? esc(tbl.name) : 'TAKEAWAY'}</span>
        <span class="age">${t.age >= WARN_MINS ? '⏱ ' : ''}${ago(t.lines[0].sent_at)}${allReady ? ' · READY' : ''}</span>
      </div>
      <ul>
        ${t.lines.map((l) => `<li style="${l.status === 'ready' ? 'opacity:.5;text-decoration:line-through' : ''}">
          <span><b class="q">${l.qty}×</b> ${esc(l.name)}${l.note ? `<div class="nt">↳ ${esc(l.note)}</div>` : ''}</span>
          ${l.status === 'sent'
            ? (allowed ? `<button class="btn xs ghost" data-readyline="${l.id}" data-ready="${o.id}">✓</button>` : '<span class="tag warn">queued</span>')
            : '<span class="tag ok">ready</span>'}
        </li>`).join('')}
      </ul>
      ${allowed ? `<div class="ticket-f">
        <button class="btn ${allReady ? 'green' : ''} sm" data-ready="${o.id}">${allReady ? '✓ All ready — expedite' : 'Mark all ready'}</button>
      </div>` : ''}
    </div>`;
  }

  async function ready(orderId, lineId) {
    try {
      const o = State.orders.find((x) => x.id === orderId);
      if (!o) return;
      if (lineId === 'all') {
        const pend = o.items.filter((i) => ['sent', 'ready'].includes(i.status));
        for (const l of pend) {
          if (l.status === 'sent') await api(`/api/orders/${o.id}/items/${l.id}`, { method: 'PATCH', body: { status: 'ready' } });
        }
      } else {
        await api(`/api/orders/${o.id}/items/${lineId}`, { method: 'PATCH', body: { status: 'ready' } });
      }
      State.orders = await api('/api/orders');
      document.dispatchEvent(new CustomEvent('pos:update', { detail: { ev: 'kitchen' } }));
      toast('Marked ready', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------------- standalone full-screen page ---------------- */
  async function bootStandalone() {
    document.body.style.background = '#0b0f14';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:14px;height:100vh;overflow:auto';
    document.body.appendChild(wrap);

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:14px';
    bar.innerHTML = `<b style="font-size:17px">🍽️ ${esc(State.settings.business_name || 'POS')} — KDS</b>
      <span id="kdsClock" style="color:var(--dim);font-size:13px"></span>
      <span style="flex:1"></span>
      <span id="kdsLive" style="font-size:12px;color:var(--dim)"><i></i> connecting…</span>
      <button class="btn sm ghost" id="kdsLogout">Sign out</button>`;
    wrap.appendChild(bar);
    const host = document.createElement('div');
    wrap.appendChild(host);

    const tick = () => {
      bar.querySelector('#kdsClock').textContent = new Date().toLocaleTimeString('en-KE');
    };
    tick(); setInterval(tick, 1000);

    try {
      await loadBootstrap();
    } catch {
      host.innerHTML = `<div class="ov" style="position:fixed"><div class="modal">
        <div class="modal-h"><h3>KDS sign in</h3></div>
        <div class="modal-b"><label class="fld">Staff PIN</label>
          <input class="inp" id="kp" type="password" inputmode="numeric" maxlength="6"></div>
        <div class="modal-f"><button class="btn primary" id="kg">Sign in</button></div></div></div>`;
      const go = async () => {
        try {
          await api('/api/login', { body: { pin: host.querySelector('#kp').value } });
          await loadBootstrap(); host.innerHTML = ''; bar.querySelector('#kdsLogout').classList.remove('hidden'); render(host);
        } catch (e) { toast(e.message, 'err'); }
      };
      host.querySelector('#kg').onclick = go;
      host.querySelector('#kp').onkeydown = (e) => { if (e.key === 'Enter') go(); };
      return;
    }

    bar.querySelector('#kdsLogout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
    render(host);
    connectEvents();
    setInterval(async () => { try { State.orders = await api('/api/orders'); render(host); } catch {} }, 20000);
    document.addEventListener('pos:update', () => render(host));
  }

  return { render, tickets, bootStandalone };
})();

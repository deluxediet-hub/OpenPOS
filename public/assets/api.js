/* api.js — shared client core: state, HTTP, formatting, UI primitives */
'use strict';

const State = {
  user: null,
  settings: {},
  categories: [],
  menu: [],
  tables: [],
  orders: [],
  users: [],
  stock: [],
  view: 'tables',
  openOrderId: null,
  area: 'All',
  category: null,
  es: null,
  online: true,
  /* Phase 2-4 working data, refreshed with the bootstrap */
  dayparts: [],
  activeDayparts: [],
  pricing: {},
  modifierGroups: [],
  modifierOptions: [],
  itemModifiers: [],
  shift: null,
  reservations: [],
  locations: [],
  customer: null
};

/* ------------------------------- HTTP --------------------------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

/* ---------------------------- formatting ------------------------------ */
const sym = () => State.settings.currency_symbol || 'KSh';
function fmt(cents) {
  const v = (Number(cents) || 0) / 100;
  return sym() + ' ' + v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const fmtShort = (cents) => {
  const v = (Number(cents) || 0) / 100;
  return v >= 1000 ? sym() + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : sym() + v.toFixed(0);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* Local date, not UTC — toISOString() would roll back a day after midnight EAT. */
const today = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ago = (iso) => {
  const ms = Date.now() - new Date(iso.replace(' ', 'T')).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
};
const mins = (iso) => Math.floor((Date.now() - new Date(iso.replace(' ', 'T')).getTime()) / 60000);
const clockTime = (iso) => iso ? iso.slice(11, 16) : '';

/* ------------------------------ toasts -------------------------------- */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = esc(msg);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

/* ------------------------------ modal --------------------------------- */
let modalCloser = null;
function modal({ title, body, footer, wide = false, onClose }) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'ov';
  ov.innerHTML = `<div class="modal${wide ? ' wide' : ''}">
    <div class="modal-h"><h3>${esc(title)}</h3><span class="grow"></span><button class="x" data-x>×</button></div>
    <div class="modal-b">${body}</div>
    ${footer ? `<div class="modal-f">${footer}</div>` : ''}
  </div>`;
  document.getElementById('modalRoot').appendChild(ov);
  modalCloser = () => { ov.remove(); modalCloser = null; onClose && onClose(); };
  ov.querySelector('[data-x]').onclick = closeModal;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  document.addEventListener('keydown', escClose);
  return ov;
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  if (modalCloser) modalCloser();
  document.removeEventListener('keydown', escClose);
}

function confirmBox(title, message, { okLabel = 'Confirm', danger = false, onOk, fields } = {}) {
  const fieldHtml = (fields || []).map((f) => `
    <div style="margin-bottom:12px"><label class="fld">${esc(f.label)}</label>
      ${f.type === 'select'
        ? `<select class="inp" data-f="${f.name}">${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`
        : `<input class="inp" data-f="${f.name}" type="${f.type || 'text'}" placeholder="${esc(f.placeholder || '')}">`}
    </div>`).join('');
  modal({
    title,
    body: `<p class="muted" style="margin:0 0 14px">${esc(message)}</p>${fieldHtml}`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'red' : 'primary'}" data-yes>${esc(okLabel)}</button>`
  });
  const ov = document.querySelector('#modalRoot .ov');
  ov.querySelector('[data-no]').onclick = closeModal;
  ov.querySelector('[data-yes]').onclick = () => {
    const vals = {};
    ov.querySelectorAll('[data-f]').forEach((i) => { vals[i.dataset.f] = i.value; });
    closeModal();
    onOk(vals);
  };
}

/* Manager gate: re-authenticate a manager PIN for sensitive actions */
function requireManagerPin(reason, onOk) {
  if (State.user && ['manager', 'admin'].includes(State.user.role)) return onOk({});
  modal({
    title: 'Manager authorisation',
    body: `<p class="muted" style="margin-top:0">${esc(reason)}</p>
      <label class="fld">Manager PIN</label>
      <input class="inp" id="mpin" type="password" inputmode="numeric" maxlength="6" autocomplete="off">
      <div id="mperr" style="color:var(--red);font-size:12px;margin-top:8px"></div>`,
    footer: `<button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>Authorise</button>`
  });
  const ov = document.querySelector('#modalRoot .ov');
  const inp = ov.querySelector('#mpin');
  setTimeout(() => inp.focus(), 40);
  const go = async () => {
    try {
      const r = await api('/api/login', { body: { pin: inp.value } });
      if (!['manager', 'admin'].includes(r.user.role)) throw new Error('That PIN is not a manager');
      closeModal();
      toast('Manager authorised', 'ok');
      onOk({ by: r.user });
    } catch (e) { ov.querySelector('#mperr').textContent = e.message; }
  };
  ov.querySelector('[data-yes]').onclick = go;
  inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  ov.querySelector('[data-no]').onclick = closeModal;
}

/* ---------------------------- realtime -------------------------------- */
function connectEvents() {
  if (State.es) State.es.close();
  const es = new EventSource('/api/events');
  State.es = es;
  const mark = (on) => {
    State.online = on;
    const el = document.getElementById('live');
    if (el) { el.classList.toggle('off', !on); el.querySelector('span').textContent = on ? 'Live' : 'Offline'; }
  };
  es.onopen = () => mark(true);
  es.onerror = () => mark(false);
  const refresh = async (ev) => {
    mark(true);
    try {
      if (ev === 'menu') State.menu = await api('/api/menu');
      if (ev === 'tables' || ev === 'orders' || ev === 'kitchen') {
        State.orders = await api('/api/orders');
        if (ev === 'tables') { /* tables list only changes via manager */ }
      }
      if (ev === 'users' || ev === 'settings' || ev === 'stock' || ev === 'sales') {
        await loadBootstrap();
        if (typeof updateScannerState === 'function') updateScannerState();
      }
      document.dispatchEvent(new CustomEvent('pos:update', { detail: { ev } }));
    } catch (e) { /* transient */ }
  };
  ['orders', 'kitchen', 'menu', 'tables', 'users', 'settings', 'sales', 'stock'].forEach((t) => es.addEventListener(t, () => refresh(t)));
}

async function loadBootstrap() {
  const b = await api('/api/bootstrap');
  Object.assign(State, {
    user: b.user, settings: b.settings, categories: b.categories,
    menu: b.menu, tables: b.tables, orders: b.orders, users: b.users, stock: b.stock || [],
    dayparts: b.dayparts || [], activeDayparts: b.active_dayparts || [], pricing: b.pricing || {},
    modifierGroups: b.modifier_groups || [], modifierOptions: b.modifier_options || [],
    itemModifiers: b.item_modifiers || [], shift: b.shift || null,
    reservations: b.reservations || [], locations: b.locations || []
  });
  return b;
}

/* --------------------------- order helpers ---------------------------- */
const orderTable = (o) => State.tables.find((t) => t.id === o.table_id);
/** Modifier groups attached to a menu item, with their options. */
const groupsFor = (itemId) => State.itemModifiers
  .filter((im) => im.menu_item_id === itemId)
  .map((im) => State.modifierGroups.find((g) => g.id === im.group_id))
  .filter(Boolean)
  .map((g) => ({ ...g, options: State.modifierOptions.filter((o) => o.group_id === g.id) }));
/** Live selling price for an item, honouring any active happy hour. */
const priceOf = (m) => (State.pricing[m.id] ? State.pricing[m.id].price : m.price);
const ruleFor = (m) => State.pricing[m.id] ? State.pricing[m.id].rule : null;
const orderLabel = (o) => { const t = orderTable(o); return t ? t.name : (State.settings.business_type === 'wines_spirits' ? 'Sale #' : 'Takeaway #') + o.number; };
const activeOrder = () => State.orders.find((o) => o.id === State.openOrderId);
function groupedSaleItems(items = []) {
  const grouped = [];
  for (const item of items) {
    const key = [item.menu_item_id, item.name, item.price, item.note || '', JSON.stringify(item.modifiers || [])].join('|');
    const existing = grouped.find((x) => x._groupKey === key);
    if (existing) existing.qty += Number(item.qty);
    else grouped.push({ ...item, qty: Number(item.qty), _groupKey: key });
  }
  return grouped;
}
const waiterName = (id) => (State.users.find((u) => u.id === id) || {}).name || '—';
const tableStatus = (tid) => {
  const o = State.orders.find((x) => x.table_id === tid && ['open', 'billed'].includes(x.status));
  return o ? o : null;
};

/* --------------------------- SVG icon set ----------------------------- */
const ICONS = {
  floor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/></svg>',
  cash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  chef: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 19h12v2H6z"/><path d="M6 17a5 5 0 0 1-1-9.9A4 4 0 0 1 12 4a4 4 0 0 1 7 3.1A5 5 0 0 1 18 17"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5h16M4 12h16M4 19h10"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M17 11a3 3 0 1 0-1.5-5.6M18 20a6 6 0 0 0-2.2-4.6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/></svg>'
};

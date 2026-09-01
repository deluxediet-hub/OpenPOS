/* app.js — login keypad, app shell, role-based navigation */
'use strict';

const NAV = {
  seller:    [['tables', 'Sale', 'floor'], ['bills', 'Receipts', 'cash'], ['manager', 'Operations', 'chart']],
  admin:     [['tables', 'Floor', 'floor'], ['bills', 'Bills', 'cash'], ['kds', 'Kitchen', 'chef'], ['manager', 'Manager', 'chart']],
  manager:   [['tables', 'Floor', 'floor'], ['bills', 'Bills', 'cash'], ['kds', 'Kitchen', 'chef'], ['manager', 'Manager', 'chart']],
  waiter:    [['tables', 'Floor', 'floor'], ['bills', 'Bills', 'cash'], ['kds', 'Kitchen', 'chef']],
  cashier:   [['bills', 'Bills', 'cash'], ['tables', 'Floor', 'floor'], ['kds', 'Kitchen', 'chef']],
  bartender: [['kds', 'Kitchen', 'chef'], ['tables', 'Floor', 'floor']],
  kitchen:   [['kds', 'Kitchen', 'chef']]
};
const HOME = { seller: 'tables', admin: 'manager', manager: 'manager', waiter: 'tables', cashier: 'bills', bartender: 'kds', kitchen: 'kds' };

let pin = '';
let loginTimer = null;
let clockTimer = null;
let scannerBuffer = '', scannerStarted = 0, scannerLast = 0, scannerBusy = false;

function updateScannerState() {
  const el = document.getElementById('scannerState');
  if (el) el.classList.toggle('hidden', State.settings.barcode_scanner_enabled !== '1');
}

/* Keyboard-wedge scanners type a barcode very quickly and finish with Enter.
   Normal typing in inputs/forms is left completely alone. */
function initGlobalScanner() {
  window.addEventListener('keydown', async (e) => {
    if (State.settings.barcode_scanner_enabled !== '1' || !State.user || scannerBusy) return;
    if (document.querySelector('#modalRoot .ov')) { scannerBuffer = ''; return; }
    const active = document.activeElement;
    if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) { scannerBuffer = ''; return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const now = performance.now();
    if (e.key === 'Enter') {
      const fast = scannerBuffer.length >= 4 && now - scannerLast < 180 && now - scannerStarted < scannerBuffer.length * 120 + 400;
      const code = scannerBuffer.trim(); scannerBuffer = ''; scannerStarted = scannerLast = 0;
      if (!fast) return;
      e.preventDefault(); e.stopPropagation(); scannerBusy = true;
      try { await Pos.scanItem(code); } finally { scannerBusy = false; }
      return;
    }
    if (e.key.length !== 1) return;
    if (!scannerLast || now - scannerLast > 140) { scannerBuffer = ''; scannerStarted = now; }
    scannerBuffer += e.key; scannerLast = now;
  }, true);
}

/* ------------------------------ login ------------------------------- */
function paintDots() {
  document.getElementById('pinDots').innerHTML =
    Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<span class="pin-dot${i < pin.length ? ' on' : ''}"></span>`).join('');
}
async function tryLogin() {
  clearTimeout(loginTimer);loginTimer=null;
  const err = document.getElementById('loginErr');
  err.textContent = '';
  try {
    const r = await api('/api/login', { body: { pin } });
    pin = ''; paintDots();
    await startApp(r.user);
  } catch (e) {
    err.textContent = e.message || 'Invalid PIN';
    pin = ''; paintDots();
    const card = document.querySelector('.login-card');
    card.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' },
      { transform: 'translateX(7px)' }, { transform: 'translateX(0)' }], { duration: 220 });
  }
}
function initLogin() {
  paintDots();
  document.getElementById('keypad').addEventListener('click', (e) => {
    const k = e.target.dataset.k;
    if (k === undefined) return;
    if (k === 'clear') pin = '';
    else if (k === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 6) pin += k;
    paintDots();
    clearTimeout(loginTimer);
    if (pin.length >= 4) loginTimer=setTimeout(() => { if (pin.length >= 4) tryLogin(); }, 700);
  });
  document.getElementById('loginSubmit').onclick=()=>{clearTimeout(loginTimer);if(pin)tryLogin();};
  window.addEventListener('keydown', (e) => {
    if (!document.getElementById('login').classList.contains('hidden')) {
      if (/^[0-9]$/.test(e.key) && pin.length < 6) { pin += e.key; paintDots();clearTimeout(loginTimer);if(pin.length>=4)loginTimer=setTimeout(tryLogin,700); }
      else if (e.key === 'Backspace') { clearTimeout(loginTimer);pin = pin.slice(0, -1); paintDots(); }
      else if (e.key === 'Enter' && pin) {clearTimeout(loginTimer);tryLogin();}
    }
  });
}

/* ------------------------------- shell ------------------------------ */
async function startApp(user) {
  State.user = user;
  /* Always pull the full catalogue — a fresh PIN login has no bootstrap data yet,
     and a returning session may be holding a stale menu or floor plan. */
  try { await loadBootstrap(); } catch (e) { toast('Could not load data: ' + e.message, 'err'); }
  updateScannerState();
  if (State.settings.business_type === 'wines_spirits' && State.settings.licence_expiry) {
    const days = Math.ceil((new Date(State.settings.licence_expiry + 'T23:59:59') - new Date()) / 86400000);
    if (days < 0) toast('Alcohol licence appears expired — owner action required', 'err');
    else if (days <= 30) toast(`Alcohol licence expires in ${days} day(s)`, 'err');
  }
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.title = `${State.settings.business_name || 'POS'} — ${user.name}`;
  buildRail();
  const retailSeller = State.settings.business_type === 'wines_spirits' && user.role === 'seller';
  const sellingOpen = State.shift && State.shift.status === 'open';
  State.view = retailSeller && !sellingOpen ? 'manager' : (HOME[user.role] || 'tables');
  if (retailSeller && !sellingOpen) Manager.tab = 'money';
  await navigate(State.view);
  if (retailSeller && !State.shift) toast('Open the till to begin today’s sales', 'err');
  else if (retailSeller && State.shift.status === 'reconciling') toast('Complete stocktake and reconcile Cash/M-Pesa to close the till', 'err');
  connectEvents();
  document.addEventListener('pos:update', onLiveUpdate);
  clearInterval(clockTimer);
  const tick = () => {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleString('en-KE',
      { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick(); clockTimer = setInterval(tick, 1000);
}

function buildRail() {
  const retailAdmin = State.settings.business_type === 'wines_spirits' && ['admin', 'manager'].includes(State.user.role);
  const items = retailAdmin
    ? [['tables', 'Sale', 'floor'], ['bills', 'Receipts', 'cash'], ['manager', 'Management', 'chart']]
    : (NAV[State.user.role] || NAV.waiter);
  const initials = State.user.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('rail').innerHTML = `
    <div class="rail-logo">🍾</div>
    ${items.map(([k, l, ic]) => `<button class="rail-btn" data-nav="${k}" title="${l}">
      ${ICONS[ic]}<span>${l}</span></button>`).join('')}
    <div class="rail-spacer"></div>
    <button class="rail-btn" id="logoutBtn" title="Sign out">${ICONS.logout}<span>Exit</span></button>
    <div class="rail-user"><span class="av">${initials}</span><span>${esc(State.user.name)}</span>
      <span style="color:var(--amber)">${State.user.role}</span></div>`;
  document.querySelectorAll('[data-nav]').forEach((b) => b.onclick = () => navigate(b.dataset.nav));
  document.getElementById('logoutBtn').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    location.reload();
  };
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === State.view));
}

const TITLES = {
  tables: ['New sale', 'Scan or tap products, then take payment'],
  bills: ['Receipts & payments', 'Cash · Card · M-Pesa'],
  kds: ['Kitchen & bar display', 'Live tickets'],
  manager: ['Shop management', 'Sales, products, stock and staff']
};

async function navigate(view) {
  State.view = view;
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  const host = document.getElementById('view');
  document.getElementById('viewTitle').textContent = TITLES[view][0];
  document.getElementById('viewSub').textContent = TITLES[view][1];
  host.innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (view === 'tables') {
      State.orders = await api('/api/orders');
      const retailSeller = State.settings.business_type === 'wines_spirits' && State.user.role === 'seller';
      if (retailSeller && State.shift?.status !== 'open') { Manager.tab = 'money'; return navigate('manager'); }
      if (retailSeller && State.shift?.status === 'open' && !State.openOrderId) {
        let sale = State.orders.find((o) => o.waiter_id === State.user.id && o.status === 'open' && !o.table_id);
        if (!sale) {
          sale = await api('/api/orders', { body: { people: 1 } });
          State.orders = await api('/api/orders');
        }
        return Pos.openEditor(host, sale.id);
      }
      if (State.openOrderId && State.orders.some((o) => o.id === State.openOrderId)) Pos.renderEditor(host);
      else { State.openOrderId = null; Pos.renderFloor(host); }
    } else if (view === 'bills') { State.orders = await api('/api/orders'); Cashier.renderBills(host); }
    else if (view === 'kds') { State.orders = await api('/api/orders'); KDS.render(host); }
    else if (view === 'manager') { State.orders = await api('/api/orders'); Manager.render(host); }
  } catch (e) {
    if (String(e.message).includes('Not signed in')) { location.reload(); return; }
    host.innerHTML = `<div class="empty">Could not load: ${esc(e.message)}</div>`;
  }
}

function onLiveUpdate(e) {
  const host = document.getElementById('view');
  if (!host || !State.user) return;
  const ev = e.detail.ev;
  const badge = () => {
    const btn = document.querySelector('[data-nav="kds"]');
    if (!btn) return;
    const n = KDS.tickets().length;
    btn.querySelector('.dot')?.remove();
    if (n && State.view !== 'kds') {
      const d = document.createElement('span');
      d.className = 'dot'; d.textContent = n;
      btn.appendChild(d);
    }
  };
  if (State.view === 'tables') {
    if (State.openOrderId && State.orders.some((o) => o.id === State.openOrderId)) Pos.renderEditor(host);
    else Pos.renderFloor(host);
  } else if (State.view === 'bills') Cashier.renderBills(host);
  else if (State.view === 'kds') KDS.render(host);
  else if (State.view === 'manager' && ['settings', 'users', 'menu'].includes(ev)) Manager.render(host);
  badge();
}

/* ------------------------------- boot ------------------------------- */
/* First-run onboarding: configure the business and create the owner account. */
function initSetup() {
  const f = document.getElementById('setupForm');
  if (!f) return;
  document.getElementById('suCsvTemplate').onclick = downloadProductCsvTemplate;
  const sample = document.getElementById('suSample'), csvInput = document.getElementById('suCsv');
  sample.onchange = () => { if (sample.checked) csvInput.value = ''; };
  csvInput.onchange = () => { if (csvInput.files.length) sample.checked = false; };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('setupErr');
    err.textContent = '';
    const pin = document.getElementById('suPin').value.trim();
    if (pin !== document.getElementById('suPin2').value.trim()) { err.textContent = 'The two PINs do not match.'; return; }
    try {
      const csvFile = document.getElementById('suCsv').files[0];
      const productCsv = csvFile ? await csvFile.text() : '';
      const r = await fetch('/api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business: {
            business_name: document.getElementById('suName').value,
            address: document.getElementById('suAddr').value,
            phone: document.getElementById('suPhone').value,
            kra_pin: document.getElementById('suKra').value,
            receipt_footer: document.getElementById('suFooter').value,
            currency: document.getElementById('suCur').value,
            currency_symbol: document.getElementById('suSym').value,
            vat_rate: document.getElementById('suVat').value,
            tax_mode: 'inclusive',
            service_charge_rate: document.getElementById('suSvc').value,
            service_charge_enabled: false, business_type: 'wines_spirits'
          },
          owner_name: document.getElementById('suOwner').value,
          owner_pin: pin,
          sample: document.getElementById('suSample').checked,
          product_csv: productCsv
        })
      });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.error || 'Setup failed'; return; }
      document.getElementById('setup').classList.add('hidden');
      document.getElementById('lgName').textContent = d.business_name || 'Point of Sale';
      document.getElementById('login').classList.remove('hidden');
      toast('Setup complete — sign in with your owner PIN.', 'ok');
    } catch (ex) { err.textContent = ex.message; }
  });
}

(async function boot() {
  initLogin();
  initSetup();
  initGlobalScanner();
  try {
    const me = await api('/api/me');
    await startApp(me.user);
  } catch {
    // not signed in — decide between onboarding and the login keypad
    const st = await fetch('/api/setup/status').then((r) => r.json()).catch(() => null);
    if (st && st.needs_setup) {
      document.getElementById('setup').classList.remove('hidden');
    } else {
      if (st && st.business_name) document.getElementById('lgName').textContent = st.business_name;
      document.getElementById('login').classList.remove('hidden');
    }
  }
})();

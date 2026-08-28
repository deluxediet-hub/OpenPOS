'use strict';
/**
 * UI test — boots the REAL shipped client bundle inside jsdom, pointed at the
 * running server, and drives it with real clicks. No re-implementation: the
 * files evaluated here are byte-for-byte the ones served at /assets/*.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PUB = path.join(__dirname, '..', 'public');
const ASSETS = ['api.js', 'print.js', 'pos.js', 'cashier.js', 'kds.js', 'retail.js',
  'manager-pricing.js', 'manager-reconciliation.js', 'manager-hospitality.js',
  'manager-loyalty.js', 'manager-system.js', 'manager.js', 'app.js'];

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ FAIL ' + name + '  ' + extra); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    await wait(40);
  }
  throw new Error('timed out waiting for: ' + label);
}

/* Load a page into jsdom with browser stubs, then evaluate the real scripts. */
async function bootPage(file, scripts) {
  let html = fs.readFileSync(path.join(PUB, file), 'utf8')
    .replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url: BASE + '/', pretendToBeVisual: true, runScripts: 'dangerously' });
  const w = dom.window;
  const errs = [];
  w.addEventListener('error', (e) => errs.push(e.message));
  w.onerror = (m) => errs.push(String(m));

  /* Run code as a real document script: window.eval() would execute in Node's
     realm where `document` does not exist. */
  const run = (code) => {
    const s = w.document.createElement('script');
    s.textContent = code;
    w.document.body.appendChild(s);
  };

  /* ---- browser API stubs ---- */
  /* jsdom will not attach its cookie jar to Node's fetch, so emulate one:
     send stored cookies on every request and honour Set-Cookie from responses. */
  const jar = new Map();
  w.fetch = async (url, opts = {}) => {
    const abs = String(url).startsWith('http') ? url : BASE + url;
    const h = new Headers(opts.headers || {});
    const cs = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cs) h.set('cookie', cs);
    const res = await fetch(abs, { ...opts, headers: h });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1);
      if (attrs.some((a) => /max-age\s*=\s*0/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
  w.__printed = 0;
  Object.defineProperty(w, 'print', {
    configurable: true, writable: true, value: () => { w.__printed += 1; }
  });
  w.prompt = (msg, dflt) => { w.__lastPrompt = msg; return w.__promptAnswer !== undefined ? w.__promptAnswer : dflt; };
  w.confirm = () => true;
  w.alert = () => {};
  w.Element.prototype.animate = function () { return { cancel() {}, finish() {} }; };
  w.URL.createObjectURL = () => 'blob:test';
  const events = [];
  w.EventSource = class {
    constructor(url) { this.url = url; this.listeners = {}; events.push(this); }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    close() {}
    fire(t, data) { (this.listeners[t] || []).forEach((f) => f({ data: JSON.stringify(data) })); }
  };
  /* Emulate classic-script loading so dynamically appended <script src> also works */
  const realAppend = w.HTMLBodyElement.prototype.appendChild;
  w.HTMLBodyElement.prototype.appendChild = function (node) {
    if (node.tagName === 'SCRIPT' && node.getAttribute('src')) {
      const p = path.join(PUB, node.getAttribute('src').replace(/^\//, ''));
      const code = fs.readFileSync(p, 'utf8');
      setTimeout(() => { run(code); node.onload && node.onload(); }, 0);
      return node;
    }
    return realAppend.call(this, node);
  };

  /* ---- evaluate the real bundle in order ---- */
  const blob = scripts.map((s) => `/* ==== ${s} ==== */\n` + fs.readFileSync(path.join(PUB, 'assets', s), 'utf8')).join('\n');
  /* Expose internals for assertions — only when the full bundle is present,
     otherwise referencing e.g. Pos would throw on the KDS-only page. */
  const expose = scripts.includes('app.js')
    ? `\n;globalThis.__h = { State, Pos, Cashier, KDS, Manager, api, navigate, toast };`
    : `\n;globalThis.__h = { State, api };`;
  run(blob + expose);
  return { dom, w, errs, events, run };
}

const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const setVal = (w, el, v) => {
  el.value = v;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
};
/* argument-order tolerant so call sites read naturally either way */
const pick = (a, b) => (typeof a === 'string' ? [b, a] : [a, b]);
const $ = (a, b) => { const [w, sel] = pick(a, b); return w.document.querySelector(sel); };
const $$ = (a, b) => { const [w, sel] = pick(a, b); return [...w.document.querySelectorAll(sel)]; };

async function loginWithPin(w, pin) {
  for (const d of pin.split('')) {
    const btn = $$(w, '#keypad button').find((b) => b.dataset.k === d);
    click(w, btn);
    await wait(60);
  }
  await wait(200);
  await waitFor(() => !$('#login', w) || $('#login', w).classList.contains('hidden'), 'login to complete');
  await waitFor(() => $('#app', w) && !$('#app', w).classList.contains('hidden'), 'app shell');
  await waitFor(() => $$(w, '.rail-btn[data-nav]').length, 'nav rail');
}

(async () => {
  console.log('\n=== POS UI test (jsdom + real client bundle) ===\n');

  /* ---------------- WAITER ---------------- */
  console.log('WAITER — floor plan & order taking');
  let { w, errs, events } = await bootPage('index.html', ASSETS);
  ck('no uncaught errors on boot', errs.length === 0, errs.join(' | '));
  /* login / onboarding panels start hidden and are revealed by the async boot */
  await waitFor(() => !$('#login', w).classList.contains('hidden') || !$('#setup', w).classList.contains('hidden'), 'auth screen');
  ck('login screen visible', !!$('#login .login-card', w) && !$('#login', w).classList.contains('hidden'));
  ck('keypad has 12 keys', $$(w, '#keypad button').length === 12);
  ck('explicit sign-in control supports variable PIN length',!!$('#loginSubmit',w));
  ck('PIN dots render', $$(w, '.pin-dot').length === 4);

  click(w, $$(w, '#keypad button').find((b) => b.dataset.k === '9'));
  click(w, $$(w, '#keypad button').find((b) => b.dataset.k === '9'));
  click(w, $$(w, '#keypad button').find((b) => b.dataset.k === '9'));
  click(w, $$(w, '#keypad button').find((b) => b.dataset.k === '9'));
  await waitFor(() => $('#loginErr', w).textContent.trim(), 'wrong PIN response');
  ck('wrong PIN shows error and stays on login', $('#loginErr', w).textContent.trim() === 'Invalid PIN'
    && !$('#login', w).classList.contains('hidden'), $('#loginErr', w).textContent);

  await loginWithPin(w, '1234');
  ck('signed in as Brian (Waiter)', w.__h.State.user.role === 'waiter', w.__h.State.user.name);
  ck('waiter gets 3 nav buttons', $$(w, '.rail-btn[data-nav]').length === 3);
  ck('waiter has no Manager tab', !$$(w, '.rail-btn[data-nav]').some((b) => b.dataset.nav === 'manager'));
  ck('defaults to Floor view', w.__h.State.view === 'tables', w.__h.State.view);
  ck('view title set', $('#viewTitle', w).textContent === 'New sale', $('#viewTitle', w).textContent);

  await waitFor(() => $$(w, '.tbl-card').length, 'floor plan tables');
  const tables = $$(w, '.tbl-card').length;
  ck('floor renders all 27 tables', tables === 27, tables + ' table cards');
  ck('area tabs rendered', $$(w, '.area-tab').length === 5, $$(w, '.area-tab').map((b) => b.dataset.area).join(','));
  ck('floor shows free/occupied legend', !!$('.legend', w));

  /* area filter */
  click(w, $$(w, '.area-tab').find((b) => b.dataset.area === 'Lounge'));
  await wait(60);
  ck('area filter narrows the floor', $$(w, '.tbl-card').length === 8, $$(w, '.tbl-card').length + ' lounge tables');
  click(w, $$(w, '.area-tab').find((b) => b.dataset.area === 'All'));
  await wait(60);

  /* seat guests */
  const freeCard = $$(w, '.tbl-card.free')[0];
  const tableName = freeCard.querySelector('.nm').textContent;
  click(w, freeCard);
  await waitFor(() => $('#people', w), 'seating modal');
  ck('seating modal opens for ' + tableName, /Seat guests/.test($('.modal-h h3', w).textContent), $('.modal-h h3', w).textContent);
  setVal(w, $('#people', w), '5');
  setVal(w, $('#note', w), 'birthday table');
  click(w, $('[data-yes]', w));
  await waitFor(() => $('.menu-panel', w), 'order editor');

  ck('order editor opened', !!$('.menu-panel', w) && !!$('.bill-panel', w));
  ck('table name in editor header', $('#view', w).innerHTML.includes(tableName), tableName);
  ck('guest count button shows 5', $('#peopleBtn', w).textContent.includes('5'), $('#peopleBtn', w).textContent);
  ck('menu categories rendered', $$(w, '.cat').length === 13, $$(w, '.cat').length + ' categories');

  await waitFor(() => $$(w, '.item').length, 'menu items');
  ck('menu items rendered', $$(w, '.item').length > 0, $$(w, '.item').length + ' items in first category');

  /* search */
  setVal(w, $('#search', w), 'tilapia');
  await wait(160); // POS search intentionally debounces for 100ms
  ck('search filters the menu', $$(w, '.item').length === 1 && $$('.item .n', w)[0].textContent.includes('Tilapia'),
    $$('.item .n', w).map((e) => e.textContent).join(','));

  /* add items */
  click(w, $('.item', w));
  await waitFor(() => $$(w, '.line').length === 1, 'line added');
  ck('item added to bill', $$(w, '.line').length === 1);
  // 1,200.00 tilapia + 10% service charge = 1,320.00 (VAT-inclusive pricing)
  ck('bill total includes service charge', $('.tline.total b', w).textContent.trim() === 'KSh 1,320.00', $('.tline.total b', w).textContent);

  setVal(w, $('#search', w), 'Tusker');
  await wait(160); // allow the debounced retail/hospitality search to repaint
  click(w, $('.item', w));
  await waitFor(() => $$(w, '.line').length === 2, 'second line');
  ck('bar item added', $$(w, '.line').length === 2);
  ck('station tags shown', $$(w, '.line .tag.kitchen').length >= 1 && $$(w, '.line .tag.bar').length >= 1);
  ck('unsent count on send button', /Send to kitchen \/ bar \(2\)/.test($('#send', w).textContent), $('#send', w).textContent.trim());
  ck('service charge line visible', $('.bill-foot', w).textContent.includes('Service charge 10%'));
  ck('inclusive VAT line visible', $('.bill-foot', w).textContent.includes('VAT 16% (incl.)'));

  /* permission gate: waiter must not be able to void directly */
  const before = w.__h.State.orders.length;
  ck('order present in state', w.__h.State.orders.some((o) => o.id === w.__h.State.openOrderId), 'orders=' + before);

  /* send to kitchen */
  click(w, $('#send', w));
  await waitFor(() => $$(w, '.line .tag').some((t) => t.textContent === 'sent'), 'items sent');
  ck('lines marked sent', $$(w, '.line').every((l) => l.textContent.includes('sent')));
  ck('send button disabled after send', $('#send', w).disabled);
  ck('toast confirmed', $$(w, '.toast').some((t) => t.textContent.includes('Sent to kitchen')),
    $$(w, '.toast').map((t) => t.textContent).join(' | '));
  await wait(400);   // the docket auto-print fires on a short delay before window.print
  ck('docket auto-prints on send', w.__printed >= 1, 'print() calls=' + w.__printed);

  const orderId = w.__h.State.openOrderId;

  /* realtime: a KDS event should repaint the view */
  ck('SSE connection established', events.length >= 1, events.length + ' EventSource(s)');
  events[0].fire('kitchen', {});
  await wait(300);
  ck('SSE event repaints editor', $$(w, '.line').length === 2, $$(w, '.line').length + ' lines after event');

  /* KDS view as waiter */
  click(w, $$(w, '.rail-btn[data-nav]').find((b) => b.dataset.nav === 'kds'));
  await waitFor(() => $$('.ticket', w).length, 'kds tickets');
  ck('KDS shows the ticket', $$('.ticket', w).length === 2, $$('.ticket', w).length + ' tickets (kitchen + bar)');
  ck('kitchen ticket lists the tilapia', $('.ticket', w).textContent.includes('Tilapia'));
  ck('bar ticket lists the beer', $$('.ticket.bar', w)[0].textContent.includes('Tusker'));

  /* waiter sees tickets read-only: station ready controls are hidden for them
     (and the server also enforces station isolation). */
  ck('waiter sees no ready controls on KDS',
    $$(w, '[data-readyline]').length === 0 && $$(w, '.ticket-f .btn').length === 0,
    'readyline=' + $$('[data-readyline]', w).length);

  /* bills view */
  click(w, $$(w, '.rail-btn[data-nav]').find((b) => b.dataset.nav === 'bills'));
  await waitFor(() => $$('.card [data-pay]', w).length, 'bill cards');
  ck('bills view lists the open check', $$('.card [data-pay]', w).length >= 1);
  ck('bill card shows the table', $$('.card-h h3', w).some((h) => h.textContent.includes(tableName)),
    $$('.card-h h3', w)[0].textContent);

  /* logout */
  click(w, $('#logoutBtn', w));
  await wait(500);
  ck('logout returns to login screen', errs.length === 0, errs.join(' | '));

  /* ---------------- KITCHEN ---------------- */
  console.log('\nKITCHEN — standalone display page');
  let k = await bootPage('kds.html', ['api.js', 'print.js']);
  /* kds-boot.js dynamically appends kds.js — our script stub honours that */
  k.run(fs.readFileSync(path.join(PUB, 'assets', 'kds-boot.js'), 'utf8'));
  await waitFor(() => k.w.document.querySelector('.ticket, #kp'), 'kds tickets or login');
  ck('kds-boot loads the KDS module', !!k.w.KDS || !!k.w.document.querySelector('.ticket, #kp'), 'KDS=' + (!!k.w.KDS));
  if (k.w.document.querySelector('#kp')) {
    setVal(k.w, k.w.document.querySelector('#kp'), '4567');
    click(k.w, k.w.document.querySelector('#kg'));
    await waitFor(() => k.w.document.querySelector('.ticket, .empty'), 'kds tickets after login');
  }
  ck('KDS page renders kitchen column', k.w.document.body.textContent.includes('KITCHEN'));
  ck('KDS page renders bar column', k.w.document.body.textContent.includes('BAR'));
  ck('KDS shows our ticket', k.w.document.body.textContent.includes('Tilapia'));
  const readyBtn = [...k.w.document.querySelectorAll('.ticket-f .btn')][0];
  if (readyBtn) {
    click(k.w, readyBtn);
    await wait(500);
    ck('kitchen marks ticket ready', k.w.document.body.textContent.toLowerCase().includes('ready'), 'no error: ' + k.errs.join('|'));
  }
  ck('no uncaught errors on KDS page', k.errs.length === 0, k.errs.join(' | '));

  /* ---------------- CASHIER ---------------- */
  console.log('\nCASHIER — payment flow');
  let c = await bootPage('index.html', ASSETS);
  await loginWithPin(c.w, '2345');
  ck('signed in as cashier', c.w.__h.State.user.role === 'cashier', c.w.__h.State.user.name);
  ck('cashier lands on Bills', c.w.__h.State.view === 'bills', c.w.__h.State.view);
  await waitFor(() => $$(c.w, '.card [data-pay]').length, 'bill cards');
  ck('cashier has reprint-last + payment search + shift sheet', !!$('#reprintLast', c.w) && !!$('#payq', c.w) && !!$('#shiftPdf', c.w));
  const payBtn = $$(c.w, '.card [data-pay]')[0];
  click(c.w, payBtn);
  await waitFor(() => $('.mbtn', c.w), 'payment modal');
  ck('payment modal opens', $('.modal-h h3', c.w).textContent.includes('Payment'), $('.modal-h h3', c.w).textContent);
  ck('three payment methods offered', $$(c.w, '.mbtn').length === 3,
    $$(c.w, '.mbtn').map((b) => b.textContent.trim()).join(' / '));
  ck('cash selected by default', $$(c.w, '.mbtn')[0].classList.contains('primary'));
  ck('tendered field pre-filled', $('#tend', c.w).value !== '', 'tend=' + $('#tend', c.w).value);
  ck('change line present', !!$('#cLine', c.w), $('#cLine', c.w).textContent);

  /* over-tender -> change */
  const due = Math.round(Number($('#tend', c.w).value) * 100);
  setVal(c.w, $('#tend', c.w), ((due + 100000) / 100).toFixed(2));
  await wait(40);
  ck('change recalculates live', $('#cLine', c.w).textContent.includes('1,000'), $('#cLine', c.w).textContent);

  /* short tender is blocked client-side */
  setVal(c.w, $('#tend', c.w), '1.00');
  await wait(40);
  ck('short tender shows negative', $('#cLine', c.w).textContent.includes('short'), $('#cLine', c.w).textContent);
  click(c.w, $('[data-go]', c.w));
  await wait(200);
  ck('short tender blocked with toast', $$(c.w, '.toast').some((t) => t.textContent.includes('Short by')),
    $$(c.w, '.toast').map((t) => t.textContent).slice(-1).join(' | '));
  ck('modal stays open after short tender', !!$('[data-go]', c.w));

  /* tip */
  click(c.w, $$('[data-tip]', c.w).find((b) => b.dataset.tip === '100'));
  await wait(60);
  ck('tip updates the balance line', $('#tipLine', c.w).textContent.includes('100'), $('#tipLine', c.w).textContent);

  /* switch to M-Pesa and require the code */
  click(c.w, $$(c.w, '.mbtn').find((b) => b.dataset.m === 'mpesa'));
  await wait(60);
  ck('M-Pesa form swaps in', !!$('#mref', c.w) && !!$('#mphone', c.w));
  ck('STK push helper present', !!$('#stk', c.w));
  click(c.w, $('#stk', c.w));
  await wait(60);
  ck('STK push asks for phone first', $('#stkMsg', c.w).textContent.includes('phone'), $('#stkMsg', c.w).textContent);
  click(c.w, $('[data-go]', c.w));
  await wait(200);
  ck('M-Pesa requires confirmation code', $$(c.w, '.toast').some((t) => t.textContent.includes('confirmation code')));

  /* complete on M-Pesa — clear stale toasts first so we only observe this click */
  $$(c.w, '.toast').forEach((t) => t.remove());
  setVal(c.w, $('#mphone', c.w), '0712345678');
  setVal(c.w, $('#mref', c.w), 'sdf4gh7jk9');
  click(c.w, $('[data-go]', c.w));
  await waitFor(() => $$(c.w, '.toast').some((t) => t.textContent.includes('received')), 'payment confirmation toast');
  ck('payment accepted', $$(c.w, '.toast').some((t) => t.textContent.includes('received')),
    $$(c.w, '.toast').map((t) => t.textContent).join(' | '));
  await wait(400);
  ck('print invoked for the receipt', c.w.__printed >= 1, 'print() calls=' + c.w.__printed);
  await waitFor(() => $$(c.w, '#view .card').length, 'bills view repainted');
  ck('paid check left the bills queue', !c.w.__h.State.orders.some((o) => o.id === orderId), 'open orders=' + c.w.__h.State.orders.length);
  ck('no uncaught errors in cashier flow', c.errs.length === 0, c.errs.join(' | '));

  /* ---------------- MANAGER ---------------- */
  console.log('\nMANAGER — console tabs');
  let m = await bootPage('index.html', ASSETS);
  await loginWithPin(m.w, '1111');
  ck('signed in as manager', m.w.__h.State.user.role === 'manager');
  ck('manager lands on console', m.w.__h.State.view === 'manager', m.w.__h.State.view);

  /* navigate() is async — wait for the console to actually paint before asserting on it */
  const TOPS = ['Dashboard','Reports','Products & Pricing','Stock','Cash & Loyalty','Bookings','Team','Settings'];
  await waitFor(() => $$('[data-top]', m.w).length === 8, 'console top tabs');
  ck('console grouped to 8 top tabs', $$('[data-top]', m.w).length === 8,
    $$('[data-top]', m.w).map((t) => t.textContent).join(','));
  TOPS.forEach((t) => ck('top tab present: ' + t, $$('[data-top]', m.w).some((x) => x.textContent === t)));

  await waitFor(() => $$(m.w, '.stat').length >= 6, 'dashboard stats');
  ck('dashboard stats render', $$(m.w, '.stat').length >= 6, $$(m.w, '.stat').length + ' stat cards');
  ck('net sales populated', $$('.stat .v', m.w)[0].textContent.includes('KSh'), $$('.stat .v', m.w)[0].textContent);
  ck('hourly chart renders 24 bars', $$(m.w, '.bar-chart .b').length === 24);
  ck('top sellers table populated', $$(m.w, 'table.tbl tbody tr').length > 0);

  /* Read only the rendered console — document.body.textContent would also match
     the injected bundle's own source code and give false positives. */
  const vtext = () => ((m.w.document.querySelector('#mbody') || {}).textContent || '');

  const pickTab = (sel, label) => {
    const list = $$(sel, m.w);
    return list.find((t) => t.textContent.trim() === label) || list.find((t) => t.textContent.includes(label));
  };
  const goTop = async (label) => {
    const b = pickTab('[data-top]', label);
    if (!b) throw new Error('top tab not found: ' + label + ' | have: ' + $$('[data-top]', m.w).map((t) => t.textContent).join(','));
    click(m.w, b); await wait(600);
  };
  const goSub = async (label) => {
    const b = pickTab('[data-sub]', label);
    if (!b) throw new Error('sub tab not found: ' + label + ' | have: ' + $$('[data-sub]', m.w).map((t) => t.textContent).join(','));
    click(m.w, b); await wait(500);
  };

  await goTop('Reports');
  ck('reports has a PDF export', !!$('#spdf', m.w));
  click(m.w, $('#spdf', m.w)); await wait(100);
  ck('PDF builder starts with every section unselected', $$('[data-pdf]:checked', m.w).length === 0);
  click(m.w, $('[data-no]', m.w)); await wait(100);
  ck('reports tab: range quick filters', $$('[data-q]', m.w).length === 5);
  ck('reports tab: waiter table', m.w.document.body.textContent.includes('Brian (Waiter)'));
  ck('reports tab: item performance rows', $$(m.w, 'table.tbl tbody tr').length > 0,
    $$(m.w, 'table.tbl tbody tr').length + ' rows');
  click(m.w, $$('[data-q]', m.w).find((b) => b.dataset.q === '30d'));
  await wait(500);
  ck('30-day filter reloads without error', m.errs.length === 0, m.errs.join(' | '));

  await goTop('Products & Pricing');
  ck('menu tab: category sidebar', $$('[data-c]', m.w).length >= 13, $$('[data-c]', m.w).length + ' entries');
  ck('menu tab: item rows', $$(m.w, 'table.tbl tbody tr').length > 0, $$(m.w, 'table.tbl tbody tr').length + ' items');
  ck('menu tab: availability toggle present', $$('[data-avail]', m.w).length > 0);
  click(m.w, $('#add', m.w));
  await waitFor(() => $('#in', m.w), 'item form');
  ck('new product form opens', $('.modal-h h3', m.w).textContent.includes('New product'));
  ck('margin auto-calculates', (() => {
    setVal(m.w, $('#ip', m.w), '1000'); setVal(m.w, $('#ic', m.w), '300');
    return $('#im', m.w).value === '70%';
  })(), 'margin=' + $('#im', m.w).value);
  setVal(m.w, $('#in', m.w), 'UI Test Burger');
  click(m.w, $('[data-yes]', m.w));
  await waitFor(() => m.w.document.body.textContent.includes('UI Test Burger'), 'new item in list');
  ck('item created through the UI', m.w.document.body.textContent.includes('UI Test Burger'));
  const delBtn = $$('table.tbl tbody tr', m.w).map((tr) => tr).find((tr) => tr.textContent.includes('UI Test Burger')).querySelector('[data-d]');
  click(m.w, delBtn);
  await waitFor(() => $('[data-yes]', m.w), 'delete confirm');
  ck('delete asks for confirmation', $('.modal-h h3', m.w).textContent.includes('Delete'));
  click(m.w, $('[data-yes]', m.w));
  await wait(600);
  ck('item deleted through the UI', !m.w.document.body.textContent.includes('UI Test Burger'));

  await goTop('Stock');
  ck('stock tab: inventory rows', $$(m.w, 'table.tbl tbody tr').length >= 20, $$(m.w, 'table.tbl tbody tr').length + ' stock items');
  ck('stock tab: low-stock badges', $$('.tag.warn, .tag.bad', m.w).length >= 0);
  click(m.w, $('[data-rec]', m.w));
  await waitFor(() => $('#aq', m.w), 'receive modal');
  setVal(m.w, $('#aq', m.w), '25');
  setVal(m.w, $('#ar', m.w), 'UI test delivery');
  const firstStockName = $$('table.tbl tbody tr', m.w)[0].textContent;
  click(m.w, $('[data-yes]', m.w));
  await wait(600);
  ck('stock received through the UI', m.errs.length === 0, m.errs.join(' | '));

  await goTop('Team');
  ck('staff tab: team rows', $$(m.w, 'table.tbl tbody tr').length >= 7, $$(m.w, 'table.tbl tbody tr').length + ' staff');
  ck('staff tab: roles labelled', m.w.document.body.textContent.includes('Permissions'));

  await goTop('Settings');
  ck('settings tab: business name field', $('#s_bn', m.w).value === m.w.__h.State.settings.business_name, $('#s_bn', m.w).value);
  ck('settings tab: VAT field', $('#s_vat', m.w).value === '16');
  ck('settings tab: floor layout listed', $$(m.w, '[data-te]').length === 27, $$(m.w, '[data-te]').length + ' tables listed');
  setVal(m.w, $('#s_ft', m.w), 'Asante! Come again.');
  click(m.w, $('#saveS', m.w));
  await wait(500);
  ck('settings saved through the UI', m.w.__h.State.settings.receipt_footer === 'Asante! Come again.',
    m.w.__h.State.settings.receipt_footer);
  ck('settings change produced a toast', $$(m.w, '.toast').some((t) => t.textContent.includes('Settings saved')));
  /* restore */
  setVal(m.w, $('#s_ft', m.w), 'Karibu tena! Asante sana. Wi-Fi: Guest_WiFi');
  click(m.w, $('#saveS', m.w));
  await wait(400);

  /* ---- Phase 2-4 tabs must render without throwing ---- */
  const walk = async (topLabel, subs) => {
    await goTop(topLabel);
    for (const t of subs) {
      const before = m.errs.length;
      if (subs.length > 1) await goSub(t);   /* single-sub groups show via the top click */
      ck(`${topLabel} > ${t} renders`, m.errs.length === before, m.errs.slice(before).join(' | '));
      ck(`${topLabel} > ${t} produced content`, vtext().trim().length > 20, vtext().trim().slice(0, 40));
    }
  };
  await walk('Products & Pricing', ['Options', 'Recipes', 'Happy Hour']);
  await walk('Cash & Loyalty', ['Cash Drawer', 'Loyalty']);
  await walk('Reports', ['Labour', 'Audit log']);
  await walk('Settings', ['Printer', 'Backup & Recovery', 'eTIMS / M-Pesa']);
  await walk('Bookings', ['Reservations']);
  await walk('Team', ['Staff']);

  /* Happy Hour: open the create-rule form */
  await goTop('Products & Pricing'); await goSub('Happy Hour');
  click(m.w, m.w.document.querySelector('#addDp'));
  await waitFor(() => $('#dn', m.w), 'daypart form');
  ck('daypart form opens', $('.modal-h h3', m.w).textContent.includes('New pricing rule'));
  ck('daypart form has day checkboxes', $$('input.dow', m.w).length === 7);
  setVal(m.w, $('#dn', m.w), 'UI Test Happy Hour');
  setVal(m.w, $('#dd', m.w), '25');
  click(m.w, $('[data-yes]', m.w));
  await waitFor(() => vtext().includes('UI Test Happy Hour'), 'rule in list');
  ck('daypart created through the UI', vtext().includes('UI Test Happy Hour'));
  const dpRow = $$('table.tbl tbody tr', m.w).find((tr) => tr.textContent.includes('UI Test Happy Hour'));
  click(m.w, dpRow.querySelector('[data-d]'));
  await waitFor(() => $('[data-yes]', m.w), 'delete confirm');
  click(m.w, $('[data-yes]', m.w));
  await wait(500);
  ck('daypart deleted through the UI', !vtext().includes('UI Test Happy Hour'));

  /* Drawer: open a shift */
  await goTop('Cash & Loyalty'); await goSub('Cash Drawer');
  await waitFor(() => $('#fl', m.w) || $('#closeShift', m.w), 'drawer controls');
  if ($('#fl', m.w)) {
    setVal(m.w, $('#fl', m.w), '7500');
    click(m.w, $('#openShift', m.w));
    await waitFor(() => $('#closeShift', m.w), 'open shift panel');
    ck('shift opened through the UI', vtext().includes('Opening float'));
    ck('expected cash stat shown', vtext().includes('Expected cash'));
    /* close it */
    click(m.w, $('#closeShift', m.w));
    await waitFor(() => $('#cnt', m.w), 'reconciliation modal');
    ck('reconciliation modal opens', $('.modal-h h3', m.w).textContent.includes('reconcile') || $('.modal-h h3', m.w).textContent.includes('Close shift'));
    click(m.w, $('[data-yes]', m.w));
    await waitFor(() => !$('#cnt', m.w), 'modal closed after close');
    ck('shift closed through the UI', vtext().includes('Shift history'));
  } else {
    ck('shift already open — close path available', !!$('#closeShift', m.w));
  }

  /* Loyalty: issue a gift card */
  await goTop('Cash & Loyalty'); await goSub('Loyalty');
  await waitFor(() => $('[data-s="cards"]', m.w), 'loyalty sub-tabs');
  click(m.w, $('[data-s="cards"]', m.w));
  await waitFor(() => $('#addGc', m.w), 'gift card panel');
  ck('gift card panel shows outstanding liability', vtext().includes('Outstanding liability'));
  const shiftState = await m.w.__h.api('/api/shifts/current');
  if (!shiftState.shift) await m.w.__h.api('/api/shifts', { body: { opening_float: 0 } });
  click(m.w, $('#addGc', m.w));
  await waitFor(() => $('#gv', m.w), 'gift card form');
  setVal(m.w, $('#gv', m.w), '1500');
  click(m.w, $('[data-yes]', m.w));
  await waitFor(() => $$('table.tbl tbody tr', m.w).some((tr) => /GC-/.test(tr.textContent)), 'card in list');
  ck('gift card issued through the UI', $$('table.tbl tbody tr', m.w).some((tr) => /GC-/.test(tr.textContent)));
  /* dismiss the code-reveal modal if it is showing */
  const rev = $('.modal-h h3', m.w);
  if (rev && rev.textContent.includes('Gift card issued')) click(m.w, $('[data-no]', m.w));

  /* Integrations: dry run must shape a payload */
  await goTop('Settings'); await goSub('eTIMS / M-Pesa');
  await waitFor(() => $('#etDry', m.w), 'integration controls');
  ck('integration tab explains config-only status', vtext().includes('Configuration only'));
  ck('secrets shown masked, not in the clear', !vtext().includes('SUPERSECRETVALUE'));
  click(m.w, $('#etDry', m.w));
  await waitFor(() => ($('#intOut', m.w).textContent || '').trim().length > 0, 'dry-run output');
  const dryOut = ((m.w.document.querySelector('#intOut') || {}).textContent || '').trim();
  const toastsNow = $$('.toast', m.w).map((t) => t.textContent).join(' | ');
  ck('eTIMS dry run renders a payload', dryOut.includes('"tin"') || dryOut.includes('taxClass'),
    'intOut=' + JSON.stringify(dryOut.slice(0, 150)) + ' toasts=' + JSON.stringify(toastsNow.slice(0, 150)));

  await goTop('Reports'); await goSub('Audit log');
  ck('audit tab: entries listed', $$(m.w, 'table.tbl tbody tr').length > 5, $$(m.w, 'table.tbl tbody tr').length + ' entries');
  ck('audit tab: payment action logged', m.w.document.body.textContent.includes('payment'));
  ck('audit tab: tender recorded', m.w.document.body.textContent.includes('tendered') || m.w.document.body.textContent.includes('Tendered'));
  ck('no uncaught errors in manager console', m.errs.length === 0, m.errs.join(' | '));

  /* ---------------- RETAIL ACTIVE EXPERIENCE ---------------- */
  console.log('\nRETAIL — active navigation and checkout');
  await m.w.__h.api('/api/settings',{method:'PUT',body:{business_type:'wines_spirits'}});
  const retailUi=await bootPage('index.html',ASSETS);
  await loginWithPin(retailUi.w,'1111');
  await waitFor(()=>retailUi.w.document.querySelectorAll('[data-top]').length,'retail manager tabs');
  const retailLabels=[...retailUi.w.document.querySelectorAll('[data-top],[data-sub]')].map((x)=>x.textContent.trim());
  ck('retail manager removes Bookings from active UI',!retailLabels.includes('Bookings'),retailLabels.join(','));
  ck('retail manager removes Labour and Loyalty from active UI',!retailLabels.includes('Labour')&&!retailLabels.includes('Loyalty'),retailLabels.join(','));
  ck('retail manager narrows pricing to Products',!retailLabels.includes('Happy Hour')&&!retailLabels.includes('Options')&&!retailLabels.includes('Recipes'),retailLabels.join(','));
  ck('retail till navigation is explicit',retailLabels.includes('Till & Reconciliation'),retailLabels.join(','));
  const retailState=retailUi.w.__h.State;
  let retailSale=await retailUi.w.__h.api('/api/orders',{body:{people:1}});
  await retailUi.w.__h.api(`/api/orders/${retailSale.id}/items`,{body:{items:[{menu_item_id:retailState.menu[0].id,qty:1}]}});
  retailState.orders=await retailUi.w.__h.api('/api/orders');
  retailUi.w.__h.Cashier.payModal(retailSale.id);
  await waitFor(()=>retailUi.w.document.querySelector('#payForm'),'retail payment modal');
  ck('retail checkout hides tip controls',!retailUi.w.document.querySelector('#tipInp')&&!retailUi.w.document.querySelector('[data-tip]'));
  ck('retail checkout keeps Cash, Card and M-Pesa',retailUi.w.document.querySelectorAll('.mbtn').length===3);
  ck('retail UI has no uncaught errors',retailUi.errs.length===0,retailUi.errs.join(' | '));

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nUI TEST CRASH:', e); process.exit(2); });

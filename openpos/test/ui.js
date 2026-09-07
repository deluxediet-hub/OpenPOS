'use strict';
// ---------------------------------------------------------------------------
// ui.js — browser smoke test. Boots the REAL shipped pages inside jsdom against
// a running server and drives them with clicks. The files evaluated here are
// byte-for-byte the ones the shop serves.
//
// Focus: the Phase 18 module framework — an industry panel, its own strings and
// its product fields must appear in the shell with no page knowing about them.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUB = path.join(__dirname, '..', 'public');
const MODDIR = path.join(__dirname, '..', 'modules');

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v = null;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    await wait(50);
  }
  throw new Error('timed out waiting for: ' + label);
}

(async () => {
  // ---------------- server on a temp database ----------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openpos-ui-'));
  process.env.OPENPOS_DB = path.join(tmp, 'ui.db');
  process.env.OPENPOS_DATA_DIR = tmp;
  const dbm = require('../db');
  const d = dbm.open();
  const { createApp } = require('../server');
  const server = createApp(d).listen(0);
  await new Promise((r) => server.once('listening', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  // A wines & spirits shop, so its industry module switches itself on.
  const setup = await fetch(BASE + '/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      business: { name: 'Baraka Wines', trade: 'spirits' },
      owner: { name: 'Achieng', pin: '1234' },
      sample: true
    })
  });
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];

  // Phase 24: the shop switches promotions + loyalty on, so the Marketing tab
  // appears the way it would for a shop that asked for it.
  // Phase 26: the shopfront needs an item that is unmistakably its own.
  for (const body of [
    { name: 'P26 Store Tea', sku: 'P26TEA', cost: 100, price: 150 }
  ]) {
    const r = await fetch(BASE + '/api/products', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body)
    });
    const p = await r.json();
    await fetch(BASE + '/api/stock/moves', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ product_id: p.id, qty: 4, type: 'opening', reason: 'opening', unit_cost: 100 })
    });
  }

  for (const capability of ['promotions', 'loyalty', 'comms', 'store']) {
    const r = await fetch(BASE + '/api/capabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ capability, enabled: true })
    });
    if (!r.ok) console.log(`  (could not enable ${capability}: ${r.status})`);
  }

  // ---------------- boot a page ----------------
  async function bootPage(file) {
    const raw = fs.readFileSync(path.join(PUB, file), 'utf8');
    // Inline blocks are captured and replayed manually (jsdom would otherwise
    // run them at parse time, before our fetch/cookie stubs exist).
    const inlineBlocks = [...raw.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const html = raw.replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { url: BASE + '/', pretendToBeVisual: true, runScripts: 'dangerously' });
    const w = dom.window;
    const errs = [];
    w.addEventListener('error', (e) => errs.push(e.message));
    w.onerror = (m) => errs.push(String(m));

    const run = (code, label) => {
      const s = w.document.createElement('script');
      s.textContent = code;
      w.document.body.appendChild(s);
      return label;
    };

    // jsdom will not attach its cookie jar to fetch — emulate one.
    let jar = cookie;
    w.fetch = async (url, opts = {}) => {
      const abs = String(url).startsWith('http') ? url : BASE + url;
      const h = new Headers(opts.headers || {});
      if (jar) h.set('cookie', jar);
      const res = await fetch(abs, { ...opts, headers: h });
      const sc = res.headers.get('set-cookie');
      if (sc) jar = sc.split(';')[0];
      return res;
    };
    w.confirm = () => true;
    w.alert = () => {};
    w.print = () => {};
    w.Element.prototype.animate = function () { return { cancel() {}, finish() {} }; };
    w.HTMLElement.prototype.scrollTo = () => {};
    w.scrollTo = () => {};

    // Emulate classic <script src> loading for both head and body appends.
    const resolve = (src) => {
      if (src.startsWith('/modules/')) return path.join(MODDIR, 'ui', src.replace('/modules/', ''));
      return path.join(PUB, src.replace(/^\//, ''));
    };
    const patch = (proto) => {
      const real = proto.appendChild;
      proto.appendChild = function (node) {
        if (node && node.tagName === 'SCRIPT' && node.getAttribute('src')) {
          const p = resolve(node.getAttribute('src'));
          setTimeout(() => {
            try { run(fs.readFileSync(p, 'utf8'), node.getAttribute('src')); } catch (e) { errs.push(String(e.message)); }
            if (node.onload) node.onload();
          }, 0);
          return node;
        }
        return real.call(this, node);
      };
    };
    patch(w.HTMLBodyElement.prototype);
    patch(w.HTMLHeadElement.prototype);

    run(fs.readFileSync(path.join(PUB, 'assets', 'app.js'), 'utf8'), 'app.js');
    run(inlineBlocks.join('\n'), 'inline');
    return { dom, w, errs, run };
  }

  const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  console.log('\nUI smoke — the shell mounts what the modules declare (Phase 18)');

  // ---------------- till page (booted first: the manager checks reference it) ----
  const pos0 = await bootPage('pos.html');
  await waitFor(() => pos0.w.document.querySelector('#p-main') && !pos0.w.document.querySelector('#p-main').classList.contains('hidden'), 'till booted');

  // ---------------- manager page ----------------
  const mgr = await bootPage('manager.html');
  const mw = mgr.w;
  try {
    await waitFor(() => mw.document.querySelectorAll('#tabs button').length > 0, 'manager tabs');

    const tabNames = [...mw.document.querySelectorAll('#tabs button')].map((b) => b.textContent.trim());
    ck('the industry module adds its own tab to the shell',
      tabNames.some((n) => /Wines & Spirits/.test(n)), tabNames.join(' | '));

    // The module's own EN string, shipped by the module.
    const panelTab = [...mw.document.querySelectorAll('#tabs button')].find((b) => /Wines & Spirits/.test(b.textContent));
    click(mw, panelTab);
    await waitFor(() => {
      const sec = mw.document.querySelector('#tab-module-spirits-panel');
      return sec && !sec.classList.contains('hidden') && sec.textContent.includes('Premium lines');
    }, 'module panel rendered');
    ck('clicking it renders the module panel (its own strings, its own report)', true);

    // Hook 1 — product fields: the module's product-level field is in the form,
    // and its variant-level fields are left to the variant (not shoehorned in).
    const mf = mw.document.querySelector('#p-modfields');
    ck('module product fields render in the product form',
      mf && /Premium line/i.test(mf.textContent), mf ? mf.textContent.slice(0, 80) : 'no #p-modfields');
    ck('the field is a real input the shop can fill', !!mf && !!mf.querySelector('[data-mf="premium"]'));
    ck('variant-level module fields are not forced into the product form',
      mf && !/Bottle size/i.test(mf.textContent), mf ? mf.textContent.slice(0, 80) : '');

    // The panel's report call reached the server (no 404/403 in the console).
    // ---------------- Phase 24: offers, campaigns & loyalty ------------------
    const mktTab = [...mw.document.querySelectorAll('#tabs button')].find((b) => /Marketing/i.test(b.textContent));
    ck('the Marketing tab appears when the promotions capability is on', !!mktTab,
      [...mw.document.querySelectorAll('#tabs button')].map((b) => b.textContent.trim()).join(' | '));
    if (mktTab) {
      click(mw, mktTab);
      await waitFor(() => mw.document.querySelector('#mk-rows') && mw.document.querySelector('#mk-rows').textContent.trim(), 'offers table');
      ck('the offers screen explains itself before there is anything in it',
        /no offers yet/.test(mw.document.querySelector('#mk-rows').textContent));
      // create one offer the way a shopkeeper would
      click(mw, mw.document.querySelector('#mk-new-btn'));
      mw.document.querySelector('#mk-name').value = 'UI Offer 10%';
      mw.document.querySelector('#mk-type').value = 'pct';
      mw.document.querySelector('#mk-value').value = '10';
      click(mw, mw.document.querySelector('#mk-save'));
      await waitFor(() => /UI Offer 10%/.test(mw.document.querySelector('#mk-rows').textContent), 'the new offer row', 15000);
      ck('an offer created on the screen shows up in the list', true);
      ck('segments are counted on the screen',
        /Every customer/.test(mw.document.querySelector('#mk-seg-rows').textContent),
        mw.document.querySelector('#mk-seg-rows').textContent.slice(0, 80));
      // the till shows the offer and the customer's points
      ck('the till has a place for offers and points',
        !!pos0.w.document.querySelector('#p-offers') && !!pos0.w.document.querySelector('#p-points'));

      // ---------------- Phase 27: the kit is data, swapped on screen ----------
      const settingsTab = [...mw.document.querySelectorAll('#tabs button')].find((b) => /settings/i.test(b.textContent));
      click(mw, settingsTab);
      await waitFor(() => {
        const rows = mw.document.querySelector('#dev-rows');
        return rows && rows.textContent.trim().length > 0;
      }, 'the devices card rendered its rows', 15000);
      ck('the devices card says what it is for',
        /replaceable, not proprietary/.test(mw.document.querySelector('#st-dev-card').textContent)
        && mw.document.querySelector('#dev-rows').textContent.trim().length > 0,
        mw.document.querySelector('#dev-rows').textContent.slice(0, 80));
      mw.document.querySelector('#dev-name').value = 'Counter printer';
      mw.document.querySelector('#dev-type').value = 'printer';
      mw.document.querySelector('#dev-driver').value = 'escpos';
      click(mw, mw.document.querySelector('#dev-add'));
      await waitFor(() => /Counter printer/.test(mw.document.querySelector('#dev-rows').textContent), 'the new device row', 15000);
      ck('a device added on screen joins the list', true);
      ck('its profile is shown, not just its name',
        /80mm|48 cols/.test(mw.document.querySelector('#dev-rows').textContent),
        mw.document.querySelector('#dev-rows').textContent.slice(0, 160));
      const testBtn = mw.document.querySelector('#dev-rows [data-dev-test]');
      click(mw, testBtn);
      await waitFor(() => /ok|rendered/.test(mw.document.querySelector('#dev-msg').textContent)
        || /untested/.test(mw.document.querySelector('#dev-rows').textContent) === false, 'the device test result', 15000);
      ck('testing a device reports what it rendered',
        /rendered \d+ bytes/.test(mw.document.querySelector('#dev-msg').textContent),
        mw.document.querySelector('#dev-msg').textContent.slice(0, 120));

      // ---------------- Phase 29: the owner's questions, on screen ------------
      const insTab = [...mw.document.querySelectorAll('#tabs button')].find((b) => /insights/i.test(b.textContent));
      ck('an Insights tab appears — the questions an owner actually asks', !!insTab,
        [...mw.document.querySelectorAll('#tabs button')].map((b) => b.textContent.trim()).join(' | '));
      if (insTab) {
        click(mw, insTab);
        await waitFor(() => mw.document.querySelector('#ins-headline') && mw.document.querySelector('#ins-alerts').textContent.trim(),
          'the insights headline', 15000);
        ck('the screen opens with what needs the owner today',
          /need you today|Nothing needs you today/.test(mw.document.querySelector('#ins-headline').textContent),
          mw.document.querySelector('#ins-headline').textContent);
        await waitFor(() => mw.document.querySelector('#ins-profit-line').textContent.trim(), 'the profit sentence', 15000);
        ck('profit is one sentence, not a dashboard',
          /profit/i.test(mw.document.querySelector('#ins-profit-line').textContent),
          mw.document.querySelector('#ins-profit-line').textContent.slice(0, 120));
        await waitFor(() => mw.document.querySelector('#ins-reorder').textContent.trim(), 'the reorder table', 15000);
        ck('what to reorder is answered on screen',
          mw.document.querySelector('#ins-reorder').textContent.trim().length > 0,
          mw.document.querySelector('#ins-reorder').textContent.slice(0, 100));
        ck('cash on the shelf is valued',
          /Ksh/.test(mw.document.querySelector('#ins-cash').textContent),
          mw.document.querySelector('#ins-cash').textContent.slice(0, 120));
      }

      // ---------------- Phase 28: the owner can read the evidence -------------
      const evTab = [...mw.document.querySelectorAll('#tabs button')].find((b) => /evidence/i.test(b.textContent));
      ck('an Evidence tab appears — the trail belongs to the owner', !!evTab,
        [...mw.document.querySelectorAll('#tabs button')].map((b) => b.textContent.trim()).join(' | '));
      if (evTab) {
        click(mw, evTab);
        await waitFor(() => mw.document.querySelector('#ev-trail') && mw.document.querySelector('#ev-trail').textContent.trim(),
          'the trail report', 15000);
        ck('the trail report says whether every shilling left a trail',
          /left a trail|no trail/.test(mw.document.querySelector('#ev-trail').textContent),
          mw.document.querySelector('#ev-trail').textContent.slice(0, 120));
        await waitFor(() => mw.document.querySelector('#ev-logins').textContent.trim(), 'the sign-in history', 15000);
        ck('sign-ins are listed with who and what happened',
          /signed in|refused|wrong PIN/.test(mw.document.querySelector('#ev-logins').textContent),
          mw.document.querySelector('#ev-logins').textContent.slice(0, 120));
        await waitFor(() => mw.document.querySelector('#ev-sessions').textContent.trim(), 'the sessions table', 15000);
        ck('open sessions are listed so a lost till can be revoked',
          /Revoke/.test(mw.document.querySelector('#ev-sessions').textContent),
          mw.document.querySelector('#ev-sessions').textContent.slice(0, 120));
      }

      // ---------------- Phase 26: the storefront is a real page ----------------
      const store = await bootPage('store.html', 'store');
      await waitFor(() => /P26 Store|Shop/.test(store.w.document.querySelector('#shop-name').textContent),
        'the storefront named the shop');
      ck('the storefront boots without script errors', store.errs.length === 0, store.errs.join(' | '));
      await waitFor(() => store.w.document.querySelector('#grid').textContent.trim(), 'the storefront catalogue', 15000);
      ck('the storefront lists what the shop sells',
        /P26 Store Tea/.test(store.w.document.querySelector('#grid').textContent),
        store.w.document.querySelector('#grid').textContent.slice(0, 120));
      ck('the storefront says how much is left',
        /available/.test(store.w.document.querySelector('#grid').textContent),
        store.w.document.querySelector('#grid').textContent.slice(0, 120));
      const addBtn = store.w.document.querySelector('#grid [data-add]');
      click(store.w, addBtn);
      await waitFor(() => /Ksh/.test(store.w.document.querySelector('#bar-total').textContent)
        && store.w.document.querySelector('#bar-total').textContent.trim() !== 'Ksh 0', 'the basket total', 8000);
      ck('adding an item shows a total in the basket bar', true,
        store.w.document.querySelector('#bar-total').textContent);
      store.w.close();

      // ---------------- Phase 25: messages from the same screen ----------------
      await waitFor(() => mw.document.querySelector('#mk-msg-rows'), 'the messages table');
      ck('the messages table explains itself before anything is sent',
        /no messages yet/.test(mw.document.querySelector('#mk-msg-rows').textContent),
        mw.document.querySelector('#mk-msg-rows').textContent.slice(0, 60));
      mw.document.querySelector('#mk-msg-to').value = '0712 345 678';
      mw.document.querySelector('#mk-msg-body').value = 'UI message';
      click(mw, mw.document.querySelector('#mk-msg-send'));
      await waitFor(() => /UI message/.test(mw.document.querySelector('#mk-msg-rows').textContent),
        'the sent message in the list :: ' + mw.document.querySelector('#mk-msg-note').textContent, 15000);
      ck('a message sent from the screen appears in the shop outbox', true);
      ck('the outbox shows who it went to',
        /\+254712345678/.test(mw.document.querySelector('#mk-msg-rows').textContent),
        mw.document.querySelector('#mk-msg-rows').textContent.slice(0, 120));
    }

    ck('manager page booted without script errors', mgr.errs.length === 0, mgr.errs.join(' | '));
  } catch (e) {
    ck('manager page smoke', false, e.message + ' :: ' + mgr.errs.join(' | '));
  }

  // ---------------- till page ----------------
  const pos = pos0;
  try {
    await waitFor(() => pos.w.document.querySelector('#p-main') && !pos.w.document.querySelector('#p-main').classList.contains('hidden'), 'till booted');
    ck('till boots with the module framework loaded', true);
    ck('till has the module panel host', !!pos.w.document.querySelector('#p-modules'));
    ck('till page booted without script errors', pos.errs.length === 0, pos.errs.join(' | '));
  } catch (e) {
    ck('till page smoke', false, e.message + ' :: ' + pos.errs.join(' | '));
  }

  // jsdom's visual timers keep the loop alive — shut the pages down explicitly.
  for (const page of [mgr, pos]) { try { page.dom.window.close(); } catch {} }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('UI runner error:', e);
  process.exit(1);
});

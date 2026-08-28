'use strict';
/**
 * responsive.js — visual verification in real Chromium.
 *
 * jsdom does no layout, so the unit/UI suites cannot prove the responsive CSS
 * works. This drives an actual browser at each breakpoint and asserts on
 * computed geometry: no horizontal overflow, touch targets large enough,
 * the right layout shape per device class.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const browserPath = process.env.CHROME_BIN || [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find((file) => fs.existsSync(file));

const PORT = Number(process.env.RPORT || 3990);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ck = (n, c, e = '') => {
  if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('  ✗ FAIL ' + n + '  ' + e); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: 'phone-320', w: 320, h: 640, cls: 'phone' },
  { name: 'phone-375', w: 375, h: 667, cls: 'phone' },
  { name: 'phone-480', w: 480, h: 800, cls: 'phone' },
  { name: 'tablet-768', w: 768, h: 1024, cls: 'tablet' },
  { name: 'tablet-1024', w: 1024, h: 768, cls: 'tablet' },
  { name: 'desktop-1440', w: 1440, h: 900, cls: 'desktop' }
];

/* geometry probes evaluated inside the page */
const probe = () => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const rail = q('.rail'), menu = q('.menu-panel'), bill = q('.bill-panel');
  const railR = rail ? rail.getBoundingClientRect() : null;
  const menuR = menu ? menu.getBoundingClientRect() : null;
  const billR = bill ? bill.getBoundingClientRect() : null;
  return {
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    bodyW: document.body.scrollWidth,
    /* anything poking past the right edge */
    overflowers: (() => {
      /* An element poking past the right edge is only a bug if it is NOT inside a
         deliberate horizontal scroll container (chip strips, wide tables). */
      const scrollable = (el) => {
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const ox = getComputedStyle(a).overflowX;
          if (ox === 'auto' || ox === 'scroll') return true;
        }
        return false;
      };
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        if (out.length >= 4) break;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= window.innerWidth + 1) continue;
        if (getComputedStyle(el).position === 'fixed') continue;
        if (scrollable(el)) continue;
        out.push((el.className && String(el.className).slice(0, 40)) || el.tagName);
      }
      return out;
    })(),
    railBottom: railR ? railR.bottom >= window.innerHeight - 2 : false,
    railLeft: railR ? railR.left < 2 && railR.height > window.innerHeight / 2 : false,
    railH: railR ? Math.round(railR.height) : 0,
    /* POS split shape */
    posStacked: menuR && billR ? billR.top >= menuR.bottom - 2 : null,
    posSideBySide: menuR && billR ? Math.abs(menuR.top - billR.top) < 4 && billR.left >= menuR.right - 2 : null,
    billVisible: vis(bill),
    menuVisible: vis(menu),
    modalW: q('.modal') ? Math.round(q('.modal').getBoundingClientRect().width) : null,
    modalFull: q('.modal') ? Math.abs(q('.modal').getBoundingClientRect().width - window.innerWidth) < 2 : null,
    /* smallest interactive target actually on screen */
    smallestTarget: Math.min(...qa('.btn:not(.xs), .cat, .area-tab, .rail-btn, .item, .tbl-card, .keypad button')
      .filter(vis).map((el) => Math.round(el.getBoundingClientRect().height)).concat([9999])),
    keypadBtn: q('.keypad button') ? Math.round(q('.keypad button').getBoundingClientRect().height) : null,
    tableCards: qa('.tbl-card').filter(vis).length,
    gridCols: q('.grid2, .grid3') ? getComputedStyle(q('.grid2, .grid3')).gridTemplateColumns.split(' ').length : null,
    posCols: (() => { const p = q('.pos'); return p ? getComputedStyle(p).gridTemplateColumns.split(' ').length : null; })()
  };
};

/* Each screen needs its own session — the login cookie would otherwise leak
   from the previous page and skip the keypad entirely. */
async function freshPage(browser, vp) {
  const page = await browser.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const client = await page.createCDPSession();
  await client.send('Network.clearBrowserCookies');
  await page.setViewport({
    width: vp.w, height: vp.h, deviceScaleFactor: 1,
    isMobile: vp.cls === 'phone', hasTouch: vp.cls !== 'desktop'
  });
  return page;
}

async function login(page, pin) {
  await page.waitForSelector('#keypad button', { visible: true });
  for (const d of pin.split('')) {
    await page.evaluate((k) => {
      const b = [...document.querySelectorAll('#keypad button')].find((x) => x.dataset.k === k);
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, d);
    await sleep(60);
  }
  await page.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await sleep(700);
}

async function clickNav(page, key) {
  await page.evaluate((k) => document.querySelector(`[data-nav="${k}"]`).click(), key);
  await sleep(900);
}

(async () => {
  if (!browserPath) throw new Error('No Chrome/Chromium executable found. Set CHROME_BIN for the visual suite.');
  /* isolated server + throwaway DB */
  const db = path.join(os.tmpdir(), `pos-responsive-${process.pid}.db`);
  for (const f of [db, db + '-wal', db + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), POS_DB: db, TZ: 'Africa/Nairobi' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bootErr = '';
  server.stderr.on('data', (d) => { bootErr += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
    await sleep(200);
  }

  /* First-run onboarding so the suites have users + a sample menu */
  await fetch(BASE + '/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business: { business_name: 'Demo Diner', kra_pin: 'P000000000D' },
      owner_name: 'Owner', owner_pin: '0000', sample: true })
  });

  const browser = await puppeteer.launch({
    executablePath: browserPath, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'], protocolTimeout: 120000
  });
  browser.on('targetcreated', async (t) => {
    try { (await t.page()).on('dialog', (d) => d.dismiss().catch(() => {})); } catch {}
  });
  console.log('\n=== responsive verification (real Chromium) ===\n');

  for (const vp of VIEWPORTS) {
    console.log(`--- ${vp.name} (${vp.w}x${vp.h}) ---`);
    const page = await freshPage(browser, vp);
    await page.goto(BASE + '/', { waitUntil: 'networkidle2' });

    /* login screen */
    let g = await page.evaluate(probe);
    ck(`${vp.name}: login has no horizontal overflow`, g.docW <= g.winW + 1, `doc=${g.docW} win=${g.winW} ${g.overflowers.join(',')}`);
    ck(`${vp.name}: keypad targets >= 44px`, g.keypadBtn >= 44, 'h=' + g.keypadBtn);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-login.png`) });

    /* waiter floor */
    await login(page, '1234');
    g = await page.evaluate(probe);
    ck(`${vp.name}: floor has no horizontal overflow`, g.docW <= g.winW + 1, `doc=${g.docW} win=${g.winW} ${g.overflowers.join(',')}`);
    ck(`${vp.name}: all 27 tables still rendered`, g.tableCards === 27, 'cards=' + g.tableCards);

    if (vp.cls === 'phone') {
      ck(`${vp.name}: nav moved to the bottom`, g.railBottom, 'railH=' + g.railH);
      ck(`${vp.name}: smallest touch target >= 44px`, g.smallestTarget >= 44, 'min=' + g.smallestTarget);
    } else {
      ck(`${vp.name}: nav stays on the left`, g.railLeft, 'railH=' + g.railH);
    }
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-floor.png`) });

    /* open a table -> POS order-taking screen */
    await page.evaluate(() => document.querySelectorAll('.tbl-card.free')[0].click());
    await sleep(500);
    await page.evaluate(() => {
      const p = document.querySelector('#people'); if (p) { p.value = '2'; p.dispatchEvent(new Event('input', { bubbles: true })); }
      document.querySelector('.modal [data-yes]').click();
    });
    await sleep(1400);
    g = await page.evaluate(probe);
    ck(`${vp.name}: POS screen rendered`, g.menuVisible && g.billVisible);
    ck(`${vp.name}: POS has no horizontal overflow`, g.docW <= g.winW + 1, `doc=${g.docW} win=${g.winW} ${g.overflowers.join(',')}`);
    if (vp.cls === 'phone') {
      ck(`${vp.name}: POS stacks menu over bill (single column)`, g.posStacked === true,
        `stacked=${g.posStacked} sideBySide=${g.posSideBySide}`);
    } else {
      ck(`${vp.name}: POS keeps menu + bill side by side`, g.posSideBySide === true,
        `stacked=${g.posStacked} sideBySide=${g.posSideBySide}`);
    }
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-pos.png`) });

    /* Open a modal to confirm sizing. Deliberately NOT #peopleBtn — it calls
       window.prompt(), and an undismissed native dialog blocks headless Chrome. */
    await page.evaluate(() => document.querySelector('#discBtn').click());
    await sleep(900);
    g = await page.evaluate(probe);
    if (g.modalW) {
      ck(`${vp.name}: modal fits the viewport`, g.modalW <= g.winW + 1, 'w=' + g.modalW + ' win=' + g.winW);
      if (vp.cls === 'phone') ck(`${vp.name}: modal is full-width on phone`, g.modalFull === true, 'w=' + g.modalW);
      await page.screenshot({ path: path.join(SHOTS, `${vp.name}-modal.png`) });
      await page.evaluate(() => { const x = document.querySelector('.modal [data-no]') || document.querySelector('.x'); if (x) x.click(); });
      await sleep(300);
    }

    /* cashier bills screen */
    await page.evaluate(() => { const b = document.querySelector('[data-nav="bills"]'); if (b) b.click(); });
    await sleep(1100);
    g = await page.evaluate(probe);
    ck(`${vp.name}: bills screen has no horizontal overflow`, g.docW <= g.winW + 1, `doc=${g.docW} win=${g.winW} ${g.overflowers.join(',')}`);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-bills.png`) });

    await page.close();

    /* manager console — widest tables live here */
    const mp = await freshPage(browser, vp);
    await mp.goto(BASE + '/', { waitUntil: 'networkidle2' });
    await login(mp, '1111');
    const TOP_SUBS = {
      'Dashboard': [], 'Reports': ['Sales', 'Labour', 'Audit log'],
      'Products & Pricing': ['Items', 'Options', 'Recipes', 'Happy Hour'], 'Stock': [],
      'Cash & Loyalty': ['Cash Drawer', 'Loyalty'], 'Bookings': [], 'Team': ['Staff'],
      'Settings': ['Business', 'Printer', 'eTIMS / M-Pesa'] };
    for (const [topLabel, subs] of Object.entries(TOP_SUBS)) {
      await mp.evaluate((t) => {
        const b = [...document.querySelectorAll('[data-top]')].find((x) => x.textContent === t); if (b) b.click();
      }, topLabel);
      await sleep(600);
      for (const subLabel of (subs.length ? subs : [null])) {
        if (subLabel) {
          await mp.evaluate((t) => {
            const b = [...document.querySelectorAll('[data-sub]')].find((x) => x.textContent === t); if (b) b.click();
          }, subLabel);
          await sleep(500);
        }
        const nm = subLabel || topLabel;
        const r = await mp.evaluate(probe);
        ck(`${vp.name}: "${nm}" has no horizontal overflow`, r.docW <= r.winW + 1,
          `doc=${r.docW} win=${r.winW} ${r.overflowers.join(',')}`);
      }
      if (vp.name === 'phone-375' && ['Dashboard', 'Reports', 'Cash & Loyalty'].includes(topLabel))
        await mp.screenshot({ path: path.join(SHOTS, `phone-375-${topLabel.toLowerCase().replace(/[^a-z]+/g, '-')}.png`) });
      if ((vp.name === 'tablet-768' || vp.name === 'desktop-1440') && ['Dashboard', 'Reports'].includes(topLabel))
        await mp.screenshot({ path: path.join(SHOTS, `${vp.name}-${topLabel.toLowerCase()}.png`) });
    }

    /* Grid-column check. Must run on a tab that actually has a .grid2/.grid3 —
       the Audit log (last visited above) has none, so probing there returns null. */
    if (vp.cls === 'tablet' || vp.cls === 'phone') {
      const gridCols = async (tab) => {
        await mp.evaluate((t) => {
          const b = [...document.querySelectorAll('.tab')].find((x) => x.textContent === t);
          if (b) b.click();
        }, tab);
        await sleep(700);
        return mp.evaluate(() => {
          const el = document.querySelector('.grid3') || document.querySelector('.grid2');
          return el ? getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length : null;
        });
      };
      const settingsCols = await gridCols('Settings');
      if (vp.cls === 'tablet') {
        ck(`${vp.name}: Settings grid uses 2 columns`, settingsCols === 2, 'cols=' + settingsCols);
        const daypartCols = await (async () => {
          await mp.evaluate(() => {
            const t = [...document.querySelectorAll('[data-top]')].find((x) => x.textContent === 'Products & Pricing'); if (t) t.click();
          });
          await sleep(600);
          await mp.evaluate(() => {
            const b = [...document.querySelectorAll('[data-sub]')].find((x) => x.textContent === 'Happy Hour'); if (b) b.click();
          });
          await sleep(700);
          await mp.evaluate(() => { const a = document.querySelector('#addDp'); if (a) a.click(); });
          await sleep(700);
          return mp.evaluate(() => {
            const el = document.querySelector('.modal .grid3');
            return el ? getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length : null;
          });
        })();
        ck(`${vp.name}: modal .grid3 wraps to 2 columns`, daypartCols === 2, 'cols=' + daypartCols);
      } else {
        ck(`${vp.name}: Settings grid collapses to 1 column`, settingsCols === 1, 'cols=' + settingsCols);
      }
    }
    await mp.close();
  }

  /* ---- KDS: landscape wall display ---- */
  console.log('\n--- KDS (landscape wall display) ---');
  for (const [w, h, label] of [[1920, 1080, '1920x1080'], [1366, 768, '1366x768'], [1024, 600, '1024x600']]) {
    const kp = await freshPage(browser, { w, h, cls: 'desktop' });
    await kp.goto(BASE + '/kds', { waitUntil: 'networkidle2' });
    await sleep(600);
    /* sign in on the KDS page if it asks */
    const needLogin = await kp.$('#kp');
    if (needLogin) {
      await kp.type('#kp', '4567');
      await kp.click('#kg');
      await sleep(1200);
    }
    const r = await kp.evaluate(probe);
    ck(`KDS ${label}: no horizontal overflow`, r.docW <= r.winW + 1, `doc=${r.docW} win=${r.winW}`);
    const cols = await kp.evaluate(() => {
      const el = document.querySelector('.kds-cols');
      return el ? getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length : null;
    });
    ck(`KDS ${label}: multi-column ticket board`, cols >= 2, 'cols=' + cols);
    if (label === '1920x1080') await kp.screenshot({ path: path.join(SHOTS, 'kds-1920.png') });
    await kp.close();
  }

  /* ---- guest QR page on a phone ---- */
  console.log('\n--- guest QR ordering (phone) ---');
  const qp = await freshPage(browser, { w: 375, h: 667, cls: 'phone' });
  await qp.goto(BASE + '/', { waitUntil: 'networkidle2' });
  const token = await qp.evaluate(async () => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1111' }) });
    const b = await (await fetch('/api/bootstrap')).json();
    return b.tables[0].qr_token;
  });
  await qp.goto(BASE + '/order/' + token, { waitUntil: 'networkidle2' });
  await sleep(900);
  const qr = await qp.evaluate(probe);
  ck('QR page: no horizontal overflow', qr.docW <= qr.winW + 1, `doc=${qr.docW} win=${qr.winW} ${qr.overflowers.join(',')}`);
  const sendH = await qp.evaluate(() => {
    const b = document.querySelector('.bar button');
    return b ? Math.round(b.getBoundingClientRect().height) : 0;
  });
  ck('QR page: send button is a large touch target', sendH >= 44, 'h=' + sendH);
  await qp.screenshot({ path: path.join(SHOTS, 'qr-375.png') });
  await qp.close();

  /* onboarding screen on a truly fresh install */
  const freshDb = path.join(os.tmpdir(), `pos-fresh-${process.pid}.db`);
  for (const f of [freshDb, freshDb + '-wal', freshDb + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  const fresh = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT + 1), POS_DB: freshDb, TZ: 'Africa/Nairobi' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const FB = `http://127.0.0.1:${PORT + 1}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(FB + '/healthz')).ok) break; } catch {} await sleep(200); }
  for (const [w, h, name] of [[375, 667, 'phone'], [1440, 900, 'desktop']]) {
    const op = await freshPage(browser, { w, h, cls: name === 'phone' ? 'phone' : 'desktop' });
    await op.goto(FB + '/', { waitUntil: 'networkidle2' });
    await op.waitForSelector('#setup:not(.hidden)', { timeout: 8000 });
    const hasForm = await op.evaluate(() => !!document.querySelector('#setupForm'));
    ck(`onboarding shows on fresh install (${name})`, hasForm);
    const ovf = await op.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ck(`onboarding has no horizontal overflow (${name})`, ovf);
    await op.screenshot({ path: path.join(SHOTS, `onboarding-${name}.png`) });
    await op.close();
  }
  fresh.kill('SIGTERM');
  await sleep(200);
  for (const f of [freshDb, freshDb + '-wal', freshDb + '-shm']) { try { fs.unlinkSync(f); } catch {} }

  /* Primary retail experience on the supported phone/tablet widths. */
  console.log('\n--- wines & spirits retail experience ---');
  const retailDb=path.join(os.tmpdir(),`pos-retail-responsive-${process.pid}.db`),retailPort=PORT+2;
  for(const f of [retailDb,retailDb+'-wal',retailDb+'-shm']){try{fs.unlinkSync(f);}catch{}}
  const retailServer=spawn(process.execPath,[path.join(__dirname,'..','server.js')],{
    env:{...process.env,PORT:String(retailPort),POS_DB:retailDb,TZ:'Africa/Nairobi'},stdio:['ignore','pipe','pipe']});
  const RB=`http://127.0.0.1:${retailPort}`;
  for(let i=0;i<60;i++){try{if((await fetch(RB+'/healthz')).ok)break;}catch{}await sleep(200);}
  await fetch(RB+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    business:{business_name:'Responsive Wines',business_type:'wines_spirits'},owner_name:'Owner',owner_pin:'0000',sample:true})});
  let retailTillOpened=false;
  for(const vp of VIEWPORTS.filter((x)=>x.cls!=='desktop'||x.w===1440)){
    const rp=await freshPage(browser,vp);await rp.goto(RB+'/',{waitUntil:'networkidle2'});await login(rp,'1234');
    if(!retailTillOpened){await rp.evaluate(async()=>{await api('/api/shifts',{body:{opening_float:0,opening_mpesa:0,opening_card:0}});await loadBootstrap();await navigate('tables');});retailTillOpened=true;await sleep(700);}
    else{await rp.evaluate(async()=>{await loadBootstrap();await navigate('tables');});await sleep(700);}
    let rg=await rp.evaluate(probe);
    ck(`retail ${vp.name}: sale screen has no horizontal overflow`,rg.docW<=rg.winW+1,`doc=${rg.docW} win=${rg.winW} ${rg.overflowers.join(',')}`);
    ck(`retail ${vp.name}: product and cart panels render`,rg.menuVisible&&rg.billVisible);
    if(vp.cls==='phone')ck(`retail ${vp.name}: navigation is at bottom`,rg.railBottom,'railH='+rg.railH);
    await rp.evaluate(()=>document.querySelector('.item:not(.out)').click());await sleep(500);
    await rp.evaluate(()=>document.querySelector('#toBill').click());await rp.waitForSelector('#payForm');
    const retailPayment=await rp.evaluate(()=>({tips:document.querySelectorAll('[data-tip],#tipInp').length,methods:document.querySelectorAll('.mbtn').length,overflow:document.documentElement.scrollWidth<=innerWidth+1}));
    ck(`retail ${vp.name}: payment remains Cash/Card/M-Pesa only`,retailPayment.methods===3&&retailPayment.tips===0);
    ck(`retail ${vp.name}: payment modal fits viewport`,retailPayment.overflow);
    await rp.screenshot({path:path.join(SHOTS,`retail-${vp.name}.png`)});await rp.close();
  }
  retailServer.kill('SIGTERM');await sleep(200);
  for(const f of [retailDb,retailDb+'-wal',retailDb+'-shm']){try{fs.unlinkSync(f);}catch{}}

  await browser.close();
  server.kill('SIGTERM');
  await sleep(200);
  for (const f of [db, db + '-wal', db + '-shm']) { try { fs.unlinkSync(f); } catch {} }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  console.log('screenshots in shots/');
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nRESPONSIVE TEST CRASH:', e); process.exit(2); });

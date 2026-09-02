'use strict';
// ---------------------------------------------------------------------------
// app.js — shared frontend helpers: api, i18n (EN/SW core), PIN pad, money fmt
// ---------------------------------------------------------------------------

const I18N = {
  en: {
    staff_signin: 'Staff sign in', select_staff: 'Select staff member', enter_pin: 'Enter PIN',
    sign_in: 'Sign in', wrong_pin: 'Wrong PIN', locked: 'Too many attempts — try again in a few minutes',
    setup_title: 'Set up your shop', setup_sub: 'One-time setup — takes about two minutes.',
    step_business: 'Business', step_tax: 'Tax & KRA', step_owner: 'Owner', skip: 'Save & continue',
    tax_optional: 'Optional — you can skip this and set it up later in Settings.',
    solo_note: 'You can add staff, more tills and more branches any time — the shop grows without changing systems.',
    business_name: 'Business name', phone: 'Phone', address: 'Address',
    trade: 'What do you sell?', kra_pin: 'KRA PIN', vat_registered: 'Registered for VAT?',
    vat_rate: 'VAT rate %', branch_name: 'Branch name', owner_name: 'Your name',
    owner_pin: 'Create your PIN (4–8 digits)', load_sample: 'Load sample products for this trade',
    start_trading: 'Start trading', next: 'Next', back: 'Back',
    today: 'Today', sales: 'Sales', transactions: 'Transactions', products: 'Products',
    branches: 'Branches', staff: 'Staff', settings: 'Settings', audit: 'Audit log',
    till: 'Till', tills: 'Tills', customers: 'Customers', deni_short: 'Deni — credit sales',
    layout: 'Layout', locations: 'Locations', location: 'Location', warehouse: 'Warehouse',
    features: 'Features', grow: 'Grow your shop', enable: 'Enable',
    add_till: 'Add till', add_branch: 'Add branch', add_location: 'Add location',
    stock: 'Stock', stocktake: 'Stock take', shift: 'Shift',
    reason_stocktake: 'Stock take', reason_damage: 'Damage', reason_expired: 'Expired', reason_other: 'Other',
    variants: 'Variants', variant: 'Variant', packs: 'Packs', pack: 'Pack',
    attributes: 'Custom attributes', serials: 'Serials', register_serial: 'serial no.',
    in_stock: 'in stock', export_csv: 'Export CSV', import_csv: 'Import CSV',
    supplier: 'Supplier', reorder: 'Reorder level',
    reports: 'Reports', logout: 'Sign out', online: 'Online',
    offline: 'Offline — sales continue, sync later', recent_activity: 'Recent activity',
    add: 'Add', save: 'Save changes', cancel: 'Cancel', delete: 'Delete', name: 'Name',
    price: 'Price', cost: 'Cost', category: 'Category', categories: 'Categories',
    barcode: 'Barcode', unit: 'Unit', tax_type: 'Tax type', kra_code: 'KRA item code',
    role: 'Role', pin: 'PIN', active: 'Active', all_branches: 'All branches',
    owner: 'Owner', manager: 'Manager', cashier: 'Cashier', staff_r: 'Staff',
    till_coming: 'The till lands on Day 3 — cash, M-Pesa, barcode, everything.',
    reports_coming: 'Reports land on Day 12 — P&L, stock, VAT, eTIMS.',
    search: 'Search…', no_rows: 'Nothing here yet.', save_ok: 'Saved.',
    receipt_footer: 'Receipt footer',
  },
  sw: {
    staff_signin: 'Waketi wafanyakazi', select_staff: 'Chagua mfanyakazi', enter_pin: 'Weka PIN',
    sign_in: 'Ingia', wrong_pin: 'PIN si sahihi', locked: 'Jaribio nyingi — jaribu tena baada ya dakika chache',
    setup_title: 'Weka duka lako', setup_sub: 'Mipangilio ya mara moja — huchukua dakika mbili.',
    step_business: 'Biashara', step_tax: 'Kodi & KRA', step_owner: 'Mmiliki', skip: 'Hifadhi na endelea',
    tax_optional: 'Si lazima — unaweza kupuuzia na kuweka baadaye chini ya Mipangilio.',
    solo_note: 'Unaweza kuongeza wafanyakazi, taa nyingine na shamba zaidi wakati wowote — duka linakua bila kubadilisha mfumo.',
    business_name: 'Jina la biashara', phone: 'Simu', address: 'Anwani',
    trade: 'Una uunza nini?', kra_pin: 'KRA PIN', vat_registered: 'Imejiandikishwa kwa VAT?',
    vat_rate: 'Kiwango cha VAT %', branch_name: 'Jina la shamba', owner_name: 'Jina lako',
    owner_pin: 'Fungua PIN yako (tarakimu 4–8)', load_sample: 'Pakia bidhaa za mfano kwa biashara hii',
    start_trading: 'Anza biashara', next: 'Endelea', back: 'Rudi',
    today: 'Leo', sales: 'Mauzo', transactions: 'Miamala', products: 'Bidhaa',
    branches: 'Shamba', staff: 'Wafanyakazi', settings: 'Mipangilio', audit: 'Rejista',
    till: 'Taa', tills: 'Taa', customers: 'Wateja', deni_short: 'Deni — mauzo kwa deni',
    layout: 'Muundo', locations: 'Majengo', location: 'Jengo', warehouse: 'Bandari',
    features: 'Huduma', grow: 'Kua duka lako', enable: 'Washa',
    add_till: 'Ongeza taa', add_branch: 'Ongeza shamba', add_location: 'Ongeza jengo',
    stock: 'Bidhaa', stocktake: 'Kuhesabu bidhaa', shift: 'Shifu',
    reason_stocktake: 'Kuhesabu', reason_damage: 'Uharibifu', reason_expired: 'Imeisha', reason_other: 'Nyingine',
    logout: 'Toka', online: 'Mtandaoni',
    offline: 'Bana mtandao — mauzo yanaendelea, itasawazishwa baadaye', recent_activity: 'Shughuli za hivi karibuni',
    reports: 'Ripoti',
    add: 'Ongeza', save: 'Hifadhi mabadiliko', cancel: 'Ghairi', delete: 'Futa', name: 'Jina',
    price: 'Bei', cost: 'Gharama', category: 'Kundi', categories: 'Kundi',
    barcode: 'Barikodi', unit: 'Kipimo', tax_type: 'Aina ya kodi', kra_code: 'Msimbo wa KRA',
    role: 'Wadhifa', pin: 'PIN', active: 'Hai', all_branches: 'Shamba yote',
    owner: 'Mmiliki', manager: 'Meneja', cashier: 'Mkustodiani', staff_r: 'Mfanyakazi',
    till_coming: 'Taa itafika Siku 3 — pesa, M-Pesa, barikodi, yote.',
    reports_coming: 'Ripoti zitafika Siku 12 — P&L, bidhaa, VAT, eTIMS.',
    search: 'Tafuta…', no_rows: 'Hakuna data bado.', save_ok: 'Imehifadhiwa.',
    receipt_footer: 'Chini ya risiti',
  }
};

window.OP = (() => {
  let lang = localStorage.getItem('op_lang') || 'en';

  function t(key) {
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  }

  function setLang(l) {
    lang = ['en', 'sw'].includes(l) ? l : 'en';
    localStorage.setItem('op_lang', lang);
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.documentElement.lang = lang;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      if (!opts.noRedirect) location.href = '/';
      throw new Error('unauthenticated');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function fmt(n) {
    return `Ksh ${Number(n || 0).toLocaleString('en-KE')}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Keyboard-wedge PIN pad (works with USB barcode scanners too)
  function pinpad(container, onPin, maxLen = 8) {
    let pin = '';
    container.innerHTML = `
      <div class="pin-display" data-d></div>
      <div class="pinpad" data-k></div>`;
    const disp = container.querySelector('[data-d]');
    const keys = container.querySelector('[data-k]');
    const draw = () => {
      disp.textContent = pin ? '•'.repeat(pin.length) : '';
      onPin(pin);
    };
    const mk = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', () => fn(b));
      keys.appendChild(b);
      return b;
    };
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      mk(n, () => { if (pin.length < maxLen) { pin += n; draw(); } });
    }
    mk('0', () => { if (pin.length < maxLen) { pin += '0'; draw(); } });
    mk('⌫', () => { pin = pin.slice(0, -1); draw(); });
    mk('C', () => { pin = ''; draw(); }, 'wide');
    draw();
  }

  function toast(el, msg, ok = true) {
    el.textContent = msg;
    el.className = `msg ${ok ? 'ok' : 'err'}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function netBadge(container) {
    const update = () => {
      const online = navigator.onLine;
      container.textContent = online ? '● ' + t('online') : '○ ' + t('offline');
      container.className = 'net' + (online ? '' : ' offline');
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  return { t, setLang, lang: () => lang, api, fmt, esc, pinpad, toast, netBadge, I18N };
})();

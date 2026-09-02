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
    stock_ledger: 'Stock', balances: 'Balances', ledger: 'Moves', integrity: 'Check integrity',
    expected: 'Expected', physical: 'Counted', variance: 'Variance', new_stocktake: 'New stocktake',
    approve: 'Approve', stocktakes: 'Stocktakes', aging: 'Stock ageing', dead_stock: 'Dead stock',
    type: 'Type', ref: 'Ref', by: 'By', match: 'match', drift: 'drift', repair: 'Repair',
    fresh: 'fresh ≤30d', maturing: '31–90d', aging_bucket: '>90d', last_moved: 'Last moved',
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
    purchasing: 'Purchasing', suppliers: 'Suppliers', kra_pin: 'KRA PIN', contact: 'Contact',
    terms: 'Payment terms', lead_days: 'Lead days', suggested_orders: 'Suggested orders',
    suggest: 'Suggested qty', velocity: 'Sold / day', days_cover: 'Days of cover', no_suggestions: 'Nothing to order yet — sales velocity builds this list (last 30 days, supplier lead + 14 days cover).',
    purchase_orders: 'Purchase orders', new_po: 'New PO', cancel_po: 'Cancel PO',
    ordered: 'Ordered', received: 'Received', ordered_on: 'Ordered on', unit_cost: 'Unit cost',
    discrepancy: 'Discrepancy', over_qty: 'Over-received', price_diff: 'Price higher', pending: 'Pending',
    approved: 'Approved', rejected: 'Rejected', reject: 'Reject',
    post_gr: 'Post goods receipt', gr_note: 'Leave qty 0 to skip a line. Batch & expiry for batch-tracked items; serials one per unit.',
    batch_no: 'Batch no.', expiry: 'Expiry', serial_nos: 'Serial nos (one per unit)',
    supplier_invoices: 'Supplier invoices', new_invoice: 'New invoice', supplier_ref: 'Supplier ref', due: 'Due',
    pay: 'Pay', channel_ref: 'Channel ref (e.g. M-Pesa code)', method: 'Method', dispute: 'Dispute', settled: 'Settled',
    outstanding: 'Owed', balance: 'Balance', supplier_returns: 'Returns to suppliers', new_return: 'New return',
    quantity: 'Qty', reason: 'Reason', status: 'Status', sent: 'Sent', partial: 'Partial',
    received_st: 'Received', cancelled: 'Cancelled', open: 'Open', disputed: 'Disputed', paid: 'Paid',
    po_total: 'Total', po_items_count: 'lines',
    pricing: 'Pricing', price_rules: 'Price rules', price_rule: 'Price rule',
    new_rule: 'New price rule', scope: 'Scope', scope_none: 'Whole variant', scope_promo: 'Promo code', scope_customer: 'Customer', scope_branch: 'Branch', scope_tier: 'Price level (tier)',
    time_window: 'Time window (optional)', from_date: 'From', to_date: 'To', starts_at: 'Starts (HH:MM)', ends_at: 'Ends (HH:MM)',
    promo_code: 'Promo code', tier: 'Tier', retail: 'Retail', wholesale: 'Wholesale', member: 'Member',
    save_rule: 'Save rule', rule_saved: 'Rule saved.',
    margin_guard: 'Minimum margin guard',
    margin_hint: 'Any price that would sell below this margin needs approval — or is blocked. Floors can be set per product, per branch, and here (most specific wins).',
    min_margin: 'Minimum margin %', margin_policy: 'Policy', policy_pin: 'Ask for manager PIN', policy_block: 'Block it',
    price_history: 'Price history', history_hint: 'Every price change is kept forever — who, when, from, to, and who approved it.',
    when: 'When', field: 'Field', old: 'From', newp: 'To', changed_by: 'Changed by', approver: 'Approved by',
    filter_product: 'Product', all_products: 'All products', no_history: 'No price changes recorded yet.',
    window_label: 'Window', below_margin: 'below margin', pin_ok: 'PIN approved', no_pin: 'no PIN',
    // POS (Day 10)
    scan_search: 'Scan barcode or search…', all: 'All', out_of_stock: 'Out of stock',
    subtotal: 'Subtotal', discount: 'Discount', vat: 'VAT', total: 'Total',
    cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', tender: 'Tender', exact: 'Exact',
    walk_in: 'Walk-in', cart_empty: 'Cart is empty — scan or pick a product', note: 'Note',
    hold_sale: 'Hold', held_sale: 'Held sale', held_sales: 'Held sales', resume: 'Resume', resume_sale: 'Resume & pay',
    complete_sale: 'Complete sale', age_confirm_title: 'Age check',
    age_confirm_msg: 'Confirm the customer is at least {n} years old.', confirm_age: 'Customer is of age',
    supervisor_pin: 'Supervisor PIN', supervisor_pin_msg: 'Enter a manager or owner PIN to approve this discount.',
    confirm: 'Confirm', print: 'Print', new_sale: 'New sale', payment_ref: 'Reference',
    customer: 'Customer', invoice_no: 'Invoice',
    quote_sale: 'Quote', convert_sale: 'Convert & pay',
    till_tip: 'Scan a barcode or tap a product to start. F2 refocuses search. Cash is the default payment — Hold parks the cart, Quote prices it for later.',
    payments: 'Payments', awaiting_payment: 'Awaiting payment', confirm_payment: 'Confirm payment',
    cancel_payment: 'Cancel payment', confirm_code: 'Confirmation code',
    simulate_callback: 'Simulate callback (sandbox)', sandbox_wait: 'Sandbox: the callback will confirm it — or use the button below.',
    awaiting_generic: 'The customer pays, then you record the confirmation code.',
    add_payment: 'Add payment', reconcile: 'Reconcile', deposits: 'Deposits', deposit: 'Deposit',
    payment_settings: 'Payment settings', refunded: 'Refunded', failed: 'Failed',
    mpesa_mode: 'M-Pesa mode', shortcode: 'Shortcode', paybill: 'Paybill/Till',
    consumer_key: 'Consumer key', consumer_secret: 'Consumer secret',
    shifts: 'Shifts', open_shift: 'Open shift', close_shift: 'Close shift',
    shift_open: 'Shift open', shift_closed: 'Shift closed', new_shift: 'New shift',
    float: 'Float', cash_in: 'Cash in', drawer: 'Drawer', expected: 'Expected',
    counted: 'Counted', variance: 'Variance', payout: 'Payout',
    no_shift_open: 'No shift open', shift_hint: 'Sales won\'t count to a till.',
    till_enforced: 'Till control is on — open a shift to start selling.',
    returns: 'Returns', exchanges: 'Exchanges', return_exchange: 'Return / Exchange',
    return_tab: 'Return', exchange_tab: 'Exchange', exchange_for: 'Exchange for',
    add_item: '+ Add item', settle_method: 'Settle diff with', cash_m: 'Cash',
    reason_wrong: 'Wrong item', reason_damaged: 'Damaged', reason_defective: 'Defective',
    reason_mind: 'Changed mind', refund_as: 'Refund as',
    refund_money: 'Money (original method)', refund_credit: 'Store credit',
    mgr_pin: 'Manager PIN (exchange)', do_return: 'Process', restock: 'Restock',
    return_no_l: 'Note', exchanged_l: 'Exchanged', new_sale: 'New sale',
    returned_l: 'Returned', new_total_l: 'New total', diff_l: 'Diff',
    settled_by: 'Settled by', at: 'At', to_pay: 'to pay', exact_swap: 'exact swap',
    store_credit_got: 'store credit added', return_done: 'Return processed',
    exchange_done: 'Exchange processed', paid_diff: 'diff paid',
    invoice_not_found: 'no sale found for that invoice',
    nothing_selected: 'enter quantities for the returned lines',
    add_exchange_item: 'add the replacement items first',
    pin_needed: 'manager PIN needed for exchanges',
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
    stock_ledger: 'Bidhaa', balances: 'Miyalo', ledger: 'Mabadiliko', integrity: 'Angalia usahihi',
    expected: 'Inayotarajiwa', physical: 'Imeahesabiwa', variance: 'Tofauti', new_stocktake: 'Hesabu mpya',
    approve: 'Thibitisha', stocktakes: 'Hesabu ya bidhaa', aging: 'Umaskivu wa bidhaa', dead_stock: 'Bidhaa zisizouzwa',
    type: 'Aina', ref: 'Marejeo', by: 'Naye', match: 'inasawa', drift: 'tofauti', repair: 'Rekebisha',
    fresh: 'mpya ≤30s', maturing: '31–90s', aging_bucket: '>90s', last_moved: 'Mwisho wa kuharilika',
    add: 'Ongeza', save: 'Hifadhi mabadiliko', cancel: 'Ghairi', delete: 'Futa', name: 'Jina',
    price: 'Bei', cost: 'Gharama', category: 'Kundi', categories: 'Kundi',
    barcode: 'Barikodi', unit: 'Kipimo', tax_type: 'Aina ya kodi', kra_code: 'Msimbo wa KRA',
    role: 'Wadhifa', pin: 'PIN', active: 'Hai', all_branches: 'Shamba yote',
    owner: 'Mmiliki', manager: 'Meneja', cashier: 'Mkustodiani', staff_r: 'Mfanyakazi',
    till_coming: 'Taa itafika Siku 3 — pesa, M-Pesa, barikodi, yote.',
    reports_coming: 'Ripoti zitafika Siku 12 — P&L, bidhaa, VAT, eTIMS.',
    search: 'Tafuta…', no_rows: 'Hakuna data bado.', save_ok: 'Imehifadhiwa.',
    receipt_footer: 'Chini ya risiti',
    purchasing: 'Ununuzi', suppliers: 'Waviriana', kra_pin: 'KRA PIN', contact: 'Mawasiliano',
    terms: 'Sharti za malipo', lead_days: 'Siku za kutua', suggested_orders: 'Oda zilizopendekezwa',
    suggest: 'Idadi inayopendekezwa', velocity: 'Mauzo / siku', days_cover: 'Siku za kutosha', no_suggestions: 'Hakuna chochote cha kununua bado — orodha hii inajengwa na kasi ya mauzo (siku 30 zilizopita, siku za waviriana + 14 siku za kutosha).',
    purchase_orders: 'Oda za ununuzi', new_po: 'Oda mpya', cancel_po: 'Ghairisha oda',
    ordered: 'Zilizoitwa', received: 'Zilizopokelewa', ordered_on: 'Iliitwa', unit_cost: 'Bei ya kipimo',
    discrepancy: 'Tofauti', over_qty: 'Zaidi ya kilichoitwa', price_diff: 'Bei imeongezeka', pending: 'Inasubiri',
    approved: 'Imeidhinishwa', rejected: 'Imekataliwa', reject: 'Kataa',
    post_gr: 'Andika kupokea bidhaa', gr_note: 'Acha idadi 0 rukusa bidhaa. Namba ya kundi na tarehe ya mwisho kwa bidhaa za kundi; IMEI moja kwa kila kipimo.',
    batch_no: 'Namba ya kundi', expiry: 'Tarehe ya mwisho', serial_nos: 'Namba za IMEI (moja kwa kila kipimo)',
    supplier_invoices: 'Fatura za waviriana', new_invoice: 'Fatura mpya', supplier_ref: 'Marejeo ya waviriana', due: 'Inayotulia',
    pay: 'Lipa', channel_ref: 'Marejeo ya njia (mf. M-Pesa code)', method: 'Njia', dispute: 'Tafakkari', settled: 'Imelisheka',
    outstanding: 'Inayotulikiwa', balance: 'Mizizi', supplier_returns: 'Marejesho kwa waviriana', new_return: 'Marejesho mapya',
    quantity: 'Idadi', reason: 'Sababu', status: 'Hali', sent: 'Imetumwa', partial: 'Sehemu',
    received_st: 'Imepokelewa', cancelled: 'Imeghairiwa', open: 'Imefunguliwa', disputed: 'Imetafsiriwa', paid: 'Imelipwa',
    po_total: 'Jumla', po_items_count: 'vidogo',
    pricing: 'Bei', price_rules: 'Kanuni za bei', price_rule: 'Kanuni ya bei',
    new_rule: 'Kanuni mpya ya bei', scope: 'Eneo', scope_none: 'Kipimo chote', scope_promo: 'Kodi ya zawadi', scope_customer: 'Mteja', scope_branch: 'Tawi', scope_tier: 'Ngazi ya bei',
    time_window: 'Kituo cha muda (hiari)', from_date: 'Kuanzia', to_date: 'Hadi', starts_at: 'Anza (HH:MM)', ends_at: 'Maliza (HH:MM)',
    promo_code: 'Kodi ya zawadi', tier: 'Ngazi', retail: 'Rejareja', wholesale: 'Pumzii', member: 'Mwanachama',
    save_rule: 'Hifadhi kanuni', rule_saved: 'Kanuni imehifadhiwa.',
    margin_guard: 'Kinga ya faida ya chini',
    margin_hint: 'Bei yoyote ingayouza chini ya faida hii inahitaji idhini — au inazuiliwa. Mipaka inaweza kuwekwa kwa bidhaa, kwa tawi, na hapa (iliyo karibu zaidi ndiyo inayoshinda).',
    min_margin: 'Faida ya chini %', margin_policy: 'Sera', policy_pin: 'Omba PIN ya meneja', policy_block: 'Zuia',
    price_history: 'Historia ya bei', history_hint: 'Kila badiliko la bei linahifadhiwa haki — nani, lini, kutoka, kwenda, na nani aliidhinisha.',
    when: 'Lini', field: 'Sehemu', old: 'Kutoka', newp: 'Kwenda', changed_by: 'Aliyebadilisha', approver: 'Aliyeidhinisha',
    filter_product: 'Bidhaa', all_products: 'Bidhaa zote', no_history: 'Hakuna badiliko la bei lililorekodiwa bado.',
    window_label: 'Kituo', below_margin: 'chini ya faida', pin_ok: 'PIN imeidhinishwa', no_pin: 'bila PIN',
    // POS (Day 10)
    scan_search: 'Scan au tafuta…', all: 'Zote', out_of_stock: 'Imetoka madukani',
    subtotal: 'Jumla ndogo', discount: 'Punguzo', vat: 'VAT', total: 'Jumla',
    cash: 'Taslimu', mpesa: 'M-Pesa', card: 'Kadi', tender: 'Iliyotolewa', exact: 'Sahihi',
    walk_in: 'Mteja wa kawaida', cart_empty: 'Kikapu kina tupu — scan au chagua bidhaa', note: 'Maelezo',
    hold_sale: 'Shikilia', held_sale: 'Mauzo yaliyoshikiliwa', held_sales: 'Mauzo yaliyoshikiliwa', resume: 'Endelea', resume_sale: 'Endelea & lipa',
    complete_sale: 'Kamilisha mauzo', age_confirm_title: 'Hakiki umri',
    age_confirm_msg: 'Thibitisha mteja ana anga miaka {n}.', confirm_age: 'Mteja ana umri',
    supervisor_pin: 'PIN ya msimamizi', supervisor_pin_msg: 'Weka PIN ya meneja au mwenyeji ili kuidhinisha punguzo hili.',
    confirm: 'Thibitisha', print: 'Chapisha', new_sale: 'Mauzo mapya', payment_ref: 'Marejeo',
    customer: 'Mteja', invoice_no: 'Fatura',
    quote_sale: 'Nukuu', convert_sale: 'Badilisha & lipa',
    till_tip: 'Scan barcode au gusa bidhaa ili kuanza. F2 inarudisha kwenye utafutaji. Taslimu ni njia ya kawaida — Shikilia inaweka kikapu, Nukuu inamilishwa baadaye.',
    payments: 'Malipo', awaiting_payment: 'Inasubiri malipo', confirm_payment: 'Thibitisha malipo',
    cancel_payment: 'Ghairi malipo', confirm_code: 'Msimbo wa uthibitisho',
    simulate_callback: 'Simulia callback (sandbox)', sandbox_wait: 'Sandbox: callback itathibitisha — au tumia kitufe cha chini.',
    awaiting_generic: 'Mteja analipa, kisha uweke msimbo wa uthibitisho.',
    add_payment: 'Ongeza malipo', reconcile: 'Kulinganisha', deposits: 'Depoziti', deposit: 'Depoziti',
    payment_settings: 'Mipangilio ya malipo', refunded: 'Imerejeshwa', failed: 'Imeshindwa',
    mpesa_mode: 'Modi ya M-Pesa', shortcode: 'Shortcode', paybill: 'Paybill/Till',
    consumer_key: 'Consumer key', consumer_secret: 'Consumer secret',
    shifts: 'Shifuti', open_shift: 'Fungua shift', close_shift: 'Funga shift',
    shift_open: 'Shift imefunguliwa', shift_closed: 'Shift imefungwa', new_shift: 'Shift mpya',
    float: 'Floati', cash_in: 'Taslimu iliyopo', drawer: 'Fuku', expected: 'Inayotarajiwa',
    counted: 'Imehesabiwa', variance: 'Tofauti', payout: 'Toleo',
    no_shift_open: 'Hakuna shift iliyofunguliwa', shift_hint: 'Mauzo hayatahesabiwa kwa kambi.',
    till_enforced: 'Utawala wa kambi umeanzishwa — fungua shift ili kuanza kuuza.',
    returns: 'Marejesho', exchanges: 'Badilisho', return_exchange: 'Rudi / Badilisha',
    return_tab: 'Rudi', exchange_tab: 'Badilisha', exchange_for: 'Badilisha na',
    add_item: '+ Ongeza bidhaa', settle_method: 'Lipa tofauti kwa', cash_m: 'Taslimu',
    reason_wrong: 'Bidhaa potofu', reason_damaged: 'Imevunjika', reason_defective: 'Haitendwi',
    reason_mind: 'Alijua', refund_as: 'Rudi kama',
    refund_money: 'Pesa (njia asilia)', refund_credit: 'Krediti ya duka',
    mgr_pin: 'PIN ya meneja (badilisho)', do_return: 'Endelea', restock: 'Rudisha',
    return_no_l: 'Kumbukumbu', exchanged_l: 'Imebadilishwa', new_sale: 'Mauzo mapya',
    returned_l: 'Zilizorudishwa', new_total_l: 'Jumla mpya', diff_l: 'Tofauti',
    settled_by: 'Imelipwa kwa', at: 'Saa', to_pay: 'kulipa', exact_swap: 'badilisho sawa',
    store_credit_got: 'krediti ya duka imeongezwa', return_done: 'Urudishaji umefanywa',
    exchange_done: 'Badilisho limefanywa', paid_diff: 'tofauti imelipwa',
    invoice_not_found: 'hakuna mauzo kwa risiti hiyo',
    nothing_selected: 'ingiza idadi ya bidhaa zinazorudishwa',
    add_exchange_item: 'ongeza bidhaa mpya kwanza',
    pin_needed: 'inahitaji PIN ya meneja kwa badilisho',
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

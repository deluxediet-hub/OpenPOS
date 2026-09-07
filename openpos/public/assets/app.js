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
    transfers: 'Transfers', new_transfer: 'New transfer', from_loc: 'From location', to_loc: 'To location',
    create_transfer: 'Create transfer', add_line: 'Add line', batch_l: 'Batch', route: 'Route',
    lines: 'Lines', units: 'Units', received_l: 'Received', value: 'Value', run: 'Run',
    reload: 'Reload', ship: 'Ship', receive: 'Receive', rank: 'Rank', shrinkage: 'Shrinkage',
    tf_requested: 'requested', tf_approved: 'approved', tf_shipped: 'shipped', tf_received: 'received', tf_cancelled: 'cancelled',
    tf_created: 'Created {ref} — awaiting approval', tf_need_line: 'Add at least one line with a quantity',
    tf_create_fail: 'Transfer not created', tf_sent: 'Sent', tf_received_qty: 'Received',
    tf_receive_fail: 'Receive failed', branch_comparison: 'Branch comparison',
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
    deni: 'Deni', limit: 'Limit', store_credit_b: 'Store credit',
    last_purchase: 'Last purchase', total_purchases: 'Lifetime',
    add_customer: '+ Customer', print_statement: 'Statement',
    repay: 'Repay', repay_amt: 'Repay (Ksh)', deposit_amt: 'Deposit (Ksh)',
    method_l: 'Method', sc_delta: 'Credit ± (Ksh)', adjust_sc: 'Adjust credit',
    recent_sales: 'Recent sales', tier_l: 'Tier', kra_pin_l: 'KRA PIN',
    email: 'Email', balance_l: 'Balance', saved_ok: 'Saved',
    fill_amount: 'enter an amount', repaid: 'Repaid', deposited: 'Deposited',
    phone_required: 'phone number needed',
    keys: 'Keys',
    // ---- the welcome page: the first screen a shop meets ----
    welcome_eyebrow: 'For Kenyan shops',
    welcome_title: 'The till that keeps your books straight',
    welcome_sub: 'Sell, track stock, take M-Pesa and print a KRA-ready receipt — on the counter PC or the phone in your hand, even when the internet is gone.',
    welcome_start: 'Set up my shop',
    welcome_signin: 'I already have a shop',
    welcome_offline: 'Works offline',
    welcome_mpesa: 'M-Pesa built in',
    welcome_kra: 'KRA / eTIMS ready',
    welcome_yours: 'Your data stays yours',
    welcome_feat1: 'Sell in seconds',
    welcome_feat1d: 'Scan or tap. Cash, M-Pesa or credit. The receipt prints itself and the stock counts itself down.',
    welcome_feat2: 'Know what is on the shelf',
    welcome_feat2d: 'Every unit is accounted for — stock takes, low-stock warnings, batches and expiry, and shrinkage you can see.',
    welcome_feat3: 'Grows with your shop',
    welcome_feat3d: 'Start with one till. Add staff, branches and an online shop when you are ready — without changing systems.',
    welcome_foot: 'Made for shops that cannot afford a mistake.',
    welcome_back: '← Back to start',
    open_till: 'Open the till',
    open_back_office: 'Back office',
    good_morning: 'Good morning', good_afternoon: 'Good afternoon', good_evening: 'Good evening',
    // closing the last HTML/JS gaps (Phase 34)
    branch: 'Branch', orders: 'Orders', margin: 'Margin', product: 'Product', refund: 'Refund',
    suppliers_with_balance: 'Suppliers (with balance in branch)',
    // ---- Phase 34: the till, run from the keyboard ----
    keyboard_shortcuts: 'Keyboard shortcuts',
    keys_intro: 'A cashier should never have to reach for the mouse. These keys work anywhere on the till.',
    keys_search: 'Go to scan / search',
    keys_customer: 'Go to customer',
    keys_tender: 'Go to cash tendered',
    keys_pay: 'Complete the sale',
    keys_hold: 'Hold (park) the cart',
    keys_quote: 'Quote the cart',
    keys_move: 'Move up / down the cart',
    keys_qty: 'Add / remove one from the selected line',
    keys_remove: 'Remove the selected line',
    keys_escape: 'Close this, or clear the search',
    keys_this_help: 'Show or hide this list',
    qty: 'Quantity', increase_qty: 'Add one', decrease_qty: 'Remove one',
    nothing_here: 'Nothing here yet',
    nothing_here_sub: 'When there is something to show, it will appear here.',
    no_results: 'Nothing matches that search',
    something_wrong: 'That did not work',
    try_again: 'Try again',
    not_allowed: 'You are not allowed to do that — ask a manager',
    not_enough_stock: 'There is not enough on the shelf for that',
    out_of_stock: 'That item is finished — restock it first',
    sub_ended: 'The subscription has ended — pay to start selling again',
    no_internet: 'No internet — the sale will be kept and sent later',
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
    transfers: 'Usafirishaji', new_transfer: 'Usafirishaji mpya', from_loc: 'Kutoka mahali', to_loc: 'Kwenda mahali',
    create_transfer: 'Unda usafirishaji', add_line: 'Ongeza mstari', batch_l: 'Kundi', route: 'Njia',
    lines: 'Mistari', units: 'Kipimo', received_l: 'Imepokelewa', value: 'Thamani', run: 'Endesha',
    reload: 'Pakia upya', ship: 'Tuma', receive: 'Pokea', rank: 'Ushindi', shrinkage: 'Kupungua',
    tf_requested: 'imeombwa', tf_approved: 'imeidhinishwa', tf_shipped: 'imetumwa', tf_received: 'imepokelewa', tf_cancelled: 'imeghairiwa',
    tf_created: 'Imeundwa {ref} — inasubiri idhini', tf_need_line: 'Ongeza angalau mstari mmoja unaona idadi',
    tf_create_fail: 'Usafirishaji haujaundwa', tf_sent: 'Imetumwa', tf_received_qty: 'Imepokelewa',
    tf_receive_fail: 'Upokeaji umeshindwa', branch_comparison: 'Ulinganisho wa tawi',
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
    deni: 'Deni', limit: 'Kipimo', store_credit_b: 'Krediti ya duka',
    last_purchase: 'Ununuzi mwisho', total_purchases: 'Maisha yote',
    add_customer: '+ Mteja', print_statement: 'Taarifa',
    repay: 'Rudisha', repay_amt: 'Rudisha (Ksh)', deposit_amt: 'Weka (Ksh)',
    method_l: 'Njia', sc_delta: 'Krediti ± (Ksh)', adjust_sc: 'Rekebisha krediti',
    recent_sales: 'Mauzo ya hivi karibuni', tier_l: 'Kiwango', kra_pin_l: 'KRA PIN',
    email: 'Barua pepe', balance_l: 'Salio', saved_ok: 'Imehifadhiwa',
    fill_amount: 'weka kiasi', repaid: 'Imelipwa', deposited: 'Imewekwa',
    phone_required: 'inahitaji nambari ya simu',
    branch: 'Tawi', orders: 'Oda', margin: 'Faida', product: 'Bidhaa', refund: 'Rudisha',
    suppliers_with_balance: 'Washirika (wenye salio tawini)',
    keys: 'Vifungo',
    // ---- ukurasa wa kwanza: kinachokutana na duka mara ya kwanza ----
    welcome_eyebrow: 'Kwa maduka ya Kenya',
    welcome_title: 'Taa inayoweka vitabu vyako sawa',
    welcome_sub: 'Uza, fuatilia stoo, pokea M-Pesa na chapisha risiti ya KRA — kwenye kompyuta ya kaunta au simu yako, hata mtandao ukiwa haupo.',
    welcome_start: 'Weka duka langu',
    welcome_signin: 'Nina duka tayari',
    welcome_offline: 'Inafanya kazi bila mtandao',
    welcome_mpesa: 'M-Pesa imejumuishwa',
    welcome_kra: 'KRA / eTIMS tayari',
    welcome_yours: 'Data yako ni yako',
    welcome_feat1: 'Uza kwa sekunde',
    welcome_feat1d: 'Scan au gusa. Taslimu, M-Pesa au deni. Risiti inajichapisha na stoo inajipunguza.',
    welcome_feat2: 'Jua kilicho rafuni',
    welcome_feat2d: 'Kila kipande kinahesabiwa — uhesabuji wa stoo, tahadhari ya kuisha, batchi na tarehe ya mwisho, na upotevu unaoonekana.',
    welcome_feat3: 'Inakua na duka lako',
    welcome_feat3d: 'Anza na taa moja. Ongeza wafanyakazi, matawi na duka la mtandaoni utakapokuwa tayari — bila kubadilisha mfumo.',
    welcome_foot: 'Imetengenezwa kwa maduka yasiyoweza kumudu makosa.',
    welcome_back: '← Rudi mwanzo',
    open_till: 'Fungua taa',
    open_back_office: 'Ofisi ya nyuma',
    good_morning: 'Habari za asubuhi', good_afternoon: 'Habari za mchana', good_evening: 'Habari za jioni',
    // closing the last EN/SW gaps (Phase 34)
    variants: 'Aina', variant: 'Aina', packs: 'Pakiti', pack: 'Pakiti',
    attributes: 'Sifa maalum', serials: 'Namba za seriali', register_serial: 'namba ya seriali',
    in_stock: 'ipo stoo', export_csv: 'Hamisha CSV', import_csv: 'Ingiza CSV',
    supplier: 'Muuzaji wa jumla', reorder: 'Kiwango cha kuagiza tena',
    // ---- Phase 34: the till, run from the keyboard ----
    keyboard_shortcuts: 'Njia za mkato',
    keys_intro: 'Mfanyakazi wa kaunta asilazimike kufikia panya. Vifungo hivi vinafanya kazi popote kwenye kaunta.',
    keys_search: 'Nenda kwenye scan / utafutaji',
    keys_customer: 'Nenda kwa mteja',
    keys_tender: 'Nenda kwa pesa zinazolipwa',
    keys_pay: 'Maliza uuzaji',
    keys_hold: 'Shikilia kikapu',
    keys_quote: 'Toa nukuu ya kikapu',
    keys_move: 'Songa juu / chini kwenye kikapu',
    keys_qty: 'Ongeza / punguza moja kwenye mstari uliochaguliwa',
    keys_remove: 'Ondoa mstari uliochaguliwa',
    keys_escape: 'Funga hiki, au futa utafutaji',
    keys_this_help: 'Onyesha au ficha orodha hii',
    qty: 'Idadi', increase_qty: 'Ongeza moja', decrease_qty: 'Punguza moja',
    nothing_here: 'Bado hakuna kitu hapa',
    nothing_here_sub: 'Kitakapokuwepo cha kuonyesha, kitaonekana hapa.',
    no_results: 'Hakuna kinachofanana na utafutaji huo',
    something_wrong: 'Hilo halikufanikiwa',
    try_again: 'Jaribu tena',
    not_allowed: 'Hauruhusiwi kufanya hivyo — muulize meneja',
    not_enough_stock: 'Rafu haina za kutosha kwa hilo',
    out_of_stock: 'Bidhaa hiyo imeisha — jaza tena kwanza',
    sub_ended: 'Usajili umeisha — lipa ili uuze tena',
    no_internet: 'Hakuna mtandao — uuzaji utahifadhiwa na kutumwa baadaye',
  }
};

window.OP = (() => {
  let lang = localStorage.getItem('op_lang') || 'en';

  function t(key) {
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  }

  function applyI18n(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const tr = t(key);
      if (tr !== key || !el.textContent.trim()) el.textContent = tr;
    });
    (root || document).querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    (root || document).querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
  }

  function setLang(l) {
    lang = ['en', 'sw'].includes(l) ? l : 'en';
    localStorage.setItem('op_lang', lang);
    applyI18n(document);
    document.documentElement.lang = lang;
  }

  /**
   * R-C2 (Phase 34): a one-till shop must never meet the words "branch",
   * "warehouse", "supplier" or "price level". Anything that only makes sense
   * once a capability is on carries `data-cap` (or `data-caps` for any-of) and
   * disappears here — cut for this shop, not hidden behind a setting they have
   * to hunt for.
   */
  function applyCaps(caps, root) {
    const c = caps || {};
    const hide = (el) => { el.classList.add('hidden'); el.setAttribute('aria-hidden', 'true'); };
    const show = (el) => { if (!el.dataset.capHidden) el.classList.remove('hidden'); el.removeAttribute('aria-hidden'); };
    (root || document).querySelectorAll('[data-cap]').forEach((el) => (c[el.getAttribute('data-cap')] ? show(el) : hide(el)));
    (root || document).querySelectorAll('[data-caps]').forEach((el) => {
      const any = String(el.getAttribute('data-caps') || '').split(/[\s,]+/).filter(Boolean).some((k) => c[k]);
      any ? show(el) : hide(el);
    });
  }

  /**
   * Rows drawn after the page loads used to keep the old language. A row that
   * appears later is translated the moment it appears (Phase 34).
   */
  function watchI18n() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('[data-i18n],[data-i18n-ph],[data-i18n-title]')) applyI18n(node.parentNode || node);
          else if (node.querySelector && node.querySelector('[data-i18n],[data-i18n-ph],[data-i18n-title]')) applyI18n(node);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) watchI18n();
  else document.addEventListener('DOMContentLoaded', watchI18n);

  async function api(path, opts = {}) {
    const isGet = !opts.method || opts.method === 'GET';
    try {
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
      // cache successful GETs for offline fallback
      if (isGet) {
        try {
          if (path.includes('/api/products')) localStorage.setItem('op_cache_products', JSON.stringify(data));
          else if (path.includes('/api/categories')) localStorage.setItem('op_cache_cats', JSON.stringify(data));
          else if (path.includes('/api/customers')) localStorage.setItem('op_cache_customers', JSON.stringify(data));
          else if (path.includes('/api/bootstrap')) localStorage.setItem('op_cache_bootstrap', JSON.stringify(data));
          else if (path.includes('/api/payments/methods')) localStorage.setItem('op_cache_paymethods', JSON.stringify(data.methods || data));
          else if (path.includes('/api/registers')) localStorage.setItem('op_cache_registers', JSON.stringify(data));
          if (path.startsWith('/api/')) localStorage.setItem('op_cache_'+path.replace(/[^a-z0-9]/gi,'_').slice(0,80), JSON.stringify(data));
        } catch {}
      }
      return data;
    } catch (e) {
      // OFFLINE fallback for GETs — only when the browser really is offline.
      // While online, a stale cache is worse than an honest error: a shop must
      // never make a decision on a list it cannot refresh.
      if (isGet && navigator.onLine === false) {
        try {
          if (path.includes('/api/products')) {
            const c = localStorage.getItem('op_cache_products');
            if (c) return JSON.parse(c);
          }
          if (path.includes('/api/categories')) {
            const c = localStorage.getItem('op_cache_cats');
            if (c) return JSON.parse(c);
          }
          if (path.includes('/api/customers')) {
            const c = localStorage.getItem('op_cache_customers');
            if (c) return JSON.parse(c);
          }
          if (path.includes('/api/bootstrap')) {
            const c = localStorage.getItem('op_cache_bootstrap');
            if (c) return JSON.parse(c);
          }
          if (path.includes('/api/payments/methods')) {
            const c = localStorage.getItem('op_cache_paymethods');
            if (c) { const parsed = JSON.parse(c); return parsed.methods ? parsed : { methods: parsed }; }
          }
          if (path.includes('/api/registers')) {
            const c = localStorage.getItem('op_cache_registers');
            if (c) return JSON.parse(c);
          }
          const key = 'op_cache_'+path.replace(/[^a-z0-9]/gi,'_').slice(0,80);
          const generic = localStorage.getItem(key);
          if (generic) return JSON.parse(generic);
        } catch {}
      }
      throw e;
    }
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

  // ---- Phase 34: empty states and plain-language errors --------------------
  // An empty table should tell you why it is empty, and an error should tell
  // you what to do next — in the language the shop speaks.
  function emptyRow(colspan, key, sub) {
    return `<tr><td colspan="${colspan || 1}"><div class="empty">
      <div class="empty-t">${esc(t(key || 'nothing_here'))}</div>
      <div class="empty-s">${esc(sub ? t(sub) : t('nothing_here_sub'))}</div>
    </div></td></tr>`;
  }

  const ERR_MAP = [
    { test: (m) => /permission|not allowed|forbidden/i.test(m), key: 'not_allowed' },
    { test: (m) => /subscription/i.test(m), key: 'sub_ended' },
    { test: (m) => /not enough stock|insufficient stock|oversell/i.test(m), key: 'not_enough_stock' },
    { test: (m) => /out of stock|no stock/i.test(m), key: 'out_of_stock' },
    { test: (m) => /fetch|network|offline|internet/i.test(m), key: 'no_internet' }
  ];

  /** Turn whatever the server (or the network) said into a sentence. */
  function errText(e) {
    const raw = String((e && e.message) || e || t('something_wrong'));
    for (const m of ERR_MAP) if (m.test(raw)) return t(m.key);
    return raw;
  }

  function netBadge(container) {
    const update = () => {
      const online = navigator.onLine;
      let pending = 0, conflicts = 0;
      try {
        const outbox = JSON.parse(localStorage.getItem('op_offline_outbox') || '[]');
        pending = outbox.filter(o=>o.status!=='conflict').length;
        conflicts = outbox.filter(o=>o.status==='conflict').length;
      } catch {}
      const base = online ? '● ' + t('online') : '○ ' + t('offline');
      if (pending>0 || conflicts>0) {
        const parts = [base];
        if (pending>0) parts.push(`${pending} queued`);
        if (conflicts>0) parts.push(`${conflicts} conflict`);
        container.textContent = parts.join(' · ');
      } else {
        container.textContent = base;
      }
      container.className = 'net' + (online ? '' : ' offline') + (pending>0 ? ' has-pending' : '') + (conflicts>0 ? ' has-conflict' : '');
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    window.addEventListener('storage', update);
    setInterval(update, 5000);
    update();
  }

  // ---- Phase 18: industry module UI ----------------------------------------
  // A module ships a browser panel (modules/ui/<id>.js) that calls
  // OP.registerPanel({ mount, id, label, i18n, render(el, ctx) }). The shell
  // mounts panels by their `mount` name and never knows what they are — adding
  // an industry panel costs no edit to any page.
  const PANELS = [];

  function registerPanel(panel) {
    if (panel && panel.id) PANELS.push(panel);
    return panel;
  }

  function panels(mount) {
    return PANELS.filter((p) => !mount || (p.mount || 'manager') === mount);
  }

  /** Merge a module's EN/SW strings into the core dictionary. */
  function addI18n(strings) {
    for (const [lng, dict] of Object.entries(strings || {})) {
      if (!I18N[lng]) I18N[lng] = {};
      Object.assign(I18N[lng], dict);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-module="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.dataset.module = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  /** Load the panel scripts for the active modules (from bootstrap). */
  async function loadModules(parts) {
    for (const part of parts || []) {
      try {
        if (part.i18n) addI18n(part.i18n);
        await loadScript(part.script);
      } catch (e) {
        console.warn('[modules]', part.id, e.message);
      }
    }
    return PANELS.slice();
  }

  // ---- Generic panel helpers (Phases 19-23) --------------------------------
  // Every industry panel does the same two things: show a report, and run one
  // of the industry's own commands. Both are driven by the module's descriptor,
  // so a panel file stays about 40 lines and the shell stays industry-blind.
  const FORMS = {};

  function reportTable(rows, columns) {
    const list = Array.isArray(rows) ? rows : [];
    const cols = (columns && columns.length) ? columns : (list[0] ? Object.keys(list[0]) : []);
    if (!list.length) return '<p class="hint">—</p>';
    return `<table class="tbl"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      list.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`;
  }

  /** Render the inputs a module command declares. Bind with OP.bindForms(el). */
  function commandForm(cmd, onSubmit) {
    const fid = `cmd-${cmd.module}-${cmd.id}`;
    FORMS[fid] = onSubmit;
    const typeOf = (t2) => (t2 === 'number' ? 'number' : t2 === 'date' ? 'date' : 'text');
    const inputs = (cmd.params || []).map((p) => `<label class="cmd-field"><span>${esc(p.label)}</span>
      <input data-param="${esc(p.name)}" type="${typeOf(p.type)}" ${p.required ? 'required' : ''}></label>`).join('');
    return `<form class="cmd-form" data-cmd="${esc(fid)}">${inputs}
      <button class="btn" type="submit">${esc(cmd.title)}</button>
      <span class="cmd-msg hint"></span></form>`;
  }

  /** Wire every command form inside el to its module endpoint. */
  function bindForms(el) {
    (el.querySelectorAll ? el.querySelectorAll('form[data-cmd]') : []).forEach((f) => {
      const fid = f.dataset.cmd;
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const msg = f.querySelector('.cmd-msg');
        const params = {};
        f.querySelectorAll('input,select').forEach((i) => { if (i.dataset.param) params[i.dataset.param] = i.value; });
        try {
          const out = await FORMS[fid](params);
          if (msg) msg.textContent = out || 'done';
        } catch (e) {
          if (msg) msg.textContent = e.message || String(e);
        }
      });
    });
  }

  /** Mount a panel into an element. The panel gets the shell's own helpers. */
  function renderPanel(id, el, ctx = {}) {
    const p = PANELS.find((x) => x.id === id);
    if (!p || !el) return false;
    try {
      p.render(el, { t, api, fmt, esc, ...ctx });
      return true;
    } catch (e) {
      el.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      return false;
    }
  }

  return {
    t, setLang, lang: () => lang, api, fmt, esc, pinpad, toast, netBadge, I18N,
    emptyRow, errText, applyI18n, watchI18n, applyCaps,
    registerPanel, panels, addI18n, loadModules, loadScript, renderPanel,
    reportTable, commandForm, bindForms
  };
})();

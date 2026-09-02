# OpenPOS v2 — Plan & Roadmap
**"A POS for every Kenyan shop — any number of branches."**

> Status: **Days 7–8 of 60 complete** (Phase 5 — purchasing & suppliers). Roadmap
> restructured 2026-09-02 to the founder's 35-phase directive. The engineering contract is
> **`openpos/ARCHITECTURE.md`** — every phase implements it; rule changes go through its
> change log.

---

## 1. Vision

**A configurable retail operating system that can start incredibly small and grow into a
sophisticated multi-branch business platform without the business ever having to change
systems.**

One system that runs **1 branch or 100**, in **any trade** (duka, wines & spirits, boutique,
chemist, hardware, electronics, cosmetics, footwear, mini-mart…), with the Kenyan compliance
layer (KRA **eTIMS** + **M-Pesa**) built in as adapters, offline-first by design, and a
**module framework** so the next industry costs ≤ 1 build-day to add.

**The dividing line (agreed 2026-09-02):** a *POS with lots of features* shows everything to
everyone; *this* system checks the **business capability set** before every screen renders.
A single-till duka never meets the words "branch", "warehouse", "supplier" or "price level";
a 10-branch chain never meets a second system. The engine is complete from day one — what
changes with the business is what the application shows (rules **R-C**, ARCHITECTURE.md §3.0).

The build philosophy (agreed 2026-09-02):

1. **Define before we build** — architecture & universal rules first (Phase 1, done).
2. **Engines before UI** — product, stock, pricing, payments, shifts, finance are server-side
   engines with APIs; the UI is a thin client.
3. **Core + modules** — the core never knows its trade; industry behaviour is a module.
4. **Kenya-first adapters** — M-Pesa and eTIMS are pluggable adapters over clean engines, not
   checkout-specific hacks.
5. **Break it on real businesses** before polish, then pilot five.

### Market entry ticket (why this wins)
1. **KRA eTIMS invoice on every sale** (CUIN + QR; 48h offline queue) — mandatory for every
   business since 1 Jan 2024; KRA's 2026 validation engine cross-checks returns against eTIMS.
2. **M-Pesa reconciliation** (Daraja STK + C2B till/paybill/Pochi, idempotent callbacks) —
   the #1 daily pain; native reconciliation is now a major differentiator.
3. **Selling offline** (till never stops; syncs after).
4. **Thermal printing + replaceable hardware** (no proprietary terminal lock-in).
5. **Shrinkage/movement visibility** — Kenyan competitors (esp. wines & spirits) compete
   explicitly on exactly-this audit trail.
6. **Unified inventory for POS + WhatsApp/online selling** — increasingly a competitive
   requirement.

## 2. Competitor & compliance research (Sept 2026)

| Product | Price (KES/mo) | Notes |
|---|---|---|
| sell.ke | 0 / 2,999 / 6,999 | E-com + POS + M-Pesa STK + eTIMS receipts, offline, multi-branch |
| Veira | 2,999–9,999 | eTIMS-certified, offline-first, Daraja Till/Paybill/Pochi + card, free terminal |
| Mkufunzi POS | 2,500–5,000+ | eTIMS, payroll (PAYE/NSSF/SHA), WhatsApp concierge, AI copilot |
| Cute Profit | varies | Vertical editions: **wines & spirits (anti-theft)**, **chemist (batch/expiry)**, agrovet, electronics (IMEI) |
| PharmaPOS / Zameda | up to ~5,999 | FEFO, batch/expiry, prescriptions, **SHA/NHIF claims**, PPB-aligned controlled register |
| Loyverse | Free | Offline, multi-location — no native eTIMS |
| Duka Track / RetailWings / Amtel | 999–8,500 | Generic cloud POS/ERP, credit sales, multi-branch |

**Compliance facts that shape the build**
- **eTIMS**: every invoice needs seller KRA PIN, sequential unique number, buyer PIN (B2B >
  KES 50k), item details **with KRA item classification code**, correct tax type (16%/zero/
  exempt), VAT broken out, date+time, and **KRA control number (CUIN) + QR** from
  transmission. POS-grade path = **VSCU API** (Virtual Sales Control Unit); KRA allows a
  48h offline submission window; KRA describes development → testing → vetting → certification
  for third-party integrators (hence: **POS tax engine ≠ eTIMS adapter**, Phase 16).
- **M-Pesa (Daraja)**: STK push for counter checkout; C2B for Paybill/Till (incl. Pochi la
  Biashara); B2C payouts/refunds; Reversal; Balance. Sandbox shortcode `174379`, test phone
  `254708374149`; production approval 2–10 days + IP whitelisting. **The sync response ≠
  payment** — store `CheckoutRequestID`, wait for callback, handle it idempotently.
- **Pharmacy (PPB/GDP)**: FEFO mandatory; batch/lot + expiry at receipt; prescription/patient
  records; controlled-drug register (5y narcotics / 2y other retention); PPB product
  registration tracking; SHA (legacy NHIF) claims.
- **Wines & spirits**: 21+ purchase age (Liquor Control Act); excise on top of VAT; theft is
  the #1 loss driver → per-register audit + stocktaking focus.
- **Kenyan retail**: deni (informal customer credit) is a core workflow, not an edge case;
  barcodes + open-priced (weigh/measure) goods everywhere; KES + 16% VAT where registered.

## 3. Product definition (summary — full contract in ARCHITECTURE.md)

- **Hierarchy:** Business → Branch (1..N) → Location (1..N) → Register (1..N); warehouses are
  locations; departments slice a branch.
- **Product engine:** product → variants (size/colour/shade) → packs (case/carton) →
  batches (FEFO) / serials (IMEI) — one engine for *sugar 1kg*, *dress red/M*, *Jameson
  btl/case*, *paracetamol batch*.
- **Stock:** append-only move ledger (every change = who/why/where/reason); balances are a
  view over it; expected-vs-physical always answerable.
- **Payments:** independent engine with adapters (cash, M-Pesa, card, bank, credit/deni,
  store credit, other) — split/partial/deposits/refunds; light double-entry ledger so
  "what happened to the money" is always computable.
- **Branch isolation** enforced server-side: owner = everything, manager = branch,
  cashier = register.
- **Audit:** hash-chained; anything financially significant leaves evidence; corrections are
  new documents, never edits.
- **Offline-first:** local is the default; cloud is an addition (outbox sync, 48h eTIMS
  window, idempotent M-Pesa).
- **Modules:** spirits, boutique, pharmacy, mini-mart, hardware, electronics, cosmetics,
  footwear — configuration + hooks, never core forks.
- **Languages:** English + Swahili (core strings done Day 1; full coverage Phase 34).

## 4. Roadmap — 35 phases / 60 days

> Each day = one shippable increment with tests. Acceptance criteria are the definition of
> done per phase. (Existing Day-1 code = pre-architecture foundation; see build log.)

### Phase 1 — Product Architecture & Rules · Day 1 ✅
Entity hierarchy + universal rules defined (ARCHITECTURE.md): what a product/variant/pack/
batch/unit is; how prices resolve; how stock is owned and moved; how sales/refunds affect
stock; how payments affect financial records; branch isolation; auditability; what must work
offline; core vs industry-specific. **Acceptance: every later phase cites rules; no phase
contradicts the doc without a change-log entry.**

### Phase 2 — Business & Tenancy Foundation + Capability System · Day 2 ✅
- **Capability system (the meta feature, R-C):** `business_capabilities` (flags, per
  business); solo default (1 branch/1 location/1 register/1 owner, no warehouses/
  departments/price levels); capability-gated presentation everywhere (nav, screens,
  reports, settings, dashboard cards); one-tap unlocks (flag + optional seed — no
  migration); **guided-growth suggestions** (2nd till → location? · first deni → credit
  setup? · low stock → suppliers?); scaling vocabulary (shop vs branch)
- **Onboarding v2 (solo-first):** trade → name/phone → your name + PIN → done. KRA PIN/VAT
  optional + deferrable to settings; **no branch/register questions for a solo business**
  (the Day-0 wizard is replaced, not extended)
- Schema: business (tenant, `business_id` hook) → branch → **location** → **register**;
  warehouses (location flag); departments; migration of Day-1 branches/terminals
- Users, roles, **fine-grained permission matrix** (30+ permissions; role = named set;
  per-user override), assignment to branch/location/register
- Business settings · branch settings · tax settings (VAT, classes) · receipt settings ·
  currency
- **Acceptance:** a solo business sees **only** Till · Products · Customers · Sales ·
  Settings — no branch/warehouse/supplier/permissions concept anywhere (checked
  screen-by-screen); enabling multi_location unlocks the location UI instantly (flag, no
  migration); guided suggestions fire on 2nd register + first deni; 1 business / 3 branches /
  2 locations / 2 registers / 1 warehouse created and verified via API; a cashier on one
  register sees only that location's data; 1→100 branches needs no architectural change.

### Phase 3 — Universal Product Engine · Days 3–4 ✅
- Variants + axes (size/colour/shade/custom); multiple barcodes per variant; UoM
  (pcs/kg/L/m/roll/job); **packs/cases/cartons with own barcode + price**; cost; price
  levels (retail/wholesale/member); tax category; supplier link; reorder fields; images;
  custom attributes; CSV import/export incl. variants; KRA item code per variant
- Migration: flat Day-1 products → implicit single variants
- **Acceptance:** sugar 1kg (open price) · dress red/M (variant barcodes) · Jameson
  bottle/case (pack) · paracetamol batch — all in ONE engine, sellable, stockable,
  barcodable.
- **Done (Day 3–4):** all four acceptance products pass in the test suite. Variant identity
  = (product_id, canonical axes_key); stock re-keyed (variant_id, location_id). `GET
  /api/scan/:barcode` resolves unit **and** pack in one call (R-P3). Packs draw N base units
  from the same stock. Serials register/write-off move stock. Industry attribute defs
  (ABV, size, expiry…) live in variant `meta` — the core never learns a trade's fields
  (R-C9). Open-priced + fractional base units (sugar 1kg). CSV round-trips products +
  variants + packs. Supplier link + reorder level per product. UoM kept as unit label +
  open-priced flag; full multi-UoM conversion deferred to Phase 6 (pricing). 48 tests green.

### Phase 4 — Stock Ledger & Inventory Engine · Days 5–6 ✅
- Append-only moves with **reason codes**: purchase, sale, return in/out, damage, expiry,
  adjustment, stocktake, transfer, conversion, opening, refund
- Batch & serial allocation per move; balances = view over ledger + **integrity job**
  (view vs recomputed); expected-vs-physical queries; stock ageing; dead stock
- **Acceptance:** for any variant/branch the five questions (source? who? why? where now?
  what should physically be there?) answer via API; ledger rebuild == balance over 10k moves.
- **Done (Day 5–6):** one move engine (`writeMove`) is the only door for quantity changes;
  15 move types with per-type reason-code validation; FEFO batch allocation splits an
  outbound move into per-batch ledger rows (earliest expiry first); serial allocation;
  R-S8 negative stock impossible — oversell is an explicit, audited owner/manager act only.
  `stock_ledger_balances` view = recomputed ledger; integrity job (manager+) compares
  materialized vs view, reports mismatches, and repair is an explicit audited act (R-S7).
  `GET /api/stock/trace/:variantId` answers the R-S2 five questions in one call. Stocktakes:
  draft snapshots expected (per-batch lines for tracked products + residual), count, approve
  writes stocktake moves only for variances; approved stocktakes kept as evidence. Stock
  ageing buckets (≤30/31–90/>90 days by batch age) + dead stock (no consumption in N days).
  Batch expiry write-off endpoint. 60 tests green (was 48), incl. 10k-move rebuild == balance.
  Bonus fix: CSV import treated the string `"0"` as truthy — flags like track_batches were
  flipped to 1 on every round-trip (regression test added).

### Phase 5 — Purchasing & Supplier System · Days 7–8 ✅
- Suppliers (contacts, KRA PIN, terms), supplier price lists, POs (manual + **suggested from
  sales velocity × cover days × lead time**), goods received (partial, batch/serial capture,
  cost), **receiving discrepancies** (price/qty, approval), supplier invoices, supplier
  returns, supplier payments & balances, purchase price history, cost changes
- **Acceptance:** PO → partial GR with 2 discrepancies → invoice → payment, balances correct
  everywhere; suggested PO for top-20 fast movers matches the velocity math.
- **Done (Day 7–8):** purchasing is a capability (R-C) — off by default, 403-with-hint until
  enabled. Suppliers (KRA PIN, terms, **lead days**, balance, delete-blocked on open POs or
  owed money). POs with sequential `PO-` refs; suggested orders = `ceil(velocity × (lead +
  cover) − stock)` from 30-day sales velocity, most-urgent first, top-20. Goods received in
  parts (`GR-` refs, partial → received), batch/serial capture at the door, cost per line;
  **discrepancies** (over-receipt / price-overcharge) flagged pending at the door — reject an
  over-receipt → automatic supplier return (FEFO `return_out` move, lot decremented, PO
  restored) — approve → accepted. Invoices (`INV-`) with **payments that require channel
  evidence** (R-PAY: method + channel_ref), overpayment refused, dispute blocks payment,
  supplier balance = Σ invoices − Σ payments, correct at every step. Supplier returns
  (`SR-`) standalone + auto; purchase price history per product from the ledger. Manager
  **Purchasing** tab (capability-gated): suggestions → PO → receive → discrepancies →
  invoices/payments → returns → suppliers. **71 tests green** (was 60) incl. the full
  acceptance flow; 47-step UI smoke green.

### Phase 6 — Pricing Engine · Day 9 ✅
- Resolution chain (promo → customer → branch → pack → level → default); branch &
  customer-specific prices; time-based prices; **minimum-margin guard** (PIN/block); manual
  override + permission; immutable price history; price frozen onto sale lines
- **Acceptance:** same variant × 5 branches × 2 customer types × 1 promo = 11 correct
  prices; below-margin override demands manager PIN; every change leaves history.
- **Done (Day 9):** server-side chain — promo/time → customer → branch → pack → tier →
  default — with `source` on every answer (`GET /api/pricing/resolve`, testable with `now`).
  `price_rules`: one primary scope (promo code / customer / branch / tier) + combinable time
  window (date bounds and/or HH:MM of day); full CRUD, one-rule-per-scope validated at the
  door. **Margin guard (R-PR1):** floor precedence product → branch → global settings;
  policy `pin` or `block`; guarded on product/variant/pack/rule price writes; refusals are
  `403 margin_pin` / `403 margin_blocked`; the approving manager is recorded. **History
  (R-PR3):** append-only `price_history` (scope, field, old→new, user, approver, note)
  written in the same transaction as every price change; no update/delete route. Manager
  **Pricing** tab (EN/SW): rules, guard settings, history. Read-only `GET /api/customers`
  (module proper in Phase 11). **83 tests green** (was 71) incl. the full acceptance grid,
  PIN flow, block policy, floor precedence, history immutability and cashier permissions.

### Phase 7 — POS / Checkout Engine · Days 10–11 ✅
- Barcode scan (wedge), fast search, product grid, variant picker, cart, qty, discounts
  (permissioned), customer attach, **hold/resume**, **quote → invoice**, receipt (print/
  screen/HTML), notes, cashier assignment, supervisor approvals, multi-register concurrent
- **Design target: a cashier learns basic selling in minutes** — complexity stays behind the scenes
- **Acceptance:** new cashier's first unaided sale < 5 min; two registers selling
  concurrently without conflict; quote→invoice converts stock exactly once.
- **Done (Day 10):** sales engine `POST /api/sales` — chain-frozen `unit_price` per line
  (later price changes leave receipts intact — asserted), line discounts via `sales.discount`
  permission **or supervisor PIN** (approver recorded on the sale), age gate, per-line VAT
  (std/zero/exempt), stock moves exactly once through the Phase-4 move engine (FEFO per lot,
  `ref` = invoice no; oversell only as audited manager/owner act), cash (change) / M-Pesa
  (manual ref, Phase 8 swaps in STK adapters) / card, partial payments, **hold → suspended
  (zero stock) → `POST /api/sales/:id/pay`** (re-validates; double-pay refused), void
  (supervisor-only; reverses the exact lots taken; payments flagged refunded), sales
  list/detail/receipt-reprint. `sale_items.variant_id` + `sales.discount_by` +
  `base_variant_id` on product lists. Full till UI (`/pos.html`, EN/SW): staff sign-in
  (PIN pad), barcode wedge + search, category chips, product grid, variant picker, cart
  (qty/discount/note), customer + promo attach, hold + held-sales resume, printable
  receipt with KRA fields, cashier bound to their register. **96 tests green** (was 83)
  incl. two-till concurrency (8 units, 4+4, exact stock, distinct tills) + 25-step UI
  smoke. **Done (Day 11):** quote → invoice — `sales.kind` (sale/quote/invoice); a
  quote is a suspended sale that never touches stock; `POST /api/sales/:id/convert`
  re-validates the lines (deactivated item → 409, no stock move), takes payment and
  moves stock **exactly once**; pay-on-quote and double-convert refused; UI adds a
  Quote button, convert-from-held-list, and a dismissable first-run till hint
  (EN/SW) so a new cashier's first unaided sale is a scan-and-tap exercise.
  **98 tests green** (was 96) + 30-step UI smoke green; health + banner report Phase 7.

### Phase 8 — Payment Engine · Day 12
- Adapter architecture: cash · M-Pesa · card · bank · credit(deni) · store credit · other
- State machine, idempotency, split/partial payments, deposits, refunds-to-original-method,
  per-method reconcile status, light ledger writes; M-Pesa adapter = sandbox-ready + manual
  code mode
- **Acceptance:** split cash+M-Pesa(sandbox)+card sale reconciles; duplicate callback = no
  double-count; zero M-Pesa-specific code in checkout (adapter only).

### Phase 9 — Cashier Shifts & Till Control · Day 13
- Opening float, shift, cash movements, paid-outs, expenses, refunds, expected vs actual,
  variance, **shift handover**, closure; per-cashier accountability (discounts, refunds,
  voids, adjustments attributed)
- **Acceptance:** shift math ties to the shilling (float + cash sales − paid-outs − refunds +
  credit = expected); a 200 KSh shortage flags with the responsible cashier; handover makes a
  clean audit break. (OpenPOS v1's shift/reconciliation concepts ported here.)

### Phase 10 — Sales Lifecycle, Returns & Exchanges · Day 14
- Sale → payment → receipt → return → refund → exchange → cancellation → void → correction,
  with approval rules; full/partial returns (restock flags, batch/serial-aware), exchanges
  (price diff settles), wrong-item/damaged reason codes, customer/store credit,
  credit/debit notes (eTIMS-ready numbering)
- **Acceptance:** partial return of a batch item lands in the right batch; exchange price
  diff settles; every correction references its original; nothing edited in place.

### Phase 11 — Customer / Deni / Credit System · Day 15
- Phone-first profiles, home branch, purchase history, **credit (deni) accounts**: limits,
  credit sales from checkout, repayments (via payment engine), ledger + **statements**
  (print/WhatsApp), deposits, store credit, customer-specific pricing link, notes
- **Acceptance:** over-limit deni demands manager; M-Pesa repayment reduces balance and
  reconciles; printed statement matches the ledger to the shilling.

### Phase 12 — Multi-Branch Operating System · Days 16–17
- Branch dashboards; branch users/permissions/stock/pricing/expenses/suppliers/customers;
  **inter-branch & inter-location transfers**: request → approve → dispatch → receive,
  partial, discrepancies; transfer history; branch comparison
- Visibility hierarchy everywhere: **owner = entire business, manager = their branch,
  cashier = their register**
- **Acceptance:** 3-location transfer with 1 discrepancy fully traceable; branch manager's
  API cannot read branch 2 (tested); comparison report ranks branches by sales/margin/shrinkage.

### Phase 13 — Stock-Taking, Shrinkage & Reconciliation · Day 18
- Full / partial / **blind** counts, expected-vs-actual, variance with **reason codes**,
  approval, recount, historical takes, **shrinkage analysis** (by branch/location/variant/
  reason), employee/branch attribution
- **Acceptance:** blind take of 50 variants → approved → stock adjusted with reasons;
  shrinkage report names top-10 disappearing SKUs per branch; ledger integrity job clean.

### Phase 14 — Expenses & Business Finance · Day 19
- Expenses (categories, branch, register, payment), petty cash, cash movements, supplier
  balances, customer balances; **daily financial summary**: gross sales → discounts → net →
  COGS → gross profit → expenses → **net operating profit**; P&L-lite per branch +
  consolidated
- **Objective: the owner understands what happened to the money.**
- **Acceptance:** daily sheet ties (net − COGS − expenses = NOP) against independently
  computed ledger totals; petty cash reconciles.

### Phase 15 — Reporting & Business Intelligence · Days 20–21
Reports answer business questions, not "Sales Report": what sold · what made money · what
isn't selling · what's losing margin · best/worst cashier · best/worst branch · what's
disappearing · what's tied up in slow stock · what to reorder · where discounts/refunds/cash
shortages are unusually high. Four dashboards — **Owner / Branch Manager / Stock Manager /
Cashier** — with radically different information density. CSV + PDF export.
- **Acceptance:** every report drills down; dashboards load < 1s on 100k rows.

### Phase 16 — Kenyan Integration Layer · Days 22–23
**M-Pesa (real Daraja):** STK push, till, paybill (+Pochi), confirmation callbacks
(idempotent), **automatic matching to sales**, reconciliation report, B2C refunds,
sandbox→production switch in settings.
**eTIMS (real VSCU adapter over the Phase-8 queue):** transmit on sale, CUIN + QR on receipt,
KRA item-code validation, 48h offline window + resubmit, B2B buyer PIN > KES 50k,
credit/debit notes, eTIMS dashboard. **The POS tax engine (Phases 6/8) stays separated from
the eTIMS adapter** — KRA's third-party integration path (development → testing → vetting →
certification) runs against the adapter, not the core.
- **Acceptance:** sandbox sale → STK → callback → sale confirmed + eTIMS transmitted +
  CUIN/QR printed; kill network → 2 offline sales → restore → both transmit inside the
  window; M-Pesa recon = zero unmatched.

### Phase 17 — Offline-First Architecture · Days 24–25
Local transaction storage → local queue (outbox) → synchronization engine → conflict
detection (single-writer + first-ack rule, R-O4) → retry with backoff → server
acknowledgement → reconciliation; sync-status banner.
**Test matrix:** internet dies during checkout · after payment · app closes mid-sale ·
device restarts · two tills sell simultaneously · stock changes offline · branch offline for
hours · connection returns.
- **Acceptance:** matrix green — zero lost or duplicated money or stock.

### Phase 18 — Industry Module Framework · Days 26–27
Module loader + hook points (product fields, checkout gates, stock rules, reports,
permissions, UI parts, template data); business trade selection; demo module proves the loader.
- **Acceptance:** a new industry = fields + hooks + reports, **no core changes**.

### Phase 19 — Wines & Spirits Module · Day 28
Bottle/pack/case/carton economics (supplier case cost vs bottle margin), high-value stock
flags + per-register audit, fast-movers + weekend demand, cashier restrictions (manager PIN
for premium lines), deni controls, stock-counting focus, shrinkage reports.

### Phase 20 — Boutique / Fashion Module · Day 29
Style/size/colour **variant matrix** (variant-level inventory is fundamental, not optional),
brand/season/collection, variant barcodes & pricing, **markdown/clearance engine**,
size sell-through, colour sell-through, dead fashion stock.

### Phase 21 — Pharmacy Module · Days 30–31
Batch + expiry + **FEFO enforced at the till**, expiry alerts 90/60/30, batch traceability +
**recall drill**, controlled-substance register + permissions, wholesale pharmacy sales,
prescription workflows (where legally appropriate), insurance claim capture (SHA/NHIF, where
applicable), cold-chain capability, PPB registration tracking.

### Phase 22 — General Retail / Mini-Mart Module · Day 32
Grocery/household/FMCG, bulk, weight-based (scale) products, pack products, barcode + PLU,
promotions, fast-checkout mode, reorder rules, supplier purchasing.

### Phase 23 — Other Retail Modules · Days 33–34
**Hardware** (metres/kg/pieces/boxes/rolls, cut-from-roll) · **Electronics** (serial/IMEI,
warranties, repairs, customer ownership) · **Cosmetics** (shades/sizes/brands/bundles/expiry)
· **Footwear** (size/colour/width/style, variant barcodes).
- **Acceptance:** each module's core flow end-to-end on sample data; **adding the next
  industry costs ≤ 1 day.**

### Phase 24 — Promotions, Loyalty & Marketing · Day 35
BOGO, bundles, %/fixed discounts, customer-specific offers, coupons, campaigns, loyalty
points (earn/redeem as tender), VIP/tiers, customer segmentation.
- **Acceptance:** promos apply correctly through every payment method; loyalty-as-tender
  can't overspend; a segment drives a campaign.

### Phase 25 — WhatsApp & Customer Commerce · Day 36
Pluggable comms provider (Africa's Talking / Twilio + local-log fallback): WhatsApp/SMS
receipts, payment requests (STK deep link), customer statements, product sharing, mini
catalogue, **order-through-WhatsApp → the same sales engine**, notifications, low-stock/order
workflows. **Physical POS stock + online/social selling = one inventory.**
- **Acceptance:** a WhatsApp order becomes a real sale decrementing the same stock; receipt
  arrives < 10s after payment.

### Phase 26 — Online Store / Omni-Channel · Days 37–38 (architecture-first, optional)
One catalogue, one inventory, one customer; orders from POS / website / WhatsApp / manual /
future marketplaces → **same sales & inventory engine**; simple PWA storefront; stock
reservation window.
- **Acceptance:** web order + POS sale for the last unit — one wins, the other fails
  gracefully; one customer profile across channels.

### Phase 27 — Hardware & Peripheral Layer · Day 39
Barcode scanners, thermal printers (58/80mm ESC/POS, QR, drawer kick), cash drawers, customer
displays, label/price-tag printers, **scales** (serial protocol), POS terminals — per-register
device profiles, device test utility. **Hardware is replaceable, not proprietary.**
- **Acceptance:** swap printer/drawer/scanner via config only; label print matches shelf price.

### Phase 28 — Security, Audit & Fraud Controls · Day 40
Deep pass: audit log review, login history + failed-login detection, device sessions,
permission re-audit, approval workflows, **dedicated logs** (price overrides, discounts,
refunds, stock adjustments, voids/deletions, cash variance), branch restrictions, HTTPS
option, backup encryption.
**Philosophy: anything financially important leaves evidence.**
- **Acceptance:** 50-scenario financial-action audit finds no action without a trail.

### Phase 29 — Owner Intelligence · Days 41–42
Decision-making layer on real data: what's tying up the most cash (stock × cost × age) ·
which branch underperforms (vs its own history) · actual profit yesterday · why is variance
high at Branch 2 (root-cause drill) · what to reorder now · which cashier over-discounts ·
what hasn't sold in 60 days · anomaly flags (z-score on discounts/refunds/variance/velocity)
· daily owner digest (SMS/WhatsApp).
- **Acceptance:** every intelligence item = a real query with thresholds + alerts, no chatbot.

### Phase 30 — AI Business Assistant · later
Answers questions and flags anomalies **from the database** (structured queries, cited rows)
against actual sales, stock, customers, purchases, expenses, branches, payments, profit, staff
activity — not hallucinated advice. Built after pilot data exists.

### Phase 31 — Testing With Real Kenyan Businesses · Days 43–45
Scenario suites per trade (duka, wines & spirits, boutique, pharmacy, multi-branch retailer)
+ **deliberate breakage:** internet outage · duplicate payment · partial refund · wrong stock
count · cash shortage · M-Pesa mismatch · transfer not received · price changed after sale ·
product returned · expired batch · variant sold from another branch · device dies mid-
transaction.
- **Acceptance:** breakage matrix passes or yields filed, severity-rated defects; 3 real
  businesses run live transactions in test mode; **a brand-new solo shop owner onboards and
  trades without ever meeting an ERP concept** (observed, not assumed — R-C1/R-C2).

### Phase 32 — Performance, Security & Production Hardening · Days 46–48
DB optimisation + query perf (100k rows / 10k moves), API perf budgets, offline sync stress,
**backup / restore / DR drill**, security + permission review, error handling + structured
logging, monitoring (health, error rate), data export, **migration strategy** (schema
versioning, safe additive migrations).
- **Acceptance:** p95 checkout < 300ms local; restore drill < 30 min; chaos tests lose nothing.

### Phase 33 — Deployment & SaaS Layer · Days 49–50
Business registration (self-serve), **subscriptions** (plans, usage limits, billing via
M-Pesa, trials), **tenant isolation live** (`business_id`), admin console, versioning + safe
auto-updates, backups.
- **Acceptance:** two businesses side-by-side in one DB with zero data crossing; trial →
  paid via M-Pesa.

### Phase 34 — Final UX / Product Polish · Days 51–53
Only after functionality works: cashier speed (keyboard-first, shortcuts), responsive +
tablet, search speed, onboarding v2 polish, empty states, error messages, **receipt design
per trade**, dashboards, accessibility, full EN/SW coverage (UI + receipts), and a **solo-mode
audit**: every screen in a solo business walked for ERP leakage (R-C2) — anything that makes a
one-till owner pause is cut or hidden.

### Phase 35 — Pilot Release · Days 54–60
Deploy to **five** real businesses: 1 general shop · 1 wines & spirits · 1 boutique ·
1 pharmacy · 1 multi-branch. Observe: what they use, what they ignore, what confuses
cashiers, what owners check daily, where stock goes wrong, where payments go wrong, which
reports they actually need. Refine before broad release.
- **Acceptance:** pilots complete a full trading week; top-10 friction points fixed;
  go/no-go on broad release with evidence.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| 60 days is ambitious | Phase order is the contract; each day ships; scope trims only via the change log |
| eTIMS certification (KRA vetting) is external to our clock | Adapter + sandbox by Day 23; certification runs parallel to pilot; businesses may also run their own KRA account meanwhile (open question §8.4) |
| M-Pesa production approval (2–10 days) | Submit the moment sandbox is green (Day 23); manual M-Pesa mode keeps shops trading pre-approval |
| Variants/locations refactor touches early schema | All migrations additive + tested (Day 2); flat products → implicit variants |
| Offline + money = danger zone | Outbox + idempotency + reconciliation are non-negotiable; tested in Phases 17/31/32 |
| Multi-branch at a distance (different towns) | Phase 17 sync engine + Phase 33 cloud relay; same-town branches run one server |
| Single developer velocity | Engines are API-first → UI work is cheap; modules keep industries cheap |

## 6. Definition of done (Day 60)

Five pilot businesses trading on the product; eTIMS + M-Pesa live (production where approvals
landed); offline test matrix and breakage matrix green; EN/SW complete; onboarding < 15 min;
first sale < 5 min unaided; documentation + DR drill done.

## 7. Decisions & change log

- **2026-09-02 — Founder directive: 35-phase / 60-day restructure adopted.** Changes vs the
  original 24-day plan:
  1. Architecture & rules defined **before** heavy coding (Phase 1) — ARCHITECTURE.md written.
  2. **Location layer added** between branch and register; warehouses as locations.
  3. Payments become an **independent adapter subsystem** (Phase 8) — M-Pesa never touches
     checkout code.
  4. Real M-Pesa/eTIMS wiring moves to **Days 22–23**; their interfaces, tax engine and mock
     drivers are built earlier (Phases 6/8/10) so Day 22–23 is wiring + sandbox, not invention.
  5. **Deni** formalised as a first-class customer credit system (Phase 11).
  6. Industries become a **module framework** (Phase 18) with per-industry modules 19–23.
  7. **Multi-tenant hook** (`business_id`) from Day 2; SaaS layer Day 49–50.
  8. Real-business testing (43–45) precedes polish (51–53) and pilot (54–60).
  9. **2026-09-02 (2) — Capability model adopted (R-C):** "the POS must not feel like an
     ERP". The engine stays complete and capability-agnostic; **presentation is
     capability-gated** (every screen checks the business capability set). Solo default;
     trade templates seed capabilities; guided growth suggests unlocks; onboarding becomes
     solo-first (Phase 2); solo-mode audit added to Phases 31 & 34. ARCHITECTURE.md v2.
  10. **2026-09-02 (3) — Pilot = the founder's own shops.** No single-trade bias in module
      depth; their exact trades still to be stated — **needed by Day 28 (Phases 18–19)** to
      order which industry modules get built deepest.
  11. **2026-09-02 (4) — Deployment at pilot = self-hosted per business** (each shop runs
      OpenPOS on its own PC). The SaaS layer stays at Phase 33 (Days 49–50) and is pulled
      forward only if a pilot actually needs it. The `business_id` tenancy hook (Phase 2)
      keeps that option open at zero cost today.
  12. **2026-09-02 (5) — M-Pesa & KRA paperwork is READY** (paybill/till + business
      documents in hand). Action: submit the **production approval path the moment the
      sandbox is green (Days 22–23)** — the 2–10-day approval window finishes well before
      pilot, so production M-Pesa + eTIMS are live for the pilot week.

- **Cut line (agreed 2026-09-02):** if the schedule slips, trim **omni-channel (Days
  37–38) first**, then the **SaaS layer (Days 49–50)**. Non-negotiable: core engines,
  M-Pesa/eTIMS, offline test matrix, and the 5-business pilot. Process: one day per
  working session; each ends with a commit + live preview + acceptance criteria actually
  tested (tightly-coupled phase pairs may ship as one increment behind a flag).

## 8. Build log

### Pre-architecture foundation (2026-09-02, "Day 0")
- Scaffold `openpos/` (Node 22 built-in `node:sqlite` — zero native deps; Express 5; plain-ES
  UI, no build step); 28-table schema; first-run onboarding wizard; scrypt PIN auth +
  rate-limit/lockout; DB-backed sessions; branches/terminals; products (flat); stock + moves;
  hash-chained audit + verify; EN/SW core strings; dashboard; manager UI; **24 tests green**;
  live-verified spirits onboarding (21+ flags). Kept as foundation per ARCHITECTURE.md §6.

### Day 1 — Product Architecture & Rules ✅ (2026-09-02)
- ARCHITECTURE.md v1: entity hierarchy (Business→Branch→Location→Register), universal rules
  R-P/R-PR/R-S/R-PAY/R-B/R-A/R-O/R-M, module framework shape, tenancy hook, open questions.
- **ARCHITECTURE.md v2 (same day):** capability & progressive-disclosure model added
  (R-C §3.0) + product thesis — *a configurable retail operating system that starts
  incredibly small and grows without the business ever changing systems.*
- Roadmap restructured to 35 phases / 60 days (this document); Phase 2 now includes the
  capability system + solo-first onboarding v2.

### Day 2 — Capability System + Tenancy Foundation ✅ (2026-09-02)
**Backend (engines first):**
- `lib/capabilities.js` — 18-capability registry (EN/SW labels + descriptions), trade
  templates (`duka→deni`, `chemist→batches`, `spirits→packs`, boutiques→`variants`,
  `hardware→open_priced`, `electronics→serials`, …), **guided-growth suggestion rules**
  (2nd till in one location → multi_location · ≥3 out-of-stock products → purchasing ·
  first credit-sale → deni), enable-seeds (warehouse → creates a "Store Room" location).
- `lib/permissions.js` — 30-key permission matrix; roles = named sets (owner = all;
  manager = all except `capabilities.manage` + `staff.permissions`; cashier/staff = narrow
  till set); per-user **grants only ADD** (can never strip a role's base); `requirePerm`
  middleware enforced on every admin route (R-B2).
- `db.js` — schema v2: `locations` (branch→location→register, `is_warehouse`,
  `is_default`), `registers` (renamed from `terminals`), `departments`,
  `business_capabilities`, `user_permissions`; `business_id` tenant hook on all
  top-level tables (Phase 33, zero cost today); **stock re-keyed per location**;
  additive migrations for pre-Phase-2 dev DBs (terminals→registers, per-branch default
  "Main Store", stock branch→location move).
- `server.js` — full Phase-2 rewrite: **onboarding v2** (trade → name/phone → owner PIN;
  KRA/VAT optional & deferrable; branch/location/till created invisibly; capability rows
  + trade seeds); bootstrap returns caps/locations/registers/location-scoped stock +
  suggestions; branches/locations/registers/departments CRUD with guards (default
  location & branch undeletable; branch delete cascades registers/stock/locations, blocks
  on users/sales); capabilities + suggestions endpoints (owner-only); staff CRUD with
  branch/location/register assignment + per-user permission grants; **stock adjust with
  reason codes** (stocktake/damage/expired/other → `stock_moves(type=adjustment)` +
  audit); `/api/today` scoped by visible branches.

**UI (thin client over the engines):**
- Onboarding v2 (3 steps, solo-first — no branch/register questions, KRA step skippable).
- Dashboard: capability-gated nav cards (Staff/Layout appear only when enabled) +
  **"Grow your shop"** card rendering suggestions with one-tap Enable.
- Manager back office reworked: Products (always; inline **Adjust stock** with reason),
  Categories, **Tills** (register CRUD, always), Staff (gated `staff_roles`; location/till
  assignment + per-user permission editor for owner), **Layout** (gated
  `multi_location`/`multi_branch`: locations incl. warehouse flag + branches), Customers
  (placeholder — Day 15), Settings (always; **Features** section = capability toggles,
  owner-only), Audit (chain verify). EN/SW strings extended for all new vocabulary.

**Acceptance (all tested, 35 tests green, up from 24):**
- Solo duka: multi_branch/multi_location/staff_roles OFF, deni ON (trade seed); UI shows
  no branch/warehouse/supplier/permissions concept.
- Enable `multi_location` = flag flips, **zero rows migrated** (location count unchanged).
- Fixture via API: 1 business / 3 branches / 6 locations (incl. 1 seeded warehouse) /
  5 registers — verified.
- 2nd till in one location → `multi_location` suggestion fires (EN+SW reasons).
- Cashier assigned to BR02/Mall sees only BR02 branches/locations/registers; sample stock
  at other locations reads 0 for her; `/api/today` scoped to her branch.
- Cashier: product create 403 → owner grants `products.manage` → 200 → revoke → 403;
  `stock.adjust` grant lets her adjust (move + audit written at her branch's default
  location), revoke blocks again; manager cannot manage capabilities or grant
  permissions (403 both).
- Stock adjust writes append-only move with reason + hash-chained audit; reason
  mandatory (R-S3).
- Live smoke: spirits onboarding (packs seeded, 21+ products), grow-card suggestion,
  warehouse seed, cashier scope — all verified against the running server.

**Notes:** deni/purchasing suggestion *rules* are in place; their trigger data lands with
Phase 11 (customer ledger) and Phase 4 (stock ageing). `terminals`→`registers` migration
tested against a v1 dev DB.

### Day 3–4 — Universal Product Engine (Phase 3) ✅ (2026-09-02)
**Backend (engines first):**
- `db.js` — schema v3: `variants` (product_id + canonical `axes_key`, own sku/price/cost/
  wholesale/member/tax/kra, `active`, `meta` JSON), `variant_barcodes` (globally unique
  while active; `kind` unit/pack/custom; `pack_id`), `packs` (named multiple of base units,
  own price/barcode — **no separate stock**, draws N base units), `serials`,
  `attribute_defs` (industry keys → stored in variant `meta`), `suppliers`; **stock
  re-keyed (variant_id, location_id)** (was product_id, location_id). Additive migration:
  every existing product → one implicit variant (axes `{}`), its barcodes + stock moved —
  no data loss.
- `server.js` — product engine: variant CRUD (canonical axes, own-barcode assignment,
  multi-barcode per variant, 409 on cross-variant barcode clash), pack CRUD, **`GET
  /api/scan/:barcode` resolving unit AND pack in one call (R-P3)** returning
  {type, product, variant, location, stock_qty, effective price, pack?}, serials
  register/write-off (move stock), attribute-def CRUD, supplier CRUD + product
  supplier-link + reorder level, **CSV import/export** (products + variants + packs in one
  file; round-trips cleanly). Prices validated integer-shilling (R-P2); `null` variant
  price/cost = inherit from product (`eff()`). Open-priced + fractional base units
  (sugar 1kg). Deactivated variant stops resolving; product stock = sum of active variants.
- `lib/csv.js` — toCsv/fromCsv (no deps).
- `lib/capabilities.js` — fixed `getSuggestions` to join through variants (stock no longer
  has product_id).

**UI (thin client over the engines):**
- Manager **Products** tab reworked: inline **variant panel** (add/edit axes + own
  barcode/price, multi-barcode list), **pack** builder (name × multiple, own price +
  barcode), **serials** register/write-off, **CSV import/export** buttons, per-variant
  industry **attribute** editor (driven by `attribute_defs` → `meta`), supplier + reorder
  level on the product row, IMEI/serial + reorder pills. EN/SW strings added.

**Acceptance (all tested, 48 tests green, up from 35):**
- **Migration:** every flat product → implicit variant; stock intact and variant-scoped.
- **R-P3 scan:** one call resolves barcode → variant → stock → price; unknown barcode 404.
- **Dress red/M:** two variant barcodes, per-variant stock, dup-axes 409, ambiguous adjust
  400.
- **Multi-barcode:** unit + custom per variant; cross-variant clash 409.
- **Price override + integer-shilling:** variant price wins; fractional shilling 400.
- **Sugar 1kg:** open-priced, sells fractional base units.
- **Jameson bottle/case:** pack has own barcode + price ≠ 12×unit, draws same stock.
- **Paracetamol:** batches create FEFO-ordered lots; non-batch product 400.
- **Serials:** register/dup 409/write-off/double-write 400, all move stock.
- **Deactivated variant** stops resolving; product stock sums only active.
- **Attribute defs** CRUD + values live on variant `meta` (ABV).
- **Supplier link + reorder level** on product.
- **CSV round-trip:** export → delete → import restores product + variant + pack.

**Notes:** UoM kept as a unit label + `open_priced` flag (full multi-UoM conversion — kg/L
↔ pcs — deferred to Phase 6 pricing). Product images deferred to Phase 34 (storage not yet
designed). KRA item code per variant already on the variant row (used Phase 16).

### Day 5–6 — Stock Ledger & Inventory Engine (Phase 4) ✅ (2026-09-02)
**Backend (engines first):**
- `db.js` — schema v4 (additive): `stock_moves` gains `serial_id` + `unit_cost`;
  **`stock_ledger_balances` view** (recomputed ledger per variant × location — the R-S7
  source of truth); `stocktakes` + `stocktake_lines` (expected vs physical, variance);
  indexes on moves (variant, type).
- `server.js` — **one move engine** (`writeMove`) is the only door for quantity changes:
  15 move types (`opening · purchase · sale · return_in/out · transfer_in/out · adjustment ·
  damage · expiry_writeoff · stocktake · conversion · refund · hold/release`) with
  per-type reason-code validation; **FEFO batch allocation** splits an outbound move into
  per-batch ledger rows (earliest expiry first, no-expiry last); batch guards (in needs a
  batch, out bounded by batch stock); serial allocation; **R-S8** negative stock impossible
  — oversell only as an explicit, audited owner/manager act (cashiers refused). Existing
  adjust/serial endpoints rewired through the engine.
- Ledger surface: `POST/GET /api/stock/moves` (filters: variant/product/location/type/
  date, user+batch names joined), `GET /api/stock/balances` (materialized vs ledger per
  variant × location with match flag), `POST /api/stock/integrity` (R-S7: reports drift,
  `repair=true` reconciles to the ledger **and audits** — never silent), `GET
  /api/stock/trace/:variantId` (R-S2 five questions: from / changes / now / expected /
  batches), `GET /api/stock/aging` (≤30 / 31–90 / >90-day buckets by batch age), `GET
  /api/stock/dead?days=N` (on hand, no consumption), `POST /api/batches/:id/writeoff`
  (expiry write-off, bounded), `GET /api/batches?expiring=N`.
- **Stocktakes**: `POST /api/stocktakes` (draft; snapshots expected per variant — per-
  batch lines for tracked products + residual line), `PUT .../lines/:id` (count),
  `POST .../approve` (stocktake moves only for variances; manager `stocktake.approve`),
  `DELETE` (drafts only — approved stocktakes are kept as evidence).

**UI (thin client over the engines):**
- Manager **Stock** tab: balances (materialized vs ledger, drift pills), recent moves
  ledger (type filter, who/why/ref/qty), stocktake builder (new → count → approve),
  integrity check + explicit repair, stock ageing buckets, dead stock list. EN/SW strings.

**Acceptance (all tested, 60 tests green, up from 48):**
- **R-S2:** trace returns from/changes/now/expected for a real variant in one call.
- **10k moves:** ledger recomputation == materialized balances, 0 drift, integrity clean.
- **FEFO:** a -7 sale across two expiry dates splits into per-batch moves, earliest first.
- **Batch guards + R-S8:** inbound w/o batch 400; oversize out 400; oversell = owner
  audited move, cashier refused.
- **R-S7:** corrupted balance reported as an alert; explicit repair restores it + audit
  trail; cashiers cannot run integrity (403).
- **Stocktake:** draft snapshots expected; only variances become moves on approve;
  double-approve 400; approved stocktake not deletable.
- **Ageing/dead:** 200-day-old lot lands in the >90d bucket; never-sold item is dead;
  items with recent consumption are not.
- **Expiry write-off:** partial + remainder, bounded by batch qty, stock conserved.
- **Transfers (R-S5 shape):** out+in pair under one ref, net zero.

**Notes:** `conversion`/`hold`/`release` types exist in the ledger for Phase 6 (UoM) and
Phase 7 (checkout holds); actual sale/return moves land with the checkout engine (Phase 7)
through this same door. **Bug found & fixed along the way:** CSV import parsed flags with
`value ? 1 : 0`, so the exported string `"0"` read as true and every product silently
gained batch/serial tracking after a round-trip — now parsed numerically + regression test.
### Day 7–8 — Purchasing & Supplier System (Phase 5) ✅ (2026-09-02)
**Backend (engines first, all capability-gated behind `purchasing`):**
- `db.js` — schema v5 (additive): `suppliers.lead_days`; `po_items` + `gr_items` gain
  `variant_id` (+ `gr_items.po_id` backfilled) so receiving resolves variants;
  `po_items.discrepancy` / `discrepancy_status` (pending/approved/rejected); new tables
  `supplier_invoices` (+ `paid`/`outstanding`), `invoice_payments` (+ `supplier_id`),
  `supplier_returns`. All additive — no existing row touched.
- `server.js` — the purchasing surface, every route behind `needPurchasing` (403 + hint when
  the capability is off) and the `purchases.manage` permission:
  - **Suppliers**: CRUD (KRA PIN, phone, address, terms, **lead days**), live balance, delete
    blocked while open POs or owed money exist.
  - **Suggested POs** `GET /api/purchase/suggestions`: per product with an active supplier,
    `velocity = 30-day sale moves ÷ days`, `suggest = ceil(velocity × (lead + cover) − stock)`,
    most-urgent-first (lowest days-of-cover), top-N (default 20) — the velocity math, not a
    guess.
  - **POs**: create (sequential `PO-` ref, per-line cost, total = Σ qty×cost), list, detail,
    cancel (only while nothing received — received POs settle via returns).
  - **Goods received** `POST .../receive`: partial receipts (`GR-` ref, sent → partial →
    received), batch no + expiry + serial capture at the door, per-line cost; **discrepancies
    flagged pending** when a line over-receives (qty) or arrives above PO cost (price).
  - **Discrepancy decisions** `POST /api/po-items/:id/discrepancy`: approve = accept as-is;
    **reject an over-receipt = automatic supplier return** (FEFO `return_out` move, the lot is
    decremented, PO line restored to its ordered qty) — no double data entry.
  - **Invoices** (`INV-`) + **payments**: a payment needs a method **and a channel_ref** (R-PAY
    — every shilling out leaves evidence); overpayment refused; dispute blocks payment until
    resolved; supplier balance = Σ invoices − Σ payments, kept correct at every step.
  - **Supplier returns** (`SR-`) standalone (reason required) + the auto kind above;
    **purchase price history** per product read straight from the ledger.
- `writeMove` remains the only door for quantities — purchases/returns post as `purchase` /
  `return_out` moves, so the Phase-4 ledger, trace and integrity all see purchasing for free.

**UI (thin client):** manager **Purchasing** tab, visible only when the capability is on
(R-C): suggestions → one-tap "New PO" (pre-filled from the suggestion), PO detail with
partial-receive form (batch/serial capture) and discrepancy approve/reject, invoices with
inline pay + dispute, returns, and suppliers CRUD. EN/SW strings.

**Acceptance (all tested — 71 tests green, up from 60, + 47-step UI smoke):**
- **The acceptance flow:** PO → partial GR (15 of 20) → second GR with **2 discrepancies**
  (over-receipt + price overcharge, both flagged pending) → reject the over-receipt (auto
  supplier return, lot + PO restored) → approve the price → PO completes → invoice →
  partial + final payment (overpayment & missing channel_ref both refused) → **supplier
  balance correct at every step**.
- **Velocity math:** a seeded fast-mover (2 units/day over 30 days, stock 10, lead 7, cover
  14) is suggested at `ceil(2 × (7+14) − 10) = 32`, days-of-cover 5; items with no sales or no
  supplier are excluded.
- **Guards:** cancel only before any receipt (received POs settle via returns); double
  cancel refused; over-receipt can't push stock past the PO line silently; supplier delete
  blocked on open POs / owed money; every purchase/return/payment is an audited move or
  evidence row.

**Notes:** discrepancies resolve by decision, not by editing stock — the ledger never sees an
unexplained quantity. Cost is captured per line at the door (not from the product's cost), so
the purchase-history view shows what a product actually cost per lot. Suggested-PO cover days
and window are query params (defaults 30/14) so a business can tune its own appetite.

# OpenPOS v2 — Plan & Roadmap
**"A POS for every Kenyan shop — any number of branches."**

> Status: **Day 1 of 60 complete.** Roadmap restructured 2026-09-02 to the founder's
> 35-phase directive. The engineering contract is **`openpos/ARCHITECTURE.md`** — every
> phase implements it; rule changes go through its change log.

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

### Phase 2 — Business & Tenancy Foundation + Capability System · Day 2
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

### Phase 3 — Universal Product Engine · Days 3–4
- Variants + axes (size/colour/shade/custom); multiple barcodes per variant; UoM
  (pcs/kg/L/m/roll/job); **packs/cases/cartons with own barcode + price**; cost; price
  levels (retail/wholesale/member); tax category; supplier link; reorder fields; images;
  custom attributes; CSV import/export incl. variants; KRA item code per variant
- Migration: flat Day-1 products → implicit single variants
- **Acceptance:** sugar 1kg (open price) · dress red/M (variant barcodes) · Jameson
  bottle/case (pack) · paracetamol batch — all in ONE engine, sellable, stockable,
  barcodable.

### Phase 4 — Stock Ledger & Inventory Engine · Days 5–6
- Append-only moves with **reason codes**: purchase, sale, return in/out, damage, expiry,
  adjustment, stocktake, transfer, conversion, opening, refund
- Batch & serial allocation per move; balances = view over ledger + **integrity job**
  (view vs recomputed); expected-vs-physical queries; stock ageing; dead stock
- **Acceptance:** for any variant/branch the five questions (source? who? why? where now?
  what should physically be there?) answer via API; ledger rebuild == balance over 10k moves.

### Phase 5 — Purchasing & Supplier System · Days 7–8
- Suppliers (contacts, KRA PIN, terms), supplier price lists, POs (manual + **suggested from
  sales velocity × cover days × lead time**), goods received (partial, batch/serial capture,
  cost), **receiving discrepancies** (price/qty, approval), supplier invoices, supplier
  returns, supplier payments & balances, purchase price history, cost changes
- **Acceptance:** PO → partial GR with 2 discrepancies → invoice → payment, balances correct
  everywhere; suggested PO for top-20 fast movers matches the velocity math.

### Phase 6 — Pricing Engine · Day 9
- Resolution chain (promo → customer → branch → pack → level → default); branch &
  customer-specific prices; time-based prices; **minimum-margin guard** (PIN/block); manual
  override + permission; immutable price history; price frozen onto sale lines
- **Acceptance:** same variant × 5 branches × 2 customer types × 1 promo = 11 correct
  prices; below-margin override demands manager PIN; every change leaves history.

### Phase 7 — POS / Checkout Engine · Days 10–11
- Barcode scan (wedge), fast search, product grid, variant picker, cart, qty, discounts
  (permissioned), customer attach, **hold/resume**, **quote → invoice**, receipt (print/
  screen/HTML), notes, cashier assignment, supervisor approvals, multi-register concurrent
- **Design target: a cashier learns basic selling in minutes** — complexity stays behind the scenes
- **Acceptance:** new cashier's first unaided sale < 5 min; two registers selling
  concurrently without conflict; quote→invoice converts stock exactly once.

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

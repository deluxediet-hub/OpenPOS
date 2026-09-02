# OpenPOS v2 — Plan & Roadmap
**"A POS for every Kenyan shop, any number of branches."**

> Name: **OpenPOS v2** (white-label; branding, receipt layout and store name configurable per business)
>
> Build is phased: one "day" (one tested, demonstrable increment) at a time. Status: PLAN / Day 1.

---

## 1. Vision

One system that a wine & spirits shop, a chemist, a boutique, a general shop (duka), a hardware
store or a salon can run out of the box — **any number of branches under one roof**, with the
Kenyan compliance layer (KRA eTIMS + M-Pesa) built in, not bolted on. It borrows the proven
concepts from OpenPOS (first-run onboarding, PIN roles with manager escalation, Z-reports,
shift float reconciliation, daypart pricing, gift cards & loyalty, tabs, offline-first
SQLite) and adds what the Kenyan market actually demands (multi-branch, real M-Pesa, eTIMS,
vertical trade templates, credit/kodisha, Swahili).

### Why this wins (positioning from research)
The market's entry ticket is four things, and most local products only do two of them:
1. **KRA eTIMS invoice on every sale** (CUIN + QR printed, transmitted; 48h offline queue)
2. **M-Pesa reconciliation** (Daraja STK push + C2B paybill/till, idempotent callbacks)
3. **Selling offline** (internet drops → till keeps working; syncs after)
4. **Thermal printing** (80mm ESC/POS receipts + drawer kick)

Nobody combines all four with **"any trade, any number of branches, own your data, English +
Swahili, no subscription lock-in."** That is the wedge.

### What we deliberately are NOT
- Not a restaurant table-service POS first (that's OpenPOS' job; restaurant becomes one trade
  template later — tables/KDS can be added from OpenPOS).
- Not a full accounting ERP in v1 (we produce VAT summaries, P&L-lite and eTIMS-ready data).
- Not a multi-tenant SaaS in v1 (one install = one business, unlimited branches — exactly how a
  Kenyan chain actually deploys: a cheap PC or small server per site).

---

## 2. Market & competitor research (Sept 2026)

| Product | Price (KES/mo) | Strengths | Weaknesses / gap we exploit |
|---|---|---|---|
| **sell.ke** | 0 / 2,999 / 6,999 | E-commerce + POS + M-Pesa STK + eTIMS receipts, offline, multi-branch, Airtel, WhatsApp sharing | E-commerce-first; POS is secondary; one vertical mindset |
| **Veira** | 2,999 / 5,999 / 9,999 | eTIMS-certified, offline-first, Daraja Till/Paybill/Pochi + card, free terminal, pharmacy edition w/ expiries | Paid only, newer brand, per-vertical focus |
| **Mkufunzi POS** | 2,500 / 5,000+ | eTIMS, payroll (PAYE/NSSF/SHA), WhatsApp concierge, AI copilot, accounting | Heavy ERP; breadth over depth at till |
| **Cute Profit** | varies | eTIMS + M-Pesa automation; vertical editions incl. **wines & spirits (anti-theft stock control)**, **chemist (batch/expiry)**, agrovet, electronics (IMEI) | Accounting-brand; POS is a module |
| **PharmaPOS / Zameda** | up to ~5,999 | FEFO, batch/expiry, prescriptions, **SHA/NHIF claims**, PPB-aligned controlled register | Pharmacy-only; not a general shop system |
| **Loyverse** | Free (add-ons) | Offline POS, multi-location, very fast cashier | No native eTIMS, M-Pesa via 3rd party, no Kenyan verticals |
| **Duka Track / RetailWings / Amtel** | 999–8,500 | Cloud POS/ERP, credit sales, multi-branch | Generic African cloud; offline & compliance shallow |
| **SimbaPOS / JiPOS / NomadPOS** | varies | Restaurant/hotel niches, multi-store | Single-industry |

**Read-across:** the local incumbents all lead with "eTIMS + M-Pesa"; the differentiators that
sell are **per-trade depth** (chemist FEFO, spirits age-gate + anti-theft, duka kodisha),
**multi-branch consolidation**, **offline**, and **price**.

### Compliance facts that shape the build
- **eTIMS is mandatory for every business** (since 1 Jan 2024, VAT-registered or not). KRA's
  2026 validation engine cross-checks returns against eTIMS data; non-compliance penalties
  reported at KES 50,000/month up to KES 1M / 3 years.
  - Every invoice needs: seller KRA PIN, sequential unique number, buyer PIN (B2B > KES 50k),
    item details **with KRA item classification code**, correct tax type (16% / zero / exempt),
    VAT broken out, date+time, and the **KRA control number (CUIN) + QR** returned on
    transmission.
  - POS-grade integration path = **VSCU (Virtual Sales Control Unit) API**: transmit on sale,
    print CUIN + QR, queue offline invoices and resubmit (KRA allows a 48h offline window).
- **M-Pesa (Daraja)**: STK push ("Lipa Na M-Pesa Online") for counter checkout; C2B for
  Paybill/Till (incl. Pochi la Biashara); B2C for payouts/refunds; Reversal; Account Balance.
  - Sandbox: shortcode `174379`, test phone `254708374149`. Production: KYB + 2–10 day
    approval + IP whitelisting.
  - **The trap:** the sync response ≠ payment. Must store `CheckoutRequestID`, wait for the
    callback, handle it **idempotently** (Safaricom retries), then flip the sale.
- **Pharmacy (PPB/GDP guidelines)**: FEFO is mandatory for stock rotation; batch/lot + expiry
  captured at receipt; prescription/patient records; **controlled-drug register** (records kept
  5 years for narcotics, 2 years others); PPB product registration tracking; SHA (legacy NHIF)
  claim capture at the counter.
- **Wines & spirits**: legal purchase age **21+** (Liquor Control Act); no sales to intoxicated
  persons; excise duty applies on top of VAT; theft is the #1 loss driver → per-terminal audit.
- **General shop**: credit sales (kodisha) are core; barcodes everywhere; open-priced goods
  (price/kg + scale); KES + 16% VAT where registered.

---

## 3. Product definition

**OpenPOS v2** = offline-first, local-server POS + back office. One install = one business
(1..N branches, unlimited). Runs on any cheap PC or Raspberry-Pi-class box; Node 18+,
Express + SQLite (better-sqlite3), plain-ES frontend, **no build step** (inherit OpenPOS).
Everything the till needs is local; the cloud is only used when online (eTIMS, M-Pesa, SMS).

### Trade templates (onboarding picks one; modules toggle on)
| Template | Extra modules enabled |
|---|---|
| **Duka (general shop)** | Credit/kodisha, open-price (price/kg) items, barcodes, supplier POs |
| **Wines & Spirits** | 21+ age gate at checkout, anti-theft flags + per-terminal audit, pack sales (btl/6×/case), wholesale price list, excise notes |
| **Chemist / Pharmacy** | Batch + expiry + FEFO at till, expiry alerts 90/60/30d, expired-stock sale block, prescription ledger, controlled-drug register, SHA/NHIF claim fields, PPB registration tracking |
| **Boutique** | Variants (size/colour), brands, collections, alterations/services, layaway |
| **Hardware / Wholesale** | Tiered/bulk pricing, customer credit, delivery notes |
| **Restaurant** (later phase) | Tables, KDS, service-charge VAT rules (ported from OpenPOS) |

### Feature matrix (everything, and where it lands)

| Area | Features | Phase |
|---|---|---|
| **Setup** | First-run wizard (business, KRA PIN, VAT reg status, 16% VAT, trade template, owner PIN, sample data per trade); per-branch settings; branding (logo, receipt footer); EN/Swahili UI | 1, 5, 7 |
| **Security** | PIN + password auth, salted scrypt hashes, login rate-limit + lockout, session expiry, role matrix (Owner/Manager/Cashier/Staff), manager-PIN escalation for discounts/voids/refunds, tamper-evident audit log (hash chain), HTTPS option | 1 |
| **Multi-branch** | Unlimited branches; branch-scoped stock/pricing/staff/terminals; per-branch VAT status; per-branch price overrides; consolidated vs per-branch dashboards & reports; HQ view of all branches | 3 |
| **Catalog** | Products w/ SKU + barcode + KRA item code + tax type; unlimited categories (age-restricted / Rx flags on category or product); brands; units & packs (each/6×/case); variants (size/colour); per-branch price overrides; image; CSV bulk import; active/discontinued | 1 |
| **Inventory** | Stock per branch; moves ledger (purchase/sale/transfer/adjust/damage/return); reorder points + low-stock alerts; batch/lot + expiry (FEFO pick); stocktake (cycle count) w/ variance approval; FIFO cost valuation; expiry reports; recall lookup by batch; dead stock | 1, 4 |
| **Purchasing** | Suppliers (KRA PIN, terms); purchase orders (manual + auto-suggest from reorder); partial receiving with batch/expiry capture; supplier statements & payments; 3-way match-lite | 3 |
| **POS till** | Grid + search + barcode-scan (keyboard-wedge); suspend/resume; line & order discounts (manager PIN); customer attach; credit sale to account; age verification gate (21+ / 18+); Rx check (chemist); open-price weight entry; split payments; part-payments; gift card & loyalty as tender; receipt: ESC/POS 58/80mm print + screen + WhatsApp/email/SMS share; happy-hour/daypart pricing; promotions (BOGO, % off, bundle, coupon codes) | 1, 4 |
| **Payments** | Cash (server-computed change, quick notes); **M-Pesa Daraja STK** (pending→callback state machine, idempotent, reconciliation); M-Pesa manual (code) fallback; C2B paybill/till webhook; card (EDC ref); B2C refunds (optional); store credit; per-branch float | 2 |
| **Shifts & Z** | Shift open w/ float, payouts, expected-vs-counted, variance flag; Z-report (per branch, per shift); cash drawer kick | 1 |
| **eTIMS** | Sequential invoice numbers per branch; VSCU driver (online transmit + CUIN + QR); **offline queue w/ 48h window & auto-resubmit**; B2B buyer-PIN capture > KES 50k; credit/debit notes; eTIMS dashboard (transmitted/pending/failed); VAT summary for ITR6/ITR11 | 2 |
| **Customers** | Phone-first profiles; purchase history; **kodisha credit accounts** (limit, ledger, repayments, aging, credit hold); loyalty points (earn/redeem); tiers; birthday; statements; SMS/WhatsApp notifications | 5 |
| **Gift cards** | Sell/reload/redeem/expiry, balance guards, overspend protection, audit | 4 |
| **Back office** | Staff mgmt (PINs, roles, branch assignment, disable); timeclock; staff performance; terminal/hardware config (printer IP, drawer, scanner); per-terminal audit (anti-theft) | 3, 5 |
| **Reporting** | Daily sales per branch + consolidated; sales by item/category/tax/payment; top products; gross profit (P&L-lite); stock valuation; low stock; expiry; credit aging; cashier performance; VAT summary; eTIMS reconciliation; CSV + PDF export | 3, 6 |
| **Analytics** | Today vs last week; category & cashier performance; days-of-inventory; dead stock; margin trends; branch-vs-branch comparison | 6 |
| **Data & ops** | Nightly SQLite backup + full export; CSV import (products, customers); EN/Swahili; label/price-tag printing | 6 |
| **Offline-first** | Local server + SQLite; till never blocks on cloud; M-Pesa/eTIMS queue + auto-sync; sync-status banner | 1 (hardened in 6) |
| **Phase 7 (optional)** | Cloud sync for geographically remote branches; online ordering (WhatsApp/website); payroll (PAYE/NSSF/SHA); full ledger + bank rec; Android terminal app | 7 |

---

## 4. Architecture

```
openpos/
├── server.js            # Express app: API + static + webhooks (/api/webhooks/mpesa)
├── db.js                # better-sqlite3 schema + migrations + seed helpers
├── lib/
│   ├── auth.js          # scrypt PINs, sessions (DB-backed, expiry), rate limit + lockout
│   ├── money.js         # integer-peso KES math (no float money), VAT engine
│   ├── etims/
│   │   ├── driver.js    # interface: transmit(invoice) → {cuin, qr}
│   │   ├── vscu.js      # real KRA VSCU API (online)
│   │   └── mock.js      # deterministic sandbox driver (dev/tests, same interface)
│   ├── mpesa/
│   │   ├── driver.js    # interface: stkPush(), c2bCallback(), status()
│   │   ├── daraja.js    # real Daraja (sandbox + prod, OAuth token cache)
│   │   └── manual.js    # code-entry fallback mode
│   ├── escpos.js        # 58/80mm ESC/POS commands, QR (KRA), drawer kick
│   └── audit.js         # hash-chained audit log
├── public/              # plain ES modules, no build step
│   ├── index.html       # shell: login / onboarding / dashboard
│   ├── pos.html         # till
│   ├── manager.html     # catalog, stock, purchasing, customers, branches
│   ├── reports.html     # all reports + eTIMS dashboard
│   └── assets/...
├── test/run.js          # node test runner (unit + API + UI via jsdom, like OpenPOS)
└── data/                # SQLite (gitignored)
```

**Key design rules**
1. **Multi-tenant-lite:** every table is `branch_id`-scoped; `NULL branch_id` = global/HQ.
   Roles + branch assignment enforced server-side on every route.
2. **Money in integer shillings** (no floats anywhere). VAT engine: 16% standard / zero /
   exempt per line; tax type + KRA item code travel on the product.
3. **Payment = state machine**, never confirm-on-click:
   `pending → (STK request) → awaiting_callback → confirmed | failed | timeout`, with
   idempotent webhook handling + `mpesa_log` for reconciliation.
4. **eTIMS = queue, never block the till:** sale closes, invoice enters `etims_queue`;
   driver (VSCU or mock) transmits when online; CUIN + QR attach to the sale and (re)print.
   Offline sales get sequential "offline" numbering that maps into KRA's 48h window.
5. **FEFO at the till:** when a tracked product is sold, the batch with earliest expiry is
   auto-selected (and shown); expired batches are unsellable, period.
6. **Audit hash chain:** each audit row hashes prev row → voids/discounts/refunds tamper-evident.
7. **Drivers are swappable** (mock ↔ real) behind interfaces: the whole compliance layer is
   testable in sandbox with zero credentials.

### Data model (v1 tables)
`settings, branches, users, categories, products, price_overrides, stock, stock_moves, batches,
transfers, transfer_items, suppliers, purchase_orders, po_items, goods_receipts, gr_items,
sales, sale_items, payments, mpesa_log, shifts, shift_payouts, customers, customer_ledger,
gift_cards, loyalty_log, promos, prescriptions, controlled_register, audit_log, counters,
etims_queue, timeclock, terminals`

---

## 5. Phase plan (day by day)

> Each "Day" = one working increment, tested, demonstrable. Phases = weeks.

### Phase 1 — Foundation: a shop you can open & sell in (Days 1–4)
- **Day 1 — Skeleton + onboarding + security core.** Scaffold `openpos/`; schema v1; server up;
  first-run wizard (business name, KRA PIN, VAT reg status, 16%, trade template, owner PIN,
  optional sample data); PIN auth (scrypt) + login rate-limit/lockout + expiring DB-backed
  sessions; branch "HQ + Branch 1" created. *Demo: run it, onboard, log in.*
- **Day 2 — Catalog & stock engine.** Categories, products (barcode, cost, price, tax type,
  KRA item code, packs), CSV import; stock per branch + moves ledger; manual receiving;
  low-stock view. *Demo: import 200 SKUs, take stock, see alerts.*
- **Day 3 — The till (v1).** POS screen (grid/search/barcode field), cart, line edit,
  discounts w/ manager-PIN, cash payment (server-computed change), shift open/close (float,
  payouts, expected vs counted), Z-report, on-screen receipt. *Demo: full cash sale + Z.*
- **Day 4 — Payments depth + returns + printing.** Split & part payments, refunds/returns with
  restock + audit, suspend/resume tickets, ESC/POS printing (80mm + QR-ready) + drawer kick,
  per-terminal config; per-branch daily sales report. *Demo: split M-Pesa-manual + cash sale,
  printed receipt, refund, restock verified.*

### Phase 2 — Kenyan compliance core (Days 5–8)
- **Day 5 — eTIMS (queue + mock driver).** Invoice model (sequential per-branch numbers, tax
  classes, item codes); offline queue w/ 48h window; mock VSCU driver (deterministic CUIN +
  QR payload); receipt shows CUIN + KRA QR; eTIMS dashboard (transmitted/pending/failed).
- **Day 6 — eTIMS (real VSCU + edge cases).** Real VSCU driver (auth, transmit, retry,
  resubmit); B2B buyer-PIN capture > KES 50k; credit/debit notes; VAT summary report;
  sandbox tests.
- **Day 7 — M-Pesa (STK state machine).** `mpesa_log` + state machine; Daraja STK driver
  (sandbox 174379); idempotent callback webhook; sale only closes on `confirmed`; manual
  M-Pesa mode fallback; payment↔invoice reconciliation view.
- **Day 8 — M-Pesa (C2B + card + recon report).** C2B paybill/till webhook (Pochi la Biashara
  flow), card (EDC ref), M-Pesa daily reconciliation report per branch (expected vs received),
  end-to-end sandbox tests.

### Phase 3 — Multi-branch + purchasing (Days 9–12)
- **Day 9 — Branches everywhere.** Branch CRUD; per-branch staff assignment & terminals;
  per-branch price overrides; per-branch VAT status; consolidated dashboard (all branches);
  per-branch vs consolidated reports; branch picker on till.
- **Day 10 — Inter-branch stock.** Transfers: request → approve → ship → receive (partial ok);
  stock moves between branches; cross-branch low-stock suggestion ("branch 2 has 40 — pull?").
- **Day 11 — Purchasing.** Suppliers; POs (manual + auto-suggest from reorder points);
  partial receiving with cost/batch capture; supplier statements & payments.
- **Day 12 — Reports v1.** P&L-lite per branch + consolidated (revenue, COGS, gross profit);
  FIFO stock valuation; VAT summary; payment mix; CSV + PDF export.

### Phase 4 — Trade verticals (Days 13–16)
- **Day 13 — Chemist.** Batch+expiry on receipt; **FEFO pick at till**; expired blocks;
  expiry alerts 90/60/30; prescription ledger; controlled-drug register (PPB-aligned, 5y/2y
  retention flags); SHA/NHIF claim capture; PPB registration tracking + alerts.
- **Day 14 — Wines & spirits.** 21+ age gate (confirm + ID note) on restricted categories;
  anti-theft flags w/ per-terminal audit report; pack sales (btl/6×/case); wholesale price
  list; excise/VAT notes on receipts & reports.
- **Day 15 — Boutique + duka extras.** Variants (size/colour), brands, collections;
  alterations/services; open-price items (price/kg + weight at till); layaway (simple);
  gift cards (sell/reload/redeem/expiry, guards) + loyalty points (earn/redeem as tender).
- **Day 16 — Promotions engine.** Promo types: % off, fixed off, BOGO, bundle, time-based
  (happy hour); coupon codes; applies-to (product/category/all); guards (max uses, customer
  tiers); promo performance report.

### Phase 5 — Customers, credit, comms, back office (Days 17–20)
- **Day 17 — Customers + kodisha.** Phone-first profiles; attach to sale; purchase history;
  **credit accounts**: limit, sale-on-account, repayments (cash/M-Pesa), ledger, aging report,
  credit hold at till.
- **Day 18 — Loyalty & gift cards (full).** Points earn rules + redeem-as-tender; gift card
  lifecycle + statements; customer 360 page.
- **Day 19 — Notifications.** SMS/WhatsApp receipt + templates (pluggable provider: Africa's
  Talking / Twilio, with local-log fallback); daily sales digest to owner; low-stock & expiry
  digests.
- **Day 20 — Back office.** Staff mgmt UI (PINs, roles, branch assignment, disable);
  timeclock + labour report; terminal/hardware config; anti-theft per-terminal audit;
  permission audit trail review.

### Phase 6 — Scale & polish (Days 21–24)
- **Day 21 — Offline hardening + backup.** Online/offline detection & sync banner; M-Pesa +
  eTIMS queue auto-resubmit (48h window respected); nightly SQLite backup + full data export;
  restore drill.
- **Day 22 — Analytics.** Dashboard: today vs last week; top products; category & cashier
  performance; days-of-inventory; dead stock; margin trends; branch-vs-branch comparison.
- **Day 23 — i18n + templates + labels.** Full **English/Swahili** UI + receipt language;
  sample-data templates for every trade (duka, chemist, spirits, boutique, hardware);
  label/price-tag printing.
- **Day 24 — Hardening & docs.** E2E suite green; security pass (session, rate limit, hash
  chain, HTTPS option); INSTALL + USER GUIDE (EN/SW) + API doc; launcher scripts (.sh/.bat);
  polished demo seed (3 branches: duka + chemist + spirits chain).

### Phase 7 — Beyond (Day 25+, optional)
Cloud sync for remote branches · online ordering (WhatsApp/website) · payroll
(PAYE/NSSF/SHA) · full double-entry ledger + bank rec · Android terminal app · restaurant
template (tables + KDS ported from OpenPOS).

---

## 6. Risks & mitigations
| Risk | Mitigation |
|---|---|
| KRA VSCU sandbox access is fiddly | Mock driver first (Day 5) — product works end-to-end in dev; real driver swaps in Day 6 without touching till logic |
| Daraja production approval (2–10 days) | Sandbox flows from Day 7; manual M-Pesa mode keeps shops trading pre-approval |
| Scope creep ("all features") | Phased plan is the contract; Phase 7 items explicitly deferred |
| Offline + multi-branch sync complexity | v1 = one server, unlimited branches (LAN). Cloud sync is Phase 7 |
| Money bugs | Integer shillings + unit tests on every tax/total path (inherit OpenPOS' tested VAT logic) |
| Printing hardware variance | ESC/POS abstraction with 58/80mm modes + screen-receipt fallback |

## 7. Definition of done (v1, Day 24)
A 3-branch demo business (duka + chemist + wines & spirits chain) that: sells offline with
barcode + cash + M-Pesa STK (sandbox) + card; prints eTIMS receipts (mock CUIN/QR) that
transmit when online; enforces 21+ at the spirits counter, FEFO + expiry blocks at the chemist,
kodisha credit at the duka; shows the owner one consolidated dashboard and per-branch P&L;
backs up nightly; speaks English and Swahili.

## 8. Build log

### Day 1 (2026-09-02) — SKELETON + ONBOARDING + SECURITY CORE ✅
- Scaffold `openpos/` (Node 22 built-in `node:sqlite` — zero native deps; Express 5; plain-ES UI, no build step)
- Full multi-branch schema v1 (28 tables: branches, products, stock, batches, transfers, POs,
  sales, payments, mpesa_log, shifts, customers, gift cards, promos, prescriptions,
  controlled register, eTIMS queue, audit, …)
- First-run onboarding wizard: business → KRA/VAT → first branch → owner PIN + trade template
  with sample data (duka / chemist / spirits / boutique / hardware)
- Security: scrypt PIN hashes, DB-backed sessions (12h), login rate-limit (5 fails → 5 min
  lock, per staff + per IP), server-side role checks, hash-chained tamper-evident audit log
  with verify endpoint
- Manager back office: products (flags: Rx, controlled, batches, open-price, min-age),
  categories, branches (unlimited), staff, settings, audit
- Dashboard: today's sales, product/branch counts, shift status, online/offline badge,
  EN/SW core strings + language toggle
- Test suite: 24 tests (money/VAT math, full API flow, lockout, RBAC, audit-chain tamper) — **all green**
- Live-verified: onboarded a wines & spirits shop end-to-end (21+ age flags in catalog)

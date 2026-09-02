# OpenPOS v2 — Product Architecture & Universal Rules

> **Phase 1 · Day 1 deliverable.** This document is the contract. Every later phase
> implements it. If a phase needs to change a rule, this document is updated first and
> the change is logged in §9. No module may contradict a rule here.

---

## 1. What the system is

**The product thesis (agreed 2026-09-02):** a *configurable retail operating system* that can
start incredibly small and grow into a sophisticated multi-branch business platform **without
the business ever having to change systems.**

A single-till duka must never meet the words "branch", "warehouse", "supplier" or "price
level". A 10-branch chain must never meet a second system. The engine is complete from day
one (that is the "never change systems" guarantee); what changes with the business is **what
the application shows** — every part of the application checks the **business capability set**
rather than assuming every business has everything (rules R-C, §3.0).

A **single offline-first system** that runs a Kenyan business — 1 branch or 100 — across any
trade. One SQLite deployment per business (today); the schema carries a `business_id` tenant
hook so the same code becomes multi-tenant SaaS (Phase 33) without a redesign.

Three structural commitments from day one:

1. **Engines before UI.** Product, stock, pricing, payments, shifts and finance are serverside
   engines with APIs; the UI is a thin client over them. Fancy reports (Phase 15) must be
   possible *before* they exist.
2. **Core + modules.** The core never knows it is a pharmacy or a wine shop. Industry behaviour
   is activated by a module (Phase 18 framework) that adds fields, checkout gates, stock rules,
   reports and permissions — it never forks the core.
3. **Capabilities, not features.** Presentation is capability-gated (R-C): the system starts
   solo and unlocks concepts as the business grows — data changes, never deployments.

## 2. Entity hierarchy

```
Business (tenant)                     name, KRA PIN, currency, base tax, trade, language
├─ Tax settings                        VAT rate, tax categories, class rules
├─ Receipt settings                    footer, logo, language, eTIMS display, QR
├─ Branch (1..N)                       legal/operational/reporting unit; may carry its own
│   │                                   KRA PIN + VAT status; scoped users, stock, pricing,
│   │                                   expenses, suppliers, customers
│   ├─ Location (1..N)                 PHYSICAL site (address, hours). Stock lives here.
│   │   └─ Register / Till (1..N)      device bound to a location; scanner/printer/drawer
│   └─ Warehouse / Store (0..N)        a Location flagged is_warehouse (non-selling stock)
│   └─ Department (0..N)               organisational slice (e.g. Wines, Snacks, Services)
├─ User (1..N)                         assigned to branch / location / register
│   └─ Role → Permissions              global matrix (fine-grained) + branch scope
├─ Product catalogue (business-level master)   variants, packs, barcodes, units, prices
├─ Supplier (business-level, branch-scoped links)
└─ Customer (business-level, home branch, deni ledger)
```

**Definitions that settle all later ambiguity**

- **Branch** — the unit that is independently reportable, taxable, staffed and priced.
  ("Branch 2" in an owner report means this.)
- **Location** — a physical place inside a branch where stock sits and sales happen.
  Default: every branch auto-gets one location, "Main Store". A branch with two shops in the
  same town = 2 locations. A branch with a back store = warehouse location.
- **Register** — a till device bound to one location. Every sale belongs to exactly one
  register (and therefore to a location and branch).
- **Branch scope rule** — `branch_id` + `location_id` live on every operational row. Global
  masters (products, customers, suppliers) are business-level; branches see scoped views with
  overrides (price, active state).

## 3. Universal rules

### 3.0 Capabilities & progressive disclosure (R-C) — *the meta rule*

**A POS must not feel like an ERP.** Every part of the application checks the business
capability set before rendering a concept — it never assumes every business has everything.
The engine and API stay capability-agnostic and complete; **gating is a presentation and
workflow concern**, so any later unlock is instant (a flag, not a migration).

- **R-C1 — Solo default.** A new business starts as: 1 branch · 1 location · 1 register ·
  1 owner · no warehouses · no departments · one price level · no staff roles. In the UI this
  is simply "my shop" — the words *branch / location / register* never appear for a solo
  business.
- **R-C2 — Capability-gated presentation.** Every nav item, screen, tab, report, settings
  group, dashboard card and onboarding step checks the capability set before rendering. A
  concept is shown only when its capability is enabled.
- **R-C3 — Capabilities are data, not deployment.** Enabling = flag + (optionally) a small
  setup/seed. No migration, no reinstall, no "upgrade path". 1 → 10 branches happens inside
  the same installation.
- **R-C4 — Trade templates set initial capabilities** (chosen at onboarding; owner may toggle
  any of them on/off later):

  | Trade | Enables |
  |---|---|
  | Duka / general shop | deni, barcodes, optional open-price |
  | Wines & spirits | age gate, packs, high-value flags, weekend view |
  | Boutique / fashion | variants, markdowns, season/collection |
  | Pharmacy | batches/expiry/FEFO, Rx, controlled, insurance claims |
  | Hardware | open units (m/kg/roll) |
  | Electronics | serials/IMEI, warranties |
  | Mini-mart | open-price, PLU, promotions |
  | Cosmetics / footwear | variants (shade/size/width) |

- **R-C5 — Guided growth.** The system watches the shape of the business and *proposes*
  unlocks with one-tap confirmation — suggests, never forces, never silently enables:
  "You added a second till — make it a separate location?" · "First deni sale — want a credit
  limit and automatic statements?" · "12 products below reorder — set up your suppliers?"
- **R-C6 — Vocabulary scales.** Solo business hears "products · stock · customers · till";
  multi-location hears "locations · transfers"; multi-branch hears "branches · comparison".
  Same engine, named at the business's level.
- **R-C7 — Complexity budget.** The till is a fixed set of concepts: scan/search → cart →
  pay → done. Any extra concept on the till must earn its place via a capability or a trade
  module. The complexity belongs behind the scenes.
- **R-C8 — Reports & dashboards are functions of capabilities.** Solo owner dashboard:
  Today · Stock · Customers · Sales. "Branch comparison" requires multi_branch; "supplier
  balances" requires purchasing; "shrinkage" requires a stocktake; "expiry report" requires
  batches.
- **R-C9 — Never retrain.** A business that grows 1 → 10 branches keeps the **same till**.
  What unlocks is the back office — not the counter.

**Capability list (v1)**

*Core (always on, mostly invisible):* products & selling, stock levels, sales history &
receipts, owner account, business/tax/receipt settings, simple stock adjust ("counting your
stock is not a feature — it's housekeeping").

*Progressive (off until unlocked):*

| Capability | Unlock moment | What appears |
|---|---|---|
| `staff_roles` | second user added | staff list, roles, PIN escalation, timeclock |
| `multi_location` | second till / shop | location picker, location transfers |
| `multi_branch` | second branch created | branch dashboards, branch pricing/staff, comparison |
| `warehouse` | non-selling storage needed | warehouse location, warehouse movements |
| `departments` | organisational slicing needed | department field + department reports |
| `purchasing` | first supplier | suppliers, POs, goods received, supplier balances |
| `deni` (credit) | first credit sale | credit limits, ledger, statements, aging |
| `price_levels` | wholesale/member trade | level picker at checkout |
| `promotions` / `loyalty` | retention program started | promos, coupons, points, tiers |
| `variants` / `packs` / `batches` / `serials` / `open_priced` | trade template or per-product need | matching product & checkout UI |
| `expenses` | money-out tracking wanted | expenses, petty cash, P&L-lite |
| `stocktake_pro` | first blind count | blind counts, shrinkage analytics |
| `comms` / `online` | WhatsApp / social selling | receipts, statements, order capture, unified stock |

### 3.1 Product model (R-P)

| Concept | Definition |
|---|---|
| **Product** | Sellable thing, business-level: identity (name, brand, model), classification (category, tax class), compliance flags (age, Rx, controlled), traceability mode (none / batch / serial) |
| **Variant** | A product's sellable permutation over configured axes (size, colour, shade, custom). **The variant is the stock-keeping and selling unit.** A product with no axes = one implicit variant (existing Day-1 products become these) |
| **UoM** | Base unit per variant: pcs, kg, L, m, roll, job… Open-priced goods (weigh/measure) sell fractional base units — `qty REAL`, money still integer shillings |
| **Pack** | Named multiple of the base unit (case = 12 btl) with its **own barcode and price** (not forced to 12× bottle price). Selling a case decrements 12 base units. Packs are a *selling representation* of the same stock, never separate stock |
| **Batch** | For batch-tracked variants: lot with batch no, expiry, supplier, cost, qty. Stock = Σ batches. **FEFO** picks earliest expiry. Batches are immutable (qty only decreases via moves) |
| **Serial** | For serial-tracked variants (electronics): each unit has serial/IMEI; a sale binds it to a customer; warranty tracked |
| **Barcodes** | 1..N per variant (EAN/UPC/internal). Barcode must resolve to exactly one active variant; duplicates across variants = import/setup error |
| **Attributes** | Custom JSON attributes per product/variant (abv%, caffeine, cold-chain) + optional structured attribute definitions for reporting |

Rules:
- **R-P1** Stock always exists on the *variant*, never the parent product.
- **R-P2** Prices stored VAT-inclusive, integer shillings.
- **R-P3** A barcode scan resolves variant → location stock → price chain in one server call.
- **R-P4** KRA item classification code lives on the variant (eTIMS line item).

### 3.2 Pricing (R-PR)

Resolution chain — **first match wins**, computed server-side at line add, re-validated at
payment, **frozen onto the sale line**:

1. Active time-based price / promotion (applies to variant + customer + branch)
2. Customer-specific price (deni/VIP agreement)
3. Branch price override
4. Pack price (when the line is a pack)
5. Price level for the customer's tier (retail / wholesale / member)
6. Default selling price

- **R-PR1** Minimum-margin guard: a manual override that would push margin below the
  configured floor (per product or branch) requires a manager PIN (or is blocked — configurable).
- **R-PR2** Discounts are separate from prices (line discount, order discount), each permissioned,
  each audited.
- **R-PR3** `price_history` is append-only (who/when/from/to, scope). A sale line's frozen price
  is never altered by later price changes.
- **R-PR4** Pack ≠ duplicate product: case price can be 12× bottle price *or less*; both sell
  from the same stock.

### 3.3 Stock ledger (R-S) — *the heart of the system*

**Stock is a ledger, not a number.** `stock_moves` is an append-only event log; current
balances are a view over it and can always be recomputed.

- **R-S1** Every quantity change is exactly one move:
  `opening · purchase · sale · return_in · return_out · transfer_in · transfer_out ·
  adjustment · damage · expiry_writeoff · stocktake · conversion · refund · hold/release`
  with: location, variant, batch (if tracked), serial (if tracked), signed qty, **reason code**,
  reference (PO/GR/sale/transfer/take id), user, timestamp.
- **R-S2** The system must always answer, for any variant in any location:
  *Where did this stock come from? · Who changed it? · Why? · Where is it now? · What should
  physically be there?* (expected = ledger balance; physical = last approved stocktake +
  subsequent moves; variance is reportable, never silently fixed.)
- **R-S3** **Sales decrement stock at checkout commit** — the moment the sale is committed for
  payment (goods leave the shelf), even if payment is still in flight. A void/cancel before any
  payment restores stock. A partial-paid sale stays decremented (goods gone, balance on deni).
- **R-S4** **Returns restock only when goods physically come back** (per-line flag); a
  store-credit-only refund does not restock. Restock targets the original batch where tracked
  (FEFO-consistent), else current batches FIFO.
- **R-S5** **Transfers are atomic moves between locations** (out at source, in at destination,
  one transfer id) — never copies. Partial receipt + discrepancy flagging (Phase 12).
- **R-S6** **Conversions** (case↔bottle representation, cut-a-metre-from-a-roll) change
  representation while conserving base units.
- **R-S7** A periodic integrity job asserts `view == recomputed ledger`; mismatch = alert,
  never silent correction.
- **R-S8** Negative stock is impossible: a sale/transfer is refused when location stock (or
  batch stock) is insufficient — except an explicit *oversell permission* (manager) which is
  audited.

### 3.4 Payments (R-PAY) — *an independent subsystem with adapters*

The core defines a **payment order** (sale, method, amount, status). Each method is an
**adapter** implementing `initiate / confirm / refund / reconcile`. Checkout code never
contains M-Pesa specifics (this is the Phase-8 requirement made a rule).

Methods: `cash · mpesa · card · bank · credit(deni) · store_credit · other`.

- **R-PAY1** State machine for every payment: `pending → confirmed | failed | refunded`.
  The server — never the client — decides totals: a sale is payable only when
  `Σ confirmed payments = sale total` (or the remainder is intentionally moved to deni).
- **R-PAY2** **Idempotency**: every external payment carries an idempotency key
  (`sale:line:method`); a duplicate callback (Safaricom retries) is a no-op.
- **R-PAY3** **Reconciliation**: every payment carries a channel reference (MPESA ref, EDC ref,
  till ref) + reconcile status (`matched / unmatched / mismatched`). Daily recon compares
  channel statement (API or import) vs payment rows.
- **R-PAY4** Cash change is computed server-side. Float belongs to the shift (Phase 9).
- **R-PAY5** Split & partial payments, deposits, and refunds-to-original-method are core.
- **R-PAY6** **Financial records**: every confirmed payment writes to a light double-entry
  `ledger` (accounts: CASH, MPESA, CARD, BANK, CREDIT_CUSTOMER, STORE_CREDIT, REVENUE,
  DISCOUNT, VAT_PAYABLE, COGS, EXPENSE). This powers Phase 14 and is exportable to accounting
  packages — we are not an accounting package, but we never lose the money trail.
- **R-PAY7** A deni sale is a `credit` payment: moves the amount to the customer ledger;
  repayments are separate transactions through the same engine.

### 3.5 Branch isolation (R-B)

- **R-B1** Scope columns on every operational row (branch, location, register where physical).
- **R-B2** Enforcement is **server-side on every route**: user's role × assigned branch ×
  location × register. A cashier's API cannot read another location's stock or sales; a branch
  manager cannot read another branch; the owner sees all.
- **R-B3** Role visibility is a product rule, not a UI trick: owner = entire business,
  branch manager = their branch, stock manager = their branch's stock, cashier = their register.
  The same filter applies to dashboards, reports and exports.
- **R-B4** Global masters are shared; **overrides are scoped** (price, active, reorder).

### 3.6 Auditability (R-A)

- **R-A1** Hash-chained audit log (built Day 1): every financially significant action —
  login, price change, discount, override, refund, void, adjustment, transfer, stocktake
  approval, payment, settings, permission change — writes an entry.
- **R-A2** **Anything financially important leaves evidence. No exceptions.** There is no UI
  path to a financial mutation without an audit entry (enforced by the server, reviewed in
  Phase 28 against a 50-scenario checklist).
- **R-A3** Transactions are immutable: corrections are new documents (credit note, debit note,
  adjustment) referencing the original. Nothing is ever edited in place.
- **R-A4** The chain is verifiable (`/api/audit/verify` exists); verification is an owner action
  and a Phase-32 DR check.

### 3.7 Offline-first (R-O)

The local server (SQLite on the business's own machine) is the **default** mode; the cloud is
an addition, not a dependency.

- **R-O1 — Must work with zero internet:** entire checkout (catalogue, stock, pricing, sales,
  cash/card/deni payments, receipts, stock moves, held sales, quotes, shift control,
  stocktake entry, expenses).
- **R-O2 — Queued offline, synced automatically (outbox pattern):** eTIMS invoice transmission
  (KRA's 48h offline window, sequential offline numbering), M-Pesa *completion* of already-
  initiated payments, expenses, stocktakes, reports, notifications.
- **R-O3 — Cannot work offline (by physics):** initiating M-Pesa STK (Safaricom's network),
  live eTIMS confirmation, WhatsApp/SMS delivery, online-store orders. A sale whose M-Pesa
  payment can't be initiated is held as `awaiting_mpesa` and completed when online; manual
  M-Pesa code entry always works offline.
- **R-O4 — Conflict policy:** most entities are single-writer (a register writes its own sales;
  stock moves are append-only and merge by sequence). The only real conflict is shared stock
  (warehouse allocation) while disconnected: **first-acknowledged wins, the other side gets a
  flagged adjustment**, never silent loss.
- **R-O5 — Durability:** a sale is durable the moment it is written locally (WAL) — an app kill
  or power cut mid-sale must never lose a payment or double-decrement stock (test matrix in
  Phases 17 & 31).

### 3.8 Core vs industry-specific (R-M)

**Core (always on):** tenancy & setup, product/variant/pack/batch/serial engine, stock ledger,
purchasing, pricing, POS/checkout, payment engine + adapters, shifts & till control, sales
lifecycle & returns, customers & deni, transfers, stocktaking & shrinkage, expenses & finance,
reporting, audit, offline sync, hardware layer, security.

**Industry modules (activated per business trade; see §4 framework):**

| Module | Adds |
|---|---|
| Wines & Spirits | 21+/18+ age gate, bottle/pack/case economics (supplier case cost vs bottle margin), high-value flags + per-register audit, weekend-demand view, cashier restrictions, shrinkage focus |
| Boutique / Fashion | variant matrix first-class, markdown/clearance engine, size/colour sell-through, season/collection, dead-fashion stock |
| Pharmacy | FEFO enforcement, expiry block + 90/60/30 alerts, recall drill, controlled register + permissions, prescription ledger, wholesale pricing, insurance claim capture (SHA/NHIF), cold-chain flag, PPB registration tracking |
| General retail / mini-mart | open-price scale flow, PLU, promotions at till, fast-checkout mode, reorder tuning |
| Hardware | metres/kg/rolls, cut-from-roll behaviour |
| Electronics | serial/IMEI, warranties, repair jobs, customer ownership |
| Cosmetics | shades/sizes, bundles, expiry where applicable |
| Footwear | size/colour/width, variant barcodes |

- **R-M1** A module = fields + checkout hooks + stock rules + reports + permissions + template
  data. It **never** modifies the payment engine, ledger core or audit.
- **R-M2** Product/variant *flags* drive behaviour (`age_min`, `requires_rx`, `is_controlled`,
  `track_batches`, `track_serial`, `open_priced`, `cold_chain`); a module is configuration +
  hooks, not a fork.
- **R-M3** Adding a new industry must cost ≤ 1 build-day (the Phase-23 acceptance test).

## 4. Module framework (Phase 18 target shape)

```
modules/
├── loader.js        # activate(business.trade) → registry
└── spirits.js       # { name, activate(db), checkoutHooks: {validateLine, beforeCommit},
                      #   stockRules: {feFof? no—FEFO is core, expiryBlock: yes},
                      #   reports: [...], permissions: [...], ui: ['/modules/spirits.js'],
                      #   template: 'spirits' }
```

Hook points (core exposes these; modules plug in):
1. `productFields` — extra variant/product columns (via generic attribute definitions)
2. `checkout.validateLine` / `checkout.beforeCommit` — age gate, Rx check, controlled check
3. `stock.rule` — block expired sales, FEFO enforce, serial bind
4. `reports` — registered report definitions (Phase 15 renders them)
5. `permissions` — role additions (e.g. controlled-drug access)
6. `ui` — extra panels/fields rendered by the manager/POS pages
7. `template` — onboarding sample data

## 5. Tenancy & data

- One SQLite file per deployment; **every top-level table carries `business_id`** (default 1)
  — Phase 33 multi-tenant SaaS = more businesses in the same DB, isolated by the column.
- Schema versioning: `schema_version` table + additive migrations on boot (tested, reversible
  where practical). Full export: all tables CSV + single-file DB backup.

## 6. How Day-1 code maps to this architecture

| Built (Day-1 code, 2026-09-02) | Status vs architecture |
|---|---|
| Business setup wizard, settings (business/tax) | ✓ Phase 2 extends (branch settings, receipt settings, departments, warehouses) |
| Branches, terminals | ✓ becomes Branch → Location → Register (Day 2 migration: each branch auto-gets "Main Store", terminals bind to it) |
| Users, 4 roles, PIN auth, lockout, sessions | ✓ Phase 2 adds fine-grained permission matrix + branch/location/register assignment |
| Products (flat), categories | Phase 3 upgrades: variants, packs-as-model, multiple barcodes, UoM, attributes — additive migration (flat products → implicit variants) |
| Stock + moves (opening/purchase/sale/adjust) | ✓ ledger pattern already correct; Phase 4 adds all move types, reason codes, batches per move, integrity job |
| Audit hash chain + verify | ✓ R-A1/R-A4 done at core level |
| Sales/payments schema | Phase 8 reshapes payments into the adapter engine (schema ready: `payments`, `mpesa_log`) |
| EN/SW core strings, dashboard, manager UI | ✓ foundation; polished in Phase 34 |

**No rework planned — all extensions are additive.**

## 7. What must be true for the pilot (Day 60)

- Any business onboards in < 15 minutes (wizard + template data) — and a **solo shop never
  sees an ERP concept** (R-C1/R-C2, checked screen-by-screen).
- A cashier completes a first sale unaided in < 5 minutes (Phase-7 acceptance).
- eTIMS + M-Pesa live (production where approvals landed; sandbox + manual mode always works).
- The offline test matrix (Phase 17) and the break-it matrix (Phase 31) are green.
- Five pilot businesses (1 duka, 1 spirits, 1 boutique, 1 pharmacy, 1 multi-branch) complete a
  full trading week.

## 8. Open questions (answer before the phase that needs them)

1. **Warehouse transfers while offline** — first-ack-wins adjustment (R-O4) vs block outbound:
   confirm at Phase 12.
2. **Deni limits** — per customer vs per customer+branch: default per-customer, confirm Phase 11.
3. **Multi-currency** — KES-only now; USD for boutique imports? Hook exists (settings), confirm
   before Phase 6.
4. **eTIMS certification** — KRA third-party vetting runs parallel to the pilot; businesses can
   also run with their own KRA account in the meantime (confirm pilot preference).

## 9. Change log

- **2026-09-02 (v2)** — **Capabilities & progressive disclosure model added (R-C, §3.0)**
  per founder direction: "the POS should not feel like an ERP". Product thesis adopted
  (§1): a configurable retail operating system that starts incredibly small and grows into a
  sophisticated multi-branch platform without the business ever changing systems. Solo
  default (R-C1), capability-gated presentation (R-C2), capabilities are data not deployment
  (R-C3), trade templates seed capabilities (R-C4), guided growth (R-C5), scaling vocabulary
  (R-C6), till complexity budget (R-C7), capability-shaped reports (R-C8), never retrain
  (R-C9). Capability list v1 defined. Onboarding becomes solo-first (v2) in Phase 2.
- **2026-09-02 (v1)** — Initial architecture written from the founder's 35-phase directive.
  Introduces: Branch → **Location** → Register hierarchy; `business_id` tenant hook; payment
  **adapter** architecture (R-PAY); stock-as-ledger with reason codes (R-S); pricing resolution
  chain (R-PR); core-vs-module split (R-M); module hook framework shape (§4).

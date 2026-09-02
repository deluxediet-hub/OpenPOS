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
  *Done (Day 9):* floor precedence = product `min_margin_pct` → branch `settings.min_margin_pct` →
  global `settings.pricing.min_margin_pct`; policy `settings.pricing.margin_policy` = `pin`
  (manager/owner PIN via `pin` or `override_pin` on the same request) or `block`. Refusals are
  `403 {code:'margin_pin'}` / `403 {code:'margin_blocked'}`. Guarded surfaces: product
  price/wholesale/member (create + edit), variant prices, pack prices (create + edit), price-rule
  create + edit — the approver is recorded on the resulting history row.
- **R-PR2** Discounts are separate from prices (line discount, order discount), each permissioned,
  each audited. *Phase 7 (Day 10), at checkout.*
- **R-PR3** `price_history` is append-only (who/when/from/to, scope). A sale line's frozen price
  is never altered by later price changes. *Done (Day 9):* one row per change —
  `scope` = product / variant / pack / rule, `field`, `old_price` → `new_price`, `user_id`,
  `approved_by` (the PIN that approved a below-margin change), `note`. No update/delete route
  exists. Every surface that writes a price (product create/edit, variant edit, pack create/edit,
  rule create/edit/delete) writes history in the same transaction.
- **R-PR4** Pack ≠ duplicate product: case price can be 12× bottle price *or less*; both sell
  from the same stock. *Done (Day 9):* step 4 of the chain; a branch rule still outranks the pack.
- **Done (Day 9) — resolution engine:** `GET /api/pricing/resolve?variant_id&branch_id&customer_id&pack_id&promo_code&now`
  runs the chain above server-side and returns `{price, cost, margin_pct, floor_pct,
  below_margin, source, source_ref, rule_id}` (`source` = promo | time | customer | branch |
  pack | level | default). Rules = `price_rules` rows (one primary scope: promo code, customer,
  branch or tier; a time window — dates and/or HH:MM of day — may combine with any).
  Price is frozen onto the sale line at Phase 7 (line add) and re-validated at payment;
  Day 9 ships the engine + guard + history + `GET /api/price-rules` CRUD + `GET /api/customers`
  (read-only until Phase 11) + the manager **Pricing** tab (rules, guard settings, history).
- **Done (Day 10) — freeze & re-validation:** a sale line's `unit_price` is set by the chain at
  line add and is **never altered afterwards** — a later price change leaves old receipts intact
  (asserted in tests). At payment, a held sale is re-validated (variant + product must still be
  active) and stock moves **exactly once**, FEFO for batch-tracked lines, each line's lot recorded
  on the sale line and in the ledger (`ref` = invoice no). Cashiers sell from their bound
  register; every sale is attributed to branch / location / register / cashier.

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
| Products (flat), categories | ✓ **Phase 3 done (Day 3–4):** variants + canonical axes keys (flat product → implicit variant, additive migration), packs-as-model drawing from base stock, multiple barcodes per variant (unit/pack/custom), single `GET /api/scan/:barcode` resolving unit **and** pack (R-P3), serials, industry attribute defs in variant `meta` (R-C9), open-priced + fractional base units, CSV import/export, supplier link + reorder level. UoM kept simple (unit label + open-priced flag); full multi-UoM conversion deferred to Phase 6 pricing |
| Stock + moves (opening/purchase/sale/adjust) | ✓ **Phase 4 done (Day 5–6):** single move engine (15 types + per-type reason codes) is the only door for quantity changes; FEFO per-batch ledger rows; serial allocation; R-S8 oversell = explicit audited manager/owner act; `stock_ledger_balances` view + integrity job (R-S7: alert, audited repair); R-S2 five-question trace API; stocktakes (per-batch + residual, variance-only moves, evidence kept); ageing + dead stock; expiry write-off |
| Suppliers, POs, GR, supplier invoices/returns (schema stubs) | ✓ **Phase 5 done (Day 7–8), capability-gated (R-C):** suppliers (KRA PIN, terms, lead days, live balance, delete-blocked on open POs/owed money); suggested POs from 30-day sales velocity `ceil(v × (lead + cover) − stock)`; POs → partial GR with batch/serial + per-line cost at the door; receiving discrepancies (over-qty / price) pending → **reject over-receipt auto-writes the supplier return** (FEFO `return_out`, PO line restored); invoices with evidence-backed payments (R-PAY: method + channel_ref, overpay refused, dispute blocks payment); supplier balance = Σ invoices − Σ payments; per-lot purchase price history from the ledger. All quantities move through the Phase-4 move engine (`purchase` / `return_out`), so trace + integrity cover purchasing unchanged |
| Pricing: chain, rules, guard, history | ✓ **Phase 6 done (Day 9):** server-side resolution chain (promo/time → customer → branch → pack → tier → default) with `source` on every answer; `price_rules` (one primary scope + combinable time window, HH:MM and/or date bounds); minimum-margin guard (R-PR1) on every price-writing surface — PIN or block, floors product → branch → global, approver recorded; append-only `price_history` (R-PR3) in the same transaction as the change; manager **Pricing** tab (rules, guard settings, history, EN/SW). Acceptance: same variant × 5 branches × 2 customer types + 1 promo = 11 correct prices, below-margin override demands manager PIN, every change leaves history — all in `npm test` |
| Sales / checkout (engine + till UI) | ✅ **Phase 7 done (Day 10–11):** `POST /api/sales` = scan-to-receipt in one call — chain-frozen `unit_price` per line (never altered later), line discounts permissioned (`sales.discount`) or supervisor-PIN approved (approver recorded on the sale), age-gate on restricted items, VAT split per line (std/zero/exempt), stock moves **exactly once** through the Phase-4 move engine (FEFO per lot, `ref` = invoice no, oversell only as an audited manager/owner act R-S8), cash (change) / M-Pesa (manual ref) / card payments, partial payments, **hold → suspended** (no stock) → `POST /api/sales/:id/pay` (re-validates, single stock step), void reverses the exact lots taken. Till UI (`/pos.html`): barcode wedge + search, category chips, product grid, variant picker, cart (qty/discount/note), customer + promo attach, two tills concurrent, printable receipt with KRA fields, **quote → invoice** (quote = suspended sale, `kind` sale/quote/invoice; conversion re-validates, takes payment and moves stock exactly once — double-convert and pay-on-quote refused; UI: Quote button + convert-from-held-list), first-run till hint (dismissable, EN/SW) |
| Shifts & till control | ✅ **Phase 9 done (Day 13):** a shift = one cashier's session at one till, opened with a known float (`POST /api/shifts`, one open shift per cashier, bound to a real register). The drawer is tracked from the payment engine: **expected cash = float + cash collected − cash refunded − payouts − deposits** (M-Pesa/card never touch the drawer; a refund counts the moment it physically leaves, so cross-shift refunds land in the shift that pays out). `GET /api/shifts/mine` feeds the till bar (open with float / payout / close with count → variance, green at 0); `POST /api/shifts/:id/close` records expected + counted + variance, no double-close, a manager can close any shift (handover), cashiers cannot close each other's. **Till control is a business capability** (`settings.shifts.enforced`, owner): when on, cashiers cannot sell/quote/hold/pay without an open shift (403) — small shops leave it off. Open/close clock the `timeclock` row; every open/payout/close is audited. Manager gets a Shifts tab (open shifts with live drawer numbers, closed with colour-coded variance) |
| Returns & exchanges | ✅ **Phase 10 done (Day 14):** nothing is ever edited in place. A **return** is its own document (`RET-` sequential, eTIMS-ready) whose lines point at the exact `sale_items` it undoes, with per-line restock flag and the **FEFO batch the goods land back in** (batch-tracked items return to the same batch — verified). Money goes back through the payment engine as **partial refunds to the original method, newest payment first** (a payment tracks `refunded` and flips to `refunded` only when fully back; a fully-returned sale goes terminal `refunded`), or into the customer's **store credit** (ledger-evidenced). **Exchanges** = return + a replacement sale carrying the returned value as an exchange-credit discount (VAT-exact: the tax-inclusive credit is matched to the shilling); the **price diff settles exactly** — customer pays the new sale's actual balance, or the excess is refunded to the *original* sale (never double-refunded). Approval rule = a business capability: cashiers up to `settings.returns.cashier_limit` (default 5 000), managers/owners unlimited, exchanges need `sales.discount` or a supervisor PIN. The shift drawer counts partial refunds out via the `refunded` column; sale payloads expose derived `returns`/`returns_total` (computed, never written back). POS return/exchange modal (invoice → lines → reason/restock → money or credit → exchange-for + diff settlement), manager Returns/Exchanges tab. 119 tests green (was 111) + 29-step UI smoke. |
| Customers & deni (credit) | ✅ **Phase 11 done (Day 15):** phone-first profiles (same number = same customer, never duplicated), lifetime purchase total, last purchase. Deni accounts live off the payment engine: credit sales from checkout, **over-limit deni is a manager act** (`deni.approve`, audited `deni/override`, ledger marked "OVER LIMIT") — a cashier gets 403. Repayments (cash/M-Pesa/…) are ledger rows that reduce the balance, leave a till **deposit** when the money is cash, turn overpayments into store credit, and reconcile: `Σ credit_sale − Σ repayment = balance` to the shilling. Deposits top up store credit (the customer pays in advance and spends it at the till — the P8 store-credit payment method). The **statement is the ledger itself** with opening balance and a running balance — `statement.html` prints it, so it can never drift from the books. Customer-specific pricing already resolved through the Phase-6 chain (customer price rules show on the profile). Manager Customers tab (search, profile, ledger, recent sales, repay/deposit/adjust actions, statement link); POS customer options show phone + outstanding deni. 124 tests green (was 119) + 22-step UI smoke. |
| Audit hash chain + verify | ✓ R-A1/R-A4 done at core level |
| Sales/payments schema | ✅ **Phase 8 done (Day 12):** the payment **engine** — checkout never knows what a payment is. Adapters: cash · M-Pesa · card · bank · credit (deni) · store credit · gift card · loyalty · other (enable/disable per business). State machine `pending → confirmed \| cancelled \| failed`, `confirmed → refunded`; idempotency is structural — `UNIQUE(sale_id, method, ref)` so a duplicate provider callback is a guaranteed no-op (proven in tests: 3 callbacks, 1 confirm). Split/partial payments via `POST /api/sales/:id/payments`; cash over-tender = change; non-cash can't exceed the balance; duplicate (sale, method, ref) refused. **M-Pesa lives only in `lib/mpesa.js`** (the only file that knows Daraja): manual mode (record the SMS code — works day one), sandbox (simulated STK + `simulate-callback` test hook replaying the real callback path), live (real OAuth + STK push, Phase 16 credentials). Refunds go to the original method (deni refunds release the credit limit; store credit is restored; M-Pesa leaves a reversal row). Cancelled/failed money **unwinds the stock step** (same lots, audited) so a declined prompt never leaks stock. Per-method reconcile (`/api/payments/reconcile`) + deposits (`/api/deposits`, manager act, audited) + payment settings (owner). Manager gets a Payments tab; the till gets method tabs, an awaiting-payment panel and add-a-second-payment |
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

- **2026-09-02 (v12)** — **Phase 11 complete (Day 15):** customers & deni.
  Customer CRUD (POST/PUT, phone-first upsert, customers.manage),
  enriched GET /api/customers (deni_outstanding, last_purchase,
  total_purchases, ?q= phone/name search), GET /api/customers/:id
  (profile + ledger with running balance + recent sales + customer price
  rules); repayments (ledger 'repayment', cash → till deposit, overpayment
  → store credit, audited deni/repay); deposits (→ store credit);
  store-credit adjustments (manager, floor at zero); deni statement API
  (opening/running/closing, ties to the ledger) + printable
  statement.html; engine: over-limit deni needs deni.approve (audited
  deni/override, ledger marked), else 403. POS customer options show
  phone + deni; manager Customers tab. 124 tests green (was 119) +
  22-step UI smoke. Health + banner report Phase 11.
- **2026-09-02 (v11)** — **Phase 10 complete (Day 14):** returns & exchanges.
  `payments.refunded` (partial refunds; terminal `refunded` sale state);
  `returns`/`return_items` (RET-# eTIMS-ready, batch-aware restock, reason
  codes, restock flag); `exchanges`/`exchange_items` (EX-#);
  `POST /api/returns` (money to original methods newest-first, or store
  credit; cashier limit capability `settings.returns.cashier_limit`),
  `POST /api/exchanges` (exchange-credit discount, VAT-exact, diff settles
  exactly via the actual sale balance or a refund to the original sale),
  `GET /api/returns|exchanges`; sales list gains `?invoice=`; sale payloads
  gain derived `returns`/`returns_total`; shift drawer counts partial
  refunds; void marks `refunded` for consistency. POS return/exchange
  modal, manager Returns tab, EN/SW. 119 tests green (was 111) +
  29-step UI smoke. Health + banner report Phase 10.
- **2026-09-02 (v10)** — **Phase 9 complete (Day 13):** cashier shifts & till
  control. `shifts.register_id`; open/payout/close routes +
  `/api/shifts/mine`; expected cash computed from the payment engine
  (float + cash in − cash refunded − payouts − deposits; refunds counted
  when they leave the drawer, so cross-shift refunds bill the right
  shift); close records expected/counted/variance (no double-close,
  manager handover); `settings.shifts.enforced` (owner) gates every
  selling route for cashiers without an open shift; timeclock in/out;
  audited open/payout/close. POS shift bar (float / drawer live /
  payout / close + variance) and manager Shifts tab. 111 tests green
  (was 106) + 34-step UI smoke. Health + banner report Phase 9.
- **2026-09-02 (v9)** — **Phase 8 complete (Day 12):** payment engine.
  `lib/payments.js` (provider-agnostic: method registry, state machine,
  idempotency, evidence, balance recompute) + `lib/mpesa.js` (the ONLY file
  that knows Daraja — manual / sandbox / live). `payments` rebuilt with the
  full state machine, wider method set, `external_ref`, and the
  `UNIQUE(sale_id, method, ref)` idempotency index. New routes:
  `/api/payments/methods`, `POST /api/sales/:id/payments` (splits; a held
  sale takes its one stock step on the first money in),
  `POST /api/payments/:id/confirm|cancel|refund` (refund = manager act,
  to the original method), `GET /api/payments[?filters]`,
  `GET /api/payments/reconcile?date`, `POST|GET /api/deposits` (manager act),
  `POST /api/webhooks/mpesa` (idempotent), `POST /api/payments/:id/simulate-callback`
  (sandbox-only test hook), `GET|PUT /api/settings/payments`. Declined or
  failed money unwinds the stock step (same lots, audited) and parks the
  sale as suspended. 106 tests green (was 98) + 31-step UI smoke.
  Health + banner now report Phase 8.
- **2026-09-02 (v8)** — **Phase 7 complete (Day 11):** quote → invoice —
  `sales.kind` (sale/quote/invoice); a quote is a suspended sale that never
  touches stock; `POST /api/sales/:id/convert` re-validates, takes payment and
  moves stock exactly once (pay-on-quote and double-convert refused); `/pay`
  now guards quotes; till UI adds a Quote button, convert-from-held-list and a
  dismissable first-run hint (EN/SW). Health + banner now report Phase 7.
  98 tests green (was 96) + 30-step UI smoke.
- **2026-09-02 (v7)** — **Phase 7 started (Day 10 of 2):** sales/checkout engine —
  `POST /api/sales` (chain-frozen line prices, permissioned/PIN-approved discounts,
  age gate, per-line VAT, single FEFO stock step, cash/M-Pesa/card + partial,
  hold→suspended→pay, void reverses exact lots, list/detail/receipt), `base_variant_id`
  on product lists, `sale_items.variant_id` + `sales.discount_by` columns, and the full
  till UI (`/pos.html`: scan wedge, grid, variant picker, cart, hold/resume, printable
  receipt, EN/SW). 96 tests green incl. frozen-price, FEFO lots, R-S8 oversell,
  supervisor-PIN discount, hold single-stock-move, two-till concurrency.
- **2026-09-02 (v6)** — **Phase 6 implemented (Day 9):** pricing resolution engine
  (chain + `price_rules` + time windows), minimum-margin guard (R-PR1: PIN or block,
  floor precedence product → branch → global, approver recorded), append-only
  `price_history` (R-PR3) wired into every price-writing surface, `GET /api/pricing/resolve`,
  `GET/POST/PUT/DELETE /api/price-rules`, `GET /api/pricing/history`, read-only
  `GET /api/customers`, manager Pricing tab (EN/SW). Contracts in §3.2/§6.
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

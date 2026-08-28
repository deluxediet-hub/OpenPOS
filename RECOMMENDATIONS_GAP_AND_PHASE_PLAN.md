# OpenPOS Recommendations Review and Phased Plan

**Review date:** 28 August 2026  
**Baseline:** branch `arena/01a03f39-openpos`, commit `cf1199f`  
**Purpose:** compare the proposed recommendations with the current OpenPOS implementation and agree an incremental plan. This document is planning only; no application behavior is changed.

## Executive conclusion

The recommendations are directionally correct, but OpenPOS is further along than the list implies. Most of the ten “most important additions” already exist and are integrated into the daily opening-to-close flow. The right approach is **not a rewrite** and not a second implementation of stock, purchases or reconciliation.

The recommended direction is:

1. Keep the current Node/Express/SQLite foundation and pure business libraries.
2. Fix the known transaction/reporting blockers before structural work.
3. Refactor the monolith incrementally behind the existing API and tests.
4. Extend the current product → stock item → recipe model with explicit purchase packs, standardized stock-ledger references and adjustment documents.
5. Consolidate the retail UI and retire hospitality code from the retail runtime.
6. Decide how to sunset loyalty and gift cards without losing history or abandoning outstanding balances.
7. Finish with operational hardening, full CI, installer and recovery proof.

### Current position against the ten priorities

| Priority | Current OpenPOS status | Assessment |
|---|---|---|
| 1. Opening stock | Product creation and CSV import post opening stock movements | **Implemented, but not a dedicated opening-stock document/session** |
| 2. Purchases → stock | Suppliers, goods receipts, receipt lines, pay-now/pay-later and stock posting exist | **Implemented at basic delivery level; purchasing/accounting detail is partial** |
| 3. Sales → stock | Recipes, measured factors and close-once posting deduct stock | **Implemented and hardened** |
| 4. Physical stock count | Full stocktake with sealed units, open ml and weighed quantities | **Implemented** |
| 5. Stock variance | Quantity, cost and potential-retail variance stored per count and total | **Implemented** |
| 6. Cash/till variance | Opening/expected/actual Cash, M-Pesa and Card variances | **Implemented** |
| 7. Overall variance | Tender variance plus stock variance at potential retail | **Implemented** |
| 8. Daily reconciliation | Stocktake required before till close, status and notes stored | **Implemented** |
| 9. Barcode scanning | SKU/barcode fields, uniqueness, search and keyboard-wedge scanner mode | **Implemented; hardware calibration and pack barcodes remain** |
| 10. Reliable thermal printing | Direct network ESC/POS receipt is primary when configured, browser fallback | **Implemented for sales; return/report queueing and hardware proof remain** |

---

## 1. Review of “Keep” recommendations

All of these should be retained.

| Recommendation | What exists now | Decision |
|---|---|---|
| SQLite + `better-sqlite3` | WAL mode, foreign keys, integer cents, synchronous transactions, online backup | **Keep**. Correct scale for one local host and a few devices. |
| Express + localhost architecture | Express server on the shop PC, static browser client, LAN phone access | **Keep**. Preserve relative browser URLs and one local source of truth. |
| `lib/domain.js` calculations | Pricing periods, loyalty math, cash expectation, stock BOM aggregation and labour math | **Keep and expand** with all reconciliation/return allocation pure functions. |
| `lib/escpos.js` | Receipt and docket generation, TCP printer send and spool output | **Keep**. Make it the single receipt-format authority over time. |
| Stock movements / audit trail | `stock_moves` and `audit_log` are used across sale, delivery, count, return and adjustments | **Keep and strengthen**, not replace. |
| Payments and cash drawer | Split tenders, Cash/Card/M-Pesa, cash change, shift linkage, idempotency and drawer kick | **Keep**. Fix remaining partial-payment and reporting edges. |
| Recipes/BOM | Product-to-stock mapping supports shared bottle sources and proportional deduction | **Keep**. It is the correct basis for bottles, shots and keg products. |
| Integration architecture | Configuration and payload-building are isolated in `lib/integrations.js` | **Keep isolated**. No live-integration implementation is part of this plan. |
| Backup system | Online SQLite backup, integrity check, rotation, installed destination and verifier | **Keep and operationalize** with status, catch-up and restore proof. |
| Packaging/installer | Private Node runtime, ProgramData data, hidden start, watchdog, firewall and backup task | **Keep**. Test the actual installed lifecycle. |
| Existing automated tests | Domain, packaging, retail API, general API, feature, jsdom and responsive suites | **Keep and extend**. Characterization tests are required before deletion/refactor. |
| Minimal dependencies | Runtime only uses Express and better-sqlite3 | **Keep as a design constraint**. Do not add an ORM or frontend framework. |

### Architecture principle

The refactor should preserve:

```text
Browser UI → existing /api contract → Express routes → services → better-sqlite3
                                              ↓
                                      domain + ESC/POS
```

No microservices, ORM, cloud database, SPA-framework migration or TypeScript conversion is needed for this shop.

---

## 2. Review of “Modify / improve” recommendations

## 2.1 `db.js` — stronger wines and spirits inventory model

### Already present

- Separate sellable products (`menu_items`) and physical stock (`stock_items`).
- Recipe/BOM mapping between them.
- SKU and barcode.
- Product volume, serving size, sale unit and stock mode.
- Bottle capacity and fractional/open-container balances.
- Unit, pour and weighed stock modes.
- Reorder minimum.
- Supplier, receipt, stock count and complimentary records.
- Cost and selling-value variance.

### Still needed

- Explicit base unit versus purchase unit.
- Case/crate/carton-to-bottle conversion.
- Multiple barcodes for the same product or pack level.
- Standard stock-movement type and source reference columns.
- Balance-after and unit-cost snapshots on movements.
- Dedicated adjustment/breakage/transfer documents.
- Versioned, transactional migrations.

### Decision

**Extend the current model; do not replace it.** Existing fractional-bottle behavior and historical records must migrate without reinterpretation.

## 2.2 `server.js` — split routes and services

### Current state

- `server.js` is approximately 2,140 lines with 125 route declarations.
- Authentication, catalogue, sales, payment, returns, inventory, purchasing, stocktake, reports, shifts, legacy hospitality and printing are in one file.
- Critical operations do use SQLite transactions, but rules are difficult to isolate and test.

### Decision

**Incrementally split after adding characterization tests and correcting known blockers.** Keep `server.js` as the composition root while moving one bounded area at a time.

Recommended target:

```text
server.js                    app composition, middleware, static files, start
middleware/auth.js           current user, role checks, session policy
routes/auth.js
routes/catalogue.js
routes/sales.js
routes/returns.js
routes/inventory.js
routes/purchases.js
routes/stocktakes.js
routes/shifts.js
routes/reports.js
routes/printing.js
services/sales-service.js     transaction boundaries and close-once posting
services/return-service.js
services/inventory-service.js
services/reconciliation-service.js
services/backup-status.js
```

Avoid a repository layer unless repeated SQL genuinely requires it. `better-sqlite3` statements inside small services are acceptable and keep dependencies minimal.

## 2.3 `pos.js` — retail/bar-focused screen and barcode scanning

### Current state

This is mostly complete in retail mode:

- Retail starts a sale without a floor/table.
- Compact product cards, SKU/barcode search and global scanner input.
- Whole, half, quarter, eighth/shot and custom-ml sale.
- Proportional price preview and stock deduction.
- Consolidated lines and mobile full-screen modals.
- Restaurant floor code remains in the same 631-line file.

### Decision

**Keep the retail screen and extract/remove the legacy floor implementation from the retail build path.** Add scanner diagnostics and pack-level barcode behavior rather than redesigning checkout.

## 2.4 `cashier.js` — Cash/M-Pesa/Card focus

### Current state

- Cash, Card and manual M-Pesa are the primary visible retail tenders.
- Cash tender/change and reference handling exist.
- Payment search, reprint, part-payment, gift card, points, tips and returns remain in the broader code path.

### Decision

**Narrow retail cashier behavior after product decisions.** Retain Cash/Card/M-Pesa, receipts, payment lookup and returns. Remove retail tips if confirmed unnecessary. Sunset loyalty/gift-card tender only through a liability-safe process.

## 2.5 `manager.js` — inventory and reconciliation focus

### Current state

`manager.js` is approximately 987 lines and currently contains:

- Dashboard.
- Reports and custom PDF builder.
- Product/category management.
- Inventory.
- Staff.
- Settings.
- Legacy floor settings.

Retail operations for supplier, delivery and stocktake are in `retail.js`; drawer, loyalty, labour, reservation and printer panels are in `manager2.js`.

### Decision

**Do not simply paste `manager2.js` into `manager.js`.** Create a small manager shell and focused retail modules:

```text
manager-shell.js
manager-dashboard.js
manager-catalogue.js
manager-inventory.js
manager-purchases.js
manager-stocktake.js
manager-reconciliation.js
manager-reports.js
manager-settings.js
manager-staff.js
```

Then delete `manager2.js` after each retained panel has moved and removed panels have been retired.

## 2.6 `manager2.js` — merge/remove

### Current state

It is an 835-line second manager controller containing mixed retained and removable features.

### Decision

**Remove it through extraction, not a one-step merge.** The drawer/reconciliation and printer panels should move to focused retail modules. Reservations, labour and other retired panels should not be carried forward.

## 2.7 `print.js` — direct ESC/POS primary

### Current state

This recommendation is already implemented for sale receipts:

1. Browser calls `/api/print/receipt/:id` when a printer is configured.
2. Server builds ESC/POS and sends to the network printer.
3. Browser print is fallback.
4. Cash drawer kick occurs only on original cash checkout.

### Still needed

- Direct ESC/POS return receipt.
- One canonical receipt representation to prevent browser/server format drift.
- Print job status/retry and spool rotation.
- Hardware acceptance tests for 58/80mm printers and drawer.

### Decision

**Improve the existing path; do not replace it.**

## 2.8 `lib/domain.js` — reconciliation calculations

### Current state

- `expectedCash()` and `drawerVariance()` already exist.
- M-Pesa/Card expectation, tender variance, overall variance and status classification remain inline in `server.js`.

### Decision

Move pure reconciliation calculations and classifications into `lib/domain.js`, including:

- Expected value per tender.
- Per-tender variance.
- Total tender variance.
- Overall variance.
- Classification and note requirement.
- Discount and return allocation.

The service should gather database facts; the domain module should calculate the result. Add table-driven tests for every status boundary and sign combination.

## 2.9 `stock_moves` — standardized reasons and references

### Current state

`stock_moves` stores stock item, signed delta, free-text reason, user and timestamp. The text often embeds references such as order, delivery, return or count.

### Decision

Add structured columns while retaining the readable reason:

```text
movement_type       opening|purchase|sale|return|count|breakage|adjustment|transfer_in|transfer_out|complimentary
reference_type      order|return|goods_receipt|stock_count|adjustment|transfer
reference_id        internal record ID
reference_code      invoice/count/transfer code
unit_cost_snapshot
balance_after
idempotency_key     where replay is possible
```

Use a controlled constant list in one module. Backfill historical movement types from known reason prefixes where safe; otherwise classify as `legacy`.

## 2.10 Products — barcode, SKU, units, case/bottle conversion, minimum stock

### Current state

- Barcode: implemented.
- SKU: implemented.
- Selling unit: implemented as one text field.
- Bottle capacity: implemented.
- Minimum/reorder stock: implemented.
- Case/bottle conversion: missing.
- Multiple pack barcodes: missing.

### Decision

Add a packaging/conversion model without changing the base stock calculation. Recommended concept:

```text
product_packages
  stock_item_id
  name                 bottle|6-pack|case|crate
  units_per_package
  purchase_unit_cost
  barcode
  sku
  is_purchase_default
  is_saleable
```

A receipt of 2 cases × 12 posts +24 bottles to the base stock item. A case sale can use a recipe of 12 base bottles. Existing individual bottle products remain unchanged.

## 2.11 Recipes — ml/cl portions

### Current state

Recipes already support arbitrary real-number quantities and measured sale factors. The retail UI uses ml, including values such as 31.25ml. Pour products and custom measured bottle portions are supported.

### Decision

**ML is already supported.** Add unit normalization at input boundaries rather than a second recipe system:

```text
1 cl = 10 ml
1 litre = 1,000 ml
```

Store canonical volume in ml. UI may accept/display cl where desired. Add tests for ml/cl/litre conversion, rounding and source-container depletion.

## 2.12 Suppliers and purchases

### Current state

- Supplier directory.
- Goods receipts and receipt lines.
- Optional invoice reference.
- Immediate Cash/M-Pesa/other payment or pay-later status.
- Stock and till-expense posting.
- Seller access remains as required.

### Gaps

- No purchase-order lifecycle.
- No supplier return/debit note.
- No partial payment or payable aging.
- Receipt line uses configured stock cost rather than an explicit invoice unit cost.
- No duplicate invoice/idempotency control.
- No case conversion.

### Decision

Rename the UI concept to **Purchases / Deliveries** but build on `goods_receipts`. Preserve seller control. Add actual invoice quantities/costs, pack conversion, duplicate-reference warning, payment history and supplier returns in stages. A purchase-order approval workflow is unnecessary for the current tiny shop unless later requested.

## 2.13 Stock counts

### Current state

Full stock counts are implemented and required before till close. They support frozen expected quantity, save/resume, sealed units, open ml, weighed stock, added stock and financial variance.

### Decision

**Keep and refine.** Add count type, count scope, immutable completion reference, recount/correction document and structured movement references. Do not remove seller ability to count or enter added stock.

## 2.14 Breakages, adjustments and transfers

### Current state

- Owner/admin generic stock adjustment with free-text reason exists.
- Stocktake variance captures unexplained physical difference.
- Complimentary issue has a dedicated workflow.
- No first-class breakage document.
- No first-class transfer document.
- Existing “order transfer” is restaurant table movement, not inventory transfer.

### Decision

Add dedicated stock adjustment documents with reason codes. Preserve the generic note for details.

For one shop, prioritize:

1. Breakage/damage.
2. Leakage/spillage.
3. Expiry/write-off.
4. Owner correction.
5. Supplier return.

Location transfer can follow only if the shop genuinely tracks stockroom/shelf or opens another branch. Do not build complex multi-branch transfer prematurely.

## 2.15 Automatic daily backups

### Current state

Implemented in the Windows installer as a 23:30 scheduled task with 14-copy rotation and integrity verification.

### Gaps

- No catch-up when the PC is off at 23:30.
- No in-app last-success/last-failure indicator.
- No automatic off-device destination.
- Verification is not a full restore drill.

### Decision

Keep the task, add startup catch-up, durable backup status, owner warning and a tested restore workflow.

## 2.16 Authentication/PIN handling

### Current state

- Salted scrypt hashes.
- Timing-safe verification.
- HttpOnly SameSite cookie.
- Failed-login throttle.
- Role checks.
- Last-admin protection.

### Gaps

- UI submits at four digits although API permits 4-6.
- Manager authorization calls normal login and replaces seller session.
- Server-side session objects have no expiry time.
- Sessions disappear on restart.
- No explicit origin/CSRF enforcement.

### Decision

Standardize on four-digit PINs for the small shop or implement explicit Enter for variable length. Replace manager re-login with action-scoped approval. Add session expiry and baseline request-origin/security controls without introducing a large authentication framework.

## 2.17 Reconciliation tests

### Current state

- Domain tests cover cash expectation and basic variance.
- Retail/API tests exercise stocktake and closing paths.
- Packaging tests cover backup wiring.
- The full suite has not been run successfully in the current sandbox and GitHub workflow activation is pending.

### Decision

Add table-driven pure domain tests plus API scenarios for:

- Exact balance.
- Each tender over/short independently.
- Offsetting tender differences.
- Tender overage plus stock shortage.
- Critical threshold boundaries.
- Expenses, gift-card funding during sunset, returns and purchases.
- Count added-stock treatment.
- Duplicate requests and restart/retry.

---

## 3. Review of “Remove” recommendations

The app is configured primarily as a wines and spirits POS, but several restaurant systems still exist behind retail conditionals. Removal should mean **remove from the active retail product and code path**, not immediately drop historical database tables.

| Feature | Current retail state | Recommendation |
|---|---|---|
| Reservations | Routes/schema and `manager2.js` panel exist; top-level retail manager hides bookings | **Remove from retail runtime and UI**, then archive routes after tests prove no dependency. |
| Loyalty | Enabled by default, customers and points are active in payments/reports | **Retire if the owner confirms it is not wanted.** Stop new earning first, preserve history, then remove retail UI/routes. |
| Gift cards | Active, funded, redeemable and reported as liability | **Do not hard-delete.** Stop new issuance, redeem/refund/settle outstanding balances, preserve ledger, then remove active retail UI. |
| Labour management | Timeclock and labour reporting exist; retail top navigation still exposes labour to owner | **Remove from retail UI/runtime** if payroll/timeclock is not required. Preserve historical rows. |
| Floor/table dependency | Retail sale screen already bypasses the floor; tables still load in bootstrap and legacy code remains | **Complete the separation.** Retail orders should not depend on table records at all. |
| Kitchen/KDS | Retail navigation hides it and `/kds` redirects, but KDS JavaScript/routes remain loaded | **Remove from retail page/bundle and retail API surface.** Keep only in a clearly separated legacy build if still supported. |
| Customer ordering page | Retail route returns 404, but QR routes/page/schema remain | **Remove from retail server surface** after confirming no supported hospitality deployment must remain. |
| Restaurant workflow | Mostly conditional but interleaved across routes, role lists and frontend | **Extract or retire systematically**, not with broad deletion from the monolith. |
| Tips | Still visible in the payment modal and persisted | **Remove/disable in retail mode** if the owner confirms tips are unnecessary. Keep historical tip columns for old receipts. |

### Required product decisions before removal

The owner should approve these four decisions at Phase 0:

1. **Retail-only product:** Is future restaurant compatibility no longer a requirement?
2. **Loyalty:** Disable entirely, or retain simple customer history without points?
3. **Gift cards:** Stop immediately, or keep because funded balances/customer demand justify them?
4. **Tips:** Remove from retail checkout entirely?

### Safe retirement sequence

For features with history or value:

```text
Default off → hide creation → allow settlement/redemption where required
→ export final history → remove active routes/UI → retain read-only tables
→ consider dropping tables only in a later major-version migration
```

Gift cards represent customer-funded value. Removing their code while balances remain would be an operational and accounting error.

---

## 4. Phased implementation plan

## Phase 0 — Confirm retail scope and establish a green baseline

### Goal

Freeze product decisions and ensure the current behavior is reproducible before refactoring or removal.

### Work

- Decide retail-only future, loyalty, gift-card and tip policy.
- Define supported deployment as one Windows host, one shared till, owner plus approximately two sellers.
- Copy/activate `ci/openpos-ci.yml` under the GitHub workflow path using a workflow-authorized account.
- Run the complete current suite on Linux and Windows Node 20.
- Add characterization tests around every route/module planned for removal.
- Build the current installer and perform a clean install smoke test.
- Capture a sanitized fixture database containing whole bottles, measured bottle, keg, purchase, stocktake, return and reconciliation history.
- Record schema version 1 baseline and backup/restore it.

### No behavior change

No features are removed and no schema semantics change in this phase.

### Exit criteria

- Product decisions signed off.
- Full current suite green on supported environments.
- Installer builds and starts.
- Baseline backup restores successfully.

---

## Phase 1 — Close known financial and transaction blockers

### Goal

Make the current retail system safe before adding inventory capability or moving code.

### Work

- Reject/group duplicate return lines and validate combined returned quantity.
- Correct discounted multi-line return allocation.
- Freeze discount and relevant order metadata after first payment and after close.
- Print partial payments as `PART PAYMENT` with remaining balance, never `PAID`.
- Correct gross-profit calculation to exclude VAT.
- Align summary, seller, product and category return-period policy.
- Require payment idempotency keys for supported clients.
- Link each refund payment directly to its return record.
- Correct non-restocked return/write-off accounting.
- Add regression tests for all of the above.

### Preserve

- Existing seller permissions for deliveries, expenses, added stock and complimentary declarations.
- Current VAT-inclusive shelf-price behavior.
- Current close-once stock posting.

### Exit criteria

- Duplicate/retried money and stock requests are harmless.
- Paid/partial/return documents are truthful.
- Closed sale values cannot be mutated.
- Core financial reports reconcile to test fixtures.

---

## Phase 2 — Create modular boundaries without changing APIs

### Goal

Reduce change risk before inventory expansion.

### Work

- Extract authentication/session middleware.
- Extract sales/payment/return services first because their transaction boundaries are clearest.
- Extract route modules one bounded area at a time.
- Keep existing URLs, request bodies and response shapes.
- Move reconciliation and return-allocation calculations into `lib/domain.js`.
- Add route-contract tests before each extraction.
- Keep `server.js` as app composition and process startup.
- Introduce schema version tracking and transactional migration files.

### Constraints

- No ORM.
- No frontend framework.
- No dependency-heavy validation layer.
- No broad renaming in the same commits as logic movement.

### Exit criteria

- `server.js` is primarily composition/startup rather than business logic.
- Money/stock transaction services have direct tests.
- Existing API and UI tests pass unchanged.
- Existing shop database migrates and rolls back via backup restore.

---

## Phase 3 — Strengthen the inventory and purchase model

### Goal

Add the missing wines-and-spirits stock structure without breaking current bottle/portion behavior.

### Work

- Add canonical unit definitions and conversions.
- Add product purchase/sale packages with units-per-package and optional package barcode/SKU.
- Preserve base stock item and recipe quantities as the source of truth.
- Add structured stock movement type/reference/cost/balance fields.
- Add a dedicated opening-stock document/import session.
- Extend goods receipts with actual invoice unit cost, pack quantity/conversion and duplicate reference/idempotency protection.
- Add supplier return records.
- Add dedicated breakage/damage/leakage/expiry/adjustment documents.
- Add optional internal/location transfer only if a real operating need is confirmed.
- Backfill historical stock movements conservatively as `legacy` when source cannot be proved.

### Seller policy

Sellers continue to receive deliveries and enter stocktake additions. This phase structures and references their entries; it does not remove their capability.

### Exit criteria

- Two cases of 12 reliably become 24 base bottles.
- Bottle, case and measured-portion sales all deplete the same stock source correctly.
- Every new stock movement has a standard type and traceable source document.
- Breakage and supplier return are distinct from unexplained stocktake variance.
- Old data remains readable and totals are unchanged after migration.

---

## Phase 4 — Complete stocktake and reconciliation domain

### Goal

Make opening-to-close calculations centrally defined, fully tested and operationally correct.

### Work

- Move all expected-tender and reconciliation status calculations to `lib/domain.js`.
- Add table-driven threshold/sign/status tests.
- Add count types such as opening, daily close, spot and correction while retaining required daily full count policy unless changed later.
- Add immutable count completion identity and a correction/recount document rather than editing completed counts.
- Link stocktake movements through structured references.
- Separate physical variance, documented added stock, breakage and purchase timing clearly in reports.
- Update shift clearing to use discounts and return lines consistently.
- Add report truncation metadata and complete totals.
- Neutralize spreadsheet-formula prefixes in CSV exports.

### Preserve

- Seller stocktake and added-stock entry.
- Cash/M-Pesa/Card individual variances.
- `RECONCILED — POSSIBLE UNRECORDED SALES` classification.
- Owner-visible evidence and notes.

### Exit criteria

- One set of pure functions drives API, UI and reports.
- Every reconciliation classification is covered at boundaries.
- A completed count is immutable but correctable through a linked document.
- Shift, seller, product and category reports agree for the same fixture.

---

## Phase 5 — Retail UI consolidation and hospitality retirement

### Goal

Make the browser application visibly and structurally a wines and spirits POS.

### Work

- Create a small manager shell and split retail manager modules.
- Move drawer/reconciliation and printer panels out of `manager2.js`.
- Move supplier, purchase and stocktake panels from `retail.js` into the final module structure.
- Delete `manager2.js` when no retained panel depends on it.
- Separate the retail sale screen from floor/table code.
- Stop loading KDS code in retail HTML.
- Remove retail navigation/routes for reservations, labour, table/floor and customer ordering.
- Remove restaurant-only roles from new retail staff creation and retail route allowlists where safe.
- Disable tips in retail checkout if approved.
- Execute the agreed loyalty/gift-card sunset sequence.
- Keep historical tables/read-only exports through the compatibility period.
- Preserve compact phone cards, bottom navigation, full-screen phone modals, barcode scanning and simple complimentary action.

### Exit criteria

- Retail startup does not load or call floor, reservation, kitchen/KDS or customer-ordering code.
- `manager2.js` is gone.
- Retired features have export/history coverage and no outstanding value is abandoned.
- 320/375/480px real-browser flows pass.
- Seller capabilities explicitly protected by the owner remain available.

---

## Phase 6 — Printing, authentication, backup and appliance hardening

### Goal

Make everyday local operation resilient and predictable.

### Work

#### Printing

- Add server ESC/POS return receipts.
- Define one canonical receipt payload/formatter contract.
- Add print job state, retry and spool age/count rotation.
- Preserve browser fallback.
- Test 58mm, 80mm and cash drawer hardware.

#### Authentication

- Resolve PIN length policy and UI behavior.
- Replace manager re-login with an action-scoped approval token.
- Add server-side session expiry and cleanup.
- Add origin checks and baseline security headers.
- Preserve simple PIN-based shop operation.

#### Backup/recovery

- Persist last backup success/failure and display it to the owner.
- Run catch-up backup on startup when the scheduled one was missed.
- Add guided restore verification using a temporary copy.
- Configure/test an off-device destination for deployment.
- Add startup database `quick_check` and graceful WAL checkpoint/shutdown.
- Rotate portable startup logs.

### Exit criteria

- Sale and return receipts print directly and retry safely.
- Approval never changes the seller identity.
- Sessions expire predictably.
- Missed backup is caught up and visible.
- A clean restore drill succeeds against the current schema.

---

## Phase 7 — Release proof and controlled adoption

### Goal

Prove the finished retail product in its real operating environment.

### Work

- Run all unit, API, UI and responsive suites on Linux and Windows.
- Compile the real Windows installer.
- Test clean install, reboot start, LAN phone access and printer.
- Test upgrade from the current database and verify unchanged historical totals.
- Test uninstall with keep-data, reinstall and reopen.
- Test backup, off-device retrieval and restore on a separate machine/location.
- Rehearse opening, whole/portion sales, purchases, expenses, complimentary, breakage, return, stocktake and close with the owner and both sellers.
- Simulate payment retry, printer failure, power interruption, shortage and stock discrepancy.
- Run 7-14 days in parallel with independent tender/stock checks.

### Exit criteria

- CI is green and active.
- Installer and recovery evidence is recorded.
- No unexplained financial/stock mismatch in test fixtures.
- Pilot variances are explainable and backups recoverable.
- Owner signs off the opening-to-close workflow.

---

## 5. Priority and dependency map

```text
Phase 0: decisions + green baseline
   ↓
Phase 1: correctness blockers
   ↓
Phase 2: safe modular boundaries
   ↓
Phase 3: inventory/purchase extensions
   ↓
Phase 4: stocktake/reconciliation completion
   ↓
Phase 5: retail UI consolidation + feature retirement
   ↓
Phase 6: appliance/security/printing/recovery hardening
   ↓
Phase 7: installer proof + parallel pilot
```

Some work can run in parallel only after Phase 0:

- Hardware printer testing can begin while Phase 1 is developed.
- Product decisions and gift-card balance review can begin immediately.
- Windows installer smoke testing can run continuously, not only at Phase 7.
- UI mockups can be prepared early, but code deletion waits for characterization tests and modular boundaries.

---

## 6. Recommended first implementation slice

Once the owner approves this plan, the first coding phase should be deliberately small:

1. Add tests reproducing the five known functional blockers.
2. Fix duplicate return lines.
3. Fix discounted return allocation.
4. Freeze discounts after payment.
5. Correct partial-payment receipt status.
6. Correct VAT-exclusive gross-profit calculation.
7. Align return period attribution.
8. Run the complete suite and package smoke checks.

Do **not** combine that work with `server.js` splitting, inventory schema additions or hospitality removal. Keeping correctness fixes separate makes review and rollback much safer.

---

## 7. Decisions requested from the owner

Before implementation, confirm:

| Decision | Recommended default |
|---|---|
| Future product supports retail only, or retail + legacy restaurant? | **Retail only**, while preserving historical compatibility during migration. |
| Loyalty points? | **Retire from active retail** unless customers already depend on them. |
| Gift cards? | **Stop new issuance, settle existing balances, then retire** unless they are commercially important. |
| Tips at retail checkout? | **Remove in retail mode.** |
| Case/crate sales as well as case receiving? | Support both only where the shop actually sells sealed cases/crates. |
| Internal stock locations/transfers? | Defer unless stockroom-versus-shelf or multiple branch tracking is genuinely used. |
| PIN length? | **Exactly four digits** for fast small-shop operation. |
| Daily count scope? | Keep the current full count for pilot; revisit frequency after real timing data. |

---

## Final recommendation

Accept the recommendations with three adjustments:

1. Treat stock, purchases, stocktake, reconciliation, barcode and sale printing as **existing systems to strengthen**, not missing systems to rebuild.
2. Remove restaurant functionality through a tested retail retirement path, not by deleting interleaved routes and tables in one pass.
3. Sunset gift cards and loyalty only after handling historical records and outstanding customer value.

The highest-value next step is Phase 1 correctness, followed by modular extraction and the case/bottle plus standardized stock-ledger model. That sequence protects the working shop flow while moving OpenPOS toward a clean, purpose-built wines and spirits product.

# OpenPOS Wines & Spirits — Full Non-Integration Audit

**Audit date:** 27 August 2026  
**Code reviewed:** branch `arena/01a03f39-openpos`, commit `e3db610`  
**Scope:** application logic, permissions, sales, payments, stock, stocktake, reconciliation, complementaries, purchasing, reporting, printing, privacy, security, backup, installation, maintainability and market readiness.  
**Explicitly excluded:** implementation/certification of live KRA eTIMS transmission, live M-Pesa/Daraja transport and acquiring-bank/card integration. Internal Cash/M-Pesa/Card recording and reconciliation remain in scope.

---

## 1. Executive verdict

### Overall status: **Not production-ready for unattended commercial use**

OpenPOS is now a capable **supervised pilot** for one owner-operated wines and spirits shop. Its retail UX, measured pours, stocktake, Cash/M-Pesa/Card reconciliation, complementaries, CSV import, phone layout and reporting are unusually strong for a small local-first project.

It should **not yet be deployed where the owner expects the software alone to prevent loss or guarantee accounting correctness**. There are critical transaction-integrity defects that can duplicate payments or stock depletion, a gift-card path that can create value without receiving money, material reporting inaccuracies, incomplete refund accounting and weak controls around seller-entered adjustments.

### Readiness by area

| Area | Rating | Verdict |
|---|---:|---|
| Core retail sale UX | 8/10 | Strong pilot quality |
| Bottle/shot/keg stock logic | 7/10 | Good design; concurrency and valuation caveats remain |
| Till reconciliation | 8/10 | Strong operational model; seller-controlled inputs need stronger approval controls |
| Payment transaction integrity | 3/10 | **Critical fixes required** |
| Refunds/returns | 3/10 | Money, stock and shift accounting are incomplete |
| Permissions/fraud resistance | 4/10 | Role checks exist, but several bypasses and high-risk seller capabilities remain |
| Reports/accounting accuracy | 5/10 | Useful operational reports; not yet reliable financial accounts |
| Printing | 5/10 | Receipt format is good; normal checkout does not reliably use configured ESC/POS path |
| Backup/recovery | 4/10 portable, 3/10 installer | Backup code is sound, but scheduled destination is miswired |
| Security/privacy | 4/10 | Suitable only on a trusted private LAN with disciplined device access |
| Phone/responsive UX | 8/10 | Strong, but latest retail paths lack real-browser regression coverage |
| Maintainability | 5/10 | Functional but monolithic, duplicated rules and legacy hospitality coupling raise regression risk |
| Market readiness excluding integrations | 4/10 | Pilot only until P0/P1 findings are closed |

---

## 2. Audit method and evidence

The review covered approximately:

- **9,940 lines** across server, database, browser assets, libraries and tests
- **124 Express routes** including API and frontend routes
- **27 schema tables** plus migrations and indexes
- Every role declaration and `requireRole` use
- Every money-changing endpoint
- Every stock-changing endpoint
- Till open/close and reconciliation calculations
- Browser and ESC/POS receipt generation
- Portable launcher and Windows installer assets
- Backup and restore scripts

Validation performed:

- JavaScript syntax checks across server, DB, libraries, browser assets, scripts and tests
- `git diff --check`
- Pure domain suite: **53 passed, 0 failed**
- Packaging suite: **34 passed, 0 failed**
- Static permission/route inventory
- SQL/schema review

### Important test limitation

The complete API, retail UI and Chromium responsive suites were not executed in this sandbox because runtime dependencies are not installed here. The owner reports successful localhost use, but that is not a substitute for a clean automated run on a supported Windows/Node LTS machine.

There is no checked-in CI workflow, so GitHub currently does not prove that every pushed commit passes the full suite.

---

## 3. Critical findings — fix before production

## P0-01 — Closed orders can be paid again and stock can be deducted repeatedly

**Evidence:** `server.js:639–756`.

The payment endpoint loads any order by ID but does not reject `closed` or `void` status. Non-cash methods have an over-balance guard, but Cash is exempt. A direct or retried Cash request can therefore:

1. Insert another payment against an already closed order.
2. Mark the order closed again.
3. Call `closeOut()` again.
4. Deduct the full stock recipe again.
5. Award loyalty again.

Cash payment also permits `amount > balance`; `change` is calculated from tendered minus submitted amount, not from submitted amount minus bill balance.

**Impact:** duplicated takings, duplicated bottle depletion, false reconciliation and loyalty inflation. A network retry or double-submit can corrupt the ledger.

**Required fix:**

- Reject payment unless order status is `open` or `billed`.
- Require `amount <= current balance` for every tender, including Cash.
- Add an idempotency key/unique payment-attempt ID.
- Make close-out conditional on an atomic `open/billed → closed` update whose affected-row count is exactly one.
- Add a durable `stock_posted_at`/`closed_out` flag or stock ledger uniqueness constraint per order.
- Test duplicate POST, timeout retry, concurrent devices and payment against void/closed order.

## P0-02 — Gift cards can create spendable value without collecting payment

**Evidence:** `server.js:1728–1746`.

Seller/cashier/manager/admin can issue a gift card of arbitrary value. Issuance creates a full balance but does not create a sale, payment or liability-funding transaction. The same seller can then use that code as tender for goods. The list endpoint returns full codes to seller-level users.

**Impact:** an employee can issue a free KSh 50,000 card and redeem it, taking stock with no Cash/M-Pesa/Card receipt. This defeats the complimentary and reconciliation controls.

**Required fix:**

- Disable gift cards until redesigned, or make issuance admin-only.
- Require a fully settled gift-card sale before activating value.
- Store issuance payment and shift ID.
- Return masked codes in list endpoints; reveal only once or on owner-authorized lookup.
- Add immutable issue/redeem/void ledger entries.
- Add liability reconciliation and reversal rules.

## P0-03 — VAT and profitability reports are not financially reliable

**Evidence:** `server.js:1165–1241`.

Problems include:

- VAT is reconstructed from payment totals. Payments may include tips, but tips are outside the taxable total in `computeTotals`; this overstates VAT.
- Item/category revenue uses line selling price before order-level discounts, so report revenue can exceed actual sales.
- COGS joins the **current** product cost. Changing cost today rewrites the apparent profit of old sales.
- Refunds reduce payment revenue but do not reverse COGS or line quantities.
- Payment reports use payment date while item/COGS reports use order close date, creating period mismatches for part-payments.
- Commission/channel deductions are not consistently reflected in net/gross profit.

**Impact:** dashboard margin, VAT, category revenue and product profitability can disagree and change retroactively. These reports must not be used as books of account.

**Required fix:** snapshot on close:

- taxable amount, VAT, discount, net sales, tip and grand total
- unit cost and COGS per line
- allocated line discount
- channel commission

Build reports from immutable closed-sale snapshots, not current products or reconstructed payments.

## P0-04 — Refunds do not reconcile money, stock or tender type

**Evidence:** `server.js:787–799`.

Refunds are generic negative `method='refund'` payments. They:

- do not identify original tender method
- do not receive a `shift_id`
- do not reduce expected Cash/M-Pesa/Card correctly
- do not identify returned items
- do not return approved quantities to stock
- do not distinguish refund, reversal, exchange or write-off
- do not produce a dedicated refund/credit receipt

**Impact:** drawer and card reconciliation are wrong after refunds; inventory remains short after a physical return; reports cannot explain the transaction.

**Required fix:** line-level return workflow with original payment allocation, restock decision, condition/reason, shift linkage, refund receipt and immutable return ledger.

## P0-05 — The Windows scheduled backup destination is incorrect

**Evidence:** `scripts/backup.js:22–25` and `packaging/assets/run-backup.ps1`.

The scheduled wrapper points `POS_DB` to `%ProgramData%\OpenPOS\data\pos.db`, but `backup.js` always sets `BACKUP_DIR` to `app\backups`. Under an installed Program Files layout, that path may be unwritable and is not the `%ProgramData%\OpenPOS\data/backups` location promised by packaging comments.

The static packaging test checks that the wrapper mentions ProgramData; it does not verify the effective backup destination.

**Impact:** scheduled backups may fail silently or never create the retained copies operators expect.

**Required fix:** add `POS_BACKUP_DIR`, set it explicitly to `%ProgramData%\OpenPOS\backups`, log success/failure to ProgramData, test the resolved path, and perform an installer-level restore drill.

## P0-06 — Full production test status is unknown

The full suite includes legacy restaurant assumptions, while retail functionality has evolved rapidly. The Chromium suite initializes a legacy restaurant, not the final retail configuration, so it does not prove current phone checkout, measured sales, complementaries, stocktake, PDF selection or reconciliation.

**Required fix:** network-enabled CI on Windows and Linux with:

- fresh retail onboarding
- CSV import
- owner and seller flows
- measured bottle and weighed keg flows
- duplicate-payment/idempotency tests
- refund and restock tests
- 320/375/480 phone screenshots
- PDF page-count assertion using headless Chromium
- real installer smoke test on Windows VM

---

## 4. High-severity findings

## P1-01 — Item status endpoint permits unauthorized state transitions

**Evidence:** `server.js:540–562`.

The route is only protected by `requireAuth`. Special checks exist for `ready` and `void`, but any authenticated user can request other accepted states such as `pending`, `sent` or `served`. A kitchen/bar/other legacy account can alter statuses outside the intended state machine.

**Fix:** explicit transition matrix by role and current state; reject all unspecified transitions. Retail should not expose this endpoint to seller flows at all.

## P1-02 — Any authenticated role can delete a pending item from any open order

**Evidence:** `server.js:564–578`.

There is no role restriction and no order ownership/till check. A kitchen or unrelated staff session can delete another seller’s pending line. More generally, all authenticated users can read all open orders.

**Fix:** define shared-till policy explicitly; allow seller/cashier/admin only, require open order and same active location/till, and audit pending deletion with actor and reason.

## P1-03 — Manager-PIN reauthentication changes the browser session identity

**Evidence:** `public/assets/api.js:161–184`.

`requireManagerPin()` calls `/api/login`. That endpoint replaces the session cookie. The visible UI still believes the original seller is logged in, but subsequent server actions run as the manager/admin.

**Impact:** attribution mismatch, hidden privilege escalation for the rest of the session and confusing audit records.

**Fix:** replace with a short-lived, action-scoped approval token that does not change the current login. In retail mode, privileged buttons are mostly hidden, but the helper remains a structural risk.

## P1-04 — Five- and six-digit staff PINs are effectively unusable

**Evidence:** `public/assets/app.js:77,81`.

The keypad automatically attempts login 160ms after the fourth digit, although setup and staff forms advertise 4–6 digits. Human entry cannot reliably reach digit five before the request fires.

**Fix:** either require exactly four digits everywhere or add an Enter button and only auto-submit when configured PIN length is known.

## P1-05 — Seller-controlled entries can neutralize loss controls

By design, sellers may:

- receive stock with optional invoice reference
- enter “unrecorded added stock” during stocktake
- record Cash/M-Pesa expenses
- mark deliveries paid
- declare “owner authorized” for complementaries with a checkbox
- enter actual Cash/M-Pesa/Card close totals
- perform and close the same stocktake

These capabilities support a busy two-person shop, but together they allow one employee to fabricate the explanation for a shortage.

**Fix/recommendation:** preserve simple operation but add owner-review states:

- seller entries are immutable and visibly “seller-entered”
- expense and complimentary thresholds requiring owner review
- delivery invoice/photo/reference for values above threshold
- stock additions during count reported separately and never silently treated as a normal delivery
- closed shift can be seller-submitted but owner-approved later
- dashboard “unreviewed controls” queue

## P1-06 — Stock availability is not reserved across carts or linked products

Add-time stock validation examines the current menu product in the current order. A bottle and its linked shots, or two open phones, can each appear available. Final payment rechecks stock and blocks the later payment, which protects inventory but creates a poor customer experience.

**Fix:** reserve stock for open retail baskets with timeout, or calculate available stock across all open lines sharing the same `stock_item_id`. Use one transaction for availability check and line update.

## P1-07 — Product/category/stock deletion is unsafe and misleading

- `order_items.menu_item_id` does not use `ON DELETE SET NULL`.
- Product deletion claims historical sales retain their names, but deleting a sold product can fail the foreign-key constraint.
- Product-linked stock deletion can fail if delivery history references it.
- Category deletion cascades all products with no preview, typed confirmation or audit entry.
- Direct stock and category deletes have weak error handling and audit coverage.

**Fix:** never physically delete transacted master data. Add `active/archived_at`; archive products/categories/stock. Restrict hard delete to never-used setup records.

## P1-08 — Normal checkout bypasses configured network thermal printing

`printReceipt()` in `public/assets/print.js` uses browser `window.print()`. The network ESC/POS route `/api/print/receipt/:id` is called from printer testing, not the normal payment flow. Therefore normal checkout may not:

- send directly to the configured network printer
- trigger the attached cash drawer
- use the server ESC/POS receipt

**Fix:** after successful payment, call the server print endpoint when printer mode is enabled; fall back to browser printing only when disabled or failed. Make print failure non-destructive and offer retry.

## P1-09 — Receipt spool has no retention or privacy controls

Every server print writes a `.prn` file. The repository currently contains 100 historical spool files. There is no rotation, expiry, encryption or owner purge tool. Payment references and customer information may persist indefinitely.

**Fix:** remove historical spool artifacts from Git, add spool retention by count/age, store in ProgramData for all launch modes, and document retention/privacy policy.

## P1-10 — HTTP-only LAN deployment remains exposed

Cookies are HttpOnly and SameSite=Lax, but not `Secure`; traffic and PIN entry use plain HTTP. There is no CSRF token/origin enforcement, CSP, clickjacking header or general security middleware. Any compromised device on shop Wi-Fi can attempt access.

**Fix:** private dedicated POS VLAN at minimum. For remote/cloud use, require TLS reverse proxy/VPN, Secure cookies, Origin checks, CSP, frame protection and proxy-aware rate limiting.

---

## 5. Medium findings and operational gaps

### Permissions and privacy

1. `/api/events` is unauthenticated. It leaks activity timing and permits unauthenticated long-lived connections. Require authentication and connection limits.
2. `/api/timeclock` exposes all staff entries and hourly rates to any authenticated user. Restrict full list/pay rates to admin; seller should receive only own clock status.
3. `/api/customers` and `/api/customers/:id` expose customer contact, spend and loyalty history to every authenticated role. Apply least privilege and search-only responses for sellers.
4. `/api/gift-cards` exposes full codes to seller-level users. Mask or remove.
5. `/api/dayparts`, `/api/recipes`, `/api/modifiers`, `/api/stock-moves`, delivery and stocktake details are broadly readable. Some are operationally justified, but the permission policy is implicit rather than documented/tested.
6. Print endpoints allow any authenticated role to trigger arbitrary reprints/network printer traffic.
7. Managers can alter most staff accounts. New retail UI only creates admin/seller, but legacy roles and permissions remain in the API.
8. An admin can disable the last active admin through the general update endpoint. Prevent self-disable/last-admin lockout.

### Sales and inventory

9. Add-to-cart checks use current stock but do not atomically reserve it.
10. An unavailable product may still be sold by manager/admin without a recorded override reason.
11. Complimentary “owner authorized” is a seller assertion, not independently verified. This was an explicit simplicity choice; reports make it visible but it is not preventive control.
12. Weighed-keg stock depends entirely on a correct end-shift physical weight. No tare weight, scale reading or second-person verification is stored.
13. Potential-retail stock valuation chooses a direct unit price or a derived pour price. Discounts, promotions and price changes can make the value only an estimate.
14. Product and stock cost are mutable; no supplier price history or weighted-average/FIFO costing exists.
15. Receiving uses configured cost rather than actual invoice cost by explicit design. It cannot identify purchase-price variance.
16. Supplier-credit deliveries have status but no due date, payment reference, partial payment or accounts-payable aging.
17. Optional invoice references and no uniqueness check permit accidental duplicate delivery posting.
18. Stocktake “added stock” can increase stock without a corresponding supplier delivery.
19. No batch/expiry dashboard remains in the simplified receiving flow.
20. No inter-branch transfer workflow despite location tables.

### Till and reconciliation

21. One global shift is shared across all phones. This suits one counter but does not isolate two physical tills.
22. Owner auto-open uses zero opening balances. If the owner sells before recording real opening Cash/M-Pesa/Card, reconciliation starts from a knowingly wrong base.
23. Card reconciliation relies on manually entered EDC batch totals and has no terminal/device identifier.
24. “Possible unrecorded sales” is a useful heuristic, not proof. Retail valuation, discounts and count errors can create false matches.
25. Seller can count stock and enter all tender totals; there is no owner sign-off or reopening/adjustment workflow.
26. No denomination count for cash, making cashier mistakes harder to diagnose.
27. No immutable closing sequence number or signed close hash.

### Reporting

28. Sales/item/category reports disagree under discounts because discounts are stored only at order level and not allocated to lines.
29. Gross profit uses current costs and ignores refund COGS reversal.
30. Tips and VAT reconstruction can disagree.
31. Custom PDFs now have broad coverage and totals, but large audit/stock reports are capped by API limits (100 deliveries, 500 stock moves, 1,000 audit events) without warning that output is truncated.
32. CSV export is vulnerable to spreadsheet formula injection when a product name begins with `=`, `+`, `-` or `@`. Prefix dangerous cells before download.
33. No fiscal period lock; product/setting edits can alter reconstructed historical reports.

### Printing

34. Browser receipt uses the currently logged-in `State.user` as cashier on reprint, not necessarily the original closing cashier. Server ESC/POS path correctly resolves `closed_by`.
35. Reprints are not labelled `REPRINT` or timestamped as reprints.
36. Refund/void documents do not have dedicated receipt formats.
37. Printer timeout is fixed and there is no queued retry/status dashboard.
38. UTF-8 characters may not print correctly on ESC/POS devices configured for a different code page.

### Reliability and operations

39. Sessions are in memory; every restart logs all devices out. This is acceptable for a local pilot but not seamless appliance behavior.
40. There is no graceful shutdown handler or explicit DB close/checkpoint.
41. No startup integrity check (`PRAGMA quick_check`) or automated restore validation against the active version.
42. Migrations are imperative and not globally transactional/versioned. A failure can leave a partially migrated database.
43. Hidden portable launcher logs have no rotation.
44. Portable install requires system Node and internet for first `npm install`; only the packaged installer is self-contained.
45. Portable hidden launch has no simple matching stop control.
46. Server crash recovery exists in the installer watchdog but not portable launch.
47. Health endpoint proves the process responds, not that DB writes, printer or backup work.
48. SQLite is suitable for one server, but multi-device request races need explicit transaction/idempotency design.

### UX and accessibility

49. Latest phone UX is strong, but no current retail Chromium screenshots/tests prove it.
50. Modals do not trap focus or restore focus consistently.
51. Many controls rely on color/status tags without dedicated screen-reader semantics.
52. Native `prompt()` remains in legacy table flow.
53. Scanner timing heuristics can misclassify unusually fast typing or slow scanners; no test/calibration screen exists.
54. Barcode capture pauses in any form/modal, so it cannot automatically fill a new-product barcode field unless the field is manually focused—which is safe but should be documented.

---

## 6. Permission review

### Intended retail roles

| Capability | Seller | Owner/Admin | Actual assessment |
|---|---:|---:|---|
| Open/close till | Yes | Yes | Implemented; seller can control all close inputs |
| Create/pay sale | Yes | Yes | Implemented; payment integrity defects are P0 |
| View all open/closed sales | Yes | Yes | Broad shared-till visibility |
| Product/category/price edits | No | Yes | Server enforced |
| Direct stock edit | No | Yes | Server enforced |
| Receive delivery | Yes | Yes | Seller can materially increase stock |
| Stocktake | Yes | Yes | Seller can count, add unrecorded stock and complete |
| Expenses | Yes | Yes | Seller can alter expected Cash/M-Pesa |
| Complimentary | Yes, checkbox declaration | Yes | Audited but weak authorization |
| Discounts/voids/refunds | No in retail UI | Yes | Server endpoints restricted; legacy manager-PIN helper unsafe |
| Reports | Mostly operational/Z only | Full | Mostly enforced |
| Staff/settings | No | Yes | Enforced in retail model |
| Gift-card issuance | **Yes** | Yes | **Unsafe and outside stated minimal seller role** |
| View customer history | Yes | Yes | Privacy/least-privilege concern |
| View staff time/pay rates | Yes | Yes | Privacy defect |

### Recommended seller policy

Keep seller access to sale, documented receiving, guided stocktake and expense entry, but:

- remove gift-card issuance
- restrict staff/pay/customer detail
- make seller close “submitted for owner review” when non-zero
- owner-review large expenses/deliveries/complementaries
- prevent arbitrary state transitions and cross-order deletes

---

## 7. Flow-by-flow assessment

### Onboarding and CSV import

**Strengths:** transactional setup, owner creation, hashed PIN, bulk CSV, duplicate SKU/barcode checks, sample/CSV mutual exclusion.

**Gaps:** no preview/error CSV report before final setup, no owner backup prompt immediately after setup, 5–6 digit PIN mismatch, starter seller PINs are predictable, no forced PIN change.

### Morning opening

**Strengths:** Cash, M-Pesa and EDC opening figures; one active shift; audit.

**Gaps:** seller can open with arbitrary balances; owner auto-open zero can distort; no previous-close carry-forward validation; no terminal identifier.

### Sale and measured pours

**Strengths:** VAT-inclusive math, integer cents, server prices, measured price/stock factor, consolidated lines, stock recheck at settlement, seller attribution.

**Gaps:** payment replay/closed-order defect, no idempotency, no stock reservation, cost snapshots absent, direct manager unavailable-item override, no offline client queue.

### Complimentary

**Strengths:** separate from revenue/tender, stock and cost impact recorded, measured amounts supported, recorder/authorizer shown.

**Gaps:** seller authorization is declarative; no threshold or owner review; tax treatment remains external; no reversal endpoint.

### Receiving and supplier credit

**Strengths:** transactional stock posting, configured cost protected from seller, payment method affects expected till, pay-later status, audit.

**Gaps:** duplicate posting, optional reference, no actual purchase-cost variance, no due dates/partial settlement/document image, seller can fabricate receiving.

### Stocktake

**Strengths:** freezes sales, one-item workflow, save/jump, sealed/open-ml counting, signed quantity/cost/retail variance, HTTP 500 defect repaired, mandatory before close.

**Gaps:** same seller can enter additions/count/close; no blind-count mode; expected quantity is visible; no recount approval; historical retail valuation is approximate.

### Final reconciliation

**Strengths:** Cash + M-Pesa + Card variance, stock retail offset, tolerance, critical status, required note, strong “possible unrecorded sales” classification.

**Gaps:** all actuals are self-declared, classification is heuristic, refund effects incomplete, no owner approval/lock hash.

### Refunds

**Status:** not market-ready. See P0-04.

### Reports/PDF

**Strengths:** comprehensive selectable builder, no auto-selected sections, totals, stocktake/reconciliation, A4 page fix.

**Gaps:** source financial data is not immutable/fully accurate; truncation not disclosed; formula-injection risk in CSV.

### Printing

**Strengths:** polished browser/ESC-POS output, 58/80mm, spool, printer tests.

**Gaps:** checkout path bypasses network print/drawer; no spool retention; reprint attribution issue.

### Backup/update

**Strengths:** SQLite online backup, readability verification, bounded retention, optional off-site upload, installer rollback philosophy.

**Gaps:** installed scheduled backup destination defect, no restore automation, no UI status/alert, portable mode no schedule, logs/spool unbounded.

---

## 8. Kenya market-readiness considerations outside excluded integrations

### Alcohol licensing and operating controls

Kenya Law’s Alcoholic Drinks Control licensing regulations specify licence-specific hours; county governments also regulate/licence alcoholic-drink retail. OpenPOS stores `sales_hours_enforced`, open/close settings and licence expiry, but the server never enforces them. Licence expiry is only a client-side warning and can be bypassed.

Reference: Kenya Law, Alcoholic Drinks Control (Licensing) Regulations:  
https://new.kenyalaw.org/akn/ke/act/ln/2010/206

**Recommendation:** make operating hours and licence-expiry behavior owner-configurable but server-enforced, with an audited emergency override. Validate actual Nairobi County licence conditions rather than assuming national schedule values.

### Age/access controls

The national Act and licensing framework retain under-18 restrictions and licence/employee requirements. The owner requested no checkout prompt, so the system relies on physical entry/ID policy and receipt warnings. That is operationally acceptable only if the shop actually enforces access before checkout and displays required physical notices.

Reference: Kenya Law, Alcoholic Drinks Control Act:  
https://new.kenyalaw.org/akn/ke/act/2010/4/eng@2014-01-01/source.pdf

### Data protection

OpenPOS stores customer names, phones, emails, spend/visit history, supplier contacts and staff/pay data. ODPC guidance says registration depends on turnover/employee thresholds, with some processing categories non-exempt; even an exempt shop still needs lawful, secure and transparent handling.

ODPC’s FAQ states the general exemption requires both annual turnover below KSh 5 million and fewer than ten employees, subject to non-exempt categories.

References:

- https://www.odpc.go.ke/faqs/
- https://www.odpc.go.ke/wp-content/uploads/2024/02/ODPC-Guidance-Note-on-Registration-of-Data-Controllers-and-Data-Processors.pdf

**Missing product controls:** privacy notice, consent/lawful-basis record for loyalty, customer data export/correction/deletion workflow, retention schedule, breach process, encrypted off-device backup and access report.

---

## 9. Prioritized remediation roadmap

## Phase 0 — Transaction safety (must precede production)

1. Make payment settlement idempotent and reject closed/void orders.
2. Cap every payment, including Cash, at current balance; separate tendered from applied amount/change.
3. Guarantee stock/loyalty close-out runs once.
4. Disable or redesign gift-card issuance/funding and mask codes.
5. Implement line/tender-aware refunds with shift and stock handling.
6. Snapshot closed-sale tax, discount, cost and COGS values.
7. Run full retail API/UI/browser suite in CI.

**Exit criterion:** retrying any money/stock request cannot duplicate value or stock movement.

## Phase 1 — Fraud controls and permissions

8. Replace item-status API with explicit role/state transition matrix.
9. Restrict pending delete, staff pay/timeclock and customer history.
10. Replace manager re-login with action-scoped approval.
11. Archive transacted master data instead of delete.
12. Add owner review queue for seller delivery, expense, stock additions, complimentary and non-zero close.
13. Prevent last-admin disable and force starter PIN change.

## Phase 2 — Accounting and reporting correctness

14. Persist immutable closed invoice/line snapshots.
15. Allocate order discounts to lines.
16. Correct VAT reporting to exclude tips and use stored tax.
17. Reverse COGS/stock correctly on returns.
18. Define payment-date versus business-date accounting policy.
19. Add purchase price history and supplier payable aging.
20. Label estimated stock-retail valuation and show valuation basis.

## Phase 3 — Reliability and hardware

21. Wire successful checkout to ESC/POS network printing and drawer kick.
22. Fix ProgramData backup destination; expose last backup status.
23. Add spool/log rotation and restore wizard.
24. Add startup DB integrity check and versioned transactional migrations.
25. Add graceful shutdown/checkpoint and portable watchdog/stop utility.
26. Add stock reservation across devices/shared sources.

## Phase 4 — Security, privacy and compliance operations

27. Authenticated/rate-limited SSE.
28. TLS/VPN deployment profile, Secure cookies, CSP, Origin/CSRF checks.
29. Data retention/privacy controls and ODPC assessment.
30. Server-enforced licensed hours/expiry with audited override.
31. Tamper-evident audit export/off-device copy.

---

## 10. Go-live gate

Do not call the system production-ready until all are true:

- [ ] Duplicate payment retry is harmless.
- [ ] Closed/void orders reject every payment.
- [ ] Cash overpayment cannot inflate recorded takings.
- [ ] Stock posts exactly once per closed sale.
- [ ] Gift cards cannot be created without funded payment.
- [ ] Refund updates correct tender, shift, stock, COGS and receipt.
- [ ] Historical report values do not change after cost/price edits.
- [ ] VAT excludes tips and uses stored closed-sale tax.
- [ ] Seller cannot bypass stock/till controls through alternate APIs.
- [ ] Product/category deletion cannot destroy or fail against history.
- [ ] Normal checkout prints to configured thermal printer and kicks drawer.
- [ ] Scheduled backup writes outside Program Files and restore has been tested.
- [ ] Full retail tests pass in CI and on a Windows VM.
- [ ] 320/375/480 retail screenshots and PDF page counts pass.
- [ ] Shop network is private or HTTPS/VPN protected.
- [ ] Privacy/retention and county licence procedures are documented.

---

## 11. Final recommendation

### Suitable today

- owner-supervised pilot
- training and controlled parallel run
- local trial where sales are also independently checked against actual tender and stock
- demonstration to prospective users with clear limitations

### Not suitable today

- unattended seller operation
- use as sole financial/accounting record
- high-value gift-card operation
- deployment where refunds are common
- multi-till concurrent selling without reservation controls
- public internet exposure
- a commercial promise of loss prevention or audit-grade accounts

The product has a strong foundation and a thoughtfully localized operating model. The next investment should not be more features. It should be a focused hardening release covering payment idempotency, immutable accounting snapshots, returns, gift-card funding, permissions, backup verification and automated retail regression testing. Closing those areas would move OpenPOS from an impressive pilot to a credible small-shop product.

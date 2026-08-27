# OpenPOS Wines & Spirits — Post-Hardening Audit and Readiness Report

**Audit date:** 27 August 2026  
**Branch reviewed:** `arena/01a03f39-openpos`  
**Code baseline:** `e0c1849` (including hardening commit `1a19e91`)  
**Intended deployment:** one very small Kenyan wines and spirits shop, approximately two sellers and one owner, with one local Windows host and phone/tablet access on a private LAN.

This report deliberately excludes the topics the owner asked to leave out. It assesses the local POS itself: retail sales, Cash/Card/manual mobile-money recording, inventory, measured portions, weighed kegs, returns, gift cards, permissions, reconciliation, reports, printing, backup, installation, privacy, security, reliability and tests.

Seller-controlled deliveries, expenses, stocktake added-stock entry and complimentary declarations were reviewed as existing operating controls but were not changed. The required simple complimentary declaration remains intact.

---

## 1. Executive verdict

### Overall status: **Ready for a controlled, owner-supervised pilot; not yet ready for unattended production**

The hardening release materially improved the system. The former highest-risk defects—repeat payment after close, repeat stock posting, unfunded retail gift cards, generic refunds, mutable costs/tax totals, misdirected installed backups and checkout bypass of the network printer—now have credible protections.

For the intended one-shop, one-till environment, the retail workflow is practical and substantially complete. It is suitable for a parallel run where the owner checks daily tender totals, stocktake and backups.

It should not yet be treated as the shop's only authoritative financial record or left to operate without owner review. The remaining release blockers are narrower than in the previous audit, but important:

1. The complete API/UI/retail suite and real Windows installation have not produced a successful result in an active CI workflow.
2. Returns accept duplicate copies of the same sale line in one API request and allocate multi-line refund amounts incorrectly under discounts.
3. A discount can still be changed after part-payment or even after close, breaking immutable receipt consistency and potentially stranding a partially paid sale.
4. Profit reporting uses VAT-inclusive revenue as the basis for gross profit.
5. Partial-payment receipts are labelled “PAID” even when a balance remains.
6. Security and operational durability remain appropriate only for a trusted private LAN and disciplined Windows host.

### Readiness scorecard

| Area | Rating | Current verdict |
|---|---:|---|
| Core retail checkout | 8/10 | Strong for supervised pilot |
| Payment close-once integrity | 8/10 | Strong in shipped browser; compatibility gap for keyless partial-payment clients |
| Returns/refunds | 6/10 | Real workflow exists; duplicate-line and allocation defects require correction |
| Gift-card funding | 8/10 | Funded, shift-linked and owner-controlled; reversal/refund lifecycle incomplete |
| Bottle/portion/keg inventory | 8/10 | Good small-shop design; no cross-cart reservation |
| Till and final reconciliation | 8/10 | Strong three-tender plus stock model |
| Financial reporting | 6/10 | Much improved snapshots; profit and period consistency issues remain |
| Permissions | 7/10 | Major bypasses closed; manager-PIN session replacement remains |
| Receipt printing | 8/10 | Checkout network path and fallback implemented; return network print and spool lifecycle remain |
| Backup/recovery | 7/10 | Correct destination and integrity verification; no proven full restore/catch-up/off-device default |
| Windows packaging | 6/10 | Good source design; installer compile/install/uninstall not evidenced by active CI |
| Phone UI | 8/10 | Compact and practical; current hardened flows lack executed browser regression proof |
| Security/privacy | 5/10 | Private-LAN deployment only |
| Maintainability | 6/10 | Broad tests and clear modules, but a 2,140-line server and imperative migrations raise risk |
| **Overall unattended-production readiness** | **6/10** | **No-go until release blockers are closed and full tests pass** |

---

## 2. Audit method and evidence

### Reviewed

- Approximately **10,284 lines** across core server/database code, libraries, browser assets, scripts and tests.
- **125 Express route declarations**.
- **37 `CREATE TABLE IF NOT EXISTS` declarations**, including compatibility/migration declarations.
- Sales creation, line mutation, payment, close-out, return and refund paths.
- Gift-card funding, redemption and voiding.
- Product, stock, receiving, stocktake, complimentary and expense paths.
- Cash/M-Pesa/Card till calculations and final reconciliation.
- Summary, item, seller, category, stock, Z and custom PDF reporting.
- Browser and ESC/POS receipt paths.
- Session, role and sensitive-data exposure paths.
- Portable launcher, Windows installer, watchdog, backup and verification scripts.
- Test runner and proposed CI definition.

### Validation completed in this audit

- JavaScript syntax checks passed for core, libraries, browser assets, scripts and all tests.
- `git diff --check` passed.
- Domain suite: **53 passed, 0 failed**.
- Packaging invariant suite: **36 passed, 0 failed**.
- Static route, role, schema, transaction and report review completed.

### Validation not completed

`npm test` did **not** complete. Domain and packaging tests passed first, but the retail server could not start because dependencies are absent in this sandbox:

```text
Error: Cannot find module 'express'
```

Therefore the following were not executed here:

- Retail API suite.
- General API/end-to-end suite.
- Feature suite.
- jsdom UI suite.
- Chromium responsive/visual suite.
- A compiled Windows installer install/start/upgrade/uninstall exercise.
- Real network printer and cash drawer hardware tests.

The repository contains `ci/openpos-ci.yml`, but it is not under `.github/workflows`; GitHub CI is therefore not active. This is a release-evidence gap, not merely a documentation issue.

---

## 3. What the hardening release successfully closed

### 3.1 Payment and stock close-out

**Status: substantially closed.**

- Payments reject closed/void orders.
- Shipped browser sends a stable idempotency key for each payment attempt.
- Same-key retry returns the prior result.
- Applied payment is capped at balance for every tender.
- Cash tendered and change are separated from applied sale value.
- Atomic `closed_out=0` transition requires exactly one changed row.
- Stock and loyalty posting happen only after that transition.
- Final stock availability is checked before settlement.

This removes the former direct route to duplicate payment, duplicate stock depletion and duplicate loyalty posting.

### 3.2 Gift-card funding

**Status: production-capable for simple issuance, with lifecycle limitations.**

- Issuance is manager/admin-only.
- An open till is mandatory.
- Cash, Card or M-Pesa funding is mandatory.
- Non-cash funding requires a unique reference.
- Funding is shift-linked and included in expected tender without being counted as sale revenue.
- Retail redemption rejects unfunded legacy cards.
- Sellers cannot list the full card register.

### 3.3 Returns

**Status: major improvement, but not yet release-ready.**

- Returns identify original sale lines and quantities.
- Total and tender-specific refundable limits are enforced.
- Cash/Card/M-Pesa refund methods are shift-linked.
- Optional restocking observes measured-stock factors.
- Weighed stock remains physical-count controlled.
- Return, return-line, refund-payment and audit records are created transactionally.
- A dedicated return receipt exists.

The remaining defects are documented in section 4.

### 3.4 Immutable sale values

**Status: mostly closed for new sales.**

New closed orders store subtotal, service, VAT, total and grand-total snapshots. Lines store cost and allocated discount. Reports now use those values and reverse return quantity/revenue/COGS. Historical costs can only be frozen at migration-time values; that unavoidable historical limitation is correctly documented.

### 3.5 Permission tightening

**Status: materially improved.**

- SSE requires authentication.
- Item state changes are limited to explicit actions and roles.
- Kitchen-only roles cannot delete pending lines.
- Sellers only see their own time records without pay rates.
- Last-admin demotion/disable is prevented through the update path.
- Sold products and referenced stock are protected from unsafe deletion.
- Network receipt printing is restricted to till-capable roles.

### 3.6 Backup and checkout printing

**Status: design corrected.**

- Installed backups resolve to `%ProgramData%\OpenPOS\backups`.
- Backup creation runs SQLite `integrity_check` and bounded rotation.
- The owner has a “Verify latest backup” shortcut.
- Successful checkout calls the configured network receipt printer.
- Browser printing is the fallback.
- Cash drawer kick is limited to original cash checkout, not ordinary reprints.

---

## 4. Release blockers

## P0-01 — Full retail and Windows release evidence is still missing

**Evidence:** `test/run.js`, `ci/openpos-ci.yml`, repository workflow location, and this audit's failed `npm test` run.

The proposed CI definition is credible, but inactive. Static packaging tests do not prove that:

- native SQLite dependencies install correctly on the supported Windows runtime;
- every API and UI test passes after the hardening changes;
- the installer starts OpenPOS with writable ProgramData data/spool directories;
- scheduled backup and watchdog tasks run under the installed security context;
- upgrade and uninstall preserve data;
- hardened checkout/return flows remain usable at 320/375/480px.

**Production gate:** activate the workflow, obtain green Linux and Windows runs, build the real installer, then perform an install/start/sale/backup/verify/update/uninstall-preserve-data smoke test on a clean Windows machine or VM.

## P0-02 — One return request can return the same line more than once

**Evidence:** `server.js:852-864`.

Each requested entry checks previously stored return quantity independently. The request is not grouped by `order_item_id`. A crafted request can include the same line twice; both entries see the same prior returned quantity, allowing their combined quantity to exceed what was sold.

**Impact:** excess stock can be restored and return-item reporting can exceed sold quantity. Total cash exposure remains constrained by the remaining paid amount, but inventory and quantity history can be corrupted.

**Required fix:** normalize/group request lines by sale-line ID before validation, reject duplicates or validate the combined quantity, and add an API regression test.

## P0-03 — Discounted multi-line refunds can create invalid line allocations

**Evidence:** `server.js:863-877`.

`selectedValue` is discount-adjusted, but each non-final line's allocation numerator uses gross `price × qty`. With order discounts, an early line can receive more than the entire refund and the final line can become negative.

**Impact:** product/category return revenue and return receipt line values can be wrong even though the refund payment total is correct.

**Required fix:** calculate each selected line's net refundable value first, allocate against those net values, force non-negative line allocations and assign only rounding residue to the final line. Add discounted two-line, partial-quantity and repeated-return tests.

## P0-04 — Discounts remain mutable after payment and close

**Evidence:** `server.js:614-622`.

The discount endpoint does not restrict order status or consider existing payments.

Consequences:

- A closed order's `discount` and `discount_reason` can change while its total/VAT snapshots stay fixed, making the receipt internally inconsistent.
- A discount applied after a partial payment can make paid value exceed the newly calculated total. There is no zero-value settlement action to close that stranded billed order.
- Allocated line discounts remain from close while the order-level discount can later differ.

**Required fix:** only permit discount changes before the first payment, or implement an explicit audited adjustment/return document. Closed sale snapshots and allocated discounts must never be edited in place.

## P0-05 — Full “paid” receipt is printed after a partial payment

**Evidence:** `public/assets/cashier.js:394-410`, `public/assets/print.js:22`.

After every successful payment request, the browser calls `printReceipt(..., { paid: true })`, even when the returned order is only `billed` and still has a balance.

**Impact:** a customer can receive a document labelled `SALES RECEIPT · PAID` before settlement is complete.

**Required fix:** print `paid: r.order.status === 'closed'`; for partial payments, label the document `PART PAYMENT` and prominently show amount received and balance remaining.

---

## 5. High-priority findings

## P1-01 — Gross profit is calculated from VAT-inclusive sales

**Evidence:** `server.js:1282-1300`.

The summary correctly derives `netSales = gross - vatCollected`, but calculates:

```text
grossProfit = gross - cogs
```

For VAT-inclusive pricing, this overstates gross profit by the VAT portion. Item/category margin also uses VAT-inclusive revenue.

**Required fix:** define report labels precisely and calculate accounting gross profit as net sales excluding VAT minus COGS. If the owner also wants a VAT-inclusive contribution view, show it under a separate label.

## P1-02 — Seller/item/category reports use inconsistent return periods

**Evidence:** `server.js:1277-1337`.

- Summary subtracts refunds occurring in the selected return date range.
- Item and category reports place returns in the return date range.
- Seller report selects sales by original close date but includes all refund payments attached to those orders, including refunds made later.

A later refund can therefore rewrite an older seller-period report while appearing in the current summary/item report.

**Required fix:** adopt one explicit reporting policy. Recommended: sales on close date and returns on return date, with returns attributed to the original seller in the return period.

## P1-03 — Manager-PIN approval replaces the seller's login session

**Evidence:** `public/assets/api.js:160-184`.

The helper calls the normal login endpoint. A valid owner/manager PIN replaces the session cookie, but the visible browser state still identifies the seller. Subsequent server actions run as the owner/manager until logout or restart.

This path remains reachable in legacy screens and in retail edge cases such as trying to remove a non-pending line.

**Required fix:** use an action-scoped approval endpoint/token that does not change the signed-in user. Record both actor and approver.

## P1-04 — Five- and six-digit PIN entry is unreliable

**Evidence:** `public/assets/app.js:68-83`.

The keypad automatically submits 160ms after digit four even though setup and staff forms permit 4-6 digits. A user normally cannot enter digit five before the four-digit attempt runs and clears the input.

**Required fix:** standardize on exactly four digits, or add an explicit Enter action and stop automatic four-digit submission for variable-length PINs.

## P1-05 — Payment idempotency is optional for API clients

**Evidence:** `server.js:651-660`.

The shipped browser sends keys and closed-sale protection prevents replay after final settlement. A legacy/custom client that omits a key can still duplicate a partial payment retry while the order remains billed.

**Required fix:** after a compatibility window, require an idempotency key on every payment request. Until then, document that only the shipped browser is supported for payment entry.

## P1-06 — Non-restocked returns have incomplete loss accounting

**Evidence:** `server.js:1288-1293` and return handling.

All returned-item cost is reversed from COGS whether or not the product is returned to stock. For damaged/not-resellable goods, no inventory write-off/loss account is posted. Profit can therefore be overstated after a non-restocked return.

**Required fix:** distinguish “returned to saleable stock” from “damaged/write-off.” Reverse sale COGS consistently, then record non-resellable cost as a separate loss/stock movement so inventory and profit remain explainable.

## P1-07 — Commission and other descriptive order fields can change after close

**Evidence:** `server.js:625-634`, `server.js:2035-2041`, and similar order metadata routes.

The commission endpoint has no status restriction and commission is not part of the close snapshot. Transfer/people endpoints also lack a closed-status guard. These do not alter the payment ledger, but they allow historical reporting/receipt context to change after settlement.

**Required fix:** freeze financial/reporting metadata at close; use audited correction records rather than editing closed sales.

## P1-08 — Trusted-LAN security remains a deployment requirement

The app binds to all interfaces. Cookies are HttpOnly and SameSite=Lax but not Secure; sessions are in memory; there is no Origin/CSRF enforcement, CSP, clickjacking protection or general security-header middleware.

**Impact:** acceptable only on a controlled shop LAN and locked-down host. It should not be exposed directly to public Wi-Fi, port forwarding or the public internet.

**Required operational control:** dedicated/private Wi-Fi or VLAN, strong Windows account protection, firewall limited to trusted LAN profiles, and no router port-forwarding. Add security headers and origin checks before broader deployment.

---

## 6. Medium-priority findings and operating risks

### Transaction and inventory

1. Stock is checked at add and final payment but not reserved across two phones/open carts. The later payer can be blocked after the customer has already ordered.
2. Payment idempotent replay always reports `change: 0`; a retried cash checkout cannot recover the original change figure from structured fields, though the payment reference records it as text.
3. Payment and return idempotency keys are stored globally, but returns have no direct `return_id` link on the payment. Replaying an older return key after a later return can return the latest return record for that order rather than the matching record.
4. Return receipt printing is browser-only; it does not use the configured network thermal printer route.
5. Loyalty points and customer lifetime spend are not reversed on returns.
6. Gift-card and loyalty-funded portions cannot be returned to their original value store.
7. Gift-card voiding has no funding-refund/reversal workflow and does not distinguish unused from partially redeemed cards.
8. Product/category attribution is not snapshotted. Renaming or moving a product can rewrite historical category reports.
9. Historical receipt VAT amount is frozen, but the displayed VAT rate label comes from current settings and can differ from the original rate.
10. Weighed-keg stock intentionally depends on physical stocktake rather than automatic depletion; incorrect weight/tare entry remains an operational risk.

### Existing seller-controlled workflows

The following remain as required and were not restricted:

- Seller deliveries.
- Seller expenses.
- Seller added-stock entry during stocktake.
- Seller complimentary declaration using “I confirm the owner authorized this complimentary issue,” with optional phone/message note.

They are correctly audited and reported, but they remain declarative controls. The same seller can enter the event and the explanation that affects reconciliation. For the present two-seller shop, this is an accepted owner-review risk rather than a software permission defect. Daily owner review of these report sections is therefore part of readiness.

These write endpoints also do not use request idempotency keys. Browser double-submit/network retry could duplicate delivery, expense or complimentary stock effects. No change is proposed here without the owner's separate instruction, but the risk should be covered operationally by same-day report review.

### Reports

11. Shift clearing by station/category uses gross line value, not allocated discounts or return lines.
12. Average ticket divides period net-after-refunds by original closed-order count; refunds for prior sales can distort the current average.
13. The item report is capped at 100 rows without a visible “truncated” indicator.
14. Delivery, stocktake, shift and audit endpoints have fixed limits; custom PDFs can look complete when they are not.
15. Sales CSV export does not neutralize cells beginning with `=`, `+`, `-` or `@`, creating spreadsheet formula-injection risk when names are opened in Excel.
16. Stock retail variance is an estimated potential selling value, not an accounting valuation; it should remain clearly labelled as an operational estimate.
17. There is no fiscal-period lock or signed/tamper-evident daily close export.

### Permissions and privacy

18. Every authenticated retail seller can search/list customers and retrieve contact details, spend and points history. This is convenient but broader than minimum checkout need.
19. Sellers can list up to 100 historical shifts, including counted and expected tender totals.
20. Sellers can read detailed stock movements, delivery history and stocktake history. This supports their required work but exposes the complete loss trail to every seller.
21. In-memory sessions have no server-side expiry timestamp and remain in the map until logout/restart. Browser expiry does not itself invalidate a copied token on the server.
22. Login throttling is IP-wide, so one device can temporarily block all users behind the same address; it also resets on process restart.
23. Audit rows are append-only through the API but are not tamper-evident against someone with direct database/Windows file access.
24. Customer/staff/supplier retention, correction/export and deletion procedures are not implemented as owner tools.

### Reliability, backup and Windows operation

25. There is no startup `quick_check`; corruption is discovered only during backup verification or failures.
26. Migrations are imperative and not wrapped in one versioned migration transaction. A failed startup migration can leave a partially upgraded database.
27. There is no graceful SIGTERM/SIGINT shutdown with explicit WAL checkpoint and database close.
28. `/healthz` confirms the process responds, not that the database is writable or a recent backup exists.
29. The daily 23:30 task has no catch-up behavior if the PC is off at that time.
30. Backup verification is a read-only integrity drill, not a full restore-to-replacement-database rehearsal.
31. Off-device backup is optional and not configured by default. Fire, theft, disk failure or ransomware can remove both database and local backups.
32. Local backups and receipt spool are not encrypted.
33. Receipt spool has no age/count rotation or owner purge function.
34. **100 generated `.prn` files remain tracked in Git**, despite `.gitignore` stating generated print jobs should never be committed.
35. Portable startup logs have no rotation.
36. Installed ProgramData write permissions and scheduled-task execution context are not proven by an installation test.

### UI/accessibility

37. Current hardened return, gift-card and payment paths do not have an executed browser/phone regression result in this environment.
38. Modals do not consistently trap and restore keyboard focus.
39. Some status meaning relies on color and compact visual tags without dedicated screen-reader text.
40. Native `prompt()` remains in a legacy order flow.
41. Scanner timing is heuristic and lacks an owner-facing calibration/test screen.
42. The app closes the payment modal after a partial payment and clears the active sale selection. The remaining sale is recoverable from bills, but the flow is less obvious than keeping the balance open onscreen.

---

## 7. Flow-by-flow readiness

| Flow | Readiness | Audit conclusion |
|---|---|---|
| First-run setup | Pilot-ready | Transactional, hashed owner PIN, starter/CSV mutual exclusion. Variable-length PIN login remains defective. |
| Product CSV onboarding | Pilot-ready | Transactional validation, duplicate checks and measured-source linking are strong. No preview/dry-run error report. |
| Till opening | Pilot-ready | Three opening balances and audit exist. Owner auto-open at zero can knowingly create a reconciliation discrepancy. |
| Whole bottle sale | Near production-ready | Server pricing, stock checks, immutable close and idempotent browser payment are strong. Full suite evidence still required. |
| Measured bottle/shot | Near production-ready | Proportional price, six-decimal stock and readable open-container display are well designed. |
| Weighed keg | Pilot-ready | Physical-count model is appropriate, but quality depends on correct scale/tare procedure. |
| Split/partial payment | Needs fix | Core ledger works; keyless clients can retry and partial receipt is wrongly marked paid. Post-payment discount can strand the sale. |
| Cash change | Near production-ready | Tendered/change is server-validated and applied amount is capped. Replay response should retain original change. |
| Gift-card issue/redeem | Pilot-ready | Funding and tender reconciliation are sound for simple use. Refund/void lifecycle is incomplete. |
| Return/refund | Needs fix | Correct foundation, but duplicate lines and discounted allocation are release blockers. |
| Complimentary | Pilot-ready under owner review | Required simple seller declaration is preserved; reports show recorder, owner and note. |
| Supplier receiving | Pilot-ready under owner review | Transactional stock and till expense posting. Duplicate submission remains operationally detectable rather than prevented. |
| Stocktake | Pilot-ready | Full/open-container counts, additions and valuation work. Seller self-entry is an accepted owner-review policy. |
| Final reconciliation | Strong pilot-ready | Clear Cash/M-Pesa/Card and stock variance model; “possible unrecorded sales” wording avoids false balance claims. |
| Operational reports/PDF | Pilot-ready | Broad and useful; profit formula, period attribution and hidden truncation prevent accounting-grade status. |
| Thermal receipt | Pilot-ready | Checkout network print/fallback and original-cash drawer kick are implemented. Hardware test required. |
| Backup | Pilot-ready | Correct installed destination and integrity verification. Off-device and full restore drill remain required for production resilience. |
| Windows installation | Awaiting evidence | Source design is good; clean-machine execution has not been proven. |

---

## 8. Recommended release plan

### Phase A — Must complete before unattended production

1. Fix duplicate return-line validation.
2. Fix discounted multi-line refund allocation.
3. Freeze discounts and financial metadata after first payment/close.
4. Correct partial-payment receipt status and balance display.
5. Correct gross-profit calculation to exclude VAT.
6. Align seller/item/category return-period reporting.
7. Activate and pass full Linux/Windows CI.
8. Complete a clean Windows installer lifecycle smoke test.

### Phase B — Strongly recommended before relying on OpenPOS as the primary record

9. Require payment idempotency keys for all clients.
10. Replace manager re-login with action-scoped approval.
11. Resolve four-versus-six-digit PIN login behavior.
12. Link refund payments directly to return records and snapshot return tax allocation.
13. Add explicit damaged/non-resellable return loss accounting.
14. Add startup DB check, versioned transactional migrations and graceful shutdown.
15. Add spool/log rotation and backup-status visibility.
16. Configure and test an off-device backup destination.
17. Add report truncation metadata and CSV formula neutralization.

### Phase C — Operational maturity

18. Add stock reservation or shared-source availability across open carts.
19. Add customer privacy/retention tools and reduce seller customer payloads.
20. Add server-side session expiry and baseline security headers/origin checks.
21. Add tamper-evident signed daily close export.
22. Add gift-card/loyalty-specific return paths.
23. Add printer queue/retry status and network return-receipt printing.

---

## 9. Go-live gate

### Software gate

- [ ] Duplicate sale-line IDs cannot over-return quantity or stock.
- [ ] Discounted multi-line return allocations are non-negative and total exactly to the refund.
- [ ] Discounts cannot mutate a paid or closed sale.
- [ ] Partial payment prints “PART PAYMENT,” not “PAID,” and shows remaining balance.
- [ ] Gross profit excludes VAT and matches line/report totals.
- [ ] Returns appear consistently in the selected reporting period.
- [ ] Every supported payment client sends a required idempotency key.
- [ ] Manager approval does not replace the seller session.
- [ ] All supported PIN lengths work reliably, or the product standard is exactly four digits.

### Test and installation gate

- [ ] Full `npm test` passes from a clean dependency install on Node 20.
- [ ] Linux and Windows CI are active and green.
- [ ] 320/375/480px hardened retail flows pass real-browser tests.
- [ ] A real installer is compiled and installed on a clean Windows machine.
- [ ] Installed app starts after login/reboot and allows phone access on the trusted LAN.
- [ ] Upgrade preserves data; uninstall “keep data” preserves data; reinstall reopens it.
- [ ] Real thermal receipt and cash drawer behavior are tested with the shop hardware.

### Shop operating gate

- [ ] Owner and both sellers complete realistic training sales, measured portions, returns and close-out.
- [ ] Owner reviews deliveries, expenses, added stock and complementaries daily.
- [ ] Owner compares Cash/M-Pesa/Card totals and stock for at least 7-14 parallel-run days.
- [ ] Latest local backup verifies successfully.
- [ ] A backup is restored on a separate test location/device without touching the live database.
- [ ] Off-device backup is configured and retrieval tested.
- [ ] POS Windows account is locked down and the service is reachable only from trusted shop devices.
- [ ] Paper/manual fallback procedure exists for PC, router, power or printer failure.

---

## 10. Final readiness recommendation

### Approve now for

- Owner-supervised pilot in the intended single small shop.
- Staff training.
- A 7-14 day parallel run against independent daily tender and stock checks.
- Normal whole-bottle and measured sales where the shipped browser is the only payment client.
- Daily use while the owner explicitly reviews exceptions and maintains fallback records.

### Do not approve yet for

- Unattended seller-only operation.
- Use as the only authoritative financial/accounting record.
- High-volume return processing.
- Public-network or public-internet exposure.
- Multi-till or high-concurrency use.
- A commercial release claiming fully tested Windows installation and recovery.

### Bottom line

OpenPOS has advanced from a fragile pilot to a **credible, controlled-pilot retail system**. Its core local-first retail design is sound, and the hardening work closed most of the previous critical transaction risks. The remaining no-go items are now specific and testable rather than architectural.

After the five functional release blockers are fixed, the full suites pass on Linux and Windows, and a clean Windows installation/restore drill succeeds, the system can reasonably be considered **production-ready for this specific one-shop, one-till, owner-supervised operating model**. Broader or unattended deployment would still require the security, session, off-device backup and operational-maturity work listed above.

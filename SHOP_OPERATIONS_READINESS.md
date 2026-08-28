# OpenPOS Shop Operations Readiness — Opening to Close

**Assessment date:** 27 August 2026  
**Operating model:** one wines and spirits shop, one shared till/business shift, approximately two sellers and one owner.

This report covers the practical trading day from starting the shop to completing reconciliation and backup. It does not revisit the excluded topics from the main audit. Seller control of deliveries, expenses, stocktake added-stock entries and complimentary declarations remains unchanged.

---

## 1. Operational verdict

### Overall day-operation readiness: **7/10 — suitable for a controlled daily pilot**

OpenPOS has a coherent start-to-finish operating cycle:

```text
Start PC → sign in → open shared till → sell/receive/record events
→ stop sales → start full stocktake → complete count
→ enter actual Cash/M-Pesa/Card → reconcile → close till
→ review reports → back up and verify
```

The sequence is practical for a very small shop and the application enforces several important dependencies:

- Retail sales cannot start without an open till.
- Sellers cannot continue selling once stocktake changes the till to reconciliation mode.
- Till close is blocked while sales remain open or billed.
- Till close enforces the owner-configured stock-count policy: no count, any closing count or a full count.
- Every product selected in a full/category/selected/cycle/spot count must be counted or deliberately skipped/no-change before completion.
- Non-zero reconciliation requires an explanation.
- Cash, M-Pesa, Card and stock variance are shown separately and together.
- The final status distinguishes genuine balance from offsetting discrepancies.

The system is operationally stronger than the overall production score because the intended shop is small and owner-supervised. It is not yet a hands-off appliance: the owner must enforce opening-count discipline, review seller-entered events, avoid the known partial-payment/return edge cases, and verify backup completion.

---

## 2. Recommended daily sequence

## Stage 1 — Start the shop system

### Operator actions

1. Switch on the Windows till PC and router/private shop network.
2. Allow OpenPOS to start automatically, or use the OpenPOS shortcut.
3. Open OpenPOS on the till PC.
4. Connect seller phones using the shop LAN address if needed.
5. Confirm the correct business name appears and the app responds on each device.
6. Confirm the receipt printer is powered, has paper and is reachable.
7. Check that the previous backup exists and has recently verified, especially after any abnormal shutdown.

### Current system support

- Packaged startup is hidden and single-instance.
- The watchdog checks every five minutes and restarts an unresponsive server.
- Business data is stored outside Program Files.
- The firewall setup is intended for Private/Domain LAN profiles.
- The app exposes a simple process health endpoint.

### Operational weaknesses

- The health check does not prove the database is writable, the printer works or the latest backup is current.
- Startup does not run a database integrity check.
- There is no owner dashboard warning for “last backup failed/too old.”
- Real installed startup and ProgramData permissions still need a clean Windows test.

### Pilot rule

Do not begin trading if the server repeatedly restarts, yesterday's data is missing, or the database/stock figures look wrong. Keep a paper fallback book for sales during an outage.

---

## Stage 2 — Staff sign-in

### Operator actions

1. Each seller uses their own PIN—never share the owner PIN.
2. The owner uses the owner/admin account only for management actions.
3. If timeclock is used, each person clocks in under their own account.

### Current system support

- PINs are stored as salted scrypt hashes.
- Failed PIN attempts are throttled.
- Sales, payments, stock events and audit records retain the acting user.
- Sellers only see their own timeclock rows without pay rates.

### Operational weaknesses

- Use **four-digit PINs during the pilot**. Five- and six-digit PINs are allowed by setup but the login screen attempts authentication after digit four.
- A manager-PIN approval can replace the seller's server session while leaving the visible seller name unchanged. In normal retail use, avoid manager-PIN prompts; the owner should perform the action from an owner session.
- Sessions are stored in memory, so a server restart signs every device out.

---

## Stage 3 — Physically prepare and open the till

### Count before entry

Before pressing **Open till for sales**, physically establish:

- Cash float in the drawer.
- Opening M-Pesa business balance used for shop reconciliation.
- Opening Card/EDC batch position used by the shop's close procedure.

### Operator actions

1. Go to the money/till screen.
2. Enter opening Cash, M-Pesa and Card figures.
3. Add an opening note when anything differs from the previous close.
4. Press **Open till for sales**.
5. Confirm the screen shows **Till open**.

### Current system support

- Only one open/reconciling shift is allowed.
- Opening figures and opener identity are stored and audited.
- Both sellers share the same business shift, matching one-counter operation.
- A seller can open the till as required.

### Important operating rule

The owner/admin should also open the till manually before selling. If an owner starts a sale with no shift, OpenPOS can automatically open a zero-balance shift. That is convenient but can make reconciliation wrong when physical opening balances were not zero.

### Operational weakness

Opening figures are self-declared; the system does not carry forward or independently verify the previous close. The owner should compare today's opening figures to yesterday's signed closing report.

---

## Stage 4 — Pre-trade checks

Before the first customer:

1. Confirm the expected seller can start a new sale.
2. Check a few high-value products against physical stock.
3. Check measured bottle products show the correct source bottle and price preview.
4. Check weighed keg products are available only when intended.
5. Make one low-value test receipt if the printer configuration changed.
6. Confirm receipt paper and cash drawer behavior.

### Why this matters

Product prices and stock recipes drive every later sale and stocktake. A wrong bottle size, cost or recipe can process correctly but produce the wrong business result all day.

---

## Stage 5 — Normal customer sale

### Whole bottle/unit sale

1. Start a sale.
2. Tap or scan products.
3. Confirm consolidated quantity, price and total.
4. Adjust/remove items before payment.
5. Take Cash, Card or M-Pesa payment.
6. Confirm any required reference.
7. Give the final receipt.

### Measured bottle sale

1. Select Whole, Half, Quarter, Shot or Custom ml.
2. Confirm the displayed millilitres and proportional price.
3. Tap/scan the correct bottle product.
4. Confirm the sale line includes the measured amount.
5. Complete payment normally.

### Weighed keg sale

Record the sale normally. The application does not automatically subtract weighed-keg stock; final physical weight at stocktake controls the quantity.

### Current controls

- Prices are taken from the server, not trusted from the browser.
- VAT-inclusive totals keep the entered shelf price as the customer total.
- Duplicate taps consolidate identical retail lines.
- Stock is checked when adding and again before final settlement.
- Closed/void sales reject further payment.
- Shipped browser payment attempts are idempotent.
- Stock and loyalty close-out post once.
- Cash tendered and change are validated by the server.
- Network printing is attempted first when configured, with browser fallback.

### Daily-use cautions

- Two open phones do not reserve stock. If both sell the last shared bottle/source, the second checkout can be blocked. For scarce/high-value stock, verbally coordinate between sellers.
- Avoid partial/split payments during the pilot unless necessary. The ledger supports them, but the current browser prints a document marked **PAID** after a partial payment and moves the remaining sale back to the bills list.
- Never apply or change a discount after any payment has been recorded. The present endpoint can make a partially paid sale inconsistent or change a closed sale's displayed discount.
- Use only the shipped OpenPOS browser for payments; external clients that omit idempotency keys can duplicate a retried partial payment.
- If network printing fails, confirm whether the browser fallback actually printed before pressing reprint repeatedly.

---

## Stage 6 — Record events during the day

## Deliveries

When stock arrives:

1. Confirm there is no active stocktake.
2. Open Deliveries and record supplier/reference, payment method and quantities.
3. Check the displayed total before saving.
4. Physically mark the invoice/delivery note as entered into OpenPOS.
5. If pay-later stock is later paid, use **Mark paid** once.

The seller continues to control this flow as required. Saving posts stock and, for Cash/M-Pesa purchases, posts the till expense effect.

**Operating control:** write the OpenPOS delivery number on the paper invoice, and never submit the form twice after a slow response. There is no delivery request-idempotency key.

## Expenses

Record Cash or M-Pesa business expenses immediately against the open till with a clear reason. Keep the paper/mobile evidence.

The seller continues to control this flow as required.

**Operating control:** do not use “expense” to represent an unexplained shortage or a transfer between accounts. The owner should compare each entry to evidence at close.

## Complimentary issue

1. Choose the product and measure.
2. Enter reason and recipient/explanation where required.
3. Tick **I confirm the owner authorized this complimentary issue**.
4. Optionally record the phone/message authorization note.
5. Save once.

The simple declaration remains exactly as requested—no owner PIN or one-time code.

**Operating control:** the owner reviews the complimentary report daily. Avoid repeat submission after a slow response because the endpoint has no request-idempotency key.

## Returns/refunds

Only an owner/admin should process returns.

During the pilot:

- Prefer one returned sale line per return transaction.
- Avoid discounted multi-line returns until the allocation defect is fixed.
- Confirm whether the item is genuinely resellable before ticking return-to-stock.
- Keep the original receipt/reference and issue the return receipt.
- Do not expect gift-card value or loyalty points to be restored automatically.

Returns are the weakest day-operation area and should remain owner-controlled.

---

## Stage 7 — Monitor during trading

At quiet points, the owner or senior seller should check:

- Open/billed sales are genuine and not abandoned.
- Latest payments match visible confirmations/terminal slips.
- Cash/M-Pesa expenses have evidence.
- Deliveries are entered once.
- Complementaries have understandable reason/authorization notes.
- High-value and measured stock looks plausible.
- Printer has not silently fallen back or accumulated failed jobs.

### Two-seller limitation

OpenPOS uses one shared shift, not a separate drawer/accountability shift per seller. Seller reports identify who opened sales, but the final physical Cash/M-Pesa/Card count belongs to the shared shop till. The software cannot identify which seller caused a shared-till difference without supporting evidence.

For this shop size, the shared model is workable if both sellers hand over clearly and the owner reviews the event trail.

---

## Stage 8 — Prepare to close

Before starting stocktake:

1. Stop accepting new customers.
2. Finish every in-progress payment.
3. Review the bills list for open or partially paid sales.
4. Void genuine empty/abandoned sales where appropriate.
5. Record all final deliveries, expenses and complementaries.
6. Make sure no delivery is physically arriving during the count.
7. Count actual Cash, M-Pesa and Card totals independently before looking for ways to explain a difference.

### Important behavior

Starting a stock count marked **Use this count for the current till close** changes the till to **reconciling** and blocks new sales until close. A non-closing cycle/spot count leaves the till open, but completion is rejected if stock moved after its snapshot.

OpenPOS auto-voids empty retail sale tabs during close, but non-empty open or billed sales block closure.

---

## Stage 9 — Complete full stocktake

### Operator actions

1. Start stocktake and give it a clear reference.
2. Count every sealed unit.
3. For opened bottles, enter sealed/full units plus open-container ml as presented by the UI.
4. Enter physical keg weight for weighed stock.
5. Where stock arrived but was not entered as a delivery, use the existing added-stock field.
6. Use no-change/skip only after physically checking the product.
7. Save progress if interrupted.
8. Complete stocktake only after reviewing all items.

### Current controls

- Expected quantities are frozen at stocktake start.
- Sales stop during reconciliation.
- Every stock record is included.
- Sealed and open-container quantities are supported.
- Added stock is shown separately in the stocktake line.
- Quantity, inventory-cost and potential-retail variances are stored.
- Completion sets stock on hand to the physical count and creates stock movements.
- The completed stocktake is required for till close.

### Operational weaknesses

- Expected quantities are visible, so this is not a blind count.
- The same seller may enter additions, perform the count and close the till, as required by the current operating model.
- Completed stocktakes cannot be reopened or reversed through a guided workflow.
- The potential-retail variance is an estimate based on configured selling paths, not an accounting value.

### Pilot control

For high-value products and all large variances, the second seller or owner should physically recount before pressing Complete. This is a procedure, not a new software permission.

---

## Stage 10 — Reconcile and close the till

### Operator actions

1. Enter actual counted Cash.
2. Enter actual M-Pesa balance.
3. Enter actual Card/EDC batch total.
4. Review expected and variance for each tender.
5. Review stock variance at potential retail.
6. Review total tender variance and overall operational variance.
7. Add an honest note for any non-balanced outcome.
8. Press **Close till**.
9. Save/print the closing report.

### Current calculation

```text
Cash variance    = Actual Cash − Expected Cash
M-Pesa variance  = Actual M-Pesa − Expected M-Pesa
Card variance    = Actual Card − Expected Card
Tender variance  = Cash + M-Pesa + Card variances
Overall variance = Tender variance + stock variance at potential retail
```

### Current status quality

- **FULLY BALANCED** only when every component is within tolerance.
- **RECONCILED — POSSIBLE UNRECORDED SALES** when tender overage plausibly offsets stock shortage.
- **RECONCILED — OFFSETTING VARIANCES** for other offsetting differences.
- Shortage/overage and critical statuses remain visible when not reconciled.

This is a strong operational model because an offsetting Cash and stock difference is not falsely called fully balanced.

### Operational weaknesses

- Actual figures are entered by the operator and not imported from external sources.
- The same person can count stock and enter all actual tender figures.
- Closed shifts have no guided reopen/correction workflow. Check entries carefully before final submission.
- The “possible unrecorded sales” status is a clue, not proof. Wrong prices, counting error or incorrect added stock can create the same pattern.

---

## Stage 11 — Owner end-of-day review

The owner should review, even if a seller closed the till:

1. Closing Cash, M-Pesa and Card expected/actual/variance.
2. Stock variance at cost and potential retail.
3. Every complimentary issue.
4. Every expense.
5. Every delivery and pay-later payment update.
6. Every return/refund.
7. Discounts and voids.
8. Measured-product and high-value-product sales.
9. Seller totals.
10. Audit log for unusual actions.

### Report caution

Operational tender and stock reports are useful. Profit figures should not yet be treated as accounting-grade because gross profit currently uses VAT-inclusive revenue, and some return periods/discounted return allocations can disagree.

The PDF builder is suitable for a daily owner pack, but fixed API limits can truncate large histories without a visible warning. For this very small shop, daily volumes are unlikely to hit most limits, though the item report is capped at 100 products.

---

## Stage 12 — Backup and shutdown

### Current installed behavior

- A scheduled backup runs daily at 23:30.
- It writes outside Program Files to `%ProgramData%\OpenPOS\backups`.
- The last 14 local copies are retained by default.
- Each created backup runs SQLite `integrity_check`.
- The Start menu includes **Verify latest backup**.

### Closing procedure

1. If the PC will remain on past 23:30, allow the scheduled backup to run.
2. If the PC is normally switched off before 23:30, run a manual backup or change the scheduled time during deployment.
3. Run **Verify latest backup** regularly—daily during the pilot and after abnormal shutdowns.
4. Confirm a second/off-device copy exists according to the shop's backup procedure.
5. Close browser tabs and use the OpenPOS stop shortcut before maintenance or planned shutdown when practical.

### Operational weaknesses

- A powered-off PC misses the 23:30 backup; there is no automatic catch-up at next start.
- There is no in-app backup success/failure indicator.
- Verification proves the copy is readable and structurally complete; it is not a full restore replacement rehearsal.
- Local database and backups can be lost together through theft, disk failure or malware.
- Receipt spool and logs have no automatic rotation.

---

## 3. Opening-to-close control matrix

| Control point | System enforcement | Human procedure still required | Readiness |
|---|---|---|---|
| Server startup | Auto-start, single instance, watchdog | Check correct data and devices | Pilot-ready |
| Staff identity | Hashed PIN and audit identity | Use unique four-digit PINs; no sharing | Pilot-ready |
| Opening till | One shared shift; records three balances | Physically count and compare previous close | Pilot-ready |
| Starting sales | Retail till must be open | Do not rely on owner zero auto-open | Strong |
| Price/tax total | Server price and inclusive total calculation | Maintain correct catalogue | Strong |
| Stock availability | Add-time and final checks | Coordinate last units across phones | Pilot-ready |
| Payment | Browser idempotency and close-once posting | Avoid unsupported clients and partial-payment receipt issue | Near ready |
| Cash change | Server validates tender/change | Seller gives correct physical change | Strong |
| Receipt | Network path with browser fallback | Confirm physical output after failure | Pilot-ready |
| Delivery | Transactional stock/till effect | Enter once and mark paper evidence | Pilot-ready under review |
| Expense | Included in expected tender | Keep evidence; do not use as variance explanation | Pilot-ready under review |
| Complimentary | Stock/cost/audit plus simple owner declaration | Owner reviews daily | Pilot-ready under review |
| Return | Owner role, limits, stock option, receipt | Avoid known duplicate/multi-line discount edge cases | Needs fix |
| Stop sales | Stocktake puts till in reconciling mode | Announce cutoff and resolve customers first | Strong |
| Physical stock count | Configurable full/scoped count with frozen expected | Recount large/high-value differences; never treat uncounted stock as zero variance | Strong pilot |
| Tender entry | Cash/M-Pesa/Card actuals mandatory | Count independently and enter carefully | Strong pilot |
| Variance decision | Separate and combined statuses | Investigate; status is not proof | Strong pilot |
| Shift close | Blocks open sales and missing stocktake | Review before irreversible close | Strong pilot |
| Owner review | Broad reports and audit | Daily evidence matching | Required |
| Backup | Scheduled, rotated, integrity-checked | Ensure task ran and keep off-device copy | Pilot-ready |
| Recovery | Read-only verification shortcut | Perform separate restore drill | Needs deployment test |

---

## 4. Minimum pilot operating rules

For safe daily use before remaining software fixes:

1. Use one shared till and one business shift per trading day.
2. Use unique **four-digit** staff PINs.
3. Manually open the till and enter all three true opening figures before the first sale.
4. Use only the shipped OpenPOS browser for taking payment.
5. Avoid partial payments where possible; never treat a partial-payment printout as proof of full settlement.
6. Never add/change a discount after the first payment.
7. Owner handles returns; avoid discounted multi-line returns until fixed.
8. Record deliveries, expenses and complementaries immediately and only once, retaining evidence.
9. Before stocktake, finish every sale and record every event.
10. Recount high-value or material stock variances before completion.
11. Check all actual tender figures before closing because there is no guided reopen.
12. Owner reviews the daily closing pack, even when a seller closes.
13. Verify backups regularly and maintain an off-device copy.
14. Keep a paper fallback sales/expense book and reconcile it into the next controlled process after outages.

---

## 5. Operational go-live test

Before moving from training to pilot, perform this complete rehearsal with the owner and both sellers:

### Opening

- [ ] Restart Windows and confirm automatic server start.
- [ ] Connect the till PC and both seller phones.
- [ ] Sign in with three separate accounts.
- [ ] Open the till with known Cash, M-Pesa and Card figures.

### Trading

- [ ] Sell a whole bottle for Cash and verify change/receipt/stock.
- [ ] Sell a measured portion and verify proportional price and open-bottle balance.
- [ ] Sell by Card and M-Pesa with references.
- [ ] Complete a controlled two-tender payment and identify the remaining-balance behavior.
- [ ] Receive a test delivery.
- [ ] Record one Cash or M-Pesa expense with evidence.
- [ ] Record one seller complimentary with owner-authorized checkbox and note.
- [ ] Complete one owner return of a single, non-discounted line.
- [ ] Reprint a receipt without opening the cash drawer.
- [ ] Disconnect the printer and confirm browser fallback without duplicating the sale.

### Closing

- [ ] Resolve every open/billed sale.
- [ ] Start stocktake and confirm new sales are blocked.
- [ ] Count full units, an open bottle and a weighed item.
- [ ] Enter a controlled added-stock quantity.
- [ ] Complete stocktake and inspect stock movements.
- [ ] Enter known actual Cash/M-Pesa/Card figures.
- [ ] Confirm the expected reconciliation status and required note behavior.
- [ ] Close the till and produce the daily report pack.
- [ ] Owner matches deliveries, expenses, complementaries, returns and variances to evidence.

### Backup/restart

- [ ] Create or wait for a backup.
- [ ] Verify the latest backup.
- [ ] Copy it off the till PC.
- [ ] Restore a copy on a separate test installation/location.
- [ ] Restart the PC and confirm the closed day remains intact.

Run the rehearsal again with a deliberately failed printer, network interruption during a payment attempt, Cash shortage, stock shortage and PC restart. Do not start live pilot trading until the team can explain the expected result in each case.

---

## 6. Final operational recommendation

### The daily workflow itself is coherent

For one owner, two sellers and one shared till, OpenPOS provides the major operating steps needed from morning opening through final stock and tender reconciliation. It is particularly strong in requiring a completed stocktake before close and in keeping individual tender variances visible even when they offset stock.

### The owner remains part of the control system

The software records and reports seller-entered deliveries, expenses, stock additions and complementaries, but does not independently prove them. This matches the requested simple operating model. Consequently, owner review is not optional overhead; it is the compensating control that makes the model workable.

### Readiness decision

- **Training:** ready.
- **Owner-supervised pilot:** ready, using the minimum pilot rules above.
- **Normal unattended operation:** not yet ready.
- **Primary/sole operational record:** only after the functional blockers, full automated tests, Windows installation test and restore rehearsal are completed.

A successful 7-14 day parallel run with clean opening figures, evidence-backed seller events, explainable variances and verified recoverable backups would be the strongest practical proof that the shop is ready to adopt OpenPOS for daily operations.

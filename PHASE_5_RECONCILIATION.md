# Phase 5 — Authoritative Reconciliation and Configurable Stock Counts

**Completed:** 28 August 2026  
**Baseline:** Phase 4 commit `3ad93a0`  
**Approach:** centralize and extend the working reconciliation; do not rebuild it.

## Result

OpenPOS now has one authoritative reconciliation calculation in `lib/domain.js`, used by both the final close endpoint and a live UI preview endpoint.

Daily Cash/M-Pesa/Card reconciliation remains mandatory. Physical stock counting is now owner-configurable and can be full or scoped.

## Stock-count close policy

New setting:

```text
stock_count_close_policy = none | any | full
```

### `none` — default

- Till can close after tender reconciliation without a physical count.
- Stock variance is `null`, not zero.
- Whole-shop overall variance is unavailable.
- Status explicitly says `TENDERS BALANCED — STOCK NOT COUNTED` when tenders balance.

### `any`

- At least one completed count marked for the current till close is required.
- Full or scoped count is accepted.
- Scoped counts produce scoped reconciliation wording.

### `full`

- A completed full count covering the full stock list is required.
- Existing whole-shop reconciliation statuses are preserved.

Invalid policy values are rejected server-side.

## Supported physical count types

```text
full
category
selected
cycle
spot
correction
```

Every count stores:

- Count type.
- Scope label.
- Optional category.
- Whether it is for till close.
- Associated shift.
- Total stock products at snapshot time.
- Products covered.
- Coverage ratio.
- Existing expected, counted, added-stock and variance values.

### Full count

Includes every stock item and can satisfy the `full` closing policy.

### Category count

Includes distinct stock sources linked to products in the chosen category. Shared bottle sources are only counted once.

### Selected/cycle/spot/correction count

Includes only explicitly selected stock items.

A non-closing cycle or spot count leaves the till open. To prevent it overwriting intervening sales or deliveries, completion is rejected if any selected stock balance changed after the frozen snapshot. The count must then be restarted from current stock.

A count marked for till close preserves the existing safe behavior: open sales must be resolved, the till enters reconciliation mode and further sales are blocked.

## Authoritative domain calculation

New pure functions:

```text
expectedTender(...)
reconcile(...)
```

`expectedTender` is used consistently for Cash, M-Pesa and Card:

```text
opening + sales - refunds - expenses = expected tender
```

`reconcile` receives the three independent tender variances, optional stock variance, coverage, tolerance and critical threshold.

It returns:

```text
cash_variance
mpesa_variance
card_variance
tender_variance
stock_retail_variance
overall_variance
stock_coverage
status
requires_note
tolerance
```

## Full-count statuses

The existing classifications remain:

- `FULLY BALANCED`
- `RECONCILED — POSSIBLE UNRECORDED SALES`
- `RECONCILED — OFFSETTING VARIANCES`
- `SHORTAGE — INVESTIGATE`
- `OVERAGE — INVESTIGATE`
- `CRITICAL SHORTAGE`
- `CRITICAL OVERAGE`

The important offset example remains:

```text
Cash variance       +1,500
Stock variance      -1,500
Overall variance         0
Status              RECONCILED — POSSIBLE UNRECORDED SALES
```

It is not falsely called fully balanced because the individual components differ.

## Partial-count statuses

Scoped counts cannot claim whole-shop balance:

- `TENDERS BALANCED — PARTIAL STOCK COUNT`
- `SCOPED RECONCILED — POSSIBLE UNRECORDED SALES`
- `SCOPED RECONCILED — OFFSETTING VARIANCES`
- Scoped shortage/overage and critical variants

The numeric overall variance is the tender variance plus the **counted scope's** stock variance only.

## No-count statuses

When stock is not counted:

- `TENDERS BALANCED — STOCK NOT COUNTED`
- `TENDER SHORTAGE — STOCK NOT COUNTED`
- `TENDER OVERAGE — STOCK NOT COUNTED`
- Critical tender shortage/overage variants

`stock_retail_variance` and `overall_variance` remain `null`. The system never converts “not counted” into a misleading zero stock variance.

## Reconciliation preview

New authenticated endpoint:

```text
POST /api/shifts/:id/reconciliation-preview
```

The close modal sends the entered Cash/M-Pesa/Card actuals to this endpoint. The server returns the same domain calculation used by final close.

The browser no longer carries a second copy of the status-classification rules.

## Reconciliation notes

A note is required when:

- Any tender variance exceeds tolerance; or
- A counted stock variance exceeds tolerance.

A note is not required merely because the configured policy allows stock not to be counted, or because a partial count is within tolerance.

## Shift snapshots

Closed shifts now snapshot:

```text
stock_count_id
stock_count_type
stock_coverage
```

Reports and shift history distinguish:

- Full stock coverage.
- Partial/scoped coverage.
- Stock not counted.

Reports display `NOT COUNTED` and `NOT AVAILABLE` rather than formatting null stock/overall variance as KSh 0.

## UI changes

### Settings

The owner can choose:

- No stock count required—daily tender reconciliation only.
- Any completed closing count.
- Full physical count.

### Stock counts

The former full-only start dialog now supports type, category/product scope and whether the count is for till close.

History shows:

- Type.
- Scope.
- Closing-count marker.
- Covered products versus total products.

### Till close

The close screen shows stock coverage and uses the server preview for status, note requirement and overall availability.

## Schema migration

New `stock_counts` columns:

```text
count_type
scope_label
category_id
for_close
shift_id
total_stock_items
coverage_count
coverage_ratio
```

New `shifts` columns:

```text
stock_count_id
stock_count_type
stock_coverage
```

Historical stock counts default to `full`; their line count and total coverage are backfilled where possible. Historical shift records remain readable.

A database built from the pre-Phase-5 `3ad93a0` schema upgraded successfully and passed `PRAGMA foreign_key_check`.

## Tests

### Before Phase 5

```text
601 passed, 0 failed
```

### After Phase 5

```text
Domain and reconciliation             65 passed
Packaging                              37 passed
Architecture structure                 17 passed
Retail workflow                        55 passed
Phase 2 transaction hardening          19 passed
Inventory packages and ledger          20 passed
Count policy/reconciliation API        17 passed
General API/end-to-end                107 passed
Feature/API                           146 passed
Shipped-client UI                     147 passed
---------------------------------------------------
Total                                 630 passed, 0 failed
```

New tests cover:

- Generic expected-tender equation.
- Full exact balance.
- Cash shortage and surplus.
- Stock shortage and surplus.
- KSh 1,500 offset example.
- Offsetting tender methods.
- Critical no-count tender shortage.
- No-count null stock/overall values.
- Partial/scoped status.
- Default no-count close.
- Invalid policy rejection.
- Full policy rejecting a category count.
- Full policy accepting a complete count.
- Any-count policy accepting a spot count without claiming full balance.
- Category scope selection.
- Selected-product spot and cycle counts.
- Non-closing count leaving the till open.
- Stale non-closing count snapshot rejection.
- Closing count/shift association.

Syntax checks and `git diff --check` passed.

## Deliberately unchanged

- Seller ability to start and complete counts.
- Seller added-stock entry.
- Deliveries.
- Expenses.
- Complimentary declaration.
- Existing Cash/M-Pesa/Card actual entry.
- Existing tolerance and critical-threshold settings.
- Stock valuation basis.
- Sale and payment logic.
- Gift cards and loyalty.
- Hospitality mode.

## Operational note

The owner should choose a close policy deliberately:

- Use `none` when daily tender reconciliation is required but stock is counted on a cycle schedule.
- Use `any` when a selected high-value/category count is required each close.
- Use `full` when the shop intentionally performs a complete physical count at every close.

A partial count is useful operational evidence, but it cannot establish that uncounted stock is balanced.

## Remaining validation limitation

The standard suite is green. Real Chromium validation remains blocked by the undeclared Puppeteer dependency, and Windows installer/physical-device testing remains pending.

## Next phase

Phase 6 should consolidate the retail frontend, split `manager.js`/`manager2.js` into focused browser modules and retire hospitality features from the active retail UI while preserving configured hospitality mode internally.

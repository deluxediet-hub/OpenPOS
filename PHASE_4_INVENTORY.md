# Phase 4 — Inventory and Package Strengthening

**Completed:** 28 August 2026  
**Baseline:** Phase 3 commit `ff726ee`  
**Approach:** extend the existing product → stock item → recipe model; do not replace it.

## Result

OpenPOS now supports deterministic case/crate/carton-style conversions while retaining the existing canonical stock quantity, bottle fractions, measured portions, recipes and stocktake behavior.

A package is a conversion into an existing physical stock item:

```text
Package Test Beer 500ml — base stock: bottle
Crate of 24              — 24 bottles
Case of 12               — 12 bottles
```

The base stock item remains the only physical balance. Packages do not create a second inventory balance.

## Package model

A stock package stores:

```text
stock_item_id
name
units_per_package
sku
barcode
purchase_cost
sale_price
saleable
active
```

### Receiving

Example:

```text
Receive 2 crates × 24 bottles
Base stock movement: +48 bottles
```

The goods-receipt line snapshots:

- Package ID and name.
- Number of packages received.
- Units per package.
- Canonical base quantity.
- Base-unit cost used for the receipt.

### Selling

A package marked saleable can be sold from the existing bottle product:

```text
Sell 1 crate × 24 bottles
Base stock movement: -24 bottles
```

The sale line snapshots:

- Package ID and name.
- Units per package.
- Package selling price.
- Stock factor.
- Cost snapshot.

Existing bottle and measured sales are unchanged. Selling 12 individual bottles and selling a configured case of 12 both reduce the same underlying bottle stock by 12.

### Barcode/SKU

Packages can have their own SKU and barcode. They cannot conflict with an existing product or another package.

The global scanner now resolves a package barcode/SKU to its base retail product and sells the configured package. Saleable package cards also appear alongside the base product in the retail product grid, so package sales do not require a scanner.

## Package management

The owner can open **Packages** from an inventory row and define:

- Package name, such as Case of 12 or Crate of 24.
- Base-unit conversion.
- Package SKU/barcode.
- Purchase cost.
- Optional sale price and saleable status.

Seller access to operational package information is read-only and supports receiving/scanning. Catalogue control remains owner/manager-only.

## Purchase improvements

The existing goods-receipt API and seller delivery workflow were extended rather than replaced.

### Package receiving UI

Each delivery line now chooses:

1. Physical stock item.
2. Base unit or configured package.
3. Quantity received.

The UI explains each conversion, for example:

```text
Crate of 24 = 24 bottles
```

### Idempotency

The browser creates one stable delivery idempotency key. Repeating the same request returns the original goods receipt and does not add stock again.

Legacy clients may continue omitting the key for compatibility.

### Receipt detail

A read-only goods-receipt detail endpoint exposes the snapshotted package conversion and base quantity for audit and testing.

## Structured stock ledger

The existing `stock_moves` table remains the stock audit trail. It was extended with:

```text
movement_type
reference_type
reference_id
reference_code
qty_before
qty_after
unit_cost_snapshot
idempotency_key
```

All new stock-changing paths use one `inventory-ledger` service:

- Product/opening stock.
- CSV opening stock.
- Starter opening stock.
- Purchase/delivery.
- Sale close-out.
- Return to stock.
- Complimentary issue.
- Stocktake posting.
- Direct owner adjustment.
- Breakage/spoilage/supplier return adjustments.

### Standard movement types

```text
PURCHASE
DELIVERY
SALE
SALE_REVERSAL
OPENING_STOCK
STOCKTAKE
ADJUSTMENT
BREAKAGE
SPOILAGE
COMPLIMENTARY
TRANSFER_IN
TRANSFER_OUT
RETURN
SUPPLIER_RETURN
LEGACY
```

The service validates movement type, signed quantity, stock item, before/after quantity and cost snapshot.

### Historical movements

Existing movements are not deleted. Safe reason prefixes are backfilled to known types:

- Recipe usage → SALE
- Delivery → PURCHASE
- Opening stock → OPENING_STOCK
- Stocktake → STOCKTAKE
- Complimentary → COMPLIMENTARY
- Return → RETURN

Anything that cannot be classified safely remains `LEGACY`. Historical before/after values remain null when they cannot be reconstructed reliably.

## Adjustment improvements

The existing owner stock-correction capability remains available. It now supports explicit adjustment types:

- Correction.
- Breakage/leakage.
- Spoilage/expiry.
- Supplier return.

Every new adjustment records:

- Who.
- When.
- Product.
- Movement type.
- Quantity before.
- Signed change.
- Quantity after.
- Reason.
- Optional reference.
- Unit-cost snapshot.

Direct stock-control edits that change quantity also create an `ADJUSTMENT` ledger entry instead of silently changing the balance.

## Reports/UI

The inventory screen and custom stock-movement PDF now show:

- Movement type.
- Before quantity.
- Change.
- After quantity.
- Human-readable reason.
- Reference code.
- Actor.

Old legacy movements remain visible with unknown before/after values shown as `—`.

## Schema migration

New table:

```text
stock_packages
```

New `stock_moves` columns:

```text
movement_type
reference_type
reference_id
reference_code
qty_before
qty_after
unit_cost_snapshot
idempotency_key
```

New `order_items` columns:

```text
package_id
package_name
units_per_package
```

New `goods_receipts` column:

```text
idempotency_key
```

New `goods_receipt_items` columns:

```text
package_id
package_name
package_qty
units_per_package
```

Partial unique indexes protect package SKU/barcode, purchase idempotency and optional movement idempotency.

A database created by the pre-Phase-4 `ff726ee` schema was upgraded with the current code. New tables/columns were present and `PRAGMA foreign_key_check` returned no errors.

## Tests

### Before Phase 4

```text
580 passed, 0 failed
```

### After Phase 4

```text
Domain                              53 passed
Packaging                           37 passed
Architecture structure              17 passed
Retail workflow                     55 passed
Phase 2 transaction hardening       19 passed
Inventory packages and ledger       20 passed
General API/end-to-end             107 passed
Feature/API                        146 passed
Shipped-client UI                  147 passed
------------------------------------------------
Total                              601 passed, 0 failed
```

New regression coverage proves:

- Opening stock has structured before/after fields.
- Owner can define a crate conversion.
- Package barcode cannot collide with product barcode.
- Package metadata reaches operational clients.
- Two crates of 24 receive 48 base bottles.
- Purchase line snapshots package quantity/conversion.
- Purchase retry does not duplicate stock.
- Purchase movement links to its receipt and reference.
- One crate sale deducts 24 bottles.
- Crate sale uses configured package price.
- Twelve individual bottle sales use the same base balance.
- Sale movements contain before/after values.
- Breakage is typed and auditable.
- A package cannot be applied to unrelated product stock.

Syntax checks and `git diff --check` passed.

## Deliberately unchanged

- Existing bottle stock quantities.
- Fractional/open-bottle stock.
- Custom ml and shot sales.
- Weighed-keg behavior.
- Product → stock item → recipe architecture.
- Seller delivery permission.
- Seller expenses.
- Seller stocktake additions.
- Seller complimentary declaration.
- Existing base-unit delivery requests.
- Existing stocktake and reconciliation formula.
- Hospitality mode.
- Gift cards and loyalty.

## Deferred intentionally

### Internal transfers

Movement types exist for `TRANSFER_IN` and `TRANSFER_OUT`, but no transfer workflow was added. The current one-shop model has no confirmed need for separate Main Store/Display/Back Store balances. A transfer workflow should be added only with a real location requirement and must post paired movements atomically.

### Dedicated opening-stock batch

Opening stock is now fully typed and auditable whether created through products, CSV, starter data or stock master creation. A separate opening-stock batch/document wizard was not added because the existing opening mechanisms work and duplicating them would violate the polishing approach.

### Actual invoice-cost editing by sellers

Package purchase cost and base configured stock cost drive receipt valuation. Seller receiving permissions and existing cost-control behavior were preserved. A broader supplier price-history/actual-cost policy requires a separate owner decision.

## Remaining validation limitation

The standard suite is green. Current package cards and delivery controls are covered by syntax, API and existing shipped-client regression tests, but the real Chromium visual suite remains unavailable because Puppeteer is undeclared. Physical barcode scanner and Windows installer tests remain later release gates.

## Next phase

Phase 5 should centralize reconciliation classifications in `lib/domain.js` and add configurable full/category/selected/cycle/spot stock-count policies without treating uncounted inventory as zero variance.

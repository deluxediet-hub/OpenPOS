# Phase 6 — Retail UI Consolidation

**Completed:** 28 August 2026  
**Baseline:** Phase 5 commit `c8ca368`  
**Approach:** make retail the primary active experience while preserving reusable hospitality behavior.

## Result

The active Wines & Spirits UI is now focused on sales, receipts, products, stock, purchasing, stock counts, till reconciliation, reports, staff and settings.

Hospitality functionality remains available in restaurant mode, but it is not presented as part of the retail workflow.

## Retail navigation

Retail owner/manager navigation now contains:

```text
Dashboard
Reports
Products & Pricing
Stock
Till & Reconciliation
Team
Settings
```

The following are removed from active retail navigation:

- Bookings/reservations.
- Labour reports.
- Loyalty panel.
- Restaurant pricing options/modifiers/recipes/dayparts.
- Kitchen/KDS.
- Floor/table workflow.

The stock group retains:

- Inventory and package conversions.
- Physical stock counts.
- Deliveries/purchases.
- Suppliers.

Seller access remains focused on sale, receipts and operations.

## Retail checkout

Retail checkout now visibly offers only:

```text
Cash
Card
M-Pesa
```

Tip controls are removed in retail mode. Tip functionality and historical tip fields remain available for restaurant mode and old receipts.

Existing retail behavior remains intact:

- Product search.
- Product and package barcode scanning.
- Category filtering.
- Whole bottle, package and measured portions.
- Stock visibility.
- Cart and partial payments.
- Direct receipt printing.

## Loyalty and gift cards

### Loyalty

The loyalty panel and loyalty PDF option are hidden from active retail mode. Underlying customer/points records and APIs are preserved for compatibility and restaurant mode.

### Gift cards

Gift-card tables, funded balances, redemption rules and APIs were not deleted or rewritten. The custom report builder retains the Gift Cards section so the owner can review outstanding funded liability.

No funded balance is silently removed.

## Hospitality preservation

Existing restaurant behavior remains tested and available:

- Floor and table management.
- Kitchen and bar display.
- Reservations.
- Labour/timeclock reports.
- Tips.
- Loyalty and gift-card management.
- Modifiers, recipes and timed pricing.
- Guest ordering page.

Retail routes already redirect or reject the KDS/customer-ordering pages, and retail rail navigation does not expose them.

## `manager2.js` removal

`manager2.js` was not merged into the already-large `manager.js`.

Its responsibilities were identified and moved into focused modules:

```text
manager-pricing.js
  dayparts
  recipes
  modifiers

manager-reconciliation.js
  till opening
  expenses
  tender close
  reconciliation preview/history

manager-hospitality.js
  reservations
  labour/timeclock reporting

manager-loyalty.js
  customers
  loyalty
  funded gift cards

manager-system.js
  printer configuration
  integration configuration/dry-run panels
```

`manager.js` remains the shared navigation/controller and retains its existing dashboard, report builder, catalogue, inventory, staff, settings and audit panels. It dispatches to explicit module functions rather than indexing a second monolithic controller.

`manager2.js` has been deleted.

This is intentionally less risky than rewriting all management screens at once. Further extraction from `manager.js` can be considered only if a later change genuinely needs it.

## Script order and packaging

`public/index.html` loads the five focused modules before `manager.js`. The existing installer recursively packages the public directory, so no production dependency or build tool was added.

The frontend remains plain JavaScript with classic scripts.

## Tests

### Before Phase 6

```text
630 passed, 0 failed
```

### After Phase 6

```text
Domain and reconciliation             65 passed
Packaging                              37 passed
Architecture/UI structure              21 passed
Retail workflow                        55 passed
Phase 2 transaction hardening          19 passed
Inventory packages and ledger          20 passed
Count policy/reconciliation API        17 passed
General API/end-to-end                107 passed
Feature/API                           146 passed
Shipped-client UI                     154 passed
---------------------------------------------------
Total                                 641 passed, 0 failed
```

New structural tests verify:

- `manager2.js` is absent.
- All five focused manager modules exist.
- Retail manager filters loyalty from active navigation.
- Retail checkout conditionally removes tips.

New shipped-client UI tests switch the actual application into Wines & Spirits mode and verify:

- Bookings are absent.
- Labour and loyalty are absent.
- Restaurant pricing panels are absent.
- Till & Reconciliation is explicit.
- Tip inputs/buttons are absent.
- Cash, Card and M-Pesa remain.
- No uncaught browser errors occur.

The complete restaurant UI suite also remains green, proving the reusable hospitality mode was not destroyed.

## Deliberately unchanged

- Sales/payment APIs.
- Product and stock calculations.
- Package conversions.
- Reconciliation formulas and count policy.
- Seller deliveries.
- Seller expenses.
- Seller added-stock entry.
- Seller complimentary declaration.
- Gift-card balances and funding records.
- Restaurant-mode tips.
- Restaurant-mode floor/KDS/reservations/labour.
- Database schema.
- Installer and backup behavior.

## Remaining limitation

The retail UI is verified through the real shipped client bundle in jsdom. The separate real-Chromium responsive suite remains blocked because Puppeteer is not declared. Existing screenshots are not claimed as fresh Phase 6 proof.

## Next phase

Phase 7 should harden direct printing, PIN/session authorization and operator-facing backup/recovery while preserving the simplified retail UI.

# Phase 3 — Incremental Server Modularization

**Completed:** 28 August 2026  
**Baseline:** Phase 2 commit `a054713`  
**Constraint:** preserve every endpoint, request/response shape, permission and database transaction.

## Result

`server.js` is now a 274-line composition root instead of a 2,000+ line route monolith. Existing code was moved behind explicit registration/service boundaries; it was not rewritten into a new framework.

The total Express route declaration count remains **125**.

## Final structure

```text
server.js

routes/
  auth.js
  catalogue.js
  channels.js
  complimentaries.js
  hospitality.js
  integrations.js
  inventory.js
  locations.js
  loyalty.js
  orders.js
  payment-search.js
  payments.js
  pricing.js
  printing.js
  purchases.js
  qr-ordering.js
  reports.js
  returns.js
  shifts.js
  stocktakes.js
  tables.js
  users.js

services/
  reconciliation.js
  retail-till.js
  sale-closeout.js
```

## Boundaries

### `server.js`

Retains only application composition and genuinely shared app concerns:

- Database and library imports.
- Express JSON middleware.
- Route dependency wiring.
- SSE broadcast channel.
- Setup/onboarding endpoints.
- Shared menu/order decoration used by several routes.
- Bootstrap response.
- Static frontend routes.
- Health endpoint and process start.

### Authentication

`routes/auth.js` owns:

- In-memory session store.
- Login-attempt throttle.
- Cookie parsing.
- Current-user lookup.
- `requireAuth` and `requireRole` middleware.
- Login, logout and current-user endpoints.

The existing cookie, session and role behavior is unchanged.

### Sales transactions

- `routes/orders.js` owns cart/order lifecycle.
- `routes/payments.js` owns payment validation and the atomic settlement transaction.
- `routes/returns.js` owns item-linked returns/refunds.
- `services/sale-closeout.js` owns the stock and loyalty posting that runs inside successful close.
- `services/retail-till.js` preserves the existing shared-till/owner-auto-open behavior.

Payment, stock and return operations retain their original transaction boundaries.

### Stock operations

- `routes/inventory.js`: stock master data and owner adjustments.
- `routes/purchases.js`: suppliers and goods receipts.
- `routes/stocktakes.js`: physical stock counts and seller-added stock.
- `routes/complimentaries.js`: existing simple complimentary declarations.

Seller-controlled delivery, expense, stocktake-addition and complimentary behavior was not changed.

### Reconciliation

- `routes/shifts.js` owns shift opening/closing, expenses and clearing sheets.
- `services/reconciliation.js` owns collection of expected Cash/M-Pesa/Card ledger figures.

Status-classification calculations remain unchanged. Their later movement into pure `domain.js` functions belongs to the dedicated reconciliation phase rather than being mixed into this structural change.

### Printing

`routes/printing.js` owns:

- Sale receipt payload construction.
- Kitchen ticket payload construction.
- Direct network delivery.
- Spool output.
- Printer errors and responses.

`lib/escpos.js` remains the underlying printer implementation.

### Reusable non-retail capabilities

Hospitality functionality was preserved rather than deleted:

- `routes/hospitality.js`: tabs, timeclock/labour and reservations.
- `routes/tables.js`: floor/table master data.
- `routes/qr-ordering.js`: token-based guest ordering.
- `routes/pricing.js`: dayparts, recipes and modifiers.

This makes later retail-mode retirement cleaner without destroying reusable configured restaurant behavior.

### Other focused boundaries

- `routes/catalogue.js`: products, categories and retail product import.
- `routes/reports.js`: operational/financial reports, audit and current settings routes.
- `routes/loyalty.js`: customers, points and funded gift cards.
- `routes/locations.js`: location master data.
- `routes/channels.js`: order-channel reporting and commission.
- `routes/integrations.js`: configuration inspection and dry-run payloads only.
- `routes/payment-search.js`: payment lookup and latest receipt.
- `routes/users.js`: staff account management.

## Dependency style

Each route module receives only its explicit dependencies:

```js
require('./routes/payments')(app, {
  db,
  domain,
  requireAuth,
  requireRole,
  // existing helpers and services
});
```

This avoids:

- An ORM.
- A dependency-injection package.
- A global service locator.
- Circular imports back into `server.js`.
- A new web framework.

Route modules register against the existing Express app, so URLs and middleware order remain compatible.

## Tests

### Before Phase 3

```text
563 passed, 0 failed
```

### After Phase 3

```text
Domain                              53 passed
Packaging                           37 passed
Architecture structure              16 passed
Retail workflow                     55 passed
Phase 2 transaction hardening       19 passed
General API/end-to-end             107 passed
Feature/API                        146 passed
Shipped-client UI                  147 passed
------------------------------------------------
Total                              580 passed, 0 failed
```

The suite was run after the first high-risk extraction group and again after the complete route split.

New static architecture tests verify:

- `server.js` remains below 400 lines.
- All 125 route declarations are preserved.
- Core route/service modules exist.
- Payment, return, shift-close and receipt-print endpoints each register exactly once.
- Route modules do not import `server.js`.
- The Express app is still exported for the test harness.

JavaScript syntax checks and `git diff --check` passed.

## API and data compatibility

- Endpoint paths: unchanged.
- HTTP methods: unchanged.
- Request bodies: unchanged.
- Response bodies: unchanged.
- Authentication behavior: unchanged.
- Role permissions: unchanged.
- Database schema: unchanged in Phase 3.
- Stored data migration: none.
- Frontend files: unchanged in Phase 3.

The Windows payload builder now includes `routes/` and `services/`; otherwise the newly modular server would work from source but fail after installation. A packaging regression test enforces this requirement.

## Deliberately left untouched

- Payment and return rules completed in Phase 2.
- Product/stock/recipe model.
- Case/crate/carton conversion.
- Stock movement schema.
- Reconciliation formula and stock-count policy.
- Retail UI and `manager2.js`.
- Hospitality features.
- PIN policy and session lifetime.
- Printer spool retention.
- Backup and installer behavior.

Those belong to later phases and were intentionally excluded from this structural change.

## Remaining limitation

The standard Linux suite is green. The responsive Chromium suite remains blocked by its undeclared Puppeteer dependency, and Windows CI/installer execution remains pending as previously documented.

## Next phase

Phase 4 can now strengthen packages, purchase units and structured stock movements within focused catalogue/inventory/purchase services instead of adding more logic to `server.js`.

# Phase 2 — Financial and Transaction Polishing

**Completed:** 28 August 2026  
**Baseline:** Phase 1 commit `67043f3`  
**Approach:** targeted corrections only; no route split, inventory redesign or seller-workflow restriction.

## Result

Phase 2 closes the specific financial and transaction defects found in the post-hardening audit while preserving the existing APIs and operating model.

## Changes

### 1. Returns cannot duplicate one sale line

The return endpoint now rejects a request containing the same `order_item_id` more than once. Quantity validation still includes all previous returns for that sale line.

This prevents one request from restoring more stock than was sold.

### 2. Discounted return allocation is non-negative and exact

Return allocation now uses each selected line's immutable value after its allocated order discount.

For a KSh 1,000 line and KSh 500 line with a KSh 300 proportional discount:

```text
Net first line:    KSh 800
Net second line:   KSh 400
Total refund:      KSh 1,200
```

The final line receives only the rounding residue. Every line must remain non-negative, and line amounts total exactly to the refund payment.

### 3. Refund payments link directly to returns

Payments now include `return_id`. A partial unique index prevents more than one refund-payment row from claiming the same return.

Idempotent return replay resolves the exact linked return instead of selecting the latest return on the order.

### 4. Discounts and financial metadata freeze after payment

A discount is accepted only while the sale is open/billed and has no sale payment. It cannot exceed the current live subtotal.

After payment starts or the order closes:

- Discount changes return HTTP 409.
- Commission changes return HTTP 409.
- Closed order people/table-transfer metadata cannot be changed.

Corrections to a settled sale must use the return process rather than mutating the original transaction.

### 5. Partial-payment documents are truthful

A billed sale with money received now prints:

```text
PART PAYMENT - BALANCE DUE
BALANCE REMAINING ...
```

Browser and direct ESC/POS formats both support this state. The server refuses to label a non-closed order `PAID`, even if a caller requests `paid=1`.

The checkout toast also shows the remaining balance, and a cash drawer kick occurs only after full cash settlement.

### 6. Cash retry returns original change

Payments now snapshot:

- `tendered`
- `change_given`

An idempotent retry returns the original tender and change instead of incorrectly returning zero change.

### 7. Gross-profit basis corrected

Summary gross profit is now:

```text
Sales excluding VAT - COGS
```

Margin is calculated against sales excluding VAT. Management screens now distinguish:

- Sales including VAT
- Sales excluding VAT
- Gross profit excluding VAT
- VAT included

### 8. Non-resellable return cost retained and disclosed

A return put back into saleable stock reverses its COGS. A non-restocked return does not reverse stock cost and is exposed separately as `inventory_loss`.

Fully returned damaged products remain visible in item reporting when their revenue and quantity net to zero but cost remains.

### 9. Seller return-period reporting aligned

Seller reports now apply the same period policy as summary/product/category reporting:

- Sales belong to their close date.
- Returns belong to their return date.
- A return is attributed to the original seller in the return period.
- Tips are not treated as seller sales revenue.

## Schema migration

The existing startup migration adds three nullable/backward-compatible payment columns:

```text
payments.tendered       INTEGER
payments.change_given   INTEGER NOT NULL DEFAULT 0
payments.return_id      INTEGER
```

It also creates:

```text
ux_payment_return ON payments(return_id) WHERE return_id IS NOT NULL
```

Historical rows remain valid. Existing return payments have no recoverable exact return link and therefore retain `NULL`; new returns are linked exactly.

The migration and index were validated on a fresh temporary database.

## Tests

### Before Phase 2

```text
544 passed, 0 failed
```

### After Phase 2

```text
Domain                              53 passed
Packaging                           36 passed
Retail workflow                     55 passed
Phase 2 transaction hardening       19 passed
General API/end-to-end             107 passed
Feature/API                        146 passed
Shipped-client UI                  147 passed
------------------------------------------------
Total                              563 passed, 0 failed
```

New regression coverage proves:

- Discount is allowed before payment.
- Discount is rejected after partial payment.
- Discount is rejected after close.
- Part-payment document cannot claim paid status.
- Cash replay returns original tender/change.
- Duplicate return lines are rejected without stock movement.
- Discounted return allocations are exact and non-negative.
- Refund payment links to the return.
- Return replay resolves the exact original return.
- Non-restocked return cost remains in COGS and is disclosed.
- Gross profit uses VAT-exclusive sales.
- Seller and summary return-period totals agree.
- Closed-sale commission is immutable.

JavaScript syntax checks and `git diff --check` passed.

## Deliberately unchanged

- Existing endpoint paths and request formats.
- Cash, Card and manual M-Pesa payment methods.
- Gift-card and loyalty behavior.
- VAT-inclusive shelf pricing.
- Sale-to-stock and close-once posting.
- Supplier receiving.
- Seller-controlled deliveries.
- Seller expenses.
- Seller stocktake additions.
- Seller complimentary declaration and optional authorization note.
- Physical stocktake and reconciliation formula.
- Restaurant/hospitality mode.
- Installer and backup behavior.

Payment idempotency keys remain optional for legacy API compatibility. The shipped browser sends them. Requiring them for every external client is intentionally deferred until API compatibility policy is decided.

## Remaining test limitations

- The standard Linux suite is green.
- The visual suite still cannot run because Puppeteer is undeclared.
- GitHub Linux/Windows CI is not active.
- A real Windows installer test has not run.
- Printer behavior is tested against a TCP fake printer, not the shop's physical device.

## Next phase

Phase 3 should split `server.js` incrementally without changing these now-tested contracts. Financial behavior changes should not be mixed into that structural phase.

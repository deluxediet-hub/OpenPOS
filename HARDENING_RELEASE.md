# OpenPOS Transaction Hardening Release

This release implements the eight priorities from the non-integration audit. Seller-controlled deliveries, expenses, stock additions and complimentary declarations were deliberately left unchanged as requested.

## Implemented

1. **Payment idempotency and close-once posting**
   - Browser payment attempt gets a stable idempotency key.
   - Same-key retry returns the original result.
   - Closed/void sales reject a different payment.
   - Cash and every other tender are capped at remaining balance.
   - Atomic `closed_out` guard makes stock and loyalty posting run once.

2. **Gift-card funding**
   - Issuance is manager/admin-only.
   - Open till and Cash/Card/M-Pesa funding are mandatory.
   - Non-cash funding requires a unique reference.
   - Funding contributes to expected tender but not sales revenue.
   - Retail redemption rejects old/unfunded cards.

3. **Returns and refunds**
   - Select original items and quantities.
   - Cannot return more than sold or more money than remains refundable.
   - Refund uses Cash/Card/M-Pesa and current shift.
   - Optional restock posts bottle/shot recipe quantities back once.
   - Weighed kegs remain physical-count controlled.
   - Dedicated return record, items, payment, audit and receipt.

4. **Immutable close snapshots**
   - Orders store subtotal, service, VAT, total and grand total.
   - Lines store cost at sale and allocated discount.
   - Reports use snapshots and return reversals rather than current product cost.

5. **Permission tightening**
   - SSE requires login.
   - Item status route permits only explicit ready/void actions and roles.
   - Pending deletion excludes kitchen-only roles.
   - Sellers see only their own timeclock records without pay rates.
   - Last admin cannot be disabled/demoted.
   - Historical products/categories/stock are protected from unsafe deletion.

6. **Backup and restore verification**
   - `POS_BACKUP_DIR` supported.
   - Installer uses `%ProgramData%\\OpenPOS\\backups`.
   - Backups run SQLite `integrity_check`.
   - `npm run backup:verify` performs a read-only restore drill and checks core tables.

7. **Network receipt printing**
   - Successful checkout sends to configured ESC/POS printer.
   - Browser print is the fallback.
   - Cash drawer kick happens on original Cash checkout only, not reprints.

8. **CI and Windows packaging**
   - `ci/openpos-ci.yml` defines a Windows + Linux Node 20 test matrix.
   - Packaging invariants run in the workflow.
   - Its Windows job installs Inno Setup and compiles `OpenPOS-Setup.exe`.
   - Installer artifact size is checked and uploaded.
   - Arena's GitHub App lacks Workflow permission, so activation requires copying this file to `.github/workflows/ci.yml` with a suitably authorized GitHub account.

## Remaining limitations

- Legacy API clients that omit an idempotency key are protected from payment after full close, but partial-payment retry idempotency requires clients to send a key. The shipped browser does.
- Existing historical sales cannot recover their original cost snapshot; migration freezes the current known cost once, while all new sales are exact.
- External KRA, M-Pesa and acquiring-bank transport remains outside this release by instruction.

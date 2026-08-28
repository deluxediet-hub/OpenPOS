# Phase 7 — Printing, Authentication, Backup and Recovery

**Completed:** 28 August 2026  
**Baseline:** Phase 6 commit `d6044db`  
**Approach:** harden the existing local appliance paths without adding cloud requirements or replacing ESC/POS/PIN/SQLite systems.

## Printing

### Direct return receipts

Returns now have a server-generated ESC/POS route:

```text
POST /api/print/return/:id
```

It prints:

- Return number.
- Original sale number.
- Date and operator.
- Returned products and quantities.
- Refund amount and method.
- Reason.
- Whether stock was returned.

The browser attempts this direct route first when a network printer is configured and retains browser printing as fallback.

### Reprint safety

Sale reprints are explicitly labelled `REPRINT` in browser and ESC/POS output.

Reprints suppress the cash-drawer command even if a caller asks for a kick. Original fully settled Cash checkout remains the only normal drawer-kick path.

### Spool retention

Before writing a new print job, OpenPOS now removes spool jobs that are:

- Older than 30 days; or
- Beyond the newest 500 jobs.

The 100 generated `.prn` files previously committed to the repository were removed. Runtime spool output remains ignored by Git and persists in the installed ProgramData spool directory.

Network failure still returns an error while preserving the spool file for recovery/browser fallback.

## Authentication and approvals

### Server-side session expiry

In-memory sessions now have an explicit 12-hour server expiry. An expired copied token is rejected even if a client still sends it.

Logout removes the session and any pending approvals tied to that session.

### Action-scoped manager approval

The old manager-PIN helper called the normal login endpoint, replacing the seller's session. It now calls:

```text
POST /api/authorize
```

The result is:

- Bound to the current seller and session.
- Valid for two minutes.
- Usable only once.
- Accepted only where the endpoint requires manager/admin authority.
- Removed even after a failed use attempt.
- Audit logged with actor, approver and protected path.

The signed-in seller remains the actor after approval. Their browser session is never silently converted into the owner's session.

Approval PIN failures are throttled independently.

Existing protected UI actions pass the approval token explicitly:

- Whole-order void.
- Sent-item void.
- Discount.
- Return/refund authorization.

### Variable-length PIN entry

The existing 4–6 digit policy is preserved rather than changed without an owner decision.

The keypad now:

- Provides an explicit **Sign in** button.
- Supports keyboard Enter.
- Waits 700ms after the last digit before automatic submission.
- Resets that delay as digits are entered.

This allows five- and six-digit PINs to be entered reliably while keeping convenient four-digit automatic login.

PINs remain salted scrypt hashes and are never returned by list/detail APIs.

## Backup and recovery

### Owner-facing backup panel

Settings now includes **Backup & Recovery**, showing:

- Latest backup time and size.
- Number of local copies.
- Backup directory.
- Current/stale status.
- Last integrity result.

The owner can:

- Create a verified hot backup immediately.
- Verify the newest backup with the existing read-only restore drill.

Backup paths and operations remain manager/admin-only.

### Durable backup status

`backup.js` writes `backup-status.json` atomically beside the backups after success or failure. Successful status includes:

- Backup file.
- Time.
- Size.
- Order/product counts.
- Integrity result.

### Missed-backup catch-up

The Windows installer now creates an `OpenPOS Backup Catchup` task at logon. The shared backup runner skips creation when a backup is newer than 20 hours, preventing duplicate copies while catching a nightly backup missed because the PC was off.

Uninstall removes the watchdog, nightly backup and catch-up tasks.

### Startup and shutdown integrity

- Startup runs SQLite `PRAGMA quick_check` and refuses to proceed when integrity is not `ok`.
- SIGTERM/SIGINT stop accepting new requests.
- OpenPOS checkpoints/truncates the WAL and closes SQLite before exiting.
- A five-second forced-exit guard prevents shutdown from hanging indefinitely.

## Tests

### Before Phase 7

```text
641 passed, 0 failed
```

### After Phase 7

```text
Domain and reconciliation             65 passed
Packaging                              39 passed
Architecture structure                 22 passed
Retail workflow                        55 passed
Phase 2 transaction hardening          19 passed
Inventory packages and ledger          20 passed
Count policy/reconciliation API        17 passed
Operations hardening                   15 passed
General API/end-to-end                107 passed
Feature/API                           146 passed
Shipped-client UI                     157 passed
---------------------------------------------------
Total                                 662 passed, 0 failed
```

Operations regressions prove:

- Seller cannot call a protected action directly.
- Owner PIN creates a short-lived approval.
- Approval permits exactly one protected action.
- Seller session identity remains unchanged.
- Approval cannot be reused.
- Seller PIN cannot approve manager actions.
- Six-digit account authenticates.
- Return uses direct server ESC/POS output.
- Reprint is labelled and cannot kick the drawer.
- Owner can see backup health.
- Owner can create and verify a hot backup.
- Seller cannot access backup paths/status.
- Approval use appears in the audit log.

Packaging tests cover backup catch-up creation/removal and the recent-copy guard. UI tests cover the explicit login control and Backup & Recovery panel.

Syntax checks and `git diff --check` passed.

## Deliberately unchanged

- 4–6 digit PIN policy.
- Existing roles and permissions.
- Seller-controlled deliveries.
- Seller expenses.
- Seller stocktake additions.
- Seller complimentary declaration.
- Payment methods and settlement.
- Stock and reconciliation calculations.
- Browser print fallback.
- Optional off-device backup webhook.
- Hospitality behavior.
- Gift-card balances and loyalty data.

## Remaining limitations

- Sessions remain memory-backed and devices sign in again after a server restart; this is intentional for the local appliance.
- Spool jobs are retained as files rather than a database-backed print queue/status dashboard.
- A failed network print is recoverable through its spool/browser fallback, but automatic printer retry is not implemented.
- Off-device backup remains optional and must be configured/tested by the operator.
- Physical printer/drawer hardware is not available in Arena.
- Real Chromium responsive testing remains blocked by the undeclared Puppeteer dependency.
- Windows task execution and clean installer behavior remain Phase 8 proof gates.

## Next phase

Phase 8 should run clean Windows installer/lifecycle checks, activate CI where credentials permit, repair the visual-test dependency and produce a controlled shop-adoption checklist based on actual evidence.

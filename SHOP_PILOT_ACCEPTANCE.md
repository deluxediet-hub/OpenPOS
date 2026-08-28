# OpenPOS Controlled Shop Pilot Acceptance

Use this checklist on the actual Windows till PC with the owner, both sellers, shop printer and normal LAN. Do not mark an item passed unless it was physically observed.

## Installation and restart

- [ ] Installer completes on a clean Windows PC without Node.js already installed.
- [ ] OpenPOS starts without a visible command window.
- [ ] Reboot/login starts OpenPOS automatically.
- [ ] Correct existing data reopens after restart.
- [ ] Till PC opens `http://localhost:3000`.
- [ ] Both seller phones connect over the trusted shop network.
- [ ] Public Wi-Fi/port-forwarding cannot reach the POS.

## Accounts

- [ ] Owner PIN works.
- [ ] Seller 1 PIN works.
- [ ] Seller 2 PIN works.
- [ ] Wrong PIN is rejected/throttled.
- [ ] Selected 4–6 digit PIN lengths work from keypad and Sign in button.
- [ ] Seller cannot open owner settings/refunds directly.
- [ ] Owner approval permits one protected action without changing seller identity.

## Opening

- [ ] Cash opening float is physically counted and entered.
- [ ] M-Pesa opening balance is entered.
- [ ] Card/EDC opening position is entered.
- [ ] One shared till opens successfully.
- [ ] Second simultaneous till opening is rejected.

## Products and stock

- [ ] Bottle barcode scans the correct bottle and price.
- [ ] Case/crate barcode scans the correct package and conversion.
- [ ] Receiving two cases produces the expected base-bottle increase.
- [ ] Selling one case deducts the configured bottle quantity.
- [ ] Selling individual bottles uses the same stock balance.
- [ ] Half, quarter, shot and custom-ml sale use the correct price and bottle fraction.
- [ ] Open-bottle balance is readable.
- [ ] Weighed keg procedure matches the physical scale/tare practice.
- [ ] Breakage creates a typed before/change/after movement.

## Payments and receipts

- [ ] Cash exact payment closes once.
- [ ] Cash over-tender shows correct change and records only sale value.
- [ ] Card payment closes once.
- [ ] Manual M-Pesa confirmation reference records once.
- [ ] Duplicate M-Pesa reference is rejected.
- [ ] Network retry does not duplicate a payment or stock deduction.
- [ ] Partial payment prints `PART PAYMENT — BALANCE DUE`.
- [ ] Final receipt prints `PAID`.
- [ ] Reprint is labelled `REPRINT` and does not open the drawer.
- [ ] Original Cash checkout opens the drawer once.
- [ ] Printer disconnection preserves the sale and provides browser/spool fallback.

## Seller-controlled operations

- [ ] Seller records a delivery with invoice/reference evidence.
- [ ] Seller records a Cash expense.
- [ ] Seller records an M-Pesa expense.
- [ ] Seller records added stock during a count.
- [ ] Seller records a complimentary using the owner-authorized declaration.
- [ ] Optional phone/message authorization note appears in the report.
- [ ] Owner can identify actor, time, reference and stock effect for each event.

## Returns

- [ ] Owner returns one sale line.
- [ ] Return cannot exceed sold quantity.
- [ ] Discounted multi-line return allocates correctly.
- [ ] Resellable return restores stock once.
- [ ] Non-resellable return does not restore stock and discloses inventory cost.
- [ ] Refund cannot exceed original tender method.
- [ ] Return receipt prints through ESC/POS.

## Counts and close

- [ ] `none` policy closes with tender status and `STOCK NOT COUNTED`.
- [ ] Category count covers only the chosen category's stock sources.
- [ ] Selected/spot/cycle count covers only selected products.
- [ ] Non-closing cycle count leaves till open.
- [ ] Stale non-closing count is rejected after stock moves.
- [ ] Full policy rejects partial count.
- [ ] Full count handles sealed and open-container quantities.
- [ ] Cash, M-Pesa and Card variances remain separate.
- [ ] Stock variance remains separate.
- [ ] KSh +1,500 tender and KSh −1,500 stock produces zero overall but `POSSIBLE UNRECORDED SALES`.
- [ ] Non-balanced result requires a note.
- [ ] Closed shift cannot be closed again.

## Backup and recovery

- [ ] Create backup now succeeds from Backup & Recovery.
- [ ] Verify latest backup succeeds.
- [ ] Backup is outside Program Files.
- [ ] Backup catch-up runs after a missed overnight schedule.
- [ ] Off-device copy is made and retrievable.
- [ ] A copied backup restores on a separate test installation.
- [ ] Failed update can roll back without losing business data.
- [ ] Uninstall with keep-data followed by reinstall preserves data.

## Seven-day parallel run

| Day | Opening correct | Sales/tenders match | Seller events reviewed | Count policy completed | Variance explained | Backup verified | Owner initials |
|---|---|---|---|---|---|---|---|
| 1 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | |
| 2 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | |
| 3 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | |
| 4 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | |
| 5 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | |
| 6 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | |
| 7 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | |

## Acceptance

- [ ] No unresolved payment/stock duplication.
- [ ] Every variance is understood or formally accepted.
- [ ] Owner can restore a backup with written instructions.
- [ ] Sellers can complete normal opening-to-close operation without owner credentials.
- [ ] Owner approves moving from parallel run to primary daily use.

Owner: ____________________  Date: __________  Signature: ____________________

Seller 1: _________________  Date: __________

Seller 2: _________________  Date: __________

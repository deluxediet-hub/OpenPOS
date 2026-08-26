# OpenPOS — Kenyan Wines & Spirits Retail POS

A local, browser-based point of sale adapted for a small Kenyan wines and spirits shop. It is designed around one owner/administrator and about two shop sellers—not restaurant tables, waiters or a kitchen.

Node.js + Express + SQLite, with no frontend build step. Prices are in KES, VAT defaults to 16% inclusive, M-Pesa is supported as a recorded tender, and receipts include the shop's KRA PIN and an 18+ responsible-drinking notice.

## Shop roles

| Role | Access |
|---|---|
| **Owner / Admin** | Unlimited access: sales, payments, receipts, stock, products and prices, reports, refunds, discounts, staff, settings, integrations and audit history |
| **Seller** | Make sales, accept Cash/Card/M-Pesa, print/reprint receipts, run the cash drawer, receive deliveries, enter stock counts and record breakage/adjustments |

Sellers cannot change business settings, product prices, staff permissions, reports, refunds or the audit log. For a discount, void or refund, the seller signs out and the owner/admin performs the action. Legacy restaurant roles remain understood by the API so an existing OpenPOS database can still be migrated, but new shops only need `admin` and `seller`.

## First run

1. Start the app and enter the shop name, address, phone and KRA PIN.
2. Create the owner/admin account with a unique 4–6 digit PIN.
3. Optionally load the wines and spirits starter catalogue.
4. Sign in as owner and verify every selling price, cost and opening stock count before trading.
5. Under **Team**, add or edit the two seller accounts and give each person a private PIN.

The optional starter catalogue includes common Kenyan whisky, vodka, gin, rum/brandy, wine, beer/cider, liqueurs and mixers. Each product has matching bottle stock, so one unit sold automatically removes one unit from stock. Starter seller accounts are included only as an initial convenience (`Seller 1`: PIN `1234`; `Seller 2`: PIN `2345`) and their PINs should be changed before the shop goes live.

A blank setup is also supported. Creating a retail product automatically creates its matching stock record and one-unit sale deduction.

## Daily workflow

### Seller

1. Sign in with an individual PIN.
2. Tap **New sale**, search/tap products, and adjust quantities.
3. Tap **Take payment** and settle by Cash, Card or M-Pesa. M-Pesa requires a confirmation reference.
4. Print the customer receipt. A completed sale deducts its bottle/unit quantities automatically.
5. Use **Stock** to receive a supplier delivery or enter a signed stock-count correction with a reason.
6. Reconcile and close the cash drawer at shift end.

### Owner

Use **Shop management** for the sales dashboard, barcode/SKU products, pricing and costs, suppliers, delivery history, full stocktakes, stock alerts, staff, cash reconciliation, reports, KRA/eTIMS configuration and full audit history. The owner/admin account has all rights.

## Retail controls included

- USB/Bluetooth keyboard-wedge barcode scanning and SKU lookup
- Live stock shown at the till with optional negative-stock prevention
- Supplier directory and invoice/delivery-note receiving
- Batch/expiry capture on delivery lines
- Full stocktakes with expected, counted and audited variance
- Mandatory configurable age confirmation before alcohol payment
- Duplicate M-Pesa confirmation-code rejection
- Alcohol licence metadata and responsible-retail receipt warning
- Temporary lockout after repeated invalid PIN attempts

## Kenya-specific notes

- Currency: KES / KSh
- VAT: 16% inclusive by default; service charge disabled
- Payments: Cash, Card and manually confirmed M-Pesa
- Business name, KRA PIN, address and phone print on receipts
- Receipts display **18+ ONLY · PLEASE DRINK RESPONSIBLY**
- eTIMS and Daraja screens currently shape and test configuration payloads only; they do not transmit live requests. See [AUDIT.md](AUDIT.md) before production use.

Do not treat this software alone as legal, tax or liquor-licensing compliance. The shop remains responsible for its county liquor licence, age-verification procedure, KRA/eTIMS setup, receipt obligations, backups and access controls.

## Run

- **Windows:** double-click `start-pos.bat`
- **macOS/Linux:** run `./start-pos.sh`

Or use:

```bash
npm install
npm start
```

Open `http://localhost:3000`.

| Environment variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | HTTP port |
| `POS_DB` | `data/pos.db` | SQLite database path |

Data persists in `data/pos.db`. Back it up daily with `npm run backup` and test restoring backups regularly.

## Tests

```bash
npm test
```

The suites create throwaway databases and do not modify the shop database.

## Project layout

```text
server.js                 Express API, permissions, sales, payments and SSE
db.js                     SQLite schema, shop defaults and starter catalogue
public/index.html         App shell and first-run setup
public/assets/app.js      Login and role-based navigation
public/assets/pos.js      Retail sales screen and basket
public/assets/cashier.js  Payments, cash drawer and receipt lookup
public/assets/manager.js  Products, stock, staff, settings and reports
public/assets/print.js    Thermal/browser receipt output
lib/                      Domain, ESC/POS and integration helpers
test/                     Domain, API and UI tests
```

## Security basics

- Every employee should use a separate PIN; do not share the owner PIN.
- PINs are stored as salted scrypt hashes and shown only when created/reset.
- Change starter PINs before live use.
- The app is intended for a trusted shop network. Put authentication/TLS in front of it before exposing it to the public internet.
- Review the audit log for voids, discounts, refunds, price changes and stock adjustments.

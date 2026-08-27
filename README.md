# OpenPOS — Kenyan Wines & Spirits Retail POS

A local, browser-based point of sale adapted for a small Kenyan wines and spirits shop. It is designed around one owner/administrator and about two shop sellers—not restaurant tables, waiters or a kitchen.

Node.js + Express + SQLite, with no frontend build step. Prices are in KES, VAT defaults to 16% inclusive, M-Pesa is supported as a recorded tender, and receipts include the shop's KRA PIN and an 18+ responsible-drinking notice.

## Shop roles

| Role | Access |
|---|---|
| **Owner / Admin** | Unlimited access: sales, payments, receipts, stock, products and prices, reports, refunds, discounts, staff, settings, integrations and audit history |
| **Seller** | Open/close the till, make sales, accept Cash/Card/M-Pesa, print/reprint receipts, receive documented deliveries, report Cash/M-Pesa expenses and perform guided stocktakes; no direct stock editing |

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

1. Sign in with an individual PIN and open the morning till with opening Cash and M-Pesa balances.
2. The app opens directly into a ready **New sale** basket. Scan/search products and take Cash, Card or M-Pesa payment.
3. Print the receipt; a completed sale automatically deducts bottle/unit stock.
4. Receive supplier deliveries using an invoice/delivery-note number. Sellers cannot directly edit or quick-adjust stock.
5. Record business expenses against Cash or M-Pesa so they reduce the correct expected balance.
6. At day end, close every sale and start stocktake. Count one product at a time, entering unrecorded added stock and physical stock at hand, or choose **No change / Skip**.
7. After stocktake, enter actual Cash and M-Pesa balances, review both variances and close the till. Any automatically prepared sale with no products is discarded rather than blocking reconciliation.

### Owner

Use **Shop management** for the sales dashboard, barcode/SKU products, pricing and costs, suppliers, delivery history, full stocktakes, stock alerts, staff, cash reconciliation, reports, KRA/eTIMS configuration and full audit history. The owner/admin account has all rights. The owner may sell through an already-open seller till; the sale and receipt identify the owner as the seller. If no till is open, starting an owner sale opens a zero-balance owner till automatically instead of interrupting checkout.

## Retail controls included

- Owner-controlled USB/Bluetooth barcode scanner mode; when enabled, scanning from any normal page opens the current sale and adds the matching barcode/SKU
- Guided product setup with size, category and selling-unit dropdowns, plus owner-only CSV import during onboarding or later for up to 2,000 products ([template](docs/product-import-template.csv) · [format guide](docs/PRODUCT_IMPORT.md))
- One-tap **Sell measured amount** mode: Full, Half, Quarter, ⅛ shot or custom ml, with proportional price and stock deduction
- Weighed-keg stock mode records theoretical pour usage but adjusts actual kg only during end-of-shift stocktake
- Stocktake product jumper with automatic save, previous/next navigation and input auto-selection
- Live stock shown at the till with optional negative-stock prevention
- Supplier directory and fast receiving: staff select product and quantity, invoice/reference is optional, configured costs remain owner-controlled, and Cash/M-Pesa/other/pay-later status is tracked
- Whole-keg sales plus shot/glass products that show available servings and deduct the correct fraction from a tracked bottle or keg
- Focused Top 5 dashboard plus a custom PDF builder where the owner selects summary, payments, Top 5 products, sellers, categories, low stock, expenses or full stock; A4 margins and pagination are print-safe
- Repeated taps, scans and + actions consolidate into one product line with a single quantity across the basket, sales view and receipt
- Owner-only complimentary stock for owner consumption, staff, friends or promotions—including measured pours—with no cash impact and full retail-value/cost reporting
- Full stocktakes with expected, counted and audited variance
- Fast checkout with no buyer-age prompt; the configured 18+ notice remains on receipts
- Duplicate M-Pesa confirmation-code rejection
- Alcohol licence metadata and responsible-retail receipt warning
- Temporary lockout after repeated invalid PIN attempts

## Kenya-specific notes

- Currency: KES / KSh
- VAT: 16% inclusive by default; a KSh 200 selling price remains KSh 200 and VAT is extracted for reporting
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

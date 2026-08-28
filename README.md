# OpenPOS — Kenyan Wines & Spirits Retail POS

OpenPOS is a local-first point of sale for a small wines and spirits shop with one owner and a few sellers. It runs on one shop computer and is accessed from that computer or trusted phones/tablets on the same LAN.

- Node.js + Express
- SQLite + `better-sqlite3`
- Plain JavaScript frontend; no build step
- KES / KSh
- VAT-inclusive prices by default
- Direct ESC/POS receipt printing with browser fallback
- Offline operation after installation
- Windows installer/portable launch support

## Roles

| Role | Access |
|---|---|
| **Owner/Admin** | Sales, products, packages, costs, stock controls, reports, returns, discounts, staff, settings, printer, backup and audit |
| **Seller** | Open/close the shared till, sell, take Cash/Card/M-Pesa, reprint receipts, receive deliveries, record expenses, conduct stock counts and declare owner-authorized complementaries |

Every person should use a separate 4–6 digit PIN. Protected seller actions use a one-time owner approval without changing the seller's signed-in identity.

## Retail capabilities

### Sales and payments

- Barcode/SKU search and keyboard-wedge scanner mode
- Compact phone-first product grid and cart
- Repeated taps/scans consolidate into one line
- Cash, Card and manually confirmed M-Pesa
- Split/partial payments with truthful balance-due receipts
- Server-validated Cash tender and change
- Idempotent checkout and close-once stock posting
- Duplicate M-Pesa reference rejection
- Item-linked, tender-limited returns
- Return, paid, partial-payment and labelled reprint receipts

### Wines and spirits stock

- Whole bottles, cans, pieces and kegs
- Half, quarter, eighth/shot and custom-ml bottle sales
- Named shot/glass products linked to a source bottle
- Weighed keg sources reconciled by physical count
- Package conversions such as case of 12 or crate of 24
- Package-specific SKU, barcode, purchase cost and sale price
- One canonical stock balance for package, bottle and portion sales
- Six-decimal internal precision with readable open-container ml
- Negative-stock prevention
- Reorder levels and low-stock reporting

### Purchases and movements

- Suppliers and goods receipts
- Base-unit or package receiving
- Cash/M-Pesa/other/pay-later purchase state
- Idempotent browser delivery submission
- Structured stock ledger with movement type, before/change/after, cost, actor and reference
- Opening stock, purchase, sale, return, stocktake, adjustment, breakage, spoilage, complimentary and supplier-return movement types

### Counts and reconciliation

Physical count types:

- Full
- Category
- Selected products
- Cycle
- Spot
- Correction/recount

Owner-configurable close policy:

- `none` — daily tender close without requiring stock count
- `any` — require any closing count
- `full` — require complete stock count

Cash, M-Pesa and Card variances remain separate. Full/scoped stock variance is shown independently. No-count close reports stock as **NOT COUNTED**, never as zero.

```text
Tender variance  = Cash variance + M-Pesa variance + Card variance
Overall variance = Tender variance + counted-scope stock variance
```

Offsetting tender overage and stock shortage is identified as possible unrecorded sales rather than falsely called fully balanced.

### Seller-controlled records

The existing simple shop policy is preserved:

- Sellers receive deliveries.
- Sellers record Cash/M-Pesa expenses.
- Sellers enter added stock during a count.
- Sellers declare a complimentary by ticking **I confirm the owner authorized this complimentary issue**, with an optional phone/message note.

All remain owner-visible in reports and audit history.

## First run

1. Start OpenPOS.
2. Enter shop identity and receipt details.
3. Create the owner/admin PIN.
4. Optionally import a CSV or load starter products.
5. Sign in as owner and verify prices, costs and opening stock.
6. Change/remove starter seller PINs before trading.
7. Configure products, package conversions, suppliers, count policy, printer and backup procedure.

CSV resources:

- [Import guide](docs/PRODUCT_IMPORT.md)
- [Template](docs/product-import-template.csv)

## Daily workflow

```text
Start PC → sign in → enter opening Cash/M-Pesa/Card → open till
→ sell / receive / record expenses and complementaries
→ resolve open sales → perform configured stock count if required
→ enter actual tenders → reconcile and close
→ owner reviews exceptions → create/verify backup
```

See [INSTALL.md](INSTALL.md) for deployment and [SHOP_PILOT_ACCEPTANCE.md](SHOP_PILOT_ACCEPTANCE.md) for the real-shop acceptance run.

## Run from source

```bash
npm ci
npm start
```

Open `http://localhost:3000`.

Portable launchers:

- Windows: `start-pos.bat`
- macOS/Linux: `./start-pos.sh`

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `POS_DB` | `data/pos.db` | Explicit SQLite file |
| `POS_DATA_DIR` | `data/` | SQLite directory when `POS_DB` is unset |
| `POS_BACKUP_DIR` | `backups/` | Backup destination |
| `POS_BACKUP_KEEP` | `14` | Local rotating copies; `0` keeps all |
| `POS_BACKUP_WEBHOOK` | empty | Optional off-device HTTPS PUT destination |

Do not expose port 3000 directly to the public internet. Use a trusted private shop network; use VPN/HTTPS controls for remote access.

## Windows installer

The installer bundles a private Node runtime and production dependencies. Business data, backups and print spool live under `%ProgramData%\OpenPOS`, outside Program Files.

Build on Windows with Inno Setup 6:

```powershell
powershell -ExecutionPolicy Bypass -File .\packaging\build-installer.ps1
```

Output:

```text
packaging\output\OpenPOS-Setup.exe
```

See [packaging/README-PACKAGING.md](packaging/README-PACKAGING.md).

## Backup and recovery

Installed systems provide an owner-facing **Backup & Recovery** screen and Start-menu verification shortcut.

From source:

```bash
npm run backup
npm run backup:verify
```

Backups run SQLite integrity checks. Keep a separate off-device copy and prove restoration before live use.

## Tests

```bash
npm test
```

Current standard baseline:

```text
677 passed, 0 failed
```

Real-browser responsive suite:

```bash
CHROME_BIN=/path/to/chrome npm run test:visual
```

Tests use throwaway databases and backup directories. The visual suite regenerates screenshots under `shots/`; generated screenshots and print jobs are not versioned.

## Project layout

```text
server.js                 Express composition/startup
routes/                   Focused API route modules
services/                 Sale close-out, inventory, reconciliation, backup services
db.js                     SQLite schema, migrations and starter data
lib/domain.js             Pure calculations
lib/escpos.js             ESC/POS generation and network send
lib/integrations.js       Configuration/payload architecture
public/assets/            Plain JavaScript retail and reusable hospitality UI
scripts/                  Backup and verification commands
packaging/                Windows installer, launch and installed smoke test
test/                     Unit, API, UI, packaging and responsive suites
```

Retail mode hides reservations, floor/table workflow, KDS, labour, loyalty and tips. Reusable hospitality behavior remains available in restaurant mode.

## Release status

Read [RELEASE_READINESS.md](RELEASE_READINESS.md). The standard Linux suite is green. Final Windows/physical-shop approval still requires an active CI workflow, compiled installer run, physical printer/drawer test, separate-machine restore and controlled shop pilot.

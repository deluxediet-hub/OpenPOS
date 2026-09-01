# Install and Deploy OpenPOS

Publisher: **Rekonet Inv Systems** · Support: [rekonetsystems@outlook.com](mailto:rekonetsystems@outlook.com)

The Windows installer presents licence terms and pre-install safety information, then installs privacy, support and third-party notices. Have the legal wording reviewed by qualified Kenyan counsel before commercial distribution.

## Supported shop setup

- One Windows 10/11 64-bit till PC
- One owner and a few sellers
- Trusted private LAN for phones/tablets
- Optional 58mm/80mm network ESC/POS printer and cash drawer
- Off-device backup destination strongly recommended

OpenPOS is local-first. Do not forward port 3000 to the public internet.

## Recommended Windows installation

Build machine requirements:

- Windows
- PowerShell
- Inno Setup 6
- Internet access while building

```powershell
powershell -ExecutionPolicy Bypass -File .\packaging\build-installer.ps1
```

Copy `packaging\output\OpenPOS-Setup.exe` to the shop PC and run it as administrator.

The installer provides:

- Private Node runtime and production dependencies
- Hidden single-instance startup
- ProgramData database/backup/spool directories
- Private/Domain firewall rule
- Five-minute watchdog
- Nightly backup and missed-backup catch-up
- Licence acceptance plus privacy, third-party and getting-started documents
- Rekonet Inv Systems publisher/support metadata
- Start-menu shortcuts for opening, stopping, LAN address, backup verification, update, rollback, documentation and support

The shop PC does not require a system Node installation or internet after installation.

### Installed paths

| Data | Path |
|---|---|
| Application/runtime | `C:\Program Files\OpenPOS\` |
| SQLite database | `C:\ProgramData\OpenPOS\data\pos.db` |
| Database backups | `C:\ProgramData\OpenPOS\backups\` |
| Receipt spool | `C:\ProgramData\OpenPOS\spool\` |
| Update rollback copies | `C:\ProgramData\OpenPOS\app-backups\` |
| Hidden server log | `C:\ProgramData\OpenPOS\logs\server.log` |

### If localhost does not load

Use **Start menu → OpenPOS → Startup diagnostics**. It checks the private runtime, installed app modules, server health and displays the latest hidden-server log.

The **Open POS** shortcut now starts the server, waits up to 30 seconds for `/healthz`, and only then opens the browser. If startup fails, it displays the diagnostics log path instead of silently opening a dead localhost page.

## Portable/source installation

### Windows

Double-click `start-pos.bat`. It delegates to the hidden VBS launcher and logs startup diagnostics to `logs\start-pos.log`.

### macOS/Linux

```bash
chmod +x start-pos.sh
./start-pos.sh
```

### Command line

```bash
npm ci
npm start
```

Open `http://localhost:3000`.

`better-sqlite3` is native. If no prebuilt binary is available, the development machine needs Python, a C/C++ toolchain and matching Node headers. The packaged Windows installer already bundles the matching binary.

## First-run shop setup

1. Enter business/receipt identity.
2. Confirm KES and VAT-inclusive pricing.
3. Create the owner/admin with a private 4–6 digit PIN.
4. Import the real product CSV or optionally load starter products.
5. Change/remove starter seller PINs (`1234`, `2345`).
6. Verify every price, cost, barcode and opening stock quantity.
7. Configure suppliers and package conversions.
8. Choose the stock-count close policy: none, any closing count or full count.
9. Configure the receipt printer.
10. Create and verify the first backup.

Do not use sample prices/costs as authoritative shop data.

## Products, packages and portions

- Product creation automatically links ordinary retail products to physical stock.
- Configure case/crate/carton conversions from **Stock → Packages**.
- Package receiving and package sales always convert into the canonical base quantity.
- Use Sell amount for ad-hoc half/quarter/shot/custom-ml bottle sales.
- Use Pour mode for regular named shots/glasses linked to a source bottle.
- Use Weighed mode only where final physical weight controls keg stock.

CSV documentation:

- [Product import guide](docs/PRODUCT_IMPORT.md)
- [CSV template](docs/product-import-template.csv)

## Barcode scanner

1. Configure the scanner as a keyboard wedge with Enter suffix.
2. Enable the scanner under Settings.
3. Scan each product and package barcode before opening.
4. Confirm package barcodes select the intended case/crate conversion.

Global capture pauses while a form/modal input has focus.

## Receipt printer

1. Assign the printer a fixed private LAN IP.
2. Open **Settings → Printer**.
3. Enter host and port, normally 9100.
4. Print an original Cash receipt, reprint and return receipt.
5. Confirm cut and text width.
6. Confirm only original completed Cash checkout opens the drawer.
7. Disconnect the printer and confirm spool/browser fallback without duplicating the sale.

## Phones and tablets

Use **Start menu → OpenPOS → Show my LAN address** and open the displayed private address on trusted devices, for example:

```text
http://192.168.1.50:3000
```

Use a strong router password and Private network profile. For remote access, use a properly administered VPN or HTTPS reverse proxy.

## Backup and restore

### Owner UI

Use **Settings → Backup & Recovery** to:

- See latest backup status
- Create a backup now
- Verify the newest backup

### Command line

```bash
npm run backup
npm run backup:verify
```

### Restore drill

1. Close the till and create a new backup.
2. Stop OpenPOS.
3. Copy the current data directory aside.
4. Copy a backup to the configured `pos.db` path on a separate test installation where possible.
5. Start OpenPOS.
6. Verify login, latest receipts, stock, shifts and audit.
7. Restore the original live directory if this was a same-machine drill.

A local backup does not protect against theft, disk loss or ransomware. Keep protected off-device copies.

## Update and rollback

Before updating:

1. Close the till.
2. Create and verify a backup.
3. Copy it off-device.
4. Stop OpenPOS.
5. Install/copy the update.
6. Start and test login, one sale, stock lookup, reprint and backup status.

The installed update/rollback scripts preserve ProgramData business data. Database migrations are additive, but backup remains mandatory.

## Acceptance

Complete [SHOP_PILOT_ACCEPTANCE.md](SHOP_PILOT_ACCEPTANCE.md) on the actual till PC.

At minimum verify:

- Installation/reboot startup
- Owner and seller PINs
- LAN phone access
- Bottle/package/portion stock
- Cash/Card/M-Pesa
- Partial, paid, reprint and return receipts
- Seller deliveries, expenses, stock additions and complimentary declarations
- Configured count policy and reconciliation statuses
- Backup creation and separate-installation restore
- Seven days of parallel operation

## Tests for developers/builders

```bash
npm test
CHROME_BIN=/path/to/chrome npm run test:visual
```

On Windows PowerShell:

```powershell
$env:CHROME_BIN='C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:visual
```

After compiling/installing:

```powershell
.\packaging\test-installed.ps1 -InstallDir 'C:\Program Files\OpenPOS'
```

Never run installed smoke tests against a live shop database; the script uses isolated temporary data by default.

See [RELEASE_READINESS.md](RELEASE_READINESS.md) for current evidence and remaining external gates.

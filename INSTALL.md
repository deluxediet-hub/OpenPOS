# Installing OpenPOS for a Kenyan Wines & Spirits Shop

## Supported setup

- One Windows, macOS or Linux till computer
- Node.js 20 LTS or newer
- Chrome/Edge/Firefox on the till or trusted local network
- Optional 80mm ESC/POS network receipt printer and cash drawer
- Daily off-device backup destination

The application is local-first. Do not expose port 3000 directly to the public internet.

## 1. Fresh installation

### Windows

Double-click `start-pos.bat`. The launcher installs dependencies on first use, starts OpenPOS and opens the browser.

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

`better-sqlite3` is a native dependency. If installation must compile it, install a C/C++ build toolchain and Python, or use a Node LTS version with an available prebuilt binary.

## 2. First-run setup

A fresh installation displays setup instead of a login screen.

1. Enter the shop's legal/trading name, physical address, phone and KRA PIN.
2. Confirm KES, VAT and receipt footer. Retail service charge should remain zero.
3. Create the owner/admin with a private 4–6 digit PIN.
4. Optionally load the wines and spirits starter catalogue.
5. Sign in as owner.

If the starter catalogue is loaded, immediately change the sample seller PINs (`1234` and `2345`) or replace those accounts.

## 3. Configure the real shop

Under **Management**:

- **Products & Pricing:** enter each real product's name, SKU, barcode, bottle volume, cost, selling price, category and KRA classification code.
- **Stock:** enter reorder levels and conduct an opening full stocktake.
- **Suppliers:** add distributors and KRA/contact details.
- **Settings:** enter the alcohol licence number/expiry, KRA details, minimum age control and receipt printer.
- **Team:** create one private seller PIN per employee.
- **eTIMS / M-Pesa:** configuration and dry runs are present, but live transmission is not implemented in this version.

Do not assume sample prices, costs or quantities are correct.

## 4. Barcode scanner

Most USB/Bluetooth scanners work as a keyboard.

1. Configure the scanner to append Enter after each barcode.
2. Put the cursor in **Search products** on the New Sale screen.
3. Scan a configured barcode.
4. An exact barcode/SKU adds the product to the sale.

Test every barcode format used by the shop before opening.

## 5. Receipt printer

Use a network ESC/POS printer where possible:

1. Give the printer a fixed LAN IP.
2. Open **Management → Settings → Printer**.
3. Enter host and port (normally `9100`).
4. Print a test receipt.
5. Verify shop name, KRA PIN, licence number, tax, product lines, age warning, cut and drawer kick.

Without a configured network printer, browser printing remains available.

## 6. Other devices on the shop network

The server listens on `0.0.0.0`. Find the till's LAN IP and open, for example:

```text
http://192.168.1.50:3000
```

Only allow trusted shop devices. Use a private Wi-Fi/VLAN, firewall and strong router password. For remote owner access, use a VPN or a properly configured HTTPS reverse proxy—never direct public port forwarding.

## 7. Data and backups

Default database:

```text
data/pos.db
```

Manual backup:

```bash
npm run backup
```

A production backup is only useful if it is copied off the till computer. Use an encrypted external disk or protected cloud-sync folder and retain multiple dated copies.

### Restore drill

1. Stop OpenPOS.
2. Copy the current `data/` directory somewhere safe.
3. Restore a backup database to the configured data location.
4. Start OpenPOS and confirm login, recent receipts, stock and audit history.
5. Stop it and restore the live database if this was only a drill.

Perform a restore drill before launch and regularly thereafter.

## 8. Updating

1. Close the shift.
2. Run and copy a backup off-device.
3. Stop OpenPOS.
4. Install the new code without replacing the data directory.
5. Run `npm ci` if dependencies changed.
6. Start and test login, one sale, one reprint and stock lookup.

Database migrations run automatically, but a backup is still mandatory.

## 9. Pre-opening acceptance test

- [ ] Owner and each seller can log in with unique PINs.
- [ ] Seller is prompted to open the till, then lands directly in a ready New Sale basket.
- [ ] Opening Cash and M-Pesa balances are correct.
- [ ] Five invalid PINs trigger temporary lockout.
- [ ] Every product scans correctly.
- [ ] Out-of-stock product is blocked when negative stock protection is enabled.
- [ ] Age confirmation is required before payment.
- [ ] Cash payment calculates correct change.
- [ ] Card and M-Pesa references print correctly.
- [ ] Duplicate M-Pesa reference is rejected.
- [ ] Paid sale reduces product stock.
- [ ] Supplier delivery increases stock and updates cost; seller cannot directly edit/adjust stock.
- [ ] Cash and M-Pesa expenses reduce the correct expected balance.
- [ ] End-of-day stocktake blocks further sales and presents products one at a time.
- [ ] Added stock, physical stock at hand and No change / Skip all behave correctly.
- [ ] Receipt and drawer hardware work.
- [ ] Till cannot close before stocktake or with open sales.
- [ ] Closing Cash and M-Pesa variances are correct and stored.
- [ ] Owner can review audit log and reports.
- [ ] KRA-approved eTIMS process is operational separately or through a completed integration.
- [ ] Backup exists off-device and has been restored successfully.

## 10. Compliance warning

OpenPOS does not grant an alcohol licence and its ordinary receipt is not automatically an eTIMS invoice. The owner remains responsible for current national law, county permit/licence conditions, statutory signs, permitted hours, age controls, KRA/eTIMS invoicing and data protection.

Read [AUDIT.md](AUDIT.md) before deployment.

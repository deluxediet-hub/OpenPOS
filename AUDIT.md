# OpenPOS Wines & Spirits — Full Product, Security and Kenya Readiness Audit

**Audit date:** 26 August 2026
**Repository baseline reviewed:** `090cc9a` plus the improvements in this workspace
**Target operation:** one Kenyan off-licence wines and spirits shop, one owner/admin and approximately two sellers
**Method:** source review of database, API, permissions, till UI, reports, printing, integrations, packaging, tests and operating documentation; SQLite schema validation; JavaScript syntax validation; review of official KRA and Kenya Law material.

## 1. Executive verdict

### Operational verdict

**Strong single-shop pilot, but not yet safe to describe as fully eTIMS-integrated or automatically M-Pesa-integrated.**

The workspace now has a focused bottle-shop workflow: barcode/SKU products, live unit stock, negative-stock prevention, supplier deliveries, full stocktakes, thermal receipts, drawer reconciliation, role separation and audit logging. Checkout assumes the shop's buyers have already met its adult-entry policy and therefore has no repetitive age prompt. This is enough to run a controlled local pilot if the owner uses KRA's separate eTIMS solution and verifies M-Pesa confirmations independently.

### Production blockers

| Priority | Finding | Current status |
|---|---|---|
| P0 | Live eTIMS invoice transmission, KRA response/CUIN and verification QR | **Not implemented.** Configuration and dry-run payload shaping only. |
| P0 | Live Daraja STK/callback reconciliation | **Not implemented.** Manual M-Pesa reference recording only. |
| P0 | Tested restore and off-device backups | Backup script exists, but each shop must configure and test external copies. |
| P1 | HTTPS when accessed beyond a trusted private LAN | Not built into the Node server; deploy behind a TLS reverse proxy/VPN. |
| P1 | Independent legal/licensing configuration for the actual county and licence | POS stores licence details and configurable age, but does not replace legal advice or county licensing. |

**Do not market receipts from this application as eTIMS receipts until a KRA-approved integration returns and prints the required invoice identifiers.** A KRA PIN and VAT line alone are not eTIMS compliance.

## 2. What is now implemented

### Retail till

- Retail **New sale** flow with no table, waiter or kitchen dependency.
- Cash, card and manually confirmed M-Pesa payments.
- Barcode, SKU or product-name search; owner-controlled global scanner mode can pull a matching product into the current sale from any normal page.
- Scanner capture pauses in forms and modals so owner-entered data is not corrupted.
- Quantity changes, parked/open sales, part-payments and receipt reprints.
- Server-side change calculation and overpayment guards.
- Duplicate M-Pesa confirmation references are rejected.
- VAT-inclusive KES defaults and no restaurant service charge: an entered KSh 200 price remains KSh 200 while VAT is extracted for reporting.
- Product selling price, unit cost and gross-margin visibility for management.
- Guided product creation puts standard bottle/can size, retail category and selling unit directly after the product name, followed by barcode/SKU, VAT-inclusive price, cost and stock controls.
- Retail categories and products use a neutral internal `retail` route; kitchen/bar preparation fields, docket actions and station columns are suppressed throughout retail screens and reports.

### Alcohol controls

- Checkout has no age-confirmation interruption because the shop has specified that all admitted buyers are adults.
- The default receipt notice remains 18+, matching the currently published national Act reviewed during this audit.
- The printed threshold is configurable because policy and county rules can change; the owner must verify current law before trading.
- Receipts print the configured age warning and responsible-drinking message.
- Alcohol licence number and expiry can be stored and printed.

A 2025 national policy proposed raising the threshold to 21, but reporting described implementation as requiring legislative amendments. The application therefore does not hard-code a claim about future law. The owner must confirm the effective Act, regulations, licence conditions and county rules on launch day.

### Inventory and purchasing

- Every starter retail product maps one-for-one to a stock unit; a completed sale deducts units.
- New retail products automatically create matching stock and a one-unit deduction mapping.
- Current stock and low/out indicators appear in product management and the till.
- Negative stock can be blocked server-side.
- Sellers can receive deliveries against a mandatory supplier invoice/delivery-note number, but cannot directly edit or quick-adjust stock.
- Delivery lines capture quantity, unit cost, optional batch and expiry.
- Receiving updates quantity, latest cost, stock movement history and audit history transactionally.
- Supplier directory stores contact/address/KRA details.
- End-of-day stocktake freezes sales and presents one item at a time. The operator can jump through a product dropdown, move previous/next, and all entered values auto-save while the active quantity remains auto-selected.
- Full stocktakes calculate variance, post all corrections together and audit the operator. Direct quick corrections remain owner-only.
- Low-stock and stock-value reporting remains available.

### People and controls

| Role | Intended rights |
|---|---|
| Owner/Admin | All till, product, price, cost, supplier, report, refund, staff, settings, integration and audit functions |
| Seller | Open/close the till, sell, receive payment, print/reprint, receive documented deliveries, report Cash/M-Pesa expenses and perform guided stocktakes; no direct stock editing |

- PINs are salted and hashed with Node's `scrypt`.
- Duplicate PINs are checked by verifying hashes.
- Five failed logins from one address trigger a 60-second lockout.
- Staff cannot assign themselves administrator rights.
- Price changes, discounts, voids, refunds, payments, expenses, deliveries and stock corrections are audited.
- A retail till must be opened before sales. Starting end-of-day stocktake moves it into reconciliation, blocks further sales, and closing requires both Cash and M-Pesa actual balances.
- Cash and M-Pesa expenses reduce their respective expected balances; both variances are stored and audited at close.
- Runtime database files are no longer committed to Git.

## 3. Compliance assessment

### Alcohol sale and licensing

The Kenya Law version of the Alcoholic Drinks Control Act reviewed for this audit states that a retailer must display a sign warning that sale or supply to a person under 18 is prohibited, and lists “Not for sale to persons under the age of 18 years” among warning messages. It also prohibits knowingly supplying alcoholic drinks to a person under 18.

Primary reference: Kenya Law, Alcoholic Drinks Control Act:
https://new.kenyalaw.org/akn/ke/act/2010/4/eng@2022-12-31

NACADA implementation guidance also describes licensing, licence display, age/access controls, KRA registration documentation and compliance with licence hours. County requirements and the conditions printed on the actual licence must still be checked.

Reference:
https://nacada.go.ke/sites/default/files/2019-10/guidelines-for-implementing-alcoholic-drinks-control-act.pdf

**POS coverage:** warning receipt text and licence metadata are present; buyer eligibility is handled by the shop before checkout.
**Outside POS:** premises licence, displayed statutory wall signs, county permit, operating hours, employee eligibility, distance/location rules, public-health/fire requirements and physical age access controls.

### KRA eTIMS

KRA says all persons carrying on business, including non-VAT-registered persons, must electronically generate and transmit invoices through eTIMS. KRA provides eTIMS Lite options for small businesses.

Official references:

- https://www.kra.go.ke/news-center/public-notices/2077-electronic-tax-invoicing-for-non-vat-registered-persons
- https://www.kra.go.ke/news-center/press-release/2093-simplified-etims-solutions-for-informal-sector-and-small-businesses
- https://www.kra.go.ke/helping-tax-payers/faqs/learn-about-etims

**What this application has:** business/KRA details, item classification field, tax breakdown, integration settings and dry-run payload shaping.
**What it lacks:** production transport, KRA onboarding/certification, response persistence, CUIN/control identifiers, KRA verification QR, credit-note/refund transmission, outage queue processing and reconciliation.

Until those are implemented, issue the legally required invoice using the shop's approved KRA solution and treat the POS receipt as an internal/customer sales receipt only.

### M-Pesa

Manual reference capture is operational but is not independent payment verification. A seller could enter a plausible unused code unless they check the actual business Till/Paybill statement or message. Duplicate references are now blocked, reducing accidental/deliberate reuse.

A production integration needs:

1. Daraja credentials stored outside ordinary settings responses.
2. Public HTTPS callback endpoint or secure cloud relay.
3. Pending transaction table keyed by `CheckoutRequestID`.
4. Idempotent callback handling.
5. Amount, shortcode/account and result-code verification.
6. Timeout/reversal/reconciliation workflow.
7. Payment closure only after a verified successful callback.

## 4. Security audit

| Control | Assessment | Action |
|---|---|---|
| Password/PIN storage | Good: salted scrypt hashes | Keep DB and backups access-controlled. |
| Login brute-force | Improved: per-IP temporary lockout | For internet exposure use reverse-proxy rate limiting too. |
| Authorization | Server-side role checks exist | Add explicit automated seller/admin matrix tests for every new endpoint. |
| Session cookies | HttpOnly and SameSite=Lax | Add `Secure` under HTTPS; consider persistent signed sessions and idle timeout. |
| Transport security | Plain HTTP application | Trusted LAN only or TLS reverse proxy/VPN. |
| Secret storage | Integration settings live in SQLite | Encrypt production secrets or load from protected environment/secret manager. |
| CSRF | SameSite helps but no CSRF token | Add Origin/CSRF enforcement before public exposure. |
| Audit integrity | Append-only through API, but DB admin can alter | Send audit copies/backups off-device; consider chained hashes. |
| Input validation | Core money/role/stock checks server-side | Add stronger length/format limits and request schemas. |
| Dependency posture | Lockfile present | Run `npm audit` in a network-enabled CI environment and schedule updates. |
| Receipt endpoint | Protected by authenticated session | Keep receipt access limited to trusted staff roles/network. |

### Important authorization caveat

The historical `requireManagerPin` client dialog logs in a manager in the browser but does not transfer an action-scoped authorization token to the original seller session. Retail UI hides privileged refund actions from sellers and server endpoints enforce the seller's role, but a proper short-lived manager-approval token should replace this legacy pattern if “manager approves while seller remains logged in” is required.

## 5. Data and accounting audit

### Sound controls

- Monetary values are stored as integer cents.
- Cash change is calculated by the server.
- Payment amounts cannot be zero/negative and non-cash overpayment is blocked.
- Product price is frozen on the sale line, preserving historical receipts after price changes.
- Inventory deduction occurs only on full settlement.
- Delivery and full-stocktake posting use SQLite transactions.
- Cost and revenue reports exist.

### Remaining accounting gaps

- Refunds record money but do not automatically return selected items to stock; owner must post an explicit stock correction.
- There is no supplier-payment/accounts-payable ledger.
- No purchase-order approval workflow; implemented receiving starts from supplier invoice/delivery note.
- No credit-sales/customer debt ledger—intentionally excluded for a cash/M-Pesa/card bottle shop.
- No immutable accounting period lock.
- No formal eTIMS credit-note integration.
- Latest delivery cost replaces unit cost; weighted-average/FIFO costing is not implemented.
- Batch/expiry data is captured on delivery lines but there is no FEFO allocation or expiry dashboard yet.

## 6. Reliability and operations

### Before opening the shop

1. Install on a supported Node LTS release and run the full test suite.
2. Change starter seller PINs or create fresh staff.
3. Enter every real barcode, SKU, cost, selling price and opening quantity.
4. Conduct and sign off a full stocktake.
5. Enter KRA PIN and alcohol licence information.
6. Configure/test the 80mm receipt printer and cash drawer.
7. Configure a KRA-approved eTIMS invoicing process.
8. Test Cash, Card and M-Pesa sales, cancellation, refund and receipt reprint.
9. Configure automatic daily off-device backup and perform a restore drill.
10. Restrict the till machine and database directory to the owner/service account.
11. Display all statutory physical signs and trade only within licence conditions.

### Daily close checklist

- Confirm all M-Pesa references against the business statement.
- Close the drawer and investigate variance.
- Review voids, discounts, refunds and stock movements.
- Back up after close and verify the backup exists off-device.
- Check low stock, expiring licence and unresolved eTIMS entries.

## 7. Test and quality status

Validated in this workspace:

- JavaScript syntax checks for server, database and every browser asset.
- `git diff --check` whitespace/patch validation.
- SQLite schema and retail one-product/one-stock mapping using an in-memory SQLite validation.
- Earlier pure domain and packaging suites: 84 passing checks.

Not completed in the sandbox:

- Full API/UI test run, because `better-sqlite3` could not install: the environment failed TLS/network retrieval of its prebuilt binary and Node headers.
- Real barcode scanner, ESC/POS printer, cash drawer, Windows installer, Daraja or KRA hardware/service testing.

This is an environment limitation, **not a passing test result**. A network-enabled CI run on Node LTS is mandatory before deployment.

## 8. Prioritized roadmap

### P0 — before claiming compliance

1. Live eTIMS adapter, persistent invoice queue, KRA response fields and QR printing.
2. Daraja callback-based payment state machine and statement reconciliation.
3. Full automated retail API/UI suite on Node LTS.
4. Add a tested HTTPS deployment profile and CSRF/Origin enforcement.
5. Automated off-device backup plus restore verification.

### P1 — strong shop operations

6. Refund-by-line with optional stock return and eTIMS credit note.
7. Purchase orders and supplier payable status.
8. Batch/expiry dashboard and near-expiry alerts.
9. Weighted-average stock costing.
10. Licence-expiry and configurable trading-hours alerts/blocking.
11. CSV product/barcode import and stocktake export.

### P2 — expansion

12. Multi-till conflict/reservation testing.
13. Multi-branch stock transfers.
14. Cloud owner dashboard with encrypted sync.
15. Customer loyalty only after privacy/consent design.

## 9. Final assessment

This codebase is now materially adapted to a small Kenyan wines and spirits shop rather than merely relabelled restaurant software. The core retail, inventory, receiving, stocktake, responsible-retail notice, roles, receipt and audit workflows are credible for a supervised pilot.

It is **not yet a complete statutory invoicing product** because live eTIMS is absent, and manual M-Pesa references are not equivalent to Daraja confirmation. Resolve the P0 list, run hardware and restore drills, and have the actual deployment reviewed against the shop's current national law, Nairobi County requirements and licence conditions before relying on it for production compliance.

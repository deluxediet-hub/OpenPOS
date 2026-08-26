# OpenPOS — white-label restaurant & lounge POS

A self-configuring point-of-sale for a restaurant **and** lounge: KES pricing, 16% VAT,
service charge, and Cash / Card / M-Pesa settlement. A fresh install is **empty** — each
business names itself, sets its tax, creates its owner account and builds (or templates)
its own menu through a first-run onboarding wizard.

Node.js + Express + SQLite. No build step — the frontend is plain ES, so you can edit and refresh.

---

## Run it (no typing required)

- **Windows:** double-click **`start-pos.bat`**
- **macOS / Linux:** double-click (or run) **`start-pos.sh`**

The launcher installs the components on first run, starts the server and opens your browser
at `http://localhost:3000`. Keep the window/terminal open while you trade; closing it stops
the server. Node.js (LTS) must be installed once — the launcher tells you where to get it if
it's missing.

Prefer the command line? The equivalents are `npm install` then `npm start`.

---

## First run (onboarding)

Start the server and open it. Because no users exist, you get a setup wizard instead of a
login keypad:

1. Business name, address, phone, KRA PIN, receipt footer
2. Currency / symbol, VAT %, service charge %
3. Owner / administrator name + a 4–6 digit PIN (this becomes your `admin`)
4. Optional: tick "load a sample menu" to start from a ready-made Kenyan restaurant & lounge
   template (you can edit or delete everything it adds, or load it later from
   **Manager → Settings → Starter template**)

After setup you sign in with the owner PIN and add staff, tables and menu items yourself.
Onboarding is only available while **no users exist** — an installed system can never be
silently re-onboarded.

## Roles

| Role | Can do |
|---|---|
| **Admin** | Everything, including disabling staff |
| **Manager** | Reports, menu, stock, voids, discounts, refunds, staff |
| **Waiter** | Seat guests, take orders, fire tickets |
| **Cashier** | Take payment (Cash / Card / M-Pesa), Z-report |
| **Bar** | Bar tickets, mark drinks ready |
| **Kitchen** | Kitchen tickets, mark dishes ready |

PINs you assign are stored as salted scrypt hashes and are shown once, at creation, so they
can be written down — never in plaintext, never again. Type the PIN on the keypad (or the
keyboard). Sensitive actions — voiding an item, applying a discount, issuing a refund — ask
for a **manager PIN** even when a waiter triggers them.

---

## What's in it

**Floor (waiter)**
- 27 tables across Restaurant / Terrace / Lounge / VIP, live-coloured by status
- Seat guests, per-line prep notes ("no onions", "well done"), 86 an item from the menu
- **Modifier & variant picker** — required groups (steak doneness, shisha flavour, pour size)
  must be chosen before the line can be added; optional ones (sauces) can be stacked
- **Happy-hour pricing shown live** on the menu tile, with the original price struck through
- Fire pending lines to kitchen or bar as one ticket
- Move an order to another table, change cover count, print a pre-bill

**Kitchen & bar display** — `/kds` opens full-screen for a wall monitor. Tickets age,
turn amber then red. Lines can be marked ready individually or the whole ticket at once.

**Bills (cashier)**
- Cash with tender/change, quick-note buttons, round-up
- Card with EDC reference; M-Pesa with STK push helper and a **mandatory confirmation code**
- **Gift cards and loyalty points** as tender types, with overspend and balance guards
- Tips, part-payments and split bills (½ / ⅓ / full)
- Z-report printing

**Cash drawer reconciliation**
- Open a shift with a starting float, record payouts (supplies, transport, bank runs)
- Expected vs counted at close, with variance flagged and audited

**Happy hour / daypart pricing**
- Time-and-day rules, optionally scoped to a category or station
- Windows may cross midnight (22:00–02:00)
- The discounted price is frozen onto the line at sale time, so editing a rule later
  never rewrites past bills

**Inventory that actually moves**
- Recipes link menu items to ingredients; stock is deducted when a bill settles
- Theoretical usage vs on-hand report; reorder minimums and low-stock alerts
- Deduction happens on payment, not on ticket fire, so voids don't cost you stock

**Thermal printing (ESC/POS)**
- Raw ESC/POS to network printers on port 9100 — receipts and kitchen tickets
- Cash drawer kick on cash sales
- Every job also spooled to `spool/` as a reprint archive
- Falls back to the browser print dialog when no printer is configured

**Manager console** — 16 tabs
- Dashboard: net sales, average ticket, per-cover, gross profit and margin, VAT collected,
  sales by hour, payment mix, top sellers, low-stock alerts
- Reports by date range — by waiter, by category, item performance with margin, CSV export
- Menu editor with cost price and auto margin, 86 toggle
- Options (modifiers), Recipes, Happy Hour, Cash Drawer, Bookings, Loyalty, Labour
- Labour report: hours, cost, and labour as a percentage of sales against a target
- Reservations with seat/cancel/no-show states
- Loyalty: points earned per shilling, redemption value, visit and spend history
- Gift cards: issue, balance tracking, void, outstanding-liability figure
- Staff management with hourly pay rates, business/tax settings, floor layout editor
- **eTIMS / M-Pesa config tab** and **Printer tab**
- Full audit log of every login, void, discount, refund, price change and stock move

**Integration layer (config only)**
Credentials are stored per business and editable by an admin, with a **Dry run** button that
shapes a real KRA invoice or Daraja STK request without sending it — so endpoints, phone
normalisation and tax classification can be verified before any client is wired up.
Secrets are masked on read and never returned in the clear.
See [Integration status](#integration-status) below.

**Money handling**
Prices are VAT-inclusive by default (switchable). All amounts are stored as integer cents.
Service charge applies to the discounted subtotal, then VAT. Tips sit outside the taxable
base, matching KRA guidance. Cash change is computed **server-side** from the tendered
amount, so it cannot be doctored in the browser.

---

## Integration status

Deliberately **configuration only** — no live transmission is performed.

| Integration | State | What's there |
|---|---|---|
| KRA eTIMS | Config + payload shaping | Credentials, branch code, device serial, offline window, invoice builder, dry run |
| Safaricom M-Pesa | Config + request shaping | Consumer key/secret, shortcode, passkey, callback URL, phone normalisation, dry run |

Implement `transmitInvoice()` and `requestStkPush()` in `lib/integrations.js` to go live.
Both receive fully-formed payloads, so the remaining work is transport and response
handling, not data shaping.

Until then: collect M-Pesa confirmation codes by hand, and issue tax invoices through the
KRA portal or mobile app. **eTIMS is a legal requirement in Kenya — see `AUDIT.md`.**

---

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open `/kds` on a second screen for the kitchen.

**Environment**

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `POS_DB` | `data/pos.db` | SQLite file |

Data persists in `data/pos.db`. `npm run reset` wipes it and re-seeds the demo menu.

---

## Tests

```bash
npm test
```

Spawns its own server on port 3999 with a throwaway database, so it never touches your data.

Spawns a **fresh server on its own port with a throwaway database for each suite**, so the
suites can't contaminate each other and your real data is never touched.

| Suite | Assertions | Covers |
|---|---|---|
| `test/domain.js` | 53 | Pure business rules — daypart windows (incl. midnight wrap), discounts, loyalty maths, drawer arithmetic, recipe aggregation, labour cost, gift codes |
| `test/e2e.js` | 93 | Real HTTP API — auth, order lifecycle, tax maths, role permissions, payments, refunds, voids, inventory, staff, reports, audit trail |
| `test/features.js` | 146 | Phase 2–4 — happy hour pricing, BOM stock depletion, modifiers, shifts/drawer, tabs, timeclock, reservations, loyalty, gift cards, locations, **ESC/POS bytes verified against a fake TCP printer**, integration dry runs |
| `test/ui.js` | 140 | Boots the *actual shipped client bundle* in jsdom and drives it with real clicks — PIN login, floor plan, order taking, KDS tickets, the full cashier payment flow, and all 16 manager console tabs |

The ESC/POS tests are worth calling out: they open a real TCP listener on port 9100, print a
receipt, and assert on the received bytes — `ESC @` init, `GS V` cut, the `ESC p` drawer kick,
and the presence of the business name, item and chosen modifier. No printer hardware required.

The QR-ordering tests hit the **public, unauthenticated** endpoints directly to confirm guests
can read a menu and place an order but cannot reach staff endpoints, the audit log, or bypass
a required modifier.

```
432 passed, 0 failed
```

There is also a **visual, real-browser** check that the unit/UI suites cannot do, since jsdom
performs no layout. It drives Chromium at every breakpoint and asserts on computed geometry —
no horizontal overflow, ≥44px touch targets, the correct layout shape per device, and writes
screenshots to `shots/`:

```bash
npm install --no-save puppeteer   # one-time; downloads Chromium
npm run test:visual
```

```
177 passed, 0 failed   (320/375/480 phone · 768/1024 tablet · 1440 desktop · KDS · QR)
```

---

## Layout

```
server.js              Express API + SSE realtime feed + static hosting
db.js                  Schema, seed data, tax/totals maths
public/index.html      App shell
public/kds.html        Standalone kitchen display
public/assets/
  api.js               State, HTTP, formatting, modals, SSE client
  app.js               Login keypad, role-based navigation
  pos.js               Floor plan and order taking
  cashier.js           Bills and payments
  kds.js               Kitchen/bar display
  manager.js           Reports, menu, stock, staff, settings, audit
  print.js             Receipt, ticket and Z-report rendering
test/
  run.js               Test harness (isolated port + temp DB)
  e2e.js               API suite
  ui.js                Browser suite (jsdom)
```

## API

Money crosses the wire in **shillings**; the database stores **cents**.

| Method | Path | Role |
|---|---|---|
| POST | `/api/login` · `/api/logout` | all |
| GET | `/api/bootstrap` · `/api/orders` · `/api/menu` | signed in |
| POST | `/api/orders` · `/api/orders/:id/items` · `/send` · `/transfer` | waiter+ |
| PATCH | `/api/orders/:id/items/:itemId` | role-checked |
| POST | `/api/orders/:id/pay` | cashier+ |
| POST | `/api/orders/:id/discount` · `/void` · `/refund` | manager+ |
| GET | `/api/reports/*` · `/api/zreport` | cashier+ |
| * | `/api/menu-items` · `/api/stock` · `/api/users` · `/api/settings` | manager+ |
| GET | `/api/events` | SSE stream (orders, kitchen, menu, sales) |

---

## Notes

- Sessions are in-memory HTTP-only cookies; restarting the server signs everyone out.
- Real M-Pesa STK push needs Daraja credentials. The UI captures the confirmation code and
  the STK button is a prompt — wire `/api/orders/:id/pay` to your provider to go live.
- Receipts print through the browser. Point your thermal printer at the browser's print
  target, or swap `doPrint()` in `print.js` for a direct ESC/POS call.
- PINs are stored in plain text — fine for a demo, hash them before real use.

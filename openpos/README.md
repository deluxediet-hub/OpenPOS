# OpenPOS v2

**A point of sale for every Kenyan shop — any number of branches.**

Offline-first, local-server POS + back office for Kenyan trades: **duka (general shop),
chemist/pharmacy, wines & spirits, boutique, hardware** — with KRA **eTIMS** and **M-Pesa
(Daraja)** compliance built in, English + Swahili UI, and one consolidated owner dashboard
across unlimited branches.

> The repo root holds **OpenPOS v1** (the white-label restaurant & lounge POS) — kept as the
> reference implementation. **This folder is the new product.** See `../OPENPOS_PLAN.md` for
> the full research, feature matrix and 24-day phased roadmap.

## Stack

Node 18+ · Express 5 · better-sqlite3 · plain-ES frontend — **no build step**.
Everything the till needs runs locally; the cloud is only used when online (eTIMS, M-Pesa, SMS).

## Run

```bash
npm install
npm start        # → http://localhost:3000
```

First run shows the onboarding wizard: business name, trade, KRA PIN, VAT (16%),
first branch, owner PIN, optional sample products for the chosen trade.

## Test

```bash
npm test         # unit (money/VAT) + full API flow on a temp DB
```

## Build status

| Phase | Days | What |
|---|---|---|
| 1 | 1–4 | Foundation: onboarding ✓ · security ✓ · catalog ✓ · till (Day 3) · payments/returns/printing (Day 4) |
| 2 | 5–8 | Compliance: eTIMS VSCU + CUIN/QR queue · M-Pesa Daraja STK + C2B · reconciliation |
| 3 | 9–12 | Multi-branch: transfers, purchasing/POs, reports v1 |
| 4 | 13–16 | Verticals: chemist (FEFO/Rx/controlled register) · spirits (21+ gate) · boutique · promos |
| 5 | 17–20 | Customers + kodisha credit · loyalty/gift cards · SMS/WhatsApp · back office |
| 6 | 21–24 | Offline hardening · analytics · full i18n · docs + 3-branch demo |

Day 1 (this increment): skeleton, schema v1, first-run onboarding, scrypt PIN auth with
rate-limit + lockout, DB-backed sessions, branches, catalog, categories, staff, settings,
hash-chained audit log, dashboard, EN/SW core strings.

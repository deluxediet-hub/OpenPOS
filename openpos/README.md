# OpenPOS v2

**A point of sale for every Kenyan shop — any number of branches.**

Offline-first, local-server POS + back office for Kenyan trades: **duka (general shop),
chemist/pharmacy, wines & spirits, boutique, hardware** — with KRA **eTIMS** and **M-Pesa
(Daraja)** compliance built in, English + Swahili UI, and one consolidated owner dashboard
across unlimited branches.

**Starts incredibly small, grows without changing systems.** A single-till shop sees a POS —
never "branches, warehouses, suppliers". Every screen checks the business **capability set**
before showing a concept; the full multi-branch engine is underneath from day one (rules R-C,
ARCHITECTURE.md §3.0).

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

**Architecture contract:** [`ARCHITECTURE.md`](ARCHITECTURE.md) — entity hierarchy and
universal rules (product/variant/pack/batch, pricing chain, stock-as-ledger, payment
adapters, branch isolation, auditability, offline rules, core vs modules).
**Roadmap:** `../OPENPOS_PLAN.md` — 35 phases / 60 days.

| Phase | Days | What |
|---|---|---|
| 1 | 1 | Product architecture & rules ✅ |
| 2 | 2 | Business/tenancy foundation: locations, registers, warehouses, permissions |
| 3–4 | 3–4 | Universal product engine (variants, packs, barcodes, units) |
| 5–6 | 5–6 | Stock ledger & inventory (append-only moves, reason codes) |
| 7–8 | 7–8 | Purchasing & suppliers (POs, GR, discrepancies, suggested POs) |
| 9 | 9 | Pricing engine (resolution chain, margin guards, history) |
| 10–11 | 10–11 | POS / checkout engine |
| 12 | 12 | Payment engine (adapters: cash/M-Pesa/card/bank/deni) |
| 13 | 13 | Shifts & till control |
| 14 | 14 | Sales lifecycle, returns & exchanges |
| 15 | 15 | Customers & deni (credit) system |
| 16–17 | 16–17 | Multi-branch OS (transfers, comparisons, role visibility) |
| 13 | 18 | Stock-taking, shrinkage & reconciliation |
| 14 | 19 | Expenses & business finance |
| 15 | 20–21 | Reporting & BI (4 role dashboards) |
| 16 | 22–23 | Kenyan integration layer (real M-Pesa + eTIMS VSCU) |
| 17 | 24–25 | Offline-first sync architecture |
| 18 | 26–27 | Industry module framework |
| 19–23 | 28–34 | Modules: spirits · boutique · pharmacy · mini-mart · hardware/electronics/cosmetics/footwear |
| 24 | 35 | Promotions, loyalty & marketing |
| 25 | 36 | WhatsApp & customer commerce |
| 26 | 37–38 | Online store / omni-channel |
| 27 | 39 | Hardware & peripheral layer |
| 28 | 40 | Security, audit & fraud controls |
| 29 | 41–42 | Owner intelligence |
| 31 | 43–45 | Testing with real Kenyan businesses |
| 32 | 46–48 | Performance, security & production hardening |
| 33 | 49–50 | Deployment & SaaS layer |
| 34 | 51–53 | Final UX / product polish |
| 35 | 54–60 | Pilot release (5 real businesses) |

**Built so far:** foundation code (Day 0) — onboarding, secure PIN auth, schema v1, manager
UI, dashboard, EN/SW core, 24 tests green — plus Day 1 architecture.

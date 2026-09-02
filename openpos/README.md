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
> the full research, feature matrix and the 35-phase / 60-day roadmap.

## Stack

Node 18+ · Express 5 · built-in `node:sqlite` (zero native deps) · plain-ES frontend —
**no build step**. Everything the till needs runs locally; the cloud is only used when
online (eTIMS, M-Pesa, SMS).

## Run

```bash
npm install
npm start        # → http://localhost:3000
```

First run shows the **solo-first onboarding** (v2): what do you sell → business name/phone →
your name + PIN → done. KRA PIN/VAT are optional and deferrable to Settings. A solo business
gets its one branch, "Main Store" location and first till invisibly — no ERP concepts.
Optional sample products load for the chosen trade.

## Test

```bash
npm test         # unit (money/VAT) + full API flow on a temp DB (48 tests)
```

## Build status

**Architecture contract:** [`ARCHITECTURE.md`](ARCHITECTURE.md) — entity hierarchy and
universal rules (product/variant/pack/batch, pricing chain, stock-as-ledger, payment
adapters, branch isolation, auditability, offline rules, core vs modules) plus the
**capability model (R-C)** that keeps a small shop from ever feeling like an ERP.
**Roadmap:** `../OPENPOS_PLAN.md` — 35 phases / 60 days.

| Phase | Days | What |
|---|---|---|
| 1 | 1 | Product architecture & rules ✅ |
| 2 | 2 | Business/tenancy foundation: **capability system**, locations, registers, warehouses, fine-grained permissions, solo-first onboarding v2 ✅ |
| 3 | 3–4 | Universal product engine: **variants + axes, packs, multi-barcode, serials, industry attributes, CSV import/export, supplier link & reorder** ✅ |
| 4 | 5–6 | Stock ledger & inventory (append-only moves, reason codes) |
| 5 | 7–8 | Purchasing & suppliers (POs, GR, discrepancies, suggested POs) |
| 6 | 9 | Pricing engine (resolution chain, margin guards, history) |
| 7 | 10–11 | POS / checkout engine |
| 8 | 12 | Payment engine (adapters: cash/M-Pesa/card/bank/deni) |
| 9 | 13 | Shifts & till control |
| 10 | 14 | Sales lifecycle, returns & exchanges |
| 11 | 15 | Customers & deni (credit) system |
| 12 | 16–17 | Multi-branch OS (transfers, comparisons, role visibility) |
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
| 30 | later | AI business assistant (after real pilot data exists) |
| 31 | 43–45 | Testing with real Kenyan businesses |
| 32 | 46–48 | Performance, security & production hardening |
| 33 | 49–50 | Deployment & SaaS layer |
| 34 | 51–53 | Final UX / product polish + solo-mode ERP-leakage audit |
| 35 | 54–60 | Pilot release (5 real businesses) |

**Built so far:**
- **Day 1** — product architecture & universal rules (ARCHITECTURE.md, incl. the R-C
  capability model) on top of the Day-0 foundation (onboarding, scrypt PIN auth, schema,
  manager UI, dashboard, EN/SW core).
- **Day 2** — capability system (18-capability registry + trade seeds + guided-growth
  suggestions), tenancy foundation (branch → location → register, warehouses, departments,
  `business_id` hook), 30-key permission matrix with per-user grants, solo-first onboarding
  v2, capability-gated dashboard + manager back office, stock adjust with reason codes.
  **35 tests green** (was 24).
- **Day 3–4** — the **universal product engine** (rules R-P): every product gets an implicit
  single variant (axes `{}`), so flat products, dress colour/size matrices, and
  **packs** (Jameson case = 12 bottles, own barcode + price, draws from the same stock)
  all live in one model. Multi-barcode per variant (unit + case + custom), a single
  `GET /api/scan/:barcode` resolving unit **and** pack (R-P3), **serials** (register /
  write-off move stock), **industry attribute defs** stored as variant `meta` (ABV, size,
  expiry) so the core never learns a trade's fields, **CSV import/export** (products +
  variants + packs round-trips cleanly), and **supplier link + reorder level** on the
  product. Open-priced (sugar 1kg) and fractional base units work. **48 tests green**
  (was 35), all Phase-3 acceptance criteria passing (sugar 1kg open-priced, dress
  red/M variant barcode, Jameson bottle/case pack, paracetamol batch FEFO).

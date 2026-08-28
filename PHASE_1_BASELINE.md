# Phase 1 — Product Scope and Green Baseline

**Baseline date:** 28 August 2026  
**Branch:** `arena/01a03f39-openpos`  
**Starting commit:** `ab91c8c`  
**Purpose:** establish the current working state before production-polishing changes. No application or database behavior was changed in this phase.

## Result

### Phase 1 status: complete for the repository and Linux test harness

The existing application is working well. The complete standard `npm test` suite is now green after updating stale test expectations to match protections and labels already present in the application.

```text
Domain tests                 53 passed, 0 failed
Packaging invariants         36 passed, 0 failed
Wines & spirits retail       55 passed, 0 failed
General API/end-to-end      107 passed, 0 failed
Feature/API                 146 passed, 0 failed
jsdom shipped-client UI     147 passed, 0 failed
------------------------------------------------
Standard suite total        544 passed, 0 failed
```

The total above is the actual runtime result from `npm test`, not a static estimate.

JavaScript syntax checks also passed for:

- `db.js`
- `server.js`
- `lib/*.js`
- `public/assets/*.js`
- `scripts/*.js`
- `test/*.js`

`git diff --check` passed.

## Environment

```text
Arena operating system: Linux
Node used for local baseline: v22.22.3
npm: 10.9.8
Installed package versions:
  better-sqlite3 12.11.1
  express 5.2.1
  jsdom 29.1.1
Target CI runtime in ci/openpos-ci.yml: Node 20, Linux + Windows
```

### Dependency-installation note

A normal `npm ci` first failed because the sandbox could not verify/download the `better-sqlite3` prebuilt binary or Node headers:

```text
prebuild-install warn install unable to verify the first certificate
node-gyp ... headers ... ECONNRESET
```

The sandbox already contained matching local Node headers. Dependencies were installed successfully without weakening TLS settings by compiling the native package locally:

```text
npm ci --no-audit --no-fund --build-from-source --nodedir=/usr/local
```

The only installation warning was the transitive `prebuild-install@7.1.3` deprecation warning. No runtime dependency was added or changed.

## Existing baseline failures found and resolved

The first full run reached the feature suite and reported four failures. Static review showed these were stale tests, not application regressions:

1. The shift test attempted to close while three test orders were still open. The hardened application correctly blocked this.
2. The shift test omitted the required explanation for a deliberate KSh 10 variance.
3. Two later assertions cascaded from the blocked close.
4. The printer test expected an ordinary receipt reprint to kick the cash drawer, while the hardened application correctly requires explicit `kick=1`.

The feature test now:

- Explicitly resolves its own open orders before cash-up.
- Supplies a reconciliation note for its deliberate variance.
- Creates a fresh kitchen-ticket fixture after cash-up.
- Requests drawer kick explicitly for the drawer-kick assertion.

The next run reached the UI suite and exposed stale UI expectations:

- `Floor plan` had been renamed `New sale`.
- `Menu & Pricing` had been renamed `Products & Pricing`.
- `New menu item` had been renamed `New product`.
- The old `data-86` selector is now the clearer `data-avail` selector.
- `Expected in drawer` is now `Expected cash` because three tenders are displayed separately.
- Search assertions waited 60ms although the shipped UI deliberately debounces search by 100ms.
- One stock-row assertion assumed an exact fixture count rather than verifying that the populated inventory rendered.

Only test expectations/timing were aligned. Production files and APIs were not changed.

## Visual test status

`npm run test:visual` is **not runnable from a clean dependency installation** because `test/responsive.js` imports `puppeteer`, but `puppeteer` is not declared in `package.json` or `package-lock.json`.

Observed failure:

```text
Error: Cannot find module 'puppeteer'
Require stack:
- test/responsive.js
```

This is a real baseline tooling gap. It is not being hidden by claiming the responsive suite passed. Existing screenshots are present, but they are not proof that the current commit passed a fresh Chromium run.

Recommended later action:

- Decide whether to add Puppeteer as a development-only dependency, or use an available system Chromium through a small declared test dependency.
- Add the visual suite to CI only after its dependency and runtime are deterministic.
- Keep browser tooling out of the production installer payload.

## CI status

The repository contains a proposed Windows/Linux workflow at:

```text
ci/openpos-ci.yml
```

It is not active because no workflow exists under `.github/workflows`. The Arena GitHub App previously refused workflow creation without Workflow permission. No GitHub Actions run exists for this branch.

Therefore:

- Local Linux standard suite: **green**.
- GitHub Linux CI: **not active**.
- GitHub Windows CI: **not active**.
- Real Windows installer compilation: **not executed in Arena**.
- Clean Windows install/start/upgrade/uninstall: **not yet proven**.

## Packaging baseline

The 36 static packaging invariants passed. They verify source-level guarantees including:

- Hidden single-instance launcher.
- Bundled Node runtime usage.
- ProgramData database, backup and spool locations.
- LAN-only Private/Domain firewall intent.
- Watchdog and daily backup task declarations.
- Data-preserving update, rollback and uninstall design.
- Backup verification shortcut.
- Installer payload/build expectations.

These checks do not compile or install `OpenPOS-Setup.exe`. Actual Windows behavior remains a Phase 8 gate.

## Repository inventory

At the starting commit:

```text
Tracked files:                         203
Express route declarations:            125
CREATE TABLE IF NOT EXISTS clauses:     37
Static ck(...) assertion call sites:   500
server.js lines:                      2,140
db.js lines:                          1,138
manager.js lines:                       987
manager2.js lines:                      835
pos.js lines:                           631
cashier.js lines:                       419
```

The static assertion-call count differs from the 544 runtime assertions because some checks execute in loops or repeated scenarios.

### Generated spool baseline

One hundred old `.prn` print jobs are already tracked in Git history. Test runs generated further untracked spool files. This phase adds `spool/*.prn` to `.gitignore` so future generated jobs do not keep polluting working status. Existing tracked files are deliberately not removed in this baseline phase; spool migration/retention belongs to printing hardening.

## Confirmed existing systems

The baseline suite and code inspection confirm the following already exist and must not be rebuilt:

### Retail sale and stock

- Whole-unit sales.
- Measured bottle sales, including 31.25ml precision.
- Fixed pour/shot products drawing from a source bottle.
- Weighed keg theoretical usage and physical-count control.
- Consolidated repeated product lines.
- Final stock availability check.
- Close-once stock posting.
- Negative-stock protection.

### Money

- Cash, Card and manual M-Pesa tenders.
- Cash tender/change validation.
- Split/partial payments.
- Browser payment idempotency.
- M-Pesa reference uniqueness.
- Shift-linked payments.
- Expenses/payouts.
- Cash, M-Pesa and Card expected/actual variances.
- Overall tender plus stock reconciliation.

### Purchases and stock control

- Supplier directory.
- Goods receipts/deliveries.
- Immediate or pay-later delivery payment state.
- Delivery stock movements.
- Opening stock through catalogue creation/import.
- Full stocktake.
- Sealed units plus open-container ml.
- Added stock during stocktake.
- Quantity, cost and potential-retail variance.
- Complimentary stock and value recording.

### Returns and financial history

- Item-linked returns.
- Tender-limited refunds.
- Optional restocking.
- Return receipt.
- Immutable sale total/tax/cost snapshots for new sales.
- Gift-card funding and redemption controls.

### Operations

- Barcode/SKU import and scanning.
- Direct network ESC/POS sales receipt.
- Explicit original-cash drawer kick.
- Browser print fallback.
- Rotating integrity-checked backups.
- Backup verifier.
- Windows installer source, watchdog and hidden launcher.

## Exact Phase 2 code ownership

The next phase should remain targeted. The relevant current locations are:

| Concern | Current implementation |
|---|---|
| Order discount mutation | `server.js`, `POST /api/orders/:id/discount` |
| Payment, idempotency and close transition | `server.js`, `POST /api/orders/:id/pay` |
| Stock close-out | `server.js`, `closeOut()` |
| Returns/refunds | `server.js`, `POST /api/orders/:id/refund` |
| Return schema | `db.js`, `returns`, `return_items`, `payments` |
| Financial summary | `server.js`, `/api/reports/summary` |
| Product/category/seller reporting | `server.js`, `/api/reports/items`, `/waiters`, `/categories` |
| Partial-payment browser flow | `public/assets/cashier.js`, `payModal()` |
| Sale/return receipts | `public/assets/print.js`, `lib/escpos.js` |
| Shift expectation and close | `server.js`, `drawerFigures()` and `/api/shifts/:id/close` |
| Pure calculations | `lib/domain.js` |
| Retail API regressions | `test/retail.js` |
| General transaction regressions | `test/e2e.js`, `test/features.js` |
| Browser regressions | `test/ui.js` |

Phase 2 must not be mixed with the `server.js` split or inventory packaging schema.

## Product direction carried forward

Based on the latest instruction, Phase 1 assumes:

- This is polishing, not rebuilding.
- Retail is the primary active experience.
- Hospitality capability may remain internally where practical.
- Existing seller-controlled deliveries, expenses, stocktake additions and complimentary declarations remain available.
- Gift-card balances are preserved.
- Loyalty is not deleted automatically.
- Full daily physical stock count will eventually become configurable rather than universally forced.
- Internal stock locations are deferred until a real need is confirmed.
- PIN length and retail-tip policy still require an explicit product decision before their behavior changes.

## Deliberately untouched

No production code, API, schema, stored data, payment rule, stock rule, seller permission, receipt format, reconciliation formula, installer behavior or backup behavior changed in Phase 1.

## Phase 1 exit assessment

### Passed

- Complete repository structure inspected.
- Relevant implementations identified.
- Standard tests installed and run.
- Stale tests aligned with current hardened behavior.
- Standard suite green: 544/544.
- Syntax and whitespace checks green.
- Existing functionality and Phase 2 ownership documented.
- Generated future spool jobs ignored.

### Remaining external/tooling gates

- Visual suite dependency is undeclared.
- Workflow activation requires a Workflow-authorized GitHub identity.
- Windows tests and installer build have not run.

These are documented rather than concealed. They do not prevent targeted Phase 2 development against the now-green standard suite, but Windows production readiness cannot be declared until they are resolved.

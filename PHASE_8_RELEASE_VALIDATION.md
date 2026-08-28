# Phase 8 — Release Validation and Controlled Adoption

**Prepared:** 28 August 2026  
**Baseline:** Phase 7 commit `942d659`  
**Status:** repository-side validation work complete; Windows/physical-shop execution remains an external gate.

## Result

OpenPOS now includes deterministic real-browser and installed-application test definitions rather than relying only on source-level packaging assertions.

This phase does **not** claim that a Windows installer or physical printer was tested in Arena. Arena is Linux, has no Inno Setup/Wine/Windows VM and has no Chrome executable or shop hardware.

## Real-browser test dependency

The responsive suite previously imported undeclared `puppeteer`. It now uses declared development-only:

```text
puppeteer-core 24.16.0
```

`puppeteer-core` was chosen instead of bundled Puppeteer because:

- It does not download a large browser into production/dependency installs.
- GitHub's Ubuntu runner can use its installed Google Chrome.
- A local operator can set `CHROME_BIN` to an installed Chrome/Chromium.
- The dependency is omitted from the Windows production payload's runtime install.

The visual test searches:

```text
CHROME_BIN
/usr/bin/google-chrome
/usr/bin/google-chrome-stable
/usr/bin/chromium
/usr/bin/chromium-browser
```

When none exists it produces a clear configuration error.

### Arena result

The suite starts correctly and resolves `puppeteer-core`, but cannot launch here:

```text
No Chrome/Chromium executable found. Set CHROME_BIN for the visual suite.
```

This is an environment limitation, not reported as a passing visual test.

## CI definition

`ci/openpos-ci.yml` now defines three release jobs:

### Linux + Windows standard matrix

- Node 20.
- `npm ci`.
- Complete standard suite.
- Packaging invariants.

### Ubuntu real-Chromium job

- Node 20.
- Clean dependency install.
- `CHROME_BIN=/usr/bin/google-chrome`.
- Complete responsive suite.
- Screenshot artifact upload even on failure.

### Windows installer job

- Clean Windows runner.
- Install Inno Setup.
- Build real `OpenPOS-Setup.exe`.
- Enforce minimum artifact size.
- Install silently into `C:\OpenPOS-CI`.
- Exercise the installed private runtime and application.
- Upload the compiled installer artifact.

## Installed-application smoke test

New script:

```text
packaging/test-installed.ps1
```

Against the actual installed directory it verifies:

1. Private `node.exe` exists.
2. App, routes, services, public files and scripts exist.
3. Installed server starts on an isolated port.
4. A new ProgramData-style SQLite data directory can be created and written.
5. Retail onboarding succeeds.
6. Seller login succeeds.
7. Till opens.
8. Retail catalogue/bootstrap loads.
9. A sale is created and paid.
10. Stock deducts exactly once.
11. ESC/POS receipt bytes are spooled.
12. Hot backup succeeds.
13. Backup verification succeeds.

The script uses isolated temporary data/backups and does not touch a live shop database.

## Controlled shop checklist

`SHOP_PILOT_ACCEPTANCE.md` provides a physical acceptance form covering:

- Clean installation and restart.
- Owner and seller accounts.
- Opening balances.
- Bottle, package, portion and keg stock.
- Cash/Card/M-Pesa payments.
- Receipt, reprint and drawer behavior.
- Deliveries, expenses, additions and complementaries.
- Returns.
- Full/scoped/no-count reconciliation.
- Backup and recovery.
- Seven-day parallel run and owner sign-off.

## Standard test result

### Before Phase 8

```text
662 passed, 0 failed
```

### After Phase 8

```text
Domain and reconciliation             65 passed
Packaging/release definition           42 passed
Architecture structure                 22 passed
Retail workflow                        55 passed
Phase 2 transaction hardening          19 passed
Inventory packages and ledger          20 passed
Count policy/reconciliation API        17 passed
Operations hardening                   15 passed
General API/end-to-end                107 passed
Feature/API                           146 passed
Shipped-client UI                     157 passed
---------------------------------------------------
Standard suite total                  665 passed, 0 failed
```

A clean lockfile installation was also completed successfully in Arena using its local Node headers:

```text
npm ci --no-audit --no-fund --build-from-source --nodedir=/usr/local
```

The only warning was the existing transitive `prebuild-install` deprecation. The 665-test suite passed again after that clean install.

JavaScript syntax checks and `git diff --check` passed.

## CI activation limitation

The workflow remains stored at:

```text
ci/openpos-ci.yml
```

It is not active under `.github/workflows`. Arena's GitHub App previously rejected workflow creation because it lacks Workflow permission.

Activation still requires an authorized GitHub account/credential to copy it to:

```text
.github/workflows/ci.yml
```

Until that happens, no GitHub Windows, visual or installer run can be claimed.

## What was already working

- Linux standard suite.
- Static packaging checks.
- Installer source and build script.
- Responsive Chromium test source.
- Existing screenshot collection.
- Retail opening-to-close flow.
- Backup/restore verifier.

## What changed

- Declared deterministic browser automation dependency.
- Added system-Chrome discovery and clear failure message.
- Added CI real-Chromium job.
- Added silent Windows installer execution.
- Added installed-app sale/stock/print/backup smoke script.
- Added physical seven-day shop acceptance checklist.
- Added static checks proving these release gates remain in CI/package source.

## Deliberately untouched

- Runtime production dependencies.
- SQLite/Express architecture.
- APIs and database schema.
- Sales, payments and stock logic.
- Seller-controlled workflows.
- Reconciliation.
- Retail UI.
- Hospitality compatibility.
- Gift cards and loyalty records.

## Gates still required before declaring Windows production-ready

- [ ] Activate the GitHub workflow with Workflow permission.
- [ ] Observe green Linux and Windows standard jobs.
- [ ] Observe green real-Chromium job and inspect screenshots.
- [ ] Compile the actual installer.
- [ ] Complete silent installed-app smoke test.
- [ ] Test install/reboot/uninstall/reinstall on a clean Windows VM or PC.
- [ ] Test the shop's actual thermal printer and cash drawer.
- [ ] Restore a backup on a separate installation.
- [ ] Complete and sign the physical shop acceptance checklist.
- [ ] Complete 7–14 days of parallel operation.

## Readiness statement

The repository is now prepared for controlled release validation, but **Windows production readiness is not yet proven**. The application test baseline is strong and the required automated/physical gates are explicit and executable. Final approval depends on running them in environments Arena does not provide.

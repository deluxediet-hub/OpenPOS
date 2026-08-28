# OpenPOS Release Readiness

**Updated:** 28 August 2026
**Target:** one small Kenyan wines and spirits shop, one Windows host, trusted LAN, one shared till, owner and a few sellers.

## Current verdict

The application is ready for a controlled owner-supervised shop pilot. Repository-side financial, inventory, UI, backup and packaging tests are green.

Do not describe Windows production readiness as proven until the prepared Windows/Chromium jobs and physical shop checklist have actually run.

## Verified locally

```text
Standard automated suite: 671 passed, 0 failed
JavaScript syntax:         passed
Whitespace/diff checks:    passed
Clean npm lock install:    passed using available local Node headers
Legacy DB migrations:      exercised during phased development
```

Covered areas include:

- Authentication and one-use manager approval
- Whole, package, measured and weighed stock
- Purchases, stock movements and idempotency
- Cash/Card/M-Pesa payments and change
- Returns and non-resellable loss handling
- Full/scoped/no-count reconciliation
- Retail and hospitality UI regression
- ESC/POS byte generation, return receipts and reprint safety
- Backup creation and verification
- Packaging source invariants

## Prepared but not executed in Arena

- Real Chrome responsive suite at retail phone/tablet/desktop widths
- Windows Node 20 test matrix
- Inno Setup installer compilation
- Silent clean installation
- Installed-runtime sale/stock/print/backup smoke test
- Physical printer and cash drawer
- Separate-machine restore

Arena has no Chrome executable, Windows VM, Inno Setup or shop hardware.

## CI activation

Workflow source:

```text
ci/openpos-ci.yml
```

Intended active path:

```text
.github/workflows/ci.yml
```

Arena's current GitHub App lacks Workflow permission, so the active file cannot be pushed from this session. A Workflow-authorized GitHub identity must copy it.

## Distribution gate

- [ ] Activate workflow.
- [ ] Linux and Windows standard jobs pass.
- [ ] Real Chrome job passes and screenshots are inspected.
- [ ] Installer compiles and silent installed smoke passes.
- [ ] Clean Windows reboot/start/access test passes.
- [ ] Actual receipt printer and drawer pass.
- [ ] Upgrade/uninstall-keep-data/reinstall passes.
- [ ] Backup restores on another installation.
- [ ] Owner and sellers complete `SHOP_PILOT_ACCEPTANCE.md`.
- [ ] Seven to fourteen days of parallel operation are signed off.

## Accepted limitations

- Local-first trusted-LAN deployment; do not expose port 3000 publicly.
- Sessions are in memory and devices sign in again after restart.
- Print recovery uses rotating spool files and browser fallback, not a database print queue.
- Off-device backup is optional and must be configured operationally.
- Internal stock-location transfers are deferred until the shop has a real need.
- Gift-card/loyalty historical data is preserved; loyalty is hidden in active retail UI.
- Reusable hospitality mode remains in the codebase and test suite.

## Operator documents

- `README.md` — product and developer overview
- `INSTALL.md` — deployment, printer, network, update and recovery
- `SHOP_PILOT_ACCEPTANCE.md` — physical shop acceptance and seven-day sign-off
- `docs/PRODUCT_IMPORT.md` — product CSV format
- `packaging/README-PACKAGING.md` — installer build and verification

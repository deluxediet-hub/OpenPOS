# OpenPOS Windows Packaging

The Inno Setup installer wraps the existing Node/Express/SQLite application without changing its APIs or business rules.

## Installed layout

```text
C:\Program Files\OpenPOS\
  runtime\node.exe
  app\                  server, routes, services, public files and scripts
  node_modules\         production dependencies
  scripts\              Windows maintenance helpers

C:\ProgramData\OpenPOS\
  data\pos.db
  backups\
  spool\
  app-backups\
```

`app\spool` is a junction to the ProgramData spool directory. Business data survives application update/reinstall.

## Build

Requirements: Windows, PowerShell, internet during build and Inno Setup 6.

```powershell
powershell -ExecutionPolicy Bypass -File .\packaging\build-installer.ps1
```

Output:

```text
packaging\output\OpenPOS-Setup.exe
```

The build first removes the previous payload with retries and stops if Windows still has it locked. It then downloads the pinned private Node 22 LTS runtime, runs `npm ci --omit=dev` through that exact runtime, and verifies that its `node.exe` can open an in-memory `better-sqlite3` database before compiling the offline-capable installer. Node 22 uses ABI 127, matching the available Windows prebuilt binary, so the build machine does not need Python or Visual Studio. The build stops instead of producing an installer when the native ABI does not match.

The resulting EXE supports 64-bit Windows 10 build 1809 or newer. It bundles Node and all production dependencies; the shop PC does not need Node, npm, Python, Visual Studio or internet. Unsupported Windows/CPU combinations are rejected by the installer instead of failing silently. The installer, uninstaller, Start-menu entry and desktop shortcut use `assets\openpos.ico`.

## Installed behavior

- Hidden startup at user logon
- Single-instance health check
- Private/Domain firewall rule on TCP 3000
- Five-minute watchdog
- Nightly rotating verified backup
- Backup catch-up at next logon when the nightly run was missed
- ProgramData persistence
- Data-preserving update and rollback
- Uninstall prompt to keep business data

## Start-menu tools

- Open POS
- Show LAN address
- Startup diagnostics and latest hidden-server log
- Stop server
- Verify latest backup
- Update application code
- Roll back application code

Backup creation and verification are also available inside the owner Settings screen.

## Automated checks

```bash
npm test
```

Packaging assertions verify launcher, ProgramData, firewall, scheduled tasks, backup guard, update/rollback, uninstall, modular route/service payload and installed-smoke definition.

The prepared Windows CI job:

1. Compiles `OpenPOS-Setup.exe`.
2. Checks artifact size.
3. Installs silently into an isolated path.
4. Runs `packaging/test-installed.ps1`.
5. Uploads the installer artifact.

## Installed smoke test

```powershell
.\packaging\test-installed.ps1 -InstallDir 'C:\OpenPOS-CI'
```

The script uses temporary data/backups and verifies installed runtime startup, setup, login, till, sale, stock deduction, ESC/POS spool, backup and backup verification.

Do not point smoke-test environment variables at a live shop database.

## Release gate

Before distribution, also test on a clean Windows PC/VM:

- Reboot auto-start without a console
- Phone access on trusted Wi-Fi
- Actual receipt printer and drawer
- Upgrade over a copied existing database
- Uninstall with keep-data and reinstall
- Backup restore on a separate installation

The workflow source is `ci/openpos-ci.yml`. It becomes active only when copied to `.github/workflows/ci.yml` using a GitHub identity with Workflow permission.

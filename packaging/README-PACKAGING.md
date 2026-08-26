# OpenPOS — single-click Windows appliance packaging

Wraps the **existing** Node + Express + SQLite + browser POS. **Zero** application-code
changes: no changes to functionality, UI, schema, APIs, auth, tax, payments, inventory, SSE,
or the 432-test behaviour. Underneath the installer it is the *same* server your phones and
tablets already talk to over the LAN.

The customer gets **one file: `OpenPOS-Setup.exe`**. Double-click → everything installs,
the server starts hidden, the browser opens once, and every device on the local router works
— **with no internet at all**.

---

## The model

```
 C:\Program Files\OpenPOS\            <- application + private runtime (read-mostly at runtime)
    runtime\node.exe                  <- bundled Node (not on PATH, not a system install)
    app\                              <- the existing POS code, byte-for-byte
    app\spool\                        <- JUNCTION -> ProgramData\OpenPOS\spool (survives updates)
    node_modules\                     <- bundled deps incl. Windows better-sqlite3 binary
    scripts\                          <- launcher / maintenance helpers

 C:\ProgramData\OpenPOS\              <- ALL persistent business data (outside Program Files' app tree)
    data\pos.db                       <- sales, stock, staff, settings, audit  (via POS_DATA_DIR)
    spool\                            <- receipt reprint archive
    app-backups\                      <- code backups for rollback
```

- **Database is never inside the app dir.** The launcher sets `POS_DATA_DIR` to
  `ProgramData\OpenPOS\data`, which the untouched `db.js` already honours.
- **Spool survives updates/reinstalls** via a directory *junction* from `app\app\spool` to
  `ProgramData\OpenPOS\spool`, so the app keeps writing spool files to a location that is
  never overwritten by an app update. (Junction = link only; deleting it never deletes data.)
- **Single instance.** The launcher checks `http://127.0.0.1:3000/healthz` first and quits if a
  server is already up — reboots, re-logons and double-clicks never spawn a second copy.
- **Hidden.** Started via `wscript start-hidden.vbs` (window style 0) — no console window, and
  the server keeps running after the browser is closed.
- **Auto-start** at logon via a Startup-folder shortcut to the VBS.
- **LAN-only firewall**: an inbound TCP-3000 rule on **Private/Domain** profiles only — never
  Public — so phones/tablets/PCs on your Wi-Fi connect but the port is not internet-facing.

---

## Build the installer (on a Windows build machine, once per release)

Prereqs (build machine only): Windows, PowerShell, **Inno Setup 6**, internet (one time).

```powershell
cd pos\packaging
powershell -ExecutionPolicy Bypass -File build-installer.ps1
```

It copies the existing app, downloads the official Node win-x64 runtime, runs **one**
`npm install --omit=dev` to obtain the Windows `better-sqlite3` binary (matching the bundled
runtime ABI), and compiles `packaging\output\OpenPOS-Setup.exe`. The customer needs none of
these and no internet.

## Install (customer, clean PC)

1. Double-click `OpenPOS-Setup.exe` (asks for admin once: Program Files + firewall rule).
2. It installs app + runtime + deps, creates the ProgramData data layout + spool junction,
   adds the LAN firewall rule, adds the logon auto-start, starts the server, and opens the
   browser **once** (first run shows the onboarding wizard).
3. Done. It now starts automatically at every logon, hidden.

Start Menu group "OpenPOS" gives the owner plain shortcuts — no PowerShell knowledge needed:
*Open POS*, *Show my LAN address*, *Stop OpenPOS server*, *Update application code*,
*Roll back application code*.

## Where things live

| What | Path |
|---|---|
| App + runtime + deps | `C:\Program Files\OpenPOS\` |
| Database & all business data | `C:\ProgramData\OpenPOS\data\pos.db` |
| Receipt spool | `C:\ProgramData\OpenPOS\spool` |
| Code backups | `C:\ProgramData\OpenPOS\app-backups` |

## Find the server IP (for phones/tablets)

Start Menu → **OpenPOS → Show my LAN address** → prints `http://192.168.x.x:3000`.
Devices open that URL in any browser — no Node/npm/code on them.

## Stop / start / restart

* Stop: Start Menu → *Stop OpenPOS server* (clean; SQLite closes safely).
* Start: Start Menu → *Open POS* launches it if not running (the launcher is single-instance,
  so it's safe to click any time); it also auto-starts at logon.
* Restart: Stop then Start.

## Update safely (data preserved)

Start Menu → *Update application code* (or run `update-app.ps1 -Source <new code>`):
stops → backs up current code to `app-backups\<ts>` → copies new code only → restarts.
It **never** touches the database, spool, printer config or backups. `db.js`'s in-place
additive migrations handle schema evolution on next boot.

A fresh `OpenPOS-Setup.exe` over an existing install also preserves all ProgramData data
(Inno never removes files it didn't install).

## Rollback

Start Menu → *Roll back application code* (or `rollback-app.ps1 [-Name <ts>]`).
Restores a prior code backup; business data untouched.

## Uninstall without losing data

Standard uninstall. It stops the server, removes the firewall rule, the startup entry, the
app + runtime, and the spool *junction* — then **asks** "keep your business data?". Choosing
Yes (default) leaves `ProgramData\OpenPOS` intact; only an explicit **No** deletes it.

---

## Verification

**Automated, run on the build/dev machine (`npm test`), POS untouched:**

```
domain 53 · packaging 25 · e2e 93 · features 146 · ui 140  =  457 passed, 0 failed
```

The new `test/packaging.js` statically enforces the appliance guarantees (data outside app
dir, single-instance headless launcher, LAN-only firewall on 3000, junctioned spool, and
update/rollback/uninstall never deleting data).

**Not verifiable in this (Linux) sandbox — run on a clean Windows machine/VM:**

1. Install from `OpenPOS-Setup.exe`.  2. Disconnect internet.  3. Reboot.
4. Confirm POS auto-starts with **no** terminal window.  5. Open `http://localhost:3000`.
6. Connect a phone on the same Wi-Fi to `http://<server-IP>:3000`.
7. Confirm realtime (SSE) — place an order on the phone, watch it appear on the till/KDS.
8. Take a cashier payment.  9. Reboot again; confirm sales/stock persist.
10. Uninstall choosing "keep data"; confirm `pos.db` survives; reinstall and see the data return.

## Security notes

- No Node/npm exposed to the user; no system PATH change; no Windows service added.
- The only listener is the POS on 3000, bound for LAN use; firewall rule is Private/Domain only.
- Credentials stay handled exactly as the app already does (hashed PINs, masked secrets).

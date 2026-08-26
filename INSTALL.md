# Installing Serengeti POS

Everything below was verified on Linux with Node 20.20.2. Windows and macOS steps are
included but **not** verified in this environment — see [Troubleshooting](#troubleshooting).

---

## 1. Install Node.js

You need **Node.js 18 or newer**. Node 20 LTS is what this was tested on.

Check whether you already have it:

```bash
node -v
```

If that prints `v18.x`, `v20.x` or higher, skip ahead. Otherwise install it:

| System | How |
|---|---|
| **Windows / macOS** | Download the LTS installer from https://nodejs.org |
| **Ubuntu / Debian** | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash -` then `sudo apt install -y nodejs` |
| **macOS (Homebrew)** | `brew install node@20` |

`npm` comes bundled with Node, so you don't install it separately.

---

## 2. Get the project files

Copy the `pos/` folder onto the machine that will run the till. Any location works —
here we'll use `~/pos`.

If you're moving it from this workspace, **don't copy `node_modules/` or `data/`** —
those are rebuilt and re-seeded automatically:

```bash
# from wherever you have the files
rsync -av --exclude node_modules --exclude data ./pos/ user@till-machine:~/pos/
```

Or zip it:

```bash
cd pos && zip -r serengeti-pos.zip . -x "node_modules/*" -x "data/*"
```

---

## 3. Install dependencies

```bash
cd ~/pos
npm install
```

Expect roughly **one minute** and about 142 packages. You'll see one harmless warning:

```
npm warn deprecated prebuild-install@7.1.3: No longer maintained...
```

Ignore it — that's a transitive dependency of the SQLite driver, not a failure.

> `better-sqlite3` is a **native** module. On Linux and macOS it normally downloads a
> prebuilt binary. If no prebuilt exists for your platform it compiles from source, which
> needs a C++ toolchain — see [Troubleshooting](#troubleshooting).

---

## 4. Start it

```bash
npm start
```

You should see:

```
Serengeti POS listening on http://0.0.0.0:3000
```

On **first run only**, it creates `data/pos.db` and seeds the demo data — 87 menu items,
13 categories, 27 tables, 20 stock items and 7 staff accounts. You'll see `data/` appear.

---

## 5. Open it

Point a browser at:

```
http://localhost:3000
```

Sign in with a PIN:

| PIN | Role |
|---|---|
| `0000` | Admin |
| `1111` | Manager |
| `1234` | Waiter (Brian) |
| `2345` | Cashier (Njeri) |
| `3456` | Bar (Otis) |
| `4567` | Kitchen (Kamau) |

**Change these PINs immediately** — Manager → Staff → Edit.

For the kitchen, open `http://localhost:3000/kds` on a second screen and leave it there.

---

## 6. Let other devices on the network reach it

The server binds `0.0.0.0`, so tablets, phones and other tills on the same Wi-Fi can
connect without any extra configuration.

Find the till machine's LAN address:

```bash
# Linux / macOS
hostname -I | awk '{print $1}'     # or: ipconfig getifaddr en0

# Windows
ipconfig                            # look for "IPv4 Address"
```

Then from any device on the same network:

```
http://192.168.1.50:3000        # replace with your till's address
http://192.168.1.50:3000/kds    # kitchen display
```

If a device can't connect, the usual cause is a host firewall blocking port 3000:

```bash
# Ubuntu/Debian
sudo ufw allow 3000/tcp
```

---

## 7. Keep it running after you close the terminal

`npm start` stops when you close the terminal or log out. For a real till, run it as a
service. Pick the option for your platform.

> **Windows note:** the Windows options below are written from vendor documentation and
> were **not** executed in the environment this was built on (Linux). Verify on your own
> machine before depending on them to survive a reboot.

### Option A — Windows: NSSM (recommended, most reliable)

NSSM wraps any program as a genuine Windows service that starts on boot, restarts on
crash, and runs whether or not anyone is logged in.

1. Download NSSM from https://nssm.cc/download and unzip it.
2. Open **PowerShell as Administrator** and cd to the unzipped `win64` folder.
3. Install the service:

```powershell
nssm install SerengetiPOS
```

A GUI opens — fill in:

| Field | Value |
|---|---|
| Path | `C:\Program Files\nodejs\node.exe` |
| Startup directory | `C:\Users\you\pos` |
| Arguments | `server.js` |

Then on the **Details** tab set *Display name* to `Serengeti POS`, and on **I/O** point
*Output* at `C:\Users\you\pos\logs\pos.log` so you have logs.

4. Start it:

```powershell
nssm start SerengetiPOS
nssm status SerengetiPOS      # should say SERVICE_RUNNING
```

Manage it later with `nssm restart SerengetiPOS`, `nssm stop SerengetiPOS`, or from
`services.msc`. Create the `logs` folder first.

### Option B — Windows: Task Scheduler (no extra download)

Runs at boot without a console window, but does **not** auto-restart on crash.

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
             -Argument "server.js" -WorkingDirectory "C:\Users\you\pos"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "SerengetiPOS" -Action $action -Trigger $trigger `
  -Settings $settings -User "SYSTEM" -RunLevel Highest
```

Run it now with `Start-ScheduledTask -TaskName "SerengetiPOS"`.

### Option C — PM2 (any platform, simplest to manage)

```bash
npm install -g pm2
cd ~/pos
pm2 start server.js --name pos
pm2 save
pm2 startup        # prints a command — run it to survive reboots
```

On Windows, `pm2 startup` needs the extra `pm2-windows-startup` package:

```powershell
npm install -g pm2-windows-startup
pm2-startup install
pm2 start server.js --name pos
pm2 save
```

Useful commands:

```bash
pm2 logs pos       # watch output
pm2 restart pos    # restart
pm2 stop pos       # stop
```

### Option D — Linux: systemd

```bash
sudo tee /etc/systemd/system/pos.service > /dev/null <<EOF
[Unit]
Description=Serengeti POS
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/pos
ExecStart=$(which node) server.js
Restart=always
RestartSec=3
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pos
sudo systemctl status pos        # confirm it's active
```

### Confirming it survived

Whichever method you used, check after a reboot:

```
http://localhost:3000/healthz     -> {"ok":true,...}
```

Also add the app to your browser bookmarks and put `http://<till-ip>:3000/kds` on the
kitchen screen as a kiosk tab.

---

## 8. Configuration

Everything is optional — the defaults work out of the box.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `POS_DB` | `data/pos.db` | SQLite database file |

```bash
PORT=8080 npm start                              # different port
POS_DB=/srv/pos/serengeti.db npm start           # database elsewhere
```

With systemd, add them under `[Service]`:

```ini
Environment=PORT=8080
Environment=POS_DB=/srv/pos/serengeti.db
```

Business details, VAT rate, service charge and the receipt footer are edited in the app:
**Manager → Settings**.

---

## 9. Back up your data

Your entire business history is one file: `data/pos.db`. Back it up with:

```bash
npm run backup
```

```
Backup written: /home/you/pos/backups/pos-2026-08-24-08-34-02.db
  96 KB · 0 orders · 87 menu items · verified readable
```

This uses SQLite's online backup API, so it is **safe to run while the till is trading** —
no need to stop the server. It re-opens the copy afterwards to confirm it's a readable
database rather than a truncated file.

To write somewhere specific, such as an external drive:

```bash
npm run backup -- /media/usb/pos-today.db
```

**Do not** just copy `data/pos.db` by hand while the server is running. The sibling
`-wal` file can hold uncommitted transactions, and a bare copy may be inconsistent.

Automate it with cron (daily at 23:30, after service):

```bash
crontab -e
# add this line, adjusting the path:
30 23 * * * cd /home/you/pos && /usr/bin/node scripts/backup.js >> /var/log/pos-backup.log 2>&1
```

---

## 10. Verify the installation

```bash
npm test
```

Runs two suites against an isolated server on port 3999 with a throwaway database, so it
cannot touch your real data:

```
=== Serengeti POS end-to-end test ===   93 passed, 0 failed
=== Serengeti POS UI test (jsdom) ===  100 passed, 0 failed
```

If you see those numbers, the install is good.

---

## Resetting the demo data

Wipes sales, orders and any menu edits, then re-seeds on next start:

```bash
npm run reset
```

**This deletes your transaction history.** Back up first if you've been trading.

---

## Troubleshooting

**`npm install` fails with node-gyp / python / C++ errors**
`better-sqlite3` had no prebuilt binary for your platform and tried to compile.
- Windows: `npm install --global windows-build-tools` (or install Visual Studio Build Tools
  with "Desktop development with C++"), then retry.
- Ubuntu/Debian: `sudo apt install -y build-essential python3`, then retry.
- macOS: `xcode-select --install`, then retry.

**`Error: Cannot find module 'better-sqlite3'`**
You skipped step 3, or ran `npm start` from the wrong directory. `cd` into the project
folder and run `npm install`.

**Port 3000 already in use**
```bash
PORT=3001 npm start
```

**Another device can't reach the till**
Check they're on the same network (not a guest Wi-Fi), the firewall allows the port
(step 6), and you're using the LAN IP rather than `localhost`.

**I forgot a PIN**

Stop the server first, then reset it (needs only Node, which you already have):

```bash
node -e "require('better-sqlite3')('data/pos.db')
  .prepare(\"UPDATE users SET pin='9999' WHERE name LIKE '%Manager%'\").run()"
```

Sign in as `9999`, then set a real PIN under **Manager → Staff**. Swap `%Manager%` for
`%Cashier%` etc. to target a different person. If you have the `sqlite3` CLI installed,
`sqlite3 data/pos.db "UPDATE users SET pin='9999' WHERE name LIKE '%Manager%';"` does the
same job.

**Blank page in the browser**
Hard-refresh (`Ctrl+Shift+R`). If it persists, check the server is running:
`curl http://localhost:3000/healthz` should return `{"ok":true,...}`.

---

## Before you trade for real

Three things are demo-grade and need attention:

1. **PINs are stored in plain text.** Hash them (bcrypt/argon2) in `server.js` before
   taking real money.
2. **Sessions are in-memory.** Restarting the server signs everyone out. Fine for a till,
   not fine if you restart mid-service.
3. **M-Pesa is not connected to Daraja.** The UI captures confirmation codes and the STK
   button is a prompt. Wire `/api/orders/:id/pay` in `server.js` to Safaricom's API for
   live push payments.

Also set a real KRA PIN and business address under **Manager → Settings** — both print on
every receipt.

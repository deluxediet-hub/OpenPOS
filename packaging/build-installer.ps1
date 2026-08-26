# =====================================================================
#  OpenPOS - build the Windows installer (run ON WINDOWS, once per release).
#
#  Prerequisites (build machine only; the END USER needs none of these):
#    - Windows, PowerShell
#    - Inno Setup 6+   (ISCC.exe)  https://jrsoftware.org/isinfo.php
#    - Internet access (to fetch the Node runtime and npm packages ONE time)
#
#  The produced OpenPOS-Setup.exe is fully OFFLINE-capable.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File build-installer.ps1
# =====================================================================
$ErrorActionPreference = 'Stop'
$NodeVersion = 'v20.19.0'              # keep the same major as the app was developed/tested on
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo   = Split-Path -Parent $here              # the POS repo root (.. of packaging/)
$build  = Join-Path $here 'build'
$pay    = Join-Path $build 'payload'
$tools  = Join-Path $build 'tools'

Write-Host "==> Preparing payload" -ForegroundColor Cyan
Remove-Item $pay -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$pay\app"      -Force | Out-Null
New-Item -ItemType Directory -Path "$pay\runtime"  -Force | Out-Null
New-Item -ItemType Directory -Path "$pay\scripts"  -Force | Out-Null

# 1. The EXISTING POS code, byte-for-byte (never modified by packaging).
foreach ($i in @('server.js','db.js','lib','public','scripts','package.json','package-lock.json')) {
  Copy-Item -Path (Join-Path $repo $i) -Destination "$pay\app" -Recurse -Force
}
# 2. Helper scripts.
Copy-Item -Path (Join-Path $here 'assets\*') -Destination "$pay\scripts" -Recurse -Force

# 3. Private Node runtime (official win-x64 build).
Write-Host "==> Fetching Node $NodeVersion (win-x64)" -ForegroundColor Cyan
$zip = Join-Path $build "node-$NodeVersion-win-x64.zip"
if (-not (Test-Path $zip)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip -UseBasicParsing
}
Expand-Archive -Path $zip -DestinationPath $tools -Force
$nodedir = Join-Path $tools "node-$NodeVersion-win-x64"
Copy-Item (Join-Path $nodedir 'node.exe') "$pay\runtime\node.exe" -Force

# 4. Windows-native dependencies (better-sqlite3 prebuilt for this Node).
#    Uses the bundled node/npm so the native ABI matches the bundled runtime.
Write-Host "==> Installing Windows dependencies (one time)" -ForegroundColor Cyan
Push-Location "$pay\app"
& (Join-Path $nodedir 'npm.cmd') install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
Pop-Location
# Present node_modules as a sibling of app\ (matches the installer layout and the
# way Node resolves require() from app\server.js), keeping code and deps separate.
if (Test-Path "$pay\node_modules") { Remove-Item "$pay\node_modules" -Recurse -Force }
Move-Item "$pay\app\node_modules" "$pay\node_modules"

# 5. Compile the installer.
Write-Host "==> Compiling OpenPOS-Setup.exe" -ForegroundColor Cyan
$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $cand = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
  if (Test-Path $cand) { $iscc = $cand } else { throw "Inno Setup (ISCC.exe) not found. Install Inno Setup 6 first." }
}
& $iscc (Join-Path $here 'openpos.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

Write-Host "`nDone. Installer at: $here\output\OpenPOS-Setup.exe" -ForegroundColor Green
Write-Host "Copy that single file to the till PC and double-click it. No internet needed there."

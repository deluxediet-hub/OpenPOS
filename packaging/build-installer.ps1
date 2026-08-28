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
foreach ($i in @('server.js','db.js','lib','routes','services','public','scripts','package.json','package-lock.json')) {
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

# 4. Windows-native dependencies (better-sqlite3 must match the bundled Node ABI).
# Run npm THROUGH the downloaded node.exe and put that runtime first on PATH.
# Invoking npm.cmd alone can let native lifecycle scripts find a system Node first,
# which previously packaged a Node-22 ABI 127 binary beside Node-20 ABI 115.
Write-Host "==> Installing Windows dependencies for bundled $NodeVersion" -ForegroundColor Cyan
$npmCli = Join-Path $nodedir 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) { throw "Bundled npm CLI not found: $npmCli" }
$oldPath = $env:PATH
try {
  $env:PATH = "$nodedir;$oldPath"
  Push-Location "$pay\app"
  & (Join-Path $nodedir 'node.exe') $npmCli ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed under bundled Node" }
} finally {
  Pop-Location
  $env:PATH = $oldPath
}
# Present node_modules as a sibling of app\ (matches the installer layout and the
# way Node resolves require() from app\server.js), keeping code and deps separate.
if (Test-Path "$pay\node_modules") { Remove-Item "$pay\node_modules" -Recurse -Force }
Move-Item "$pay\app\node_modules" "$pay\node_modules"

# Refuse to compile an installer until the exact bundled runtime can load and use
# its packaged native SQLite module. This turns an ABI mismatch into a build error.
Write-Host "==> Verifying bundled Node / better-sqlite3 ABI" -ForegroundColor Cyan
$verifyNative = @'
const modulePath = process.argv[1];
const Database = require(modulePath);
const db = new Database(':memory:');
const answer = db.prepare('SELECT 42 answer').get().answer;
db.close();
if (answer !== 42) throw new Error('SQLite native smoke test failed');
console.log(`Native SQLite OK: Node ${process.version}, ABI ${process.versions.modules}`);
'@
& "$pay\runtime\node.exe" -e $verifyNative "$pay\node_modules\better-sqlite3"
if ($LASTEXITCODE -ne 0) { throw "Bundled better-sqlite3 is incompatible with bundled Node $NodeVersion" }

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

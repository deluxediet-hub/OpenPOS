# =====================================================================
#  OpenPOS - update the APPLICATION CODE only.
#  NEVER touches: the database, sales, stock, staff, settings, audit logs,
#  printer config, or the spool archive (all live in %ProgramData%\OpenPOS).
#
#  Usage:
#     powershell -ExecutionPolicy Bypass -File update-app.ps1 -Source C:\path\to\new\pos
# =====================================================================
param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$app  = Join-Path $base 'app'
$back = Join-Path $env:ProgramData 'OpenPOS\app-backups'

if (-not (Test-Path (Join-Path $Source 'server.js'))) {
  Write-Host "Source does not look like the POS (no server.js). Nothing changed." -ForegroundColor Red; exit 1
}

& (Join-Path $PSScriptRoot 'stop-server.ps1')

# Back up current code (spool is a junction and is skipped automatically).
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $back $ts
New-Item -ItemType Directory -Path $dest -Force | Out-Null
foreach ($item in @('server.js','db.js','lib','public','scripts','package.json','package-lock.json')) {
  $p = Join-Path $app $item
  if (Test-Path $p) { Copy-Item -Path $p -Destination $dest -Recurse -Force }
}
Write-Host "Backed up current app to $dest"

# Copy new code over the top; never delete data or the spool junction.
foreach ($item in @('server.js','db.js','lib','public','scripts','package.json','package-lock.json')) {
  $p = Join-Path $Source $item
  if (Test-Path $p) { Copy-Item -Path $p -Destination $app -Recurse -Force }
}
if (Test-Path (Join-Path $Source 'node_modules')) {
  Copy-Item -Path (Join-Path $Source 'node_modules') -Destination $base -Recurse -Force
}

wscript.exe "`"$($PSScriptRoot)\start-hidden.vbs`""
Write-Host "Update applied. Business data was NOT modified." -ForegroundColor Green

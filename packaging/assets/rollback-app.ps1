# =====================================================================
#  OpenPOS - roll the APPLICATION CODE back to a previous backup.
#  The database and all business data are never modified by a rollback.
#
#  Usage:  powershell -ExecutionPolicy Bypass -File rollback-app.ps1 [-Name yyyyMMdd-HHmmss]
#  With no -Name, rolls back to the most recent backup.
# =====================================================================
param([string]$Name)
$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$app  = Join-Path $base 'app'
$back = Join-Path $env:ProgramData 'OpenPOS\app-backups'

if (-not (Test-Path $back)) { Write-Host "No backups found at $back" -ForegroundColor Red; exit 1 }
$all = Get-ChildItem $back -Directory | Sort-Object Name -Descending
if (-not $all) { Write-Host "No backups found." -ForegroundColor Red; exit 1 }

if ($Name) { $pick = $all | Where-Object Name -eq $Name | Select-Object -First 1 }
else       { $pick = $all | Select-Object -First 1 }
if (-not $pick) { Write-Host "Backup '$Name' not found. Available:"; $all | ForEach-Object { Write-Host "  $($_.Name)" }; exit 1 }

& (Join-Path $PSScriptRoot 'stop-server.ps1')
foreach ($item in @('server.js','db.js','lib','public','scripts','package.json','package-lock.json')) {
  $p = Join-Path $pick.FullName $item
  if (Test-Path $p) { Copy-Item -Path $p -Destination $app -Recurse -Force }
}
wscript.exe "`"$($PSScriptRoot)\start-hidden.vbs`""
Write-Host "Rolled back to $($pick.Name). Business data untouched." -ForegroundColor Green

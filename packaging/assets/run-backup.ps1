# =====================================================================
#  OpenPOS scheduled backup runner.
#  Uses the bundled runtime to run the app's own backup.js against the
#  ProgramData database, keeping the last N local copies and (optionally)
#  pushing to an off-site webhook via POS_BACKUP_WEBHOOK.
#  Safe to run any time; never modifies the database.
# =====================================================================
param([switch]$Force)
$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = Join-Path $base 'runtime\node.exe'
$bk   = Join-Path $base 'app\scripts\backup.js'
$db   = Join-Path $env:ProgramData 'OpenPOS\data\pos.db'
$dest = Join-Path $env:ProgramData 'OpenPOS\backups'

if (-not (Test-Path $node)) { Write-Host "runtime not found"; exit 1 }
if (-not (Test-Path $db))   { Write-Host "no database yet - nothing to back up"; exit 0 }

$env:POS_DB = $db
$env:POS_BACKUP_DIR = $dest
$env:POS_BACKUP_KEEP = '14'
New-Item -ItemType Directory -Path $dest -Force | Out-Null
# At logon this acts as catch-up, but does not create another copy when a recent
# scheduled backup already exists. The nightly task naturally runs once >20h old.
$latest = Get-ChildItem $dest -Filter 'pos-*.db' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Force -and $latest -and $latest.LastWriteTime -gt (Get-Date).AddHours(-20)) { exit 0 }
# Optional off-site copy: set this to an HTTPS receiver (S3 presigned, NAS webhook, etc.)
# $env:POS_BACKUP_WEBHOOK = 'https://your-offsite.example/backup'

& $node $bk
exit $LASTEXITCODE

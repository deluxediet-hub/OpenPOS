# =====================================================================
#  OpenPOS scheduled backup runner.
#  Uses the bundled runtime to run the app's own backup.js against the
#  ProgramData database, keeping the last N local copies and (optionally)
#  pushing to an off-site webhook via POS_BACKUP_WEBHOOK.
#  Safe to run any time; never modifies the database.
# =====================================================================
$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = Join-Path $base 'runtime\node.exe'
$bk   = Join-Path $base 'app\scripts\backup.js'
$db   = Join-Path $env:ProgramData 'OpenPOS\data\pos.db'

if (-not (Test-Path $node)) { Write-Host "runtime not found"; exit 1 }
if (-not (Test-Path $db))   { Write-Host "no database yet - nothing to back up"; exit 0 }

$env:POS_DB = $db
$env:POS_BACKUP_KEEP = '14'
# Optional off-site copy: set this to an HTTPS receiver (S3 presigned, NAS webhook, etc.)
# $env:POS_BACKUP_WEBHOOK = 'https://your-offsite.example/backup'

& $node $bk
exit $LASTEXITCODE

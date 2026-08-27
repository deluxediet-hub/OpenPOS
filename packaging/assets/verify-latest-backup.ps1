# Read-only restore drill for the newest installed OpenPOS backup.
$ErrorActionPreference='Stop'
$base=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node=Join-Path $base 'runtime\node.exe'
$verify=Join-Path $base 'app\scripts\verify-backup.js'
$env:POS_BACKUP_DIR=Join-Path $env:ProgramData 'OpenPOS\backups'
& $node $verify
if($LASTEXITCODE -ne 0){Write-Host 'Backup verification FAILED.' -ForegroundColor Red}else{Write-Host 'Backup verification passed.' -ForegroundColor Green}
Read-Host 'Press Enter to close'
exit $LASTEXITCODE

# Offline, verified database restore with automatic emergency rollback.
param([Parameter(Mandatory=$true)][string]$Backup)
$ErrorActionPreference='Stop'
$base=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$data=Join-Path $env:ProgramData 'OpenPOS\data';$db=Join-Path $data 'pos.db'
$backupRoot=Join-Path $env:ProgramData 'OpenPOS\backups';$source=[IO.Path]::GetFullPath($Backup)
if(-not $source.StartsWith([IO.Path]::GetFullPath($backupRoot),[StringComparison]::OrdinalIgnoreCase)){throw 'Restore source must be inside the OpenPOS backups folder'}
if(-not (Test-Path $source)){throw 'Selected backup does not exist'}
& (Join-Path $base 'runtime\node.exe') (Join-Path $base 'app\scripts\verify-backup.js') $source
if($LASTEXITCODE -ne 0){throw 'Backup verification failed; live data was not changed'}
& (Join-Path $PSScriptRoot 'stop-server.ps1');Start-Sleep -Seconds 2
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$emergency=Join-Path $backupRoot "pre-restore-$stamp.db"
if(Test-Path $db){Copy-Item $db $emergency -Force}
try{
  Remove-Item "$db-wal","$db-shm" -Force -ErrorAction SilentlyContinue
  $temp="$db.restore";Copy-Item $source $temp -Force;Move-Item $temp $db -Force
  wscript.exe "`"$PSScriptRoot\start-hidden.vbs`""
  $healthy=$false;for($i=0;$i -lt 30;$i++){Start-Sleep -Seconds 1;try{$h=Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 2;if($h.ok){$healthy=$true;break}}catch{}}
  if(-not $healthy){throw 'Restored database did not start successfully'}
  "Restore succeeded from $source. Pre-restore copy: $emergency"|Out-File (Join-Path $backupRoot 'restore-status.txt')
}catch{
  & (Join-Path $PSScriptRoot 'stop-server.ps1');if(Test-Path $emergency){Copy-Item $emergency $db -Force}
  wscript.exe "`"$PSScriptRoot\start-hidden.vbs`"";throw "Restore failed and the pre-restore database was put back: $($_.Exception.Message)"
}

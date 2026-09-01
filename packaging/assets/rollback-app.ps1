# Roll application code back to a verified pre-update snapshot. Business data is untouched.
param([string]$Name)
$ErrorActionPreference='Stop'
$base=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path);$app=Join-Path $base 'app'
$back=Join-Path $env:ProgramData 'OpenPOS\app-backups';$items=@('server.js','db.js','lib','routes','services','public','scripts','package.json','package-lock.json')
$all=@(Get-ChildItem $back -Directory -ErrorAction SilentlyContinue|Sort-Object Name -Descending)
$pick=if($Name){$all|Where-Object Name -eq $Name|Select-Object -First 1}else{$all|Select-Object -First 1}
if(-not $pick){throw "Application backup '$Name' was not found at $back"}
if(-not (Test-Path (Join-Path $pick.FullName 'routes')) -or -not (Test-Path (Join-Path $pick.FullName 'services'))){throw 'Selected backup predates the modular application and is not safe to restore.'}
& (Join-Path $PSScriptRoot 'stop-server.ps1')
foreach($item in $items){$target=Join-Path $app $item;$source=Join-Path $pick.FullName $item;if(Test-Path $target){Remove-Item $target -Recurse -Force};if(Test-Path $source){Copy-Item $source $app -Recurse -Force}else{throw "Backup is incomplete: $item"}}
if(Test-Path (Join-Path $pick.FullName 'node_modules')){if(Test-Path (Join-Path $base 'node_modules')){Remove-Item (Join-Path $base 'node_modules') -Recurse -Force};Copy-Item (Join-Path $pick.FullName 'node_modules') $base -Recurse -Force}
wscript.exe "`"$PSScriptRoot\start-hidden.vbs`""
$healthy=$false;for($i=0;$i -lt 30;$i++){Start-Sleep -Seconds 1;try{$h=Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 2;if($h.ok){$healthy=$true;break}}catch{}}
if(-not $healthy){throw 'Rollback files were restored, but OpenPOS did not become healthy. Open Startup diagnostics.'}
Write-Host "Rolled back to $($pick.Name) and verified healthy. Business data untouched." -ForegroundColor Green

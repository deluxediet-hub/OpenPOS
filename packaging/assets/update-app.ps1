# OpenPOS verified application-code update. Business data in ProgramData is never touched.
param([Parameter(Mandatory=$true)][string]$Source,[switch]$AllowUnsigned)
$ErrorActionPreference='Stop'
$base=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$app=Join-Path $base 'app'; $back=Join-Path $env:ProgramData 'OpenPOS\app-backups'
$items=@('server.js','db.js','lib','routes','services','public','scripts','package.json','package-lock.json')
$manifestPath=Join-Path $Source 'release-manifest.json'
if(-not (Test-Path (Join-Path $Source 'server.js')) -or -not (Test-Path (Join-Path $Source 'routes')) -or -not (Test-Path (Join-Path $Source 'services'))){throw 'Update source is incomplete (server.js, routes and services are required).'}
if(-not (Test-Path $manifestPath)){if(-not $AllowUnsigned){throw 'release-manifest.json is required. Use -AllowUnsigned only for a trusted local development source.'}}
else {
  $manifest=Get-Content $manifestPath -Raw | ConvertFrom-Json
  foreach($file in $manifest.files.PSObject.Properties){
    $path=Join-Path $Source ($file.Name -replace '/','\')
    if(-not (Test-Path -LiteralPath $path)){throw "Release file missing: $($file.Name)"}
    $actual=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
    if($actual -ne [string]$file.Value){throw "Checksum mismatch: $($file.Name)"}
  }
  Write-Host "Verified release $($manifest.version) ($($manifest.files.PSObject.Properties.Count) files)" -ForegroundColor Green
}
& (Join-Path $PSScriptRoot 'stop-server.ps1')
$ts=Get-Date -Format 'yyyyMMdd-HHmmss';$dest=Join-Path $back $ts
New-Item -ItemType Directory -Path $dest -Force|Out-Null
foreach($item in $items){$p=Join-Path $app $item;if(Test-Path $p){Copy-Item $p $dest -Recurse -Force}}
if(Test-Path (Join-Path $base 'node_modules')){Copy-Item (Join-Path $base 'node_modules') $dest -Recurse -Force}
try {
  foreach($item in $items){$target=Join-Path $app $item;$source=Join-Path $Source $item;if(Test-Path $target){Remove-Item $target -Recurse -Force};Copy-Item $source $app -Recurse -Force}
  if(Test-Path (Join-Path $Source 'node_modules')){if(Test-Path (Join-Path $base 'node_modules')){Remove-Item (Join-Path $base 'node_modules') -Recurse -Force};Copy-Item (Join-Path $Source 'node_modules') $base -Recurse -Force}
  & (Join-Path $base 'runtime\node.exe') -e "const D=require(process.argv[1]);const d=new D(':memory:');if(d.prepare('select 42 n').get().n!==42)process.exit(2);d.close()" (Join-Path $base 'node_modules\better-sqlite3')
  if($LASTEXITCODE -ne 0){throw 'Packaged SQLite module is incompatible with the bundled Node runtime'}
  wscript.exe "`"$PSScriptRoot\start-hidden.vbs`""
  $healthy=$false;for($i=0;$i -lt 30;$i++){Start-Sleep -Seconds 1;try{$h=Invoke-RestMethod 'http://127.0.0.1:3000/healthz' -TimeoutSec 2;if($h.ok){$healthy=$true;break}}catch{}}
  if(-not $healthy){throw 'Updated application did not become healthy within 30 seconds'}
  Write-Host "Update applied and health verified. Rollback: $($dest|Split-Path -Leaf)" -ForegroundColor Green
}catch{
  Write-Warning $_.Exception.Message;Write-Warning 'Restoring the pre-update application automatically.'
  foreach($item in $items){$target=Join-Path $app $item;$source=Join-Path $dest $item;if(Test-Path $target){Remove-Item $target -Recurse -Force};if(Test-Path $source){Copy-Item $source $app -Recurse -Force}}
  if(Test-Path (Join-Path $dest 'node_modules')){if(Test-Path (Join-Path $base 'node_modules')){Remove-Item (Join-Path $base 'node_modules') -Recurse -Force};Copy-Item (Join-Path $dest 'node_modules') $base -Recurse -Force}
  wscript.exe "`"$PSScriptRoot\start-hidden.vbs`"";throw
}

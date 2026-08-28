$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = Join-Path $env:ProgramData 'OpenPOS'
$log = Join-Path $root 'logs\server.log'
Write-Host 'OpenPOS startup diagnostics' -ForegroundColor Cyan
Write-Host "Install: $base"
Write-Host "Data:    $root"
foreach ($path in @((Join-Path $base 'runtime\node.exe'),(Join-Path $base 'app\server.js'),(Join-Path $base 'node_modules'),(Join-Path $base 'app\routes'),(Join-Path $base 'app\services'))) {
  Write-Host ("{0}  {1}" -f ($(if(Test-Path $path){'[OK]'}else{'[MISSING]'}),$path))
}
try {
  $response=Invoke-WebRequest 'http://127.0.0.1:3000/healthz' -UseBasicParsing -TimeoutSec 2
  Write-Host "[OK] Server responded HTTP $($response.StatusCode)" -ForegroundColor Green
} catch {
  Write-Host '[DOWN] Server did not answer on localhost:3000' -ForegroundColor Red
}
Write-Host "`nLatest server log: $log" -ForegroundColor Cyan
if(Test-Path $log){Get-Content $log -Tail 80}else{Write-Host 'No server log exists yet.'}
Write-Host "`nPress Enter to close."
Read-Host | Out-Null

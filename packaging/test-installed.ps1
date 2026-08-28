param(
  [string]$InstallDir = 'C:\OpenPOS-CI',
  [int]$Port = 3917
)
$ErrorActionPreference = 'Stop'
$node = Join-Path $InstallDir 'runtime\node.exe'
$app = Join-Path $InstallDir 'app'
if (-not (Test-Path $node)) { throw "Installed runtime missing: $node" }
if (-not (Test-Path (Join-Path $app 'server.js'))) { throw 'Installed server.js missing' }
foreach ($folder in @('routes','services','public','scripts')) {
  if (-not (Test-Path (Join-Path $app $folder))) { throw "Installed app folder missing: $folder" }
}

$root = Join-Path $env:TEMP ("OpenPOS-installed-smoke-" + [guid]::NewGuid().ToString('N'))
$data = Join-Path $root 'data'; $backups = Join-Path $root 'backups'; $spool = Join-Path $app 'spool'
New-Item -ItemType Directory -Path $data,$backups -Force | Out-Null
$env:POS_DATA_DIR = $data; $env:POS_BACKUP_DIR = $backups; $env:PORT = [string]$Port
$stdout = Join-Path $root 'server.out.log'; $stderr = Join-Path $root 'server.err.log'
$process = $null
try {
  $process = Start-Process $node -ArgumentList 'server.js' -WorkingDirectory $app -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $base = "http://127.0.0.1:$Port"
  $up = $false
  for ($i=0; $i -lt 100; $i++) {
    try { if ((Invoke-WebRequest "$base/healthz" -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200) { $up=$true; break } } catch {}
    Start-Sleep -Milliseconds 200
  }
  if (-not $up) { throw "Installed server did not start: $(Get-Content $stderr -Raw -ErrorAction SilentlyContinue)" }

  $setup = @{business=@{business_name='Installed Smoke Wines';business_type='wines_spirits';currency='KES';currency_symbol='KSh';vat_rate='16';tax_mode='inclusive'};owner_name='Owner';owner_pin='0000';sample=$true} | ConvertTo-Json -Depth 5
  Invoke-RestMethod "$base/api/setup" -Method Post -ContentType 'application/json' -Body $setup | Out-Null
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Invoke-WebRequest "$base/api/login" -Method Post -ContentType 'application/json' -Body '{"pin":"1234"}' -WebSession $session -UseBasicParsing | Out-Null
  Invoke-RestMethod "$base/api/shifts" -Method Post -ContentType 'application/json' -Body '{"opening_float":1000,"opening_mpesa":0,"opening_card":0}' -WebSession $session | Out-Null
  $boot = Invoke-RestMethod "$base/api/bootstrap" -WebSession $session
  if ($boot.settings.business_type -ne 'wines_spirits' -or $boot.menu.Count -lt 1) { throw 'Installed retail bootstrap failed' }
  $stockId=$boot.menu[0].stock_item_id; $before=($boot.stock | Where-Object id -eq $stockId).qty
  $order=Invoke-RestMethod "$base/api/orders" -Method Post -ContentType 'application/json' -Body '{}' -WebSession $session
  $line=@{items=@(@{menu_item_id=$boot.menu[0].id;qty=1})}|ConvertTo-Json -Depth 4
  $order=Invoke-RestMethod "$base/api/orders/$($order.id)/items" -Method Post -ContentType 'application/json' -Body $line -WebSession $session
  $amount=$order.totals.grand_total/100
  $pay=@{method='cash';amount=$amount;tendered=$amount;idempotency_key='installed-smoke-payment'}|ConvertTo-Json
  $paid=Invoke-RestMethod "$base/api/orders/$($order.id)/pay" -Method Post -ContentType 'application/json' -Body $pay -WebSession $session
  if ($paid.order.status -ne 'closed') { throw 'Installed sale did not close' }
  $after=(Invoke-RestMethod "$base/api/stock" -WebSession $session | Where-Object id -eq $stockId).qty
  if ([math]::Abs(($before-$after)-1) -gt 0.000001) { throw "Installed stock did not deduct once: $before -> $after" }
  $print=Invoke-RestMethod "$base/api/print/receipt/$($order.id)?paid=1" -Method Post -ContentType 'application/json' -Body '{}' -WebSession $session
  if ($print.bytes -lt 100 -or -not (Test-Path $print.spool)) { throw 'Installed ESC/POS spool test failed' }

  $env:POS_DB=Join-Path $data 'pos.db'
  & $node (Join-Path $app 'scripts\backup.js')
  if ($LASTEXITCODE -ne 0) { throw 'Installed backup command failed' }
  & $node (Join-Path $app 'scripts\verify-backup.js')
  if ($LASTEXITCODE -ne 0) { throw 'Installed backup verification failed' }
  Write-Host 'Installed OpenPOS smoke test passed: start, setup, login, sale, stock, ESC/POS spool, backup and verification.' -ForegroundColor Green
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}

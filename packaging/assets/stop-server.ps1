# =====================================================================
#  OpenPOS - stop the running server cleanly (SQLite closes safely).
# =====================================================================
$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$appJs = Join-Path $base 'app\server.js'

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -replace '"','' -like "*$([IO.Path]::GetFullPath($appJs).Replace('"',''))*" }

if (-not $procs) {
  # fall back to any node running our server.js path substring
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*OpenPOS*server.js*' }
}

if ($procs) {
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "OpenPOS server stopped." -ForegroundColor Yellow
} else {
  Write-Host "No running OpenPOS server found." -ForegroundColor Gray
}

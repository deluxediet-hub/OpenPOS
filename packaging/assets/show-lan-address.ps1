# =====================================================================
#  OpenPOS - show the addresses other devices should use to connect.
#  Safe to run any time; makes no changes.
# =====================================================================
$port = 3000
Write-Host ""
Write-Host "  OpenPOS connection addresses" -ForegroundColor Cyan
Write-Host "  ----------------------------"
Write-Host "  On THIS computer:   http://localhost:$port"
Write-Host ""
Write-Host "  On phones/tablets/other PCs on the same Wi-Fi/LAN:" -ForegroundColor Yellow

$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -ExpandProperty IPAddress

if ($ips) {
  foreach ($ip in $ips) { Write-Host ("     http://{0}:{1}" -f $ip, $port) -ForegroundColor Green }
} else {
  Write-Host "     (no LAN address found - check you are connected to Wi-Fi/LAN)" -ForegroundColor Red
}
Write-Host ""
Write-Host "  If a device cannot connect, run allow-lan-access.ps1 as Administrator."
Write-Host ""
Read-Host "Press Enter to close"

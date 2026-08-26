# =====================================================================
#  OpenPOS - allow LOCAL LAN devices to reach the POS on port 3000.
#  Adds an inbound rule for Private/Domain networks ONLY, so the POS is
#  reachable from phones/tablets/PCs on your Wi-Fi/LAN but is NOT opened
#  on Public networks (i.e. not exposed to the internet).
#  Requires Administrator. Run elevated.
# =====================================================================
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$rule = 'OpenPOS LAN (TCP 3000)'

# Replace any prior copy of the rule so updates never stack duplicates.
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName $rule `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 `
  -Profile Private,Domain `
  -Description 'OpenPOS server access for devices on the local LAN only.' | Out-Null

Write-Host "Firewall rule '$rule' added (Private/Domain profiles only)." -ForegroundColor Green
Write-Host "Devices on this network can now open  http://<this-PC-IP>:3000"

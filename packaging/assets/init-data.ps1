# =====================================================================
#  OpenPOS - create the persistent data layout OUTSIDE the app directory.
#  Idempotent: safe to run on install, reinstall and repair.
#    %ProgramData%\OpenPOS\data         pos.db (never in Program Files)
#    %ProgramData%\OpenPOS\backups      verified rotating database backups
#    %ProgramData%\OpenPOS\spool        receipt reprint archive
#    %ProgramData%\OpenPOS\app-backups  app code backups for rollback
#    <app>\app\spool                    a directory JUNCTION to the spool above,
#                                       so the untouched app keeps writing spool
#                                       files to a location that survives updates.
# =====================================================================
$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # <root>
$appSpool = Join-Path $base 'app\spool'
$root = Join-Path $env:ProgramData 'OpenPOS'

foreach ($d in @('data','backups','spool','logs','app-backups')) {
  New-Item -ItemType Directory -Path (Join-Path $root $d) -Force | Out-Null
}

# The server starts as the signed-in shop user, while setup runs elevated. Grant
# the built-in Users group Modify rights using its language-independent SID so
# SQLite, backups, logs and print spool remain writable after installer exit/reboot.
& icacls.exe $root /grant '*S-1-5-32-545:(OI)(CI)M' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not grant the shop user write access to $root" }

# Junction <app>\app\spool -> ProgramData\OpenPOS\spool (link only; data stays put).
if (-not (Test-Path $appSpool)) {
  cmd /c mklink /J "`"$appSpool`"" "`"$(Join-Path $root 'spool')`"" | Out-Null
}
Write-Host "OpenPOS data layout ready at $root"

; =====================================================================
;  OpenPOS - single-click Windows installer (Inno Setup 6)
;  Wraps the EXISTING Node/Express/SQLite POS. Zero application code changes.
;
;  Appliance model:
;    App code + private Node runtime + deps  -> {app}  (Program Files\OpenPOS)
;    Persistent business data (pos.db etc.)  -> {commonappdata}\OpenPOS  (ProgramData)
;    spool survives updates via a junction   -> {app}\app\spool => ProgramData\OpenPOS\spool
;    Auto-start at logon, hidden, single-instance
;    LAN-only (Private/Domain) firewall rule for TCP 3000
; =====================================================================
#define MyAppName "OpenPOS"
#define AppPort "3000"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

[Setup]
AppId={{8A128F45-33DE-4A5A-B6BA-77C91F4057D8}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=OpenPOS
DefaultDirName={autopf}\OpenPOS
DefaultGroupName=OpenPOS
PrivilegesRequired=admin
MinVersion=10.0.17763
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
SetupIconFile=assets\openpos.ico
OutputDir=output
OutputBaseFilename=OpenPOS-Setup
Compression=lzma2/ultra64
SolidCompression=yes
SetupLogging=yes
UninstallDisplayIcon={app}\scripts\openpos.ico
VersionInfoVersion={#MyAppVersion}.0
VersionInfoCompany=OpenPOS
VersionInfoDescription=OpenPOS Wines and Spirits Retail POS
VersionInfoProductName=OpenPOS

[Files]
Source: "build\payload\runtime\node.exe";      DestDir: "{app}\runtime";     Flags: ignoreversion
Source: "build\payload\app\*";                 DestDir: "{app}\app";         Flags: ignoreversion recursesubdirs createallsubdirs
Source: "build\payload\node_modules\*";        DestDir: "{app}\node_modules";Flags: ignoreversion recursesubdirs createallsubdirs
Source: "build\payload\scripts\*";             DestDir: "{app}\scripts";     Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Auto-start at logon, hidden, single-instance.
Name: "{userstartup}\OpenPOS Server"; Filename: "wscript.exe"; Parameters: """{app}\scripts\start-hidden.vbs"""; WorkingDir: "{app}"
; Owner-facing shortcuts (no PowerShell knowledge required).
Name: "{group}\Open POS"; Filename: "wscript.exe"; Parameters: """{app}\scripts\start-hidden.vbs"" /open"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\openpos.ico"
Name: "{group}\Show my LAN address (for phones & tablets)"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\show-lan-address.ps1"""; WorkingDir: "{app}"
Name: "{group}\Startup diagnostics"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\show-diagnostics.ps1"""; WorkingDir: "{app}"
Name: "{group}\Stop OpenPOS server"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\stop-server.ps1"""; WorkingDir: "{app}"
Name: "{group}\Verify latest backup"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\verify-latest-backup.ps1"""; WorkingDir: "{app}"
Name: "{group}\Update application code"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\update-app.ps1"""; WorkingDir: "{app}"
Name: "{group}\Roll back application code"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\rollback-app.ps1"""; WorkingDir: "{app}"
Name: "{commondesktop}\OpenPOS"; Filename: "wscript.exe"; Parameters: """{app}\scripts\start-hidden.vbs"" /open"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\openpos.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
Name: "firewall"; Description: "Let phones/tablets on my network connect (LAN-only firewall rule)"; Flags: checkedonce

[Run]
; 1. Create ProgramData data layout + spool junction (idempotent).
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\init-data.ps1"""; Flags: runhidden waituntilterminated
; 2. Self-heal: a 5-minute watchdog restarts the server if it ever stops answering.
Filename: "schtasks.exe"; Parameters: "/create /tn ""OpenPOS Watchdog"" /tr ""wscript.exe \""{app}\scripts\watchdog.vbs\"""" /sc minute /mo 5 /f"; Flags: runhidden waituntilterminated
; 3. Daily backup at 23:30 (keeps last 14 local copies; optional off-site webhook).
Filename: "schtasks.exe"; Parameters: "/create /tn ""OpenPOS Daily Backup"" /tr ""powershell.exe -ExecutionPolicy Bypass -File \""{app}\scripts\run-backup.ps1\"""" /sc daily /st 23:30 /f"; Flags: runhidden waituntilterminated
; Catch up a missed nightly backup at the next Windows logon (runner skips copies newer than 20h).
Filename: "schtasks.exe"; Parameters: "/create /tn ""OpenPOS Backup Catchup"" /tr ""powershell.exe -ExecutionPolicy Bypass -File \""{app}\scripts\run-backup.ps1\"""" /sc onlogon /f"; Flags: runhidden waituntilterminated
; 2. LAN-only firewall rule (Private/Domain, never Public).
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\allow-lan-access.ps1"""; Flags: runhidden waituntilterminated; Tasks: firewall
; 3. Start the server now (hidden, single-instance) and open the browser once.
Filename: "wscript.exe"; Parameters: """{app}\scripts\start-hidden.vbs"" /open"; Flags: nowait postinstall skipifsilent runasoriginaluser; Description: "Start OpenPOS and open it when ready"
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\show-lan-address.ps1"""; Flags: nowait postinstall skipifsilent unchecked; Description: "Show the LAN address for phones/tablets"

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\stop-server.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopOpenPOS"
Filename: "schtasks.exe"; Parameters: "/delete /tn ""OpenPOS Watchdog"" /f"; Flags: runhidden waituntilterminated; RunOnceId: "DelWatchdog"
Filename: "schtasks.exe"; Parameters: "/delete /tn ""OpenPOS Daily Backup"" /f"; Flags: runhidden waituntilterminated; RunOnceId: "DelBackup"
Filename: "schtasks.exe"; Parameters: "/delete /tn ""OpenPOS Backup Catchup"" /f"; Flags: runhidden waituntilterminated; RunOnceId: "DelBackupCatchup"
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Remove-NetFirewallRule -DisplayName 'OpenPOS LAN (TCP 3000)' -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated; RunOnceId: "FwOpenPOS"
; Remove ONLY the spool junction (the link, never the data behind it).
Filename: "cmd.exe"; Parameters: "/c rmdir ""{app}\app\spool"" 2>nul"; Flags: runhidden waituntilterminated; RunOnceId: "SpoolJunction"

[UninstallDelete]
Name: "{userstartup}\OpenPOS Server*"; Type: files

[Code]
var KeepData: Boolean;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    KeepData := (MsgBox('Keep your business data (sales, stock, staff, settings, receipts)?' + #13#10 +
      'It is stored in ProgramData\OpenPOS. Choose Yes to keep it (recommended).',
      mbConfirmation, MB_YESNO) = IDYES);
    if not KeepData then
      DelTree(ExpandConstant('{commonappdata}\OpenPOS'), True, True, True);
  end;
end;

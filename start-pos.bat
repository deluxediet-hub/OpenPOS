@echo off
setlocal EnableExtensions
rem =====================================================================
rem  OpenPOS one-click launcher (Windows)
rem
rem  Double-clicking this BAT immediately hands startup to the hidden VBS
rem  launcher, so no command window remains on screen. Run with --hidden
rem  only from the VBS launcher. Startup details are written to
rem  logs\start-pos.log for troubleshooting.
rem =====================================================================

if /I not "%~1"=="--hidden" (
  if not exist "%~dp0start-pos-hidden.vbs" (
    echo OpenPOS hidden launcher is missing: start-pos-hidden.vbs
    pause
    exit /b 1
  )
  start "" wscript.exe //nologo "%~dp0start-pos-hidden.vbs"
  exit /b 0
)

cd /d "%~dp0"
if not exist "logs\" mkdir "logs" >nul 2>&1
set "LOG=%~dp0logs\start-pos.log"

echo.>>"%LOG%"
echo ================================================================>>"%LOG%"
echo [%date% %time%] OpenPOS startup requested>>"%LOG%"

rem If OpenPOS is already running, simply bring it up in the browser.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/healthz' -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0} } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 (
  echo [%date% %time%] Server already running; opening browser.>>"%LOG%"
  start "" "http://localhost:3000"
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR: Node.js was not found.>>"%LOG%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Node.js was not found. Install the LTS version from https://nodejs.org, then start OpenPOS again.','OpenPOS',[System.Windows.MessageBoxButton]::OK,[System.Windows.MessageBoxImage]::Error)" >nul 2>&1
  exit /b 1
)

if not exist "node_modules\" (
  echo [%date% %time%] First run: installing components...>>"%LOG%"
  call npm ci --omit=dev --no-audit --no-fund >>"%LOG%" 2>&1
  if errorlevel 1 (
    echo [%date% %time%] ERROR: npm install failed.>>"%LOG%"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('OpenPOS installation failed. Check the internet connection and logs\start-pos.log, then try again.','OpenPOS',[System.Windows.MessageBoxButton]::OK,[System.Windows.MessageBoxImage]::Error)" >nul 2>&1
    exit /b 1
  )
  echo [%date% %time%] Components installed.>>"%LOG%"
)

rem Open the browser after the local server has had time to start.
start "" /b powershell.exe -WindowStyle Hidden -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'"

echo [%date% %time%] Starting server on http://localhost:3000>>"%LOG%"
node server.js >>"%LOG%" 2>&1
set "EXITCODE=%errorlevel%"
echo [%date% %time%] Server stopped with exit code %EXITCODE%.>>"%LOG%"

if not "%EXITCODE%"=="0" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('OpenPOS stopped unexpectedly. See logs\start-pos.log for details.','OpenPOS',[System.Windows.MessageBoxButton]::OK,[System.Windows.MessageBoxImage]::Warning)" >nul 2>&1
exit /b %EXITCODE%

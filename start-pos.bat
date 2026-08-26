@echo off
setlocal
rem =====================================================================
rem  OpenPOS one-click launcher (Windows)
rem  Double-click this file. It installs components on first run, starts
rem  the server, and opens your browser. Keep this window open while you
rem  trade; close it (or press Ctrl+C) to stop the POS server.
rem =====================================================================
cd /d "%~dp0"
title OpenPOS - Restaurant and Lounge POS
color 0A

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo   Install the LTS version from https://nodejs.org, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   First run - installing components, one time only...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   Installation failed. Check your internet connection, then double-click this file again.
    pause
    exit /b 1
  )
  echo   Components installed.
)

rem Open the default browser a few seconds after the server starts.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

echo.
echo   Starting the POS server...
echo   Keep this window OPEN while you trade. Close it or press Ctrl+C to stop.
echo.
node server.js

pause

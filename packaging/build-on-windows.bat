@echo off
rem =====================================================================
rem  Build OpenPOS-Setup.exe  (run ON a Windows machine, once per release)
rem  One-time prerequisites on this machine only:
rem     1. Inno Setup 6  -> https://jrsoftware.org/isdl.php   (free)
rem     2. Internet access (to fetch Node + npm packages ONE time)
rem  The customer's till PC needs NEITHER.
rem =====================================================================
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 ( echo PowerShell not found. & pause & exit /b 1 )

if not exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
  echo Inno Setup 6 was not found.
  echo Install it once from https://jrsoftware.org/isdl.php, then run this file again.
  pause
  exit /b 1
)

powershell -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
if errorlevel 1 (
  echo.
  echo Build FAILED. See messages above.
  pause
  exit /b 1
)

echo.
echo Success. Your installer is at:
echo    %~dp0output\OpenPOS-Setup.exe
echo Copy that single file to any till PC and double-click it.
pause

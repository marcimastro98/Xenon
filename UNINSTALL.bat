@echo off
setlocal
title Xenon - Uninstall
cd /d "%~dp0"

rem A complete uninstall touches admin-only things (edge-swipe policy, the legacy
rem service, shared winget packages), so elevate first — mirroring INSTALL.bat.
net session >nul 2>nul
if errorlevel 1 (
  echo Requesting administrator privileges for a complete uninstall...
  if "%~1"=="" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
  ) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
  )
  rem If the UAC prompt was declined, don't just give up — run non-elevated here.
  rem uninstall.ps1 handles this gracefully and skips the admin-only steps.
  if errorlevel 1 (
    echo.
    echo Elevation was declined - continuing without administrator rights.
    echo Admin-only steps ^(edge-swipe policy, legacy service, shared packages^) will be skipped.
    goto :run
  )
  exit /b
)

:run
rem Leave the install folder before running: if this console kept it as the
rem current directory, the final self-delete could never remove the folder itself.
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\uninstall.ps1" %*
echo.
pause

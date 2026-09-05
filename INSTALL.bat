@echo off
setlocal EnableExtensions
title Xenon - One Click Install

rem ---------------------------------------------------------------------------
rem install.ps1 writes a log from the moment it starts, and everything it does
rem runs in a console of its own that closes the instant it ends. The checks
rem here guard the stretch BEFORE that: each one used to surface as a raw error
rem in a window that vanished, with no log written to ask the reporter for.
rem ---------------------------------------------------------------------------

rem Debloat scripts and locked-down images do remove Windows PowerShell, and
rem every real step below is a powershell.exe call: without this the user gets
rem "'powershell.exe' is not recognized" three times and no explanation.
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Windows PowerShell was not found on this PC.
  echo   Xenon installs itself through it, so setup cannot continue.
  echo   It ships with Windows and normally lives in
  echo     C:\Windows\System32\WindowsPowerShell\v1.0
  echo   If a debloat or cleanup tool removed it, restore it and run this again.
  echo.
  pause
  exit /b 1
)

rem CMD cannot hold a UNC path as its current directory. "cd /d" would print its
rem own complaint and then carry on from C:\Windows\System32, so the install
rem would run from the wrong place rather than stop.
set "XENON_HERE=%~dp0"
if "%XENON_HERE:~0,2%"=="\\" (
  echo.
  echo   Xenon cannot be installed straight from a network location:
  echo     %XENON_HERE%
  echo   Copy the Xenon folder onto this PC - the Desktop is fine - and run
  echo   INSTALL.bat from there.
  echo.
  pause
  exit /b 1
)
cd /d "%~dp0"

rem Double-clicking INSTALL.bat inside the downloaded .zip runs it from a
rem temporary folder holding that one file: the server folder never came along.
if not exist "%~dp0server\install.ps1" (
  echo.
  echo   The rest of Xenon is not next to this file.
  echo   If you opened INSTALL.bat straight from the .zip, Windows only
  echo   unpacked that one file. Right-click the .zip, choose "Extract All",
  echo   then run INSTALL.bat from the extracted folder.
  echo.
  pause
  exit /b 1
)

net session >nul 2>nul
if not errorlevel 1 goto :run

echo Requesting administrator privileges for hardware sensor setup...
rem The path travels as an environment variable rather than inline: a Windows
rem user name may contain an apostrophe (C:\Users\O'Brien\...), which closes the
rem PowerShell string early and turns this line into a parser error.
set "XENON_BAT=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:XENON_BAT -Verb RunAs -ErrorAction Stop } catch { exit 3 }"
if not "%ERRORLEVEL%"=="0" goto :noadmin
exit /b

:noadmin
echo.
echo   Xenon needs administrator rights once, to install the hardware sensor
echo   driver that reads CPU and GPU temperatures.
echo   The prompt was declined, or this account cannot grant it.
echo   Right-click INSTALL.bat and choose "Run as administrator", or ask
echo   whoever administers this PC to run it for you.
echo.
pause
exit /b 1

:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\install.ps1"
if errorlevel 1 (
  echo.
  echo Installation did not finish. Read the message above, then press any key to close.
  pause >nul
  exit /b 1
)

echo.
echo Done. You can close this window.
timeout /t 5 >nul

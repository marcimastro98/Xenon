@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed or not on PATH.
  echo Install it from https://nodejs.org/ ^(version 18.15 or newer^) and try again.
  echo.
  pause
  exit /b 1
)

:: Stop any existing widget server (process listening on port 3030)
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr " :3030 " ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
)
timeout /t 1 /nobreak >nul 2>nul

start "Xenon Edge Widget" /min node "%~dp0server.js"

$ErrorActionPreference = 'SilentlyContinue'

$appName = 'Xenon Edge Widget'
$root = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path (Join-Path $root 'server') 'server.js'

# Remove the backend Windows service (Phase 3/7), if it was registered. This
# stops + unregisters XenonEdgeService and leaves server/ and server/data/ intact.
$serviceUninstall = Join-Path (Join-Path $root 'service') 'uninstall-service.ps1'
if (Test-Path $serviceUninstall) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $serviceUninstall
}

# Remove Task Scheduler task (new installs)
$task = Get-ScheduledTask -TaskName $appName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $appName -Confirm:$false
  Write-Host "Removed startup task: $appName" -ForegroundColor Green
} else {
  Write-Host 'No startup task found.' -ForegroundColor Yellow
}

# Remove the optional "open dashboard in browser at logon" task, if present.
$browserTask = Get-ScheduledTask -TaskName 'Xenon Edge Dashboard' -ErrorAction SilentlyContinue
if ($browserTask) {
  Unregister-ScheduledTask -TaskName 'Xenon Edge Dashboard' -Confirm:$false
  Write-Host 'Removed browser auto-open task: Xenon Edge Dashboard' -ForegroundColor Green
}

# Remove old Startup folder shortcut (legacy installs)
$startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$shortcutPath = Join-Path $startup "$appName.lnk"
if (Test-Path $shortcutPath) {
  Remove-Item $shortcutPath -Force
  Write-Host "Removed legacy startup shortcut." -ForegroundColor Green
}

$resolvedServerPath = (Resolve-Path $serverPath).Path
$processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$resolvedServerPath*" }

foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Host "Stopped running widget server (PID $($process.ProcessId))." -ForegroundColor Green
}

# Remove the auto-installed PresentMon (used for in-game FPS)
$presentMonDir = Join-Path (Join-Path $root 'server') 'presentmon'
if (Test-Path $presentMonDir) {
  Remove-Item $presentMonDir -Recurse -Force
  Write-Host 'Removed PresentMon (in-game FPS helper).' -ForegroundColor Green
}

# Remove the auto-installed Xenon Helper (native media/game-mode companion).
# Its processes exit on their own right after the server above is stopped
# (stdin EOF) — give them a moment to release the exe.
$helperDir = Join-Path (Join-Path $root 'server') 'helper'
if (Test-Path $helperDir) {
  Start-Sleep -Seconds 2
  Remove-Item $helperDir -Recurse -Force
  if (-not (Test-Path $helperDir)) {
    Write-Host 'Removed the Xenon Helper (native companion).' -ForegroundColor Green
  } else {
    Write-Host 'The Xenon Helper folder could not be fully removed (a process may still be exiting). Delete server\helper manually if it remains.' -ForegroundColor Yellow
  }
}

# Give Windows its touchscreen edge-swipe gestures back (the native install
# reserved them for Xenon via the HKLM AllowEdgeSwipe policy). Needs elevation;
# if this run isn't elevated the removal silently fails, so check and say so.
$edgeKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI'
$edgeVal = (Get-ItemProperty -Path $edgeKey -Name 'AllowEdgeSwipe' -ErrorAction SilentlyContinue).AllowEdgeSwipe
if ($null -ne $edgeVal) {
  Remove-ItemProperty -Path $edgeKey -Name 'AllowEdgeSwipe' -ErrorAction SilentlyContinue
  $edgeVal = (Get-ItemProperty -Path $edgeKey -Name 'AllowEdgeSwipe' -ErrorAction SilentlyContinue).AllowEdgeSwipe
  if ($null -eq $edgeVal) {
    Write-Host 'Restored Windows touchscreen edge-swipe gestures (applies at next sign-in).' -ForegroundColor Green
  } else {
    Write-Host 'Could not restore Windows edge-swipe gestures - run UNINSTALL.bat as Administrator, or delete the AllowEdgeSwipe value under HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI.' -ForegroundColor Yellow
  }
}

Write-Host 'Uninstall complete. Your local notes/events files were not deleted.' -ForegroundColor Green

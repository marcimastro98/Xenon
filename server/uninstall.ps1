$ErrorActionPreference = 'SilentlyContinue'

$appName = 'Xenon Edge Widget'
$root = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path (Join-Path $root 'server') 'server.js'

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

Write-Host 'Uninstall complete. Your local notes/events files were not deleted.' -ForegroundColor Green

$ErrorActionPreference = 'Stop'

$appName = 'Xenon Edge Widget'
$hardwareMonitorPackageId = 'LibreHardwareMonitor.LibreHardwareMonitor'
$pawnIoPackageId = 'namazso.PawnIO'
$root = Split-Path -Parent $PSScriptRoot
$filesDir = Join-Path $root 'server'
$serverPath = Join-Path $filesDir 'server.js'
$runner = Join-Path $filesDir 'start-hidden.vbs'
$url = 'http://127.0.0.1:3030/'

function Write-Step($Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machinePath, $userPath, $env:Path) -join ';'
}

function Test-IsElevated {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { }
  return $false
}

function Get-NodePath {
  Refresh-Path
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $programFilesX86 = ${env:ProgramFiles(x86)}
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  if ($programFilesX86) { $candidates += Join-Path $programFilesX86 'nodejs\node.exe' }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
  $candidates = $candidates | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates.Count -gt 0) { return $candidates[0] }
  return $null
}

function Install-NodeIfNeeded {
  $nodePath = Get-NodePath
  if ($nodePath) {
    Write-Step "Node.js found: $nodePath"
    return $nodePath
  }

  Write-Step 'Node.js is missing. Installing Node.js LTS with Windows Package Manager...'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host ''
    Write-Host 'Windows Package Manager (winget) is not available on this PC.' -ForegroundColor Yellow
    Write-Host 'The Node.js download page will open now. Install the LTS version, then run INSTALL.bat again.' -ForegroundColor Yellow
    Start-Process 'https://nodejs.org/'
    throw 'Node.js installation requires winget or a manual Node.js install.'
  }

  $arguments = @(
    'install',
    '--id', 'OpenJS.NodeJS.LTS',
    '--exact',
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--silent'
  )

  $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "winget could not install Node.js (exit code $($process.ExitCode))."
  }

  $nodePath = Get-NodePath
  if (-not $nodePath) {
    throw 'Node.js was installed, but node.exe was not found yet. Restart Windows, then run INSTALL.bat again.'
  }

  Write-Step "Node.js installed: $nodePath"
  return $nodePath
}

function Get-FfmpegPath {
  Refresh-Path
  $command = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @()
  if ($env:ProgramFiles) { $candidates += Join-Path (Join-Path (Join-Path $env:ProgramFiles 'ffmpeg') 'bin') 'ffmpeg.exe' }
  if ($env:LOCALAPPDATA) {
    $localFfmpegBin = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'Microsoft') 'ffmpeg') 'bin'
    $candidates += Join-Path $localFfmpegBin 'ffmpeg.exe'
  }
  $candidates = $candidates | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates.Count -gt 0) { return $candidates[0] }

  $wingetPackages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $wingetPackages) {
    $wingetFfmpeg = Get-ChildItem -Path $wingetPackages -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wingetFfmpeg) { return $wingetFfmpeg.FullName }
  }

  return $null
}

function Get-CurrentTaskUserId {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity -and $identity.Name -and $identity.Name.Contains('\')) { return $identity.Name }
  } catch { }

  if ($env:USERDOMAIN -and $env:USERNAME) { return "$($env:USERDOMAIN)\$($env:USERNAME)" }
  return $env:USERNAME
}

function Install-FfmpegIfNeeded {
  $ffmpegPath = Get-FfmpegPath
  if ($ffmpegPath) {
    Write-Step "FFmpeg found: $ffmpegPath"
    return $ffmpegPath
  }

  Write-Step 'FFmpeg is missing. Installing FFmpeg for automatic MP4 to WebM conversion...'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host 'winget is not available. MP4 backgrounds will still upload, but automatic WebM conversion will be disabled.' -ForegroundColor Yellow
    return $null
  }

  foreach ($packageId in @('Gyan.FFmpeg.Essentials', 'Gyan.FFmpeg')) {
    $arguments = @(
      'install',
      '--id', $packageId,
      '--exact',
      '--source', 'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--silent'
    )
    $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -eq 0) {
      $ffmpegPath = Get-FfmpegPath
      if ($ffmpegPath) {
        Write-Step "FFmpeg installed: $ffmpegPath"
        return $ffmpegPath
      }
    }
  }

  Write-Host 'FFmpeg could not be installed automatically. MP4 backgrounds will upload, but automatic WebM conversion will be disabled.' -ForegroundColor Yellow
  return $null
}

function Get-LibreHardwareMonitorPath {
  Refresh-Path
  $candidates = @()

  $command = Get-Command LibreHardwareMonitor.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }

  if ($env:LOCALAPPDATA) {
    $wingetPackages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    try {
      $packageDirs = @(Get-ChildItem -Path $wingetPackages -Directory -Filter 'LibreHardwareMonitor*' -ErrorAction SilentlyContinue)
      foreach ($packageDir in $packageDirs) {
        $found = Get-ChildItem -Path $packageDir.FullName -Filter LibreHardwareMonitor.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $candidates += $found.FullName }
      }
    } catch { }
  }

  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\LibreHardwareMonitor\LibreHardwareMonitor.exe' }
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'LibreHardwareMonitor\LibreHardwareMonitor.exe' }
  $programFilesX86 = ${env:ProgramFiles(x86)}
  if ($programFilesX86) { $candidates += Join-Path $programFilesX86 'LibreHardwareMonitor\LibreHardwareMonitor.exe' }

  foreach ($candidate in $candidates | Where-Object { $_ -and (Test-Path $_) }) {
    $libraryPath = Join-Path (Split-Path -Parent $candidate) 'LibreHardwareMonitorLib.dll'
    if (Test-Path $libraryPath) { return $candidate }
  }

  return ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

function Install-LibreHardwareMonitorIfNeeded {
  $monitorPath = Get-LibreHardwareMonitorPath
  if ($monitorPath) {
    Write-Step "LibreHardwareMonitor found: $monitorPath"
    return $monitorPath
  }

  Write-Step 'LibreHardwareMonitor is missing. Installing it for automatic CPU temperature readings...'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host 'winget is not available. CPU temperature will stay hidden until LibreHardwareMonitor is installed manually.' -ForegroundColor Yellow
    Write-Host 'Download it from: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases' -ForegroundColor Yellow
    return $null
  }

  $arguments = @(
    'install',
    '--id', $hardwareMonitorPackageId,
    '--exact',
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--silent'
  )

  $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "LibreHardwareMonitor could not be installed automatically (exit code $($process.ExitCode)). CPU temperature will stay hidden until it is installed manually." -ForegroundColor Yellow
    return $null
  }

  $monitorPath = Get-LibreHardwareMonitorPath
  if ($monitorPath) {
    Write-Step "LibreHardwareMonitor installed: $monitorPath"
    return $monitorPath
  }

  Write-Host 'LibreHardwareMonitor was installed, but its executable was not found yet. Restart Windows if CPU temperature is still unavailable.' -ForegroundColor Yellow
  return $null
}

function Get-PawnIoDriver {
  try {
    return Get-CimInstance Win32_SystemDriver -Filter "Name = 'PawnIO'" -ErrorAction SilentlyContinue
  } catch { }
  return $null
}

function Install-PawnIoIfNeeded {
  $driver = Get-PawnIoDriver
  if ($driver) {
    Write-Step "PawnIO driver found: $($driver.State)"
    if ($driver.State -ne 'Running') {
      try { & (Join-Path $env:WINDIR 'System32\sc.exe') start pawnio | Out-Null } catch { }
    }
    return
  }

  Write-Step 'PawnIO driver is missing. Installing it for low-level CPU sensor access...'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host 'winget is not available. Some CPU temperature sensors may stay unavailable until PawnIO is installed manually.' -ForegroundColor Yellow
    return
  }

  $arguments = @(
    'install',
    '--id', $pawnIoPackageId,
    '--exact',
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--silent'
  )

  $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "PawnIO could not be installed automatically (exit code $($process.ExitCode)). Some CPU temperature sensors may stay unavailable." -ForegroundColor Yellow
    return
  }

  $driver = Get-PawnIoDriver
  if ($driver) {
    Write-Step "PawnIO installed: $($driver.State)"
  } else {
    Write-Host 'PawnIO was installed, but the driver is not visible yet. Restart Windows if CPU temperature is still unavailable.' -ForegroundColor Yellow
  }
}

function Register-StartupTask {
  Write-Step 'Registering startup task in Task Scheduler...'
  # Remove old Startup folder shortcut if left over from a previous install
  $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  $oldLnk = Join-Path $startup "$appName.lnk"
  if (Test-Path $oldLnk) { Remove-Item $oldLnk -Force }

  $taskUser = Get-CurrentTaskUserId
  $isElevated = Test-IsElevated
  $runLevel = if ($isElevated) { 'Highest' } else { 'Limited' }
  if (-not $isElevated) {
    Write-Host 'CPU temperature sensors on some systems require elevated access.' -ForegroundColor Yellow
    Write-Host 'For full automatic CPU temperature support, run INSTALL.bat once as Administrator.' -ForegroundColor Yellow
  }
  $action   = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument "`"$runner`"" -WorkingDirectory $filesDir
  $trigger  = New-ScheduledTaskTrigger -AtLogon -User $taskUser
  $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel $runLevel
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

  try {
    Register-ScheduledTask `
      -TaskName $appName `
      -Action $action `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Force | Out-Null
  } catch {
    Write-Host "PowerShell task registration failed: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host 'Retrying with schtasks.exe...' -ForegroundColor Yellow

    $schtasks = Join-Path $env:WINDIR 'System32\schtasks.exe'
    $taskRun = '"{0}" "{1}"' -f (Join-Path $env:WINDIR 'System32\wscript.exe'), $runner
    $schtasksRunLevel = if ($isElevated) { 'HIGHEST' } else { 'LIMITED' }
    & $schtasks /Create /TN $appName /TR $taskRun /SC ONLOGON /RL $schtasksRunLevel /F | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "schtasks.exe could not register the startup task (exit code $LASTEXITCODE)."
    }
  }
}

function Test-WidgetServer {
  try {
    $response = Invoke-WebRequest -Uri "$url/status" -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-WidgetServerProcesses {
  try {
    $resolvedServerPath = (Resolve-Path $serverPath).Path
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$resolvedServerPath*" })
  } catch { }
  return @()
}

function Stop-WidgetServer {
  $processes = @(Get-WidgetServerProcesses)
  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Step "Stopped existing widget server (PID $($process.ProcessId)) so elevated sensor access can take effect."
    } catch {
      Write-Host "Could not stop existing widget server (PID $($process.ProcessId)): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

function Start-WidgetServer {
  param([switch]$RestartExisting)

  if (Test-WidgetServer) {
    if ($RestartExisting) {
      Stop-WidgetServer
      for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 300
        if (-not (Test-WidgetServer)) { break }
      }
    } else {
      Write-Step 'Widget server is already running.'
      return
    }
  }

  Write-Step 'Starting the widget server in the background...'
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $runner + '"') -WorkingDirectory $filesDir

  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-WidgetServer) { return }
  }

  Write-Host 'The server may still be starting. If the browser page is blank, wait a few seconds and refresh.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Xenon Edge Widget - One Click Setup' -ForegroundColor Green
Write-Host 'This installer will install Node.js and hardware sensor support if needed, enable startup with Windows, start the widget, and open the dashboard.'
Write-Host ''

$installerElevated = Test-IsElevated
Install-NodeIfNeeded | Out-Null
Install-FfmpegIfNeeded | Out-Null
Install-LibreHardwareMonitorIfNeeded | Out-Null
Install-PawnIoIfNeeded | Out-Null
Register-StartupTask
Start-WidgetServer -RestartExisting:$installerElevated

Write-Step 'Opening the dashboard...'
Start-Process $url

Write-Host ''
Write-Host 'All set.' -ForegroundColor Green
Write-Host 'The widget is installed, running now, and will start automatically with Windows.'
if (-not $installerElevated) {
  Write-Host 'For automatic CPU temperature on hardware that requires admin sensor access, rerun INSTALL.bat once as Administrator.' -ForegroundColor Yellow
}
Write-Host 'Use this URL in Corsair iCUE / Xeneon Edge iframe widgets:'
Write-Host "  $url" -ForegroundColor White

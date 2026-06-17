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

  Write-Step 'FFmpeg is missing. Installing FFmpeg (required for AI voice, audio capture, and MP4 background conversion)...'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host 'winget is not available. FFmpeg is required for AI voice features (wake word, TTS) and MP4 backgrounds.' -ForegroundColor Yellow
    Write-Host 'Download it from https://www.gyan.dev/ffmpeg/builds/ and add ffmpeg.exe to your PATH, then run INSTALL.bat again.' -ForegroundColor Yellow
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

  Write-Host 'FFmpeg could not be installed automatically. AI voice and MP4 conversion will be unavailable.' -ForegroundColor Yellow
  Write-Host 'Download it from https://www.gyan.dev/ffmpeg/builds/ and add ffmpeg.exe to PATH, then run INSTALL.bat again.' -ForegroundColor Yellow
  return $null
}

function Install-NpmDependenciesIfNeeded {
  # The widget needs all three runtime dependencies: ws (the server's WebSocket relay,
  # required to even start), koffi (RGB bridge) and msedge-tts (local AI voice). Only
  # skip the install when every one is present — a partial node_modules must not pass,
  # or the server crashes on require('ws').
  $deps = @('ws', 'koffi', 'msedge-tts')
  $missing = @($deps | Where-Object { -not (Test-Path (Join-Path $root "node_modules\$_")) })
  if ($missing.Count -eq 0) {
    Write-Step 'Node.js dependencies already installed.'
    return
  }

  Write-Step 'Installing Node.js dependencies (ws, koffi, msedge-tts)...'
  Refresh-Path

  # Run npm by invoking node.exe directly on npm-cli.js. Do NOT resolve npm via
  # Get-Command: PowerShell returns npm.ps1 ahead of npm.cmd, and handing a .ps1 path to
  # cmd.exe makes Windows "open" it with its file association (Notepad) instead of running
  # it — npm never executes, returns exit code 0, node_modules stays empty, and the server
  # then crashes on require('ws'). node.exe is a real executable, so Start-Process
  # -NoNewWindow launches it reliably regardless of PATHEXT ordering.
  $nodePath = Get-NodePath
  if (-not $nodePath) {
    Write-Host 'Node.js not found. Run "npm install" in the project folder, then start the widget.' -ForegroundColor Yellow
    return
  }
  $nodeDir = Split-Path -Parent $nodePath
  $npmCli = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'

  if (Test-Path $npmCli) {
    $process = Start-Process -FilePath $nodePath `
      -ArgumentList "`"$npmCli`"", 'install' `
      -WorkingDirectory $root `
      -Wait -PassThru -NoNewWindow
  } else {
    # Fallback: invoke npm.cmd explicitly (never npm.ps1) through cmd.exe.
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path $npmCmd)) {
      Write-Host 'npm not found next to Node.js. Run "npm install" in the project folder.' -ForegroundColor Yellow
      return
    }
    $process = Start-Process -FilePath $env:ComSpec `
      -ArgumentList '/c', "`"$npmCmd`"", 'install' `
      -WorkingDirectory $root `
      -Wait -PassThru -NoNewWindow
  }

  if ($process.ExitCode -ne 0) {
    Write-Host "npm install failed (exit code $($process.ExitCode)). Run 'npm install' in the project folder manually." -ForegroundColor Yellow
    return
  }

  # A zero exit code alone is not proof of success — the old npm.ps1/Notepad failure
  # returned 0 while installing nothing. Verify the modules actually landed.
  $stillMissing = @($deps | Where-Object { -not (Test-Path (Join-Path $root "node_modules\$_")) })
  if ($stillMissing.Count -gt 0) {
    Write-Host "Dependencies still missing after npm install: $($stillMissing -join ', '). Run 'npm install' in the project folder manually." -ForegroundColor Yellow
    return
  }

  Write-Step 'Node.js dependencies installed.'
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

function Install-PresentMonIfNeeded {
  $dir = Join-Path $filesDir 'presentmon'
  $exe = Join-Path $dir 'PresentMon.exe'
  if (Test-Path $exe) { Write-Step "PresentMon found: $exe"; return }

  Write-Step 'Installing PresentMon for real in-game FPS (including exclusive fullscreen)...'
  try {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = 'XenonEdgeHub'; 'Accept' = 'application/vnd.github+json' }
    # Pin the last classic 1.x release: its single-binary CLI (-output_stdout)
    # is what server/fpsmon.js parses. (2.x uses a different service-based CLI.)
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/GameTechDev/PresentMon/releases/tags/v1.10.0' -Headers $headers -TimeoutSec 25
    $asset = $rel.assets | Where-Object { $_.name -match 'PresentMon.*x64.*\.exe$' } | Select-Object -First 1
    if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -match '\.exe$' } | Select-Object -First 1 }
    if (-not $asset) { throw 'no PresentMon x64 executable in the release assets' }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -Headers @{ 'User-Agent' = 'XenonEdgeHub' } -TimeoutSec 120 -UseBasicParsing
    if (Test-Path $exe) { Write-Step "PresentMon installed: $exe" }
    else { throw 'download did not produce PresentMon.exe' }
  } catch {
    Write-Host "PresentMon could not be installed automatically ($($_.Exception.Message)). In-game FPS will fall back to the windowed-only method until PresentMon.exe is placed in server\presentmon\." -ForegroundColor Yellow
  }
}

function Install-XenonHelperIfNeeded {
  $dir = Join-Path $filesDir 'helper'
  $exe = Join-Path $dir 'xenon-helper.exe'

  # Clean up renamed leftovers from previous updates (kept while the old server
  # still had the image mapped; deletable once it has restarted).
  try { Get-ChildItem -Path $dir -Filter 'xenon-helper.old*' -ErrorAction Stop | Remove-Item -Force -ErrorAction SilentlyContinue } catch { }

  # Minimum helper version this Xenon version expects. Bump together with
  # helper/XenonHelper.csproj <Version> when the stdio protocols change, so
  # re-running INSTALL.bat after an update refreshes an outdated exe.
  $minVersion = [Version]'0.3.2'
  if (Test-Path $exe) {
    $current = $null
    try { $current = [Version](Get-Item $exe).VersionInfo.FileVersion } catch { }
    if ($current -and $current -ge $minVersion) { Write-Step "Xenon Helper found: $exe (v$current)"; return }
    Write-Step "Xenon Helper is outdated (v$current, expected v$minVersion+) - refreshing..."
  } else {
    Write-Step 'Installing the Xenon Helper (native media/game-mode companion)...'
  }

  try {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ 'User-Agent' = 'XenonEdgeHub'; 'Accept' = 'application/vnd.github+json' }
    # The exe is built and attached to each release by CI (.github/workflows/helper.yml).
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/marcimastro98/Xenon/releases/latest' -Headers $headers -TimeoutSec 25
    $asset = $rel.assets | Where-Object { $_.name -eq 'xenon-helper.exe' } | Select-Object -First 1
    if (-not $asset) { throw 'the latest release has no xenon-helper.exe asset' }

    $download = "$exe.download"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $download -Headers @{ 'User-Agent' = 'XenonEdgeHub' } -TimeoutSec 180 -UseBasicParsing
    if (-not (Test-Path $download)) { throw 'download did not produce a file' }

    if (Test-Path $exe) {
      try {
        Remove-Item $exe -Force -ErrorAction Stop
      } catch {
        # The running server still has the old exe mapped: deleting is blocked,
        # but renaming a running image is allowed. The restart below picks up
        # the fresh exe; the .old leftover is cleaned on the next install run.
        Move-Item $exe ("$exe.old-" + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
      }
    }
    Move-Item $download $exe -Force
    Write-Step "Xenon Helper installed: $exe"
  } catch {
    Write-Host "The Xenon Helper could not be installed automatically ($($_.Exception.Message)). Xenon works fine without it - media and game detection simply use the classic PowerShell path until server\helper\xenon-helper.exe appears." -ForegroundColor Yellow
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
Write-Host 'This installer will install Node.js, required dependencies, FFmpeg, and hardware sensor support if needed, enable startup with Windows, start the widget, and open the dashboard.'
Write-Host ''

$installerElevated = Test-IsElevated
Install-NodeIfNeeded | Out-Null
Install-NpmDependenciesIfNeeded
Install-FfmpegIfNeeded | Out-Null
Install-LibreHardwareMonitorIfNeeded | Out-Null
Install-PawnIoIfNeeded | Out-Null
Install-PresentMonIfNeeded
Install-XenonHelperIfNeeded
# The free local AI provider (Ollama + Whisper.cpp) is OPT-IN: it is NOT set up
# here so the installer stays fast for everyone. When the user actually switches
# Xenon AI to the local provider, the dashboard (Settings -> Xenon AI) downloads
# Whisper on demand and links to the Ollama installer.
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

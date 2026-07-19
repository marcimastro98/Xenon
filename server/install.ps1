# -Mode native|icue skips the interactive surface prompt (used by the native
# setup.exe bootstrap, where env vars don't survive the -Verb RunAs elevation).
param([ValidateSet('native', 'icue', '')][string]$Mode = '')

$ErrorActionPreference = 'Stop'

$appName = 'Xenon Edge Widget'
# Required npm runtime deps — the server won't even boot without them. Single
# source of truth for the install step AND the final component check.
$requiredNodeDeps = @('ws', 'koffi', 'msedge-tts')
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

# Read the version we are installing straight from package.json so the banner
# never drifts from the real release. Falls back gracefully if the file moved.
function Get-AppVersion {
  try {
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($pkg.version) { return [string]$pkg.version }
  } catch { }
  return 'unknown'
}

# Compose the "XENON" wordmark from fixed-width (7x6) ASCII glyphs. Building it
# programmatically — rather than as one hand-typed here-string — guarantees the
# columns line up perfectly: every glyph row is exactly 7 chars, joined by a
# single space, so all five letters stay in register. Plain ASCII only (no
# box-drawing) so it renders identically under Windows PowerShell 5.1 regardless
# of the console code page. Single-quoted strings keep the backtick in the "N"
# literal.
function Get-BannerLines {
  $glyphs = @{
    'X' = @('__   __', '\ \ / /', ' \ V / ', '  > <  ', ' / . \ ', '/_/ \_\')
    'E' = @(' _____ ', '| ____|', '| |__  ', '|  __| ', '| |___ ', '|_____|')
    'N' = @(' _   _ ', '| \ | |', '|  \| |', '| . ` |', '| |\  |', '|_| \_|')
    'O' = @(' _____ ', '|  _  |', '| | | |', '| | | |', '| |_| |', '|_____|')
  }
  $order = @('X', 'E', 'N', 'O', 'N')
  $lines = @()
  for ($r = 0; $r -lt 6; $r++) {
    $lines += (($order | ForEach-Object { $glyphs[$_][$r] }) -join ' ')
  }
  return $lines
}

# Animated "power-on" reveal: the wordmark is scanned in left-to-right with a
# bright leading edge (feels like it's being drawn by a beam), then pulses white
# once and settles to cyan. Uses absolute cursor positioning so all six rows
# animate together. Falls back to a plain static print when the console can't be
# positioned (output redirected / unattended install) so nothing ever hangs or
# prints garbage into a log. Indent keeps the art off the left edge.
function Write-BannerReveal {
  param([string[]]$Lines, [int]$Indent = 3)

  $pad = ' ' * $Indent
  $maxLen = ($Lines | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum

  $canAnimate = $false
  try { $canAnimate = ([Environment]::UserInteractive -and -not [Console]::IsOutputRedirected) } catch { $canAnimate = $false }

  if (-not $canAnimate) {
    foreach ($line in $Lines) { Write-Host ($pad + $line) -ForegroundColor Cyan }
    return
  }

  try {
    # Reserve the six rows, then anchor to the top one (absolute buffer coords).
    foreach ($line in $Lines) { Write-Host '' }
    $top = [Console]::CursorTop - $Lines.Count

    for ($w = 1; $w -le $maxLen; $w++) {
      for ($r = 0; $r -lt $Lines.Count; $r++) {
        $line = $Lines[$r]
        if ($w -gt $line.Length) { continue }
        [Console]::SetCursorPosition(0, $top + $r)
        Write-Host ($pad + $line.Substring(0, $w - 1)) -NoNewline -ForegroundColor Cyan
        Write-Host $line.Substring($w - 1, 1) -NoNewline -ForegroundColor White
      }
      Start-Sleep -Milliseconds 12
    }

    # Settle: one quick white pulse, then cyan.
    foreach ($color in @('White', 'Cyan')) {
      for ($r = 0; $r -lt $Lines.Count; $r++) {
        [Console]::SetCursorPosition(0, $top + $r)
        Write-Host ($pad + $Lines[$r]) -NoNewline -ForegroundColor $color
      }
      Start-Sleep -Milliseconds 60
    }
    [Console]::SetCursorPosition(0, $top + $Lines.Count)
  } catch {
    # Any positioning failure mid-way: drop to a clean static render.
    Write-Host ''
    foreach ($line in $Lines) { Write-Host ($pad + $line) -ForegroundColor Cyan }
  }
}

# Type a short line out character-by-character for a subtle "terminal" feel.
# Static print when non-interactive.
function Write-Typed {
  param([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::DarkCyan, [int]$DelayMs = 12)
  $canAnimate = $false
  try { $canAnimate = ([Environment]::UserInteractive -and -not [Console]::IsOutputRedirected) } catch { $canAnimate = $false }
  if (-not $canAnimate) { Write-Host $Text -ForegroundColor $Color; return }
  foreach ($ch in $Text.ToCharArray()) {
    Write-Host $ch -NoNewline -ForegroundColor $Color
    Start-Sleep -Milliseconds $DelayMs
  }
  Write-Host ''
}

# Can we redraw a single line in place? Same guard the banner uses: false when
# output is redirected or the session isn't interactive (unattended/logged
# installs), so those paths keep the plain blocking calls and never emit control
# characters or animate into a log file.
function Test-CanAnimate {
  try { return ([Environment]::UserInteractive -and -not [Console]::IsOutputRedirected) } catch { return $false }
}

# Animate an indeterminate spinner + elapsed seconds on one line while $While
# keeps returning $true, then wipe the line. Purely cosmetic reassurance for the
# long, SILENT steps (winget --silent, downloads, the /S native installer) that
# otherwise look frozen for a minute with zero output. Plain ASCII frames so it
# renders under any console code page; never touches the work it waits on. The
# caller must have already started that work asynchronously (a process, a job)
# so $While can observe it finishing.
function Show-Spinner {
  param([string]$Activity, [scriptblock]$While)
  if (-not (Test-CanAnimate)) { return }
  $frames = @('|', '/', '-', '\')
  $i = 0
  $start = Get-Date
  try {
    while (& $While) {
      $elapsed = [int]((Get-Date) - $start).TotalSeconds
      Write-Host ("`r  {0} {1}... ({2}s) " -f $frames[$i % $frames.Count], $Activity, $elapsed) -NoNewline -ForegroundColor DarkCyan
      $i++
      Start-Sleep -Milliseconds 120
    }
  } catch { }
  # Clear the spinner line so the next Write-Step prints cleanly over it.
  try {
    $width = [Console]::WindowWidth
    if ($width -lt 1) { $width = 80 }
    Write-Host ("`r" + (' ' * ($width - 1)) + "`r") -NoNewline
  } catch { Write-Host '' }
}

# Run a process to completion with a spinner instead of a dead console. Mirrors
# Start-Process -Wait -PassThru (returns the exit code); when the console can't
# animate it IS exactly that. Used for winget --silent and the /S native
# installer, whose windows produce no output in this console.
function Invoke-ProcessWithSpinner {
  param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$Activity = 'Working')
  $params = @{ FilePath = $FilePath; PassThru = $true }
  if ($ArgumentList -and $ArgumentList.Count -gt 0) { $params.ArgumentList = $ArgumentList }
  if ($WorkingDirectory) { $params.WorkingDirectory = $WorkingDirectory }
  if (-not (Test-CanAnimate)) {
    $params.Wait = $true
    return (Start-Process @params).ExitCode
  }
  $proc = Start-Process @params
  Show-Spinner -Activity $Activity -While { -not $proc.HasExited }
  try { $proc.WaitForExit() } catch { }
  return $proc.ExitCode
}

# Download a file with a spinner. The work runs in a background job so the
# foreground can animate; on completion any download error is rethrown exactly
# as a direct Invoke-WebRequest would throw it, so every caller's existing
# try/catch + retry logic is unchanged. Falls back to a plain blocking
# Invoke-WebRequest when the console can't animate.
function Invoke-DownloadWithSpinner {
  param([string]$Uri, [string]$OutFile, [hashtable]$Headers, [int]$TimeoutSec = 120, [string]$Activity = 'Downloading')
  if (-not (Test-CanAnimate)) {
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -Headers $Headers -TimeoutSec $TimeoutSec -UseBasicParsing
    return
  }
  $job = Start-Job -ScriptBlock {
    param($u, $o, $h, $t)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $u -OutFile $o -Headers $h -TimeoutSec $t -UseBasicParsing
  } -ArgumentList $Uri, $OutFile, $Headers, $TimeoutSec
  try {
    # 'NotStarted' too: Start-Job's transition to Running is asynchronous, and a
    # spinner that exits during that window would let the finally's forced
    # Remove-Job kill the in-flight download. -Wait on Receive-Job is the
    # backstop for the same reason (it also covers a spinner that threw).
    Show-Spinner -Activity $Activity -While { $job.State -eq 'NotStarted' -or $job.State -eq 'Running' }
    Receive-Job -Job $job -Wait -ErrorAction Stop | Out-Null
  } finally {
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

# Cosmetic-only intro: the animated "XENON" wordmark, the version being installed,
# and a short summary of what the installer sets up. Pure console output — it
# changes nothing about the install and is fully suppressed to a static render
# for unattended installs (XENON_INSTALL_MODE set) so logs stay clean.
function Show-Banner {
  param([string]$Version)

  Write-Host ''
  Write-BannerReveal -Lines (Get-BannerLines)
  Write-Host ''
  Write-Typed '        S M A R T   P C   D A S H B O A R D'
  Write-Host ''
  Write-Host '   ---------------------------------------------------' -ForegroundColor DarkGray
  Write-Host '    Version   ' -NoNewline -ForegroundColor Gray;      Write-Host "v$Version" -ForegroundColor White
  Write-Host '    Display   ' -NoNewline -ForegroundColor Gray;      Write-Host 'CORSAIR Xeneon Edge 14.5" LCD' -ForegroundColor White
  Write-Host '    Dashboard ' -NoNewline -ForegroundColor Gray;      Write-Host $url -ForegroundColor White
  Write-Host '    Project   ' -NoNewline -ForegroundColor Gray;      Write-Host 'https://github.com/marcimastro98/Xenon' -ForegroundColor White
  Write-Host '   ---------------------------------------------------' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '   This one-click setup will, only if needed:' -ForegroundColor Gray
  Write-Host '     - install Node.js, FFmpeg and hardware-sensor support' -ForegroundColor DarkGray
  Write-Host '     - set up the native Xenon Helper and PresentMon (FPS)' -ForegroundColor DarkGray
  Write-Host '     - start Xenon now and launch it automatically at login' -ForegroundColor DarkGray
  Write-Host ''
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

# Silent winget install with automatic retries. winget failures are very often
# transient (source sync, network hiccup) — and a component that failed on the
# first pass used to just scroll away as a yellow line, leaving the user to
# notice and re-run INSTALL.bat by hand (issue #87). Returns $true on success;
# $false when winget is missing or every attempt failed.
function Invoke-WingetInstall {
  param([string]$PackageId, [int]$Attempts = 2)
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { return $false }
  $arguments = @(
    'install',
    '--id', $PackageId,
    '--exact',
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--silent'
  )
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "  Retrying $PackageId (attempt $attempt of $Attempts)..." -ForegroundColor Yellow
      Start-Sleep -Seconds 5
    }
    $exitCode = Invoke-ProcessWithSpinner -FilePath $winget.Source -ArgumentList $arguments -Activity "Installing $PackageId"
    if ($exitCode -eq 0) { return $true }
    Write-Host "  winget exited with code $exitCode for $PackageId." -ForegroundColor Yellow
  }
  return $false
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

  if (-not (Invoke-WingetInstall -PackageId 'OpenJS.NodeJS.LTS')) {
    throw 'winget could not install Node.js.'
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
    if (Invoke-WingetInstall -PackageId $packageId) {
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
  $deps = $requiredNodeDeps
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
  $npmCmd = Join-Path $nodeDir 'npm.cmd'
  if (-not (Test-Path $npmCli) -and -not (Test-Path $npmCmd)) {
    Write-Host 'npm not found next to Node.js. Run "npm install" in the project folder.' -ForegroundColor Yellow
    return
  }

  # Registry/network hiccups make npm fail transiently, and a single failed pass
  # used to just tell the user to do it by hand (issue #87) — retry it instead.
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "  Retrying npm install (attempt $attempt of $maxAttempts)..." -ForegroundColor Yellow
      Start-Sleep -Seconds 5
    }

    if (Test-Path $npmCli) {
      $process = Start-Process -FilePath $nodePath `
        -ArgumentList "`"$npmCli`"", 'install' `
        -WorkingDirectory $root `
        -Wait -PassThru -NoNewWindow
    } else {
      # Fallback: invoke npm.cmd explicitly (never npm.ps1) through cmd.exe.
      $process = Start-Process -FilePath $env:ComSpec `
        -ArgumentList '/c', "`"$npmCmd`"", 'install' `
        -WorkingDirectory $root `
        -Wait -PassThru -NoNewWindow
    }

    if ($process.ExitCode -ne 0) {
      Write-Host "  npm install failed (exit code $($process.ExitCode))." -ForegroundColor Yellow
      continue
    }

    # A zero exit code alone is not proof of success — the old npm.ps1/Notepad failure
    # returned 0 while installing nothing. Verify the modules actually landed.
    $stillMissing = @($deps | Where-Object { -not (Test-Path (Join-Path $root "node_modules\$_")) })
    if ($stillMissing.Count -eq 0) {
      Write-Step 'Node.js dependencies installed.'
      return
    }
    Write-Host "  Dependencies still missing after npm install: $($stillMissing -join ', ')." -ForegroundColor Yellow
  }

  Write-Host "Node.js dependencies could not be installed after $maxAttempts attempts. Run 'npm install' in the project folder manually, then run INSTALL.bat again." -ForegroundColor Red
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

  if (-not (Invoke-WingetInstall -PackageId $hardwareMonitorPackageId)) {
    Write-Host 'LibreHardwareMonitor could not be installed automatically. CPU temperature will stay hidden until it is installed manually.' -ForegroundColor Yellow
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

  if (-not (Invoke-WingetInstall -PackageId $pawnIoPackageId)) {
    Write-Host 'PawnIO could not be installed automatically. Some CPU temperature sensors may stay unavailable.' -ForegroundColor Yellow
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
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "  Retrying the PresentMon download (attempt $attempt of $maxAttempts)..." -ForegroundColor Yellow
      Start-Sleep -Seconds 5
    }
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
      Invoke-DownloadWithSpinner -Uri $asset.browser_download_url -OutFile $exe -Headers @{ 'User-Agent' = 'XenonEdgeHub' } -TimeoutSec 120 -Activity 'Downloading PresentMon'
      if (Test-Path $exe) { Write-Step "PresentMon installed: $exe"; return }
      throw 'download did not produce PresentMon.exe'
    } catch {
      if ($attempt -eq $maxAttempts) {
        Write-Host "PresentMon could not be installed automatically ($($_.Exception.Message)). In-game FPS will fall back to the windowed-only method until PresentMon.exe is placed in server\presentmon\." -ForegroundColor Yellow
      }
    }
  }
}

function Install-ICueSdkIfNeeded {
  # The iCUE SDK client DLL is what server/lighting.js talks to for CORSAIR RGB.
  # iCUE 5.48 no longer installs it anywhere, so without this step the only
  # machines with working RGB are the ones where some unrelated software happens
  # to ship a copy.
  #
  # It is DOWNLOADED from Corsair's own official release, never shipped with
  # Xenon: the SDK EULA (in the zip's PDF) grants a "nonexclusive, nontransferable
  # royalty-free license to allow You to use the Software" and forbids transferring
  # "all or any portion of the Software ... to any other person". Bundling it, or
  # mirroring it as one of our release assets, would be that transfer. Fetching it
  # from Corsair on the user's own machine is not.
  #
  # Version and hash are pinned: an asset that changes underneath us must fail
  # loudly rather than install something we never verified.
  $sdkVersion = '4.0.84'
  $sdkZipSha  = 'EB4414CF505145F3E507DC839AD587BF7CA684D64BE3D9A834F416A136736D5D'
  $dir = Join-Path $filesDir 'icue-sdk'
  $dll = Join-Path $dir 'iCUESDK.x64_2019.dll'
  if (Test-Path $dll) { Write-Step "iCUE SDK found: $dll"; return }

  Write-Step 'Installing the CORSAIR iCUE SDK component for RGB lighting...'
  $zip = Join-Path $env:TEMP "iCUESDK_$sdkVersion.zip"
  $stage = Join-Path $env:TEMP "iCUESDK_$sdkVersion"
  try {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $uri = "https://github.com/CorsairOfficial/cue-sdk/releases/download/v$sdkVersion/iCUESDK_$sdkVersion.zip"
    Invoke-DownloadWithSpinner -Uri $uri -OutFile $zip -Headers @{ 'User-Agent' = 'XenonEdgeHub' } -TimeoutSec 120 -Activity 'Downloading the iCUE SDK component'

    $hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
    if ($hash -ne $sdkZipSha) { throw "checksum mismatch (expected $sdkZipSha, got $hash)" }

    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
    Expand-Archive -Path $zip -DestinationPath $stage -Force
    $src = Join-Path $stage 'iCUESDK\redist\x64\iCUESDK.x64_2019.dll'
    if (-not (Test-Path $src)) { throw 'the archive did not contain redist\x64\iCUESDK.x64_2019.dll' }
    Copy-Item -Path $src -Destination $dll -Force
    Write-Step "iCUE SDK installed: $dll"
  } catch {
    Write-Host "The iCUE SDK component could not be installed automatically ($($_.Exception.Message)). CORSAIR RGB control will be unavailable until it is; everything else works normally." -ForegroundColor Yellow
  } finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-XenonHelperIfNeeded {
  # The helper download + required-version gate live in helper-update.ps1, the
  # single source of truth shared with the in-app self-update (server.js runs the
  # same script at boot to refresh an outdated exe). Invoke it as a CHILD process
  # (never dot-source it) so its exit code can't abort the installer.
  $script = Join-Path $filesDir 'helper-update.ps1'
  if (-not (Test-Path $script)) {
    Write-Host 'helper-update.ps1 not found; skipping the Xenon Helper (the PowerShell fallback path is used).' -ForegroundColor Yellow
    return
  }
  Write-Step 'Setting up the Xenon Helper (native media/game-mode companion)...'
  $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  try {
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $script -InstallIfMissing -HelperDir (Join-Path $filesDir 'helper')
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

  # A just-stopped instance (e.g. the old service's node during a reinstall)
  # can keep port 3030 bound for a few seconds after it stops answering HTTP;
  # a fresh node started in that window dies on EADDRINUSE and the user ends
  # up with no backend at all. Wait for the listener to actually vanish.
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }

  Write-Step 'Starting the widget server in the background...'
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $runner + '"') -WorkingDirectory $filesDir

  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-WidgetServer) { return }
  }

  Write-Host 'The server may still be starting. If the browser page is blank, wait a few seconds and refresh.' -ForegroundColor Yellow
}

# The backend must run in the USER'S interactive session — never as a session-0
# Windows service. An early v4 beta registered it as a WinSW service; Windows
# isolates services from the interactive desktop, which silently broke every
# desktop integration: Deck open app/site/file, SMTC media detection, hotkeys,
# window actions, screen capture and TTS audio. This removes that service from
# machines that still have it, so the per-logon task can own startup again.
function Remove-BackendServiceIfPresent {
  if (-not (Get-Service -Name 'XenonEdgeService' -ErrorAction SilentlyContinue)) { return $true }
  if (-not (Test-IsElevated)) {
    Write-Host 'An earlier beta registered the Xenon backend as a Windows service, which breaks app launching and media detection.' -ForegroundColor Yellow
    Write-Host 'Run INSTALL.bat once as Administrator so it can be removed.' -ForegroundColor Yellow
    return $false
  }
  try {
    Write-Step 'Removing the old backend Windows service (the backend now runs in your session)...'
    $script = Join-Path (Split-Path -Parent $PSScriptRoot) 'service\uninstall-service.ps1'
    if (Test-Path $script) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
      if ($LASTEXITCODE -ne 0) { throw "service uninstaller exited with code $LASTEXITCODE" }
    } else {
      & sc.exe stop 'XenonEdgeService' 2>$null | Out-Null
      & sc.exe delete 'XenonEdgeService' 2>$null | Out-Null
    }
    # The SCM keeps the registration alive ("delete pending") until the service
    # process fully exits — and the node backend shuts down gracefully over a few
    # seconds. Wait it out so the fresh backend doesn't race the dying one for
    # port 3030 (Start-WidgetServer additionally waits for the listener to clear).
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Service -Name 'XenonEdgeService' -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
      Start-Sleep -Milliseconds 500
    }
    return $true
  } catch {
    Write-Host "Could not remove the backend service: $($_.Exception.Message)" -ForegroundColor Yellow
    return $false
  }
}

# Windows 11 claims touch swipes that start at the screen edge for its own
# gestures (taskbar reveal, Start, notification centre), so the native app's
# "swipe up to the desktop" gesture loses the race on the touchscreen. The only
# switch Windows honours is the MACHINE policy AllowEdgeSwipe=0 under HKLM (the
# HKCU twin is silently ignored), which needs elevation, and the shell only
# re-reads it when Explorer restarts or the user signs in — so this applies it
# and restarts Explorer once. Native installs only; UNINSTALL.bat removes it.
# Mouse/keyboard and the taskbar itself are unaffected — only the touch
# edge-swipe gesture is reserved for Xenon.
function Disable-WindowsEdgeSwipe {
  $key = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI'
  # Clean up the value older builds wrote under HKCU — Windows ignores it there.
  try { Remove-ItemProperty -Path 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI' -Name 'AllowEdgeSwipe' -ErrorAction Stop } catch { }
  try {
    $current = (Get-ItemProperty -Path $key -Name 'AllowEdgeSwipe' -ErrorAction SilentlyContinue).AllowEdgeSwipe
    if ($current -eq 0) { return } # already applied — never restart Explorer on a re-run
    if (-not (Test-IsElevated)) {
      Write-Host 'Note: Windows may intercept the touchscreen swipe-up gesture (it opens Start/taskbar instead of Xenon).' -ForegroundColor Yellow
      Write-Host 'Rerun INSTALL.bat once as Administrator to reserve the edge swipe for Xenon.' -ForegroundColor Yellow
      return
    }
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name 'AllowEdgeSwipe' -PropertyType DWord -Value 0 -Force | Out-Null
    Write-Step 'Reserved the touchscreen bottom-edge swipe for Xenon (Windows edge gestures off).'
    # Explorer only reads this policy at startup/sign-in; restart it so the
    # gesture works right away instead of after the next sign-out.
    try {
      Stop-Process -Name explorer -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 1200
      if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process 'explorer.exe' }
      Write-Step 'Restarted Windows Explorer to apply the gesture change immediately.'
    } catch {
      Write-Host 'Sign out and back in once to finish applying the gesture change.' -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Could not adjust the Windows edge-swipe policy: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# Install the native kiosk app (Tauri/NSIS) from its bundled installer if one
# shipped with this release (built by `npm run native:build`). It ensures the
# WebView2 runtime and sets its own login autostart. Entirely optional: the
# browser and iCUE iframe surfaces work from the service without it.
function Install-NativeAppIfPresent {
  # An exe already on disk does NOT short-circuit outright: re-running the
  # installer over an old or broken shell must keep repairing/upgrading it
  # (README promises exactly that). The version-aware skip lives in the
  # download branch below, once the latest release version is known — the
  # bootstrap-launched case (fresh shell just installed by the setup) lands
  # there as "already current" and skips the pointless re-download. Recursion
  # is broken by /NOBOOTSTRAP on every silent install plus the scheduled-task
  # marker the setup's post-install hook checks.
  $installedExe = Get-NativeAppExe
  $root = Split-Path -Parent $PSScriptRoot
  $dirs = @(
    (Join-Path $root 'installers'),
    (Join-Path $root 'apps\native\src-tauri\target\release\bundle\nsis')
  )
  # 1) A locally-built bundle — only present on a dev machine that ran
  # `npm run native:build`. A downloaded release source zip has neither dir.
  foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) { continue }
    $exe = Get-ChildItem -Path $dir -Filter '*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) {
      try {
        Write-Step "Installing the native Xenon app ($($exe.Name))..."
        Invoke-ProcessWithSpinner -FilePath $exe.FullName -ArgumentList '/S', '/NOBOOTSTRAP' -Activity 'Installing the native app' | Out-Null
        return $true
      } catch {
        Write-Host "Native app install failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
      }
    }
  }
  # 2) The normal case: no local bundle. Download the signed *-setup.exe from the
  # latest GitHub release — the SAME asset the dashboard's install button uses
  # (install-native.ps1). Without this, a normal user who picked "Native app"
  # got no app and the installer fell back to opening the browser.
  $maxAttempts = 2
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "  Retrying the native app download (attempt $attempt of $maxAttempts)..." -ForegroundColor Yellow
      Start-Sleep -Seconds 5
    }
    try {
      Write-Step 'Downloading the native Xenon app installer...'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $headers = @{ 'User-Agent' = 'XenonEdgeHub'; 'Accept' = 'application/vnd.github+json' }
      $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/marcimastro98/Xenon/releases/latest' -Headers $headers -TimeoutSec 25
      $asset = $release.assets | Where-Object { $_.name -like '*-setup.exe' } | Select-Object -First 1
      if (-not $asset) {
        Write-Host 'The native app installer is not attached to the latest release yet — you can install it later from the dashboard: Settings -> General.' -ForegroundColor Gray
        return $false
      }
      # Version-aware skip: an installed shell that already matches the latest
      # release needs no re-download (the setup.exe bootstrap path always lands
      # here — the shell it just installed IS the latest). An unreadable version
      # falls through to a reinstall, which doubles as the repair path.
      if ($installedExe) {
        $installedVer = ''
        try { $installedVer = ('' + (Get-Item $installedExe).VersionInfo.ProductVersion).Trim() -replace '^[vV]', '' } catch { }
        $latestVer = ('' + $release.tag_name).Trim() -replace '^[vV]', ''
        if ($installedVer -and $latestVer -and $installedVer -eq $latestVer) {
          Write-Step "Native app already up to date (v$installedVer)."
          return $true
        }
      }
      $dlDir = Join-Path $PSScriptRoot 'data\native-installer'
      New-Item -ItemType Directory -Path $dlDir -Force | Out-Null
      $exe = Join-Path $dlDir $asset.name
      Invoke-DownloadWithSpinner -Uri $asset.browser_download_url -OutFile $exe -Headers @{ 'User-Agent' = 'XenonEdgeHub' } -TimeoutSec 180 -Activity 'Downloading the native app installer'
      if (-not (Test-Path $exe)) { throw 'the download did not produce the installer' }
      Write-Step "Installing the native Xenon app ($($asset.name))..."
      Invoke-ProcessWithSpinner -FilePath $exe -ArgumentList '/S', '/NOBOOTSTRAP' -Activity 'Installing the native app' | Out-Null
      return $true
    } catch {
      if ($attempt -eq $maxAttempts) {
        Write-Host "Could not download the native app installer: $($_.Exception.Message). You can install it later from the dashboard: Settings -> General." -ForegroundColor Yellow
        return $false
      }
    }
  }
  return $false
}

# Resolve the installed native app exe. The Tauri NSIS bundle installs per-user
# (installMode currentUser) into %LOCALAPPDATA%\Xenon; the binary keeps the
# cargo name (xenon-native.exe), not the product name. Fall back to the NSIS
# uninstall registry key in case a future bundle changes the location — note
# its InstallLocation value is stored WITH literal quotes.
function Get-NativeAppExe {
  $dirs = @((Join-Path $env:LOCALAPPDATA 'Xenon'))
  try {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Xenon' -ErrorAction Stop
    if ($reg.InstallLocation) { $dirs += $reg.InstallLocation.Trim('"') }
  } catch { }
  foreach ($dir in ($dirs | Select-Object -Unique)) {
    foreach ($name in @('xenon-native.exe', 'Xenon.exe')) {
      $path = Join-Path $dir $name
      if (Test-Path $path) { return $path }
    }
  }
  return $null
}

# Launch the freshly installed kiosk. The silent NSIS install never starts the
# app, and the app registers its own login autostart only on first run — so
# without this the user ends the install with nothing on screen. Safe to call
# when already running: the app is single-instance and just refocuses.
function Start-NativeAppIfInstalled {
  $exe = Get-NativeAppExe
  if (-not $exe) { return $false }
  try {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
    return $true
  } catch {
    Write-Host "Could not start the native app: $($_.Exception.Message)" -ForegroundColor Yellow
    return $false
  }
}

# Ask which surface to set up. BOTH modes set up the shared backend (per-logon
# task); only Native additionally installs the Tauri kiosk app. iCUE mode installs
# nothing Tauri-related — the user imports the iCUE widget into iCUE themselves,
# and can switch to the native app later from the dashboard Settings. Set
# XENON_INSTALL_MODE=native|icue to run unattended.
function Read-InstallMode {
  # The -Mode parameter wins: the setup.exe bootstrap launches this script
  # elevated, and environment variables don't survive -Verb RunAs.
  if ($Mode -eq 'native' -or $Mode -eq 'icue') { return $Mode }
  if ($env:XENON_INSTALL_MODE -eq 'native' -or $env:XENON_INSTALL_MODE -eq 'icue') { return $env:XENON_INSTALL_MODE }
  Write-Host ''
  Write-Host '   How do you want to use Xenon on the CORSAIR Xeneon Edge?' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '   [1] Native app       ' -NoNewline -ForegroundColor White
  Write-Host 'Dedicated full-screen kiosk - sharper and' -ForegroundColor Gray
  Write-Host '                        independent of iCUE. Recommended (beta).' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '   [2] iCUE / Browser   ' -NoNewline -ForegroundColor White
  Write-Host 'Show the same dashboard inside Corsair iCUE' -ForegroundColor Gray
  Write-Host '                        or in any web browser at' -ForegroundColor DarkGray
  Write-Host "                        $url" -ForegroundColor DarkGray
  Write-Host ''
  $choice = Read-Host '  Enter 1 or 2 (default 1)'
  if ($choice.Trim() -eq '2') { return 'icue' }
  return 'native'
}

# Record the chosen surface so the dashboard can adapt (e.g. offer the native
# app from Settings when the user is on iCUE). Written into DATA_DIR (server/data),
# which is never HTTP-reachable; the server reads it and exposes only a status.
function Write-InstallModeMarker {
  param([string]$Mode)
  try {
    $dataDir = Join-Path $PSScriptRoot 'data'
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    $payload = [pscustomobject]@{ mode = $Mode; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    Set-Content -Path (Join-Path $dataDir 'install-mode.json') -Value $payload -Encoding UTF8
  } catch { }
}

# Snapshot of what is actually on disk after the install steps ran. Used for
# the automatic second pass on anything that failed (issue #87) and for the
# clear OK/MISSING summary at the end — a failed component must never again be
# just a yellow line that scrolled away.
function Get-ComponentStatus {
  return [ordered]@{
    'Node.js'               = [bool](Get-NodePath)
    'Dashboard libraries'   = (@($requiredNodeDeps | Where-Object { -not (Test-Path (Join-Path $root "node_modules\$_")) }).Count -eq 0)
    'FFmpeg (AI voice)'     = [bool](Get-FfmpegPath)
    'LibreHardwareMonitor'  = [bool](Get-LibreHardwareMonitorPath)
    'PawnIO driver'         = [bool](Get-PawnIoDriver)
    'PresentMon (game FPS)' = (Test-Path (Join-Path $filesDir 'presentmon\PresentMon.exe'))
    'Xenon Helper'          = (Test-Path (Join-Path $filesDir 'helper\xenon-helper.exe'))
  }
}

# One automatic second pass over whatever failed (every installer is an
# idempotent "IfNeeded", so re-running only touches the missing pieces).
function Invoke-ComponentRetryPass {
  $status = Get-ComponentStatus
  $failed = @($status.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
  if ($failed.Count -eq 0) { return }
  Write-Host ''
  Write-Step "Retrying components that did not install on the first pass: $($failed -join ', ')..."
  if ($failed -contains 'Node.js') { try { Install-NodeIfNeeded | Out-Null } catch { } }
  if ($failed -contains 'Dashboard libraries') { Install-NpmDependenciesIfNeeded }
  if ($failed -contains 'FFmpeg (AI voice)') { Install-FfmpegIfNeeded | Out-Null }
  if ($failed -contains 'LibreHardwareMonitor') { Install-LibreHardwareMonitorIfNeeded | Out-Null }
  if ($failed -contains 'PawnIO driver') { Install-PawnIoIfNeeded }
  if ($failed -contains 'PresentMon (game FPS)') { Install-PresentMonIfNeeded }
  if ($failed -contains 'Xenon Helper') { Install-XenonHelperIfNeeded }
}

function Write-ComponentSummary {
  $status = Get-ComponentStatus
  Write-Host ''
  Write-Host '   Components:' -ForegroundColor Gray
  foreach ($entry in $status.GetEnumerator()) {
    if ($entry.Value) {
      Write-Host ('     [OK]      {0}' -f $entry.Key) -ForegroundColor Green
    } else {
      Write-Host ('     [MISSING] {0}' -f $entry.Key) -ForegroundColor Yellow
    }
  }
  if (-not $status['Dashboard libraries']) {
    Write-Host ''
    Write-Host '   The dashboard libraries are REQUIRED — check your connection and run INSTALL.bat again.' -ForegroundColor Red
  }
}

$appVersion = Get-AppVersion
Show-Banner -Version $appVersion

$installMode = Read-InstallMode
$installerElevated = Test-IsElevated
Install-NodeIfNeeded | Out-Null
Install-NpmDependenciesIfNeeded
Install-FfmpegIfNeeded | Out-Null
Install-LibreHardwareMonitorIfNeeded | Out-Null
Install-PawnIoIfNeeded | Out-Null
Install-PresentMonIfNeeded
Install-XenonHelperIfNeeded
Install-ICueSdkIfNeeded
# Anything that failed above gets ONE automatic second pass before the backend
# starts (the dashboard libraries are required for it to even boot).
Invoke-ComponentRetryPass
# The free local AI provider (Ollama + Whisper.cpp) is OPT-IN: it is NOT set up
# here so the installer stays fast for everyone. When the user actually switches
# Xenon AI to the local provider, the dashboard (Settings -> Xenon AI) downloads
# Whisper on demand and links to the Ollama installer.
# The backend starts via the per-logon scheduled task and runs IN the user's
# session — the only place SMTC media, Deck app/site launching, hotkeys, window
# actions and screen capture can work. (A session-0 service cannot touch the
# interactive desktop; see Remove-BackendServiceIfPresent.) Migrate old beta
# installs off the service first, then register the task and start the backend.
Remove-BackendServiceIfPresent | Out-Null
Register-StartupTask
Start-WidgetServer -RestartExisting:$installerElevated

# Record the chosen surface, then act on it. Native installs the Tauri kiosk;
# iCUE installs nothing Tauri-related and points the user at the iframe URL.
Write-InstallModeMarker -Mode $installMode
$nativeLaunched = $false
if ($installMode -eq 'native') {
  # Reserve the touchscreen edge swipe before the kiosk appears, so its
  # swipe-up-to-desktop gesture wins over Windows' Start/taskbar gestures.
  Disable-WindowsEdgeSwipe
  if (Install-NativeAppIfPresent) {
    Write-Step 'Native Xenon app installed (full-screen kiosk on the Xeneon Edge).'
    $nativeLaunched = Start-NativeAppIfInstalled
    if (-not $nativeLaunched) {
      Write-Host 'Could not launch the native app automatically — start "Xenon" from the Start menu.' -ForegroundColor Yellow
    }
  } else {
    Write-Host 'The native app could not be installed automatically (offline, or not yet attached to the release). You can install it anytime from the dashboard: Settings -> General.' -ForegroundColor Gray
  }
} else {
  Write-Step 'iCUE mode selected - backend installed; the native app was skipped.'
  Write-Host 'To show the dashboard in iCUE: open Corsair iCUE, add a Web/HTML widget and point it at the URL below.' -ForegroundColor Gray
  Write-Host 'You can switch to the native app anytime from the dashboard: Settings -> General.' -ForegroundColor Gray
}

# Native launched → the kiosk IS the dashboard; opening a browser tab on top of
# it would be confusing. Every other outcome still gets the browser.
if ($nativeLaunched) {
  Write-Step 'Native Xenon app started - it will also launch automatically at login.'
} else {
  Write-Step 'Opening the dashboard...'
  Start-Process $url
}

Write-ComponentSummary

Write-Host ''
Write-Host '   ---------------------------------------------------' -ForegroundColor DarkGray
Write-Host "   All set - Xenon v$appVersion is installed and running." -ForegroundColor Green
Write-Host '   It will start automatically every time you sign in to Windows.' -ForegroundColor Gray
Write-Host ''
Write-Host '   Open the dashboard in iCUE or any browser at:' -ForegroundColor Gray
Write-Host "     $url" -ForegroundColor White
if (-not $installerElevated) {
  Write-Host ''
  Write-Host '   Tip: for automatic CPU temperature on hardware that requires' -ForegroundColor Yellow
  Write-Host '   admin sensor access, rerun INSTALL.bat once as Administrator.' -ForegroundColor Yellow
}
Write-Host '   ---------------------------------------------------' -ForegroundColor DarkGray

$ErrorActionPreference = 'Stop'

$appName = 'Xenon Edge Widget'
$root = Split-Path -Parent $PSScriptRoot
$filesDir = Join-Path $root 'server'
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

function Register-StartupTask {
  Write-Step 'Registering startup task in Task Scheduler...'
  # Remove old Startup folder shortcut if left over from a previous install
  $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  $oldLnk = Join-Path $startup "$appName.lnk"
  if (Test-Path $oldLnk) { Remove-Item $oldLnk -Force }

  $action   = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument "`"$runner`"" -WorkingDirectory $filesDir
  $trigger  = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
  Register-ScheduledTask `
    -TaskName $appName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Force | Out-Null
}

function Test-WidgetServer {
  try {
    $response = Invoke-WebRequest -Uri "$url/status" -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Start-WidgetServer {
  if (Test-WidgetServer) {
    Write-Step 'Widget server is already running.'
    return
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
Write-Host 'This installer will install Node.js if needed, enable startup with Windows, start the widget, and open the dashboard.'
Write-Host ''

Install-NodeIfNeeded | Out-Null
Install-FfmpegIfNeeded | Out-Null
Register-StartupTask
Start-WidgetServer

Write-Step 'Opening the dashboard...'
Start-Process $url

Write-Host ''
Write-Host 'All set.' -ForegroundColor Green
Write-Host 'The widget is installed, running now, and will start automatically with Windows.'
Write-Host 'Use this URL in Corsair iCUE / Xeneon Edge iframe widgets:'
Write-Host "  $url" -ForegroundColor White

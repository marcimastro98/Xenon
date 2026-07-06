#Requires -Version 5.1
<#
  install-service.ps1 — RETIRED. Register the Xenon backend as an auto-start
  Windows service via WinSW v2.

  ⚠ Do not use. A Windows service runs in session 0, isolated from the user's
  interactive desktop, which silently breaks most of Xenon: Deck open app/site/
  file keys, SMTC media detection, hotkeys, window actions, screen capture and
  TTS audio. The backend must run in the user's session — install.ps1 registers
  the per-logon scheduled task and actively REMOVES this service if present.
  This script is kept only for reference; it refuses to run without -Force.

  What it does:
    1. Resolves node.exe (absolute path — services don't inherit the user PATH).
    2. Ensures WinSW v2.12.0 is present as service/xenon-service.exe, downloading
       it from the pinned GitHub release and verifying its SHA-256.
    3. Writes service/xenon-service.xml from the committed template with the
       machine-specific absolute paths.
    4. (Re)installs and starts the "XenonEdgeService" service.

  The backend is run UNMODIFIED (`node server/server.js`, workdir = server/), so
  every collector / vendored binary / data path resolves as under `npm start`,
  koffi loads normally, and the listener stays on loopback.

  Must run elevated (registering a service needs admin). Idempotent: re-running
  reconfigures the service in place.
#>
[CmdletBinding()]
param(
  # Override the node.exe path if auto-detection is not desired.
  [string]$NodeExe,
  # The service is retired (session 0 breaks desktop integration); require an
  # explicit opt-in so nothing re-registers it by accident.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Force) {
  throw 'RETIRED: the backend must run in the user session (session-0 services break Deck launches, SMTC media, hotkeys and capture). Use the per-logon task registered by server\install.ps1. Pass -Force only if you really know what you are doing.'
}

# ── Pinned WinSW release (self-contained x64 build — no .NET prerequisite) ──────
$WinswVersion = 'v2.12.0'
$WinswUrl     = "https://github.com/winsw/winsw/releases/download/$WinswVersion/WinSW-x64.exe"
$WinswSha256  = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'

$ServiceId = 'XenonEdgeService'

# ── Paths ───────────────────────────────────────────────────────────────────
$ServiceDir = $PSScriptRoot
$RepoRoot   = Split-Path -Parent $ServiceDir
$ServerDir  = Join-Path $RepoRoot 'server'
$ServerJs   = Join-Path $ServerDir 'server.js'
$ExePath    = Join-Path $ServiceDir 'xenon-service.exe'
$XmlPath    = Join-Path $ServiceDir 'xenon-service.xml'
$Template   = Join-Path $ServiceDir 'xenon-service.xml.template'
$LogDir     = Join-Path $ServiceDir 'logs'

function Write-Step($m) { Write-Host "[xenon-service] $m" -ForegroundColor Cyan }

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Registering a Windows service requires an elevated (Administrator) PowerShell. Right-click > Run as administrator, then re-run.'
  }
}

function Resolve-NodeExe {
  if ($NodeExe -and (Test-Path $NodeExe)) { return (Resolve-Path $NodeExe).Path }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @()
  if ($env:ProgramFiles)      { $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }
  if ($env:LOCALAPPDATA)      { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
  foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
  throw 'node.exe was not found. Install Node.js LTS (the main installer does this via winget) and retry.'
}

function Ensure-Winsw {
  if (Test-Path $ExePath) {
    $existing = (Get-FileHash -Algorithm SHA256 -Path $ExePath).Hash
    if ($existing -eq $WinswSha256) { Write-Step "WinSW already present and verified."; return }
    Write-Step "Replacing unexpected xenon-service.exe (hash mismatch)."
    Remove-Item $ExePath -Force
  }
  Write-Step "Downloading WinSW $WinswVersion ..."
  $tmp = Join-Path $ServiceDir 'winsw-download.tmp'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $WinswUrl -OutFile $tmp -UseBasicParsing
    $hash = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash
    if ($hash -ne $WinswSha256) {
      throw "WinSW download failed integrity check. Expected $WinswSha256, got $hash."
    }
    Move-Item $tmp $ExePath -Force
    Write-Step "WinSW verified and installed as xenon-service.exe."
  } finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
}

function Write-ServiceXml {
  $nodeExe = Resolve-NodeExe
  if (-not (Test-Path $ServerJs)) { throw "server.js not found at $ServerJs" }
  Write-Step "Node:   $nodeExe"
  Write-Step "Server: $ServerJs"
  $xml = Get-Content -Raw -Path $Template
  $xml = $xml.Replace('@NODE_EXE@', $nodeExe)
  $xml = $xml.Replace('@SERVER_JS@', $ServerJs)
  $xml = $xml.Replace('@WORKDIR@', $ServerDir)
  # WinSW reads the config as UTF-8; write without a BOM.
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($XmlPath, $xml, $enc)
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

# ── Run ─────────────────────────────────────────────────────────────────────
Assert-Admin
Ensure-Winsw
Write-ServiceXml

# Reconfigure cleanly if the service already exists.
$existingSvc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($existingSvc) {
  Write-Step 'Service exists — stopping and removing before reinstall.'
  & $ExePath stop  2>$null | Out-Null
  & $ExePath uninstall 2>$null | Out-Null
  # The SCM keeps the registration alive ("delete pending") until the service
  # process fully exits — and the node backend shuts down gracefully over
  # several seconds. Reinstalling in that window fails with "already exists"
  # and leaves the machine with NO service at all, so wait it out.
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
    throw "The previous $ServiceId registration is still pending deletion after 45s. Re-run the installer in a moment."
  }
}

# Port 3030 must be free before the service starts, or its node child dies on
# EADDRINUSE. Two holders are possible: the old service's node still shutting
# down, and a manually-started backend (npm start / the per-logon task runner).
# Stop the latter ourselves — it never exits on its own — then wait the port out.
foreach ($conn in @(Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue)) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
  if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -like "*$ServerJs*") {
    Write-Step "Stopping the running backend (PID $($proc.ProcessId)) so the service can take over."
    Stop-Process -Id $proc.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
  }
}
$deadline = (Get-Date).AddSeconds(30)
while ((Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Milliseconds 500
}

Write-Step 'Installing service ...'
& $ExePath install
if ($LASTEXITCODE -ne 0) { throw "WinSW install failed (exit $LASTEXITCODE)." }

Write-Step 'Starting service ...'
& $ExePath start
if ($LASTEXITCODE -ne 0) { throw "WinSW start failed (exit $LASTEXITCODE)." }

Write-Step 'Done. The Xenon backend is now an auto-start service on 127.0.0.1:3030.'
Write-Step 'Logs: ' ; Write-Host "  $LogDir" -ForegroundColor Gray

# Airflow spike (step 0): what LibreHardwareMonitor can drive on THIS PC, and what
# happens to a fan header when the process that set it disappears.
# Dev-only, never shipped. Run elevated (the Super I/O needs PawnIO, which needs admin):
#   powershell -ExecutionPolicy Bypass -File tools\airflow-spike\lhm-controls.ps1 -Out <dir>
# Writes <dir>\airflow-spike.json. Every write is followed by SetDefault in the same
# process, except the deliberate "orphan" child, which the parent rescues at the end.
param(
  [string]$Out = $env:TEMP,
  [ValidateSet('all', 'orphan', 'fresh-default', 'gpu-probe')] [string]$Mode = 'all',
  [string]$Control = '',
  [int]$Percent = 60,
  [int]$Seconds = 10,
  [string]$GpuControl = '',
  # Comma list of stages to run (board, gpu, crash, gpu-system); empty = all.
  [string]$Only = ''
)
function Test-Stage([string]$name) { return (-not $Only) -or (($Only -split ',') -contains $name) }
$ErrorActionPreference = 'Stop'

function Get-TrustedLhmDll {
  # Same rule as the sensor service: machine-wide copies only (admin-writable),
  # never a per-user one, never a WinRing0 build (< 0.9.5).
  foreach ($sf in @([Environment+SpecialFolder]::ProgramFiles, [Environment+SpecialFolder]::ProgramFilesX86)) {
    $pf = [Environment]::GetFolderPath($sf)
    if (-not $pf) { continue }
    $candidates = @(Join-Path $pf 'LibreHardwareMonitor\LibreHardwareMonitorLib.dll')
    foreach ($dir in @(Get-ChildItem -LiteralPath (Join-Path $pf 'WinGet\Packages') -Directory -Filter 'LibreHardwareMonitor*' -ErrorAction SilentlyContinue)) {
      $found = Get-ChildItem -LiteralPath $dir.FullName -Filter LibreHardwareMonitorLib.dll -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { $candidates += $found.FullName }
    }
    foreach ($c in $candidates) {
      if (-not (Test-Path -LiteralPath $c -PathType Leaf)) { continue }
      $raw = '' + (Get-Item -LiteralPath $c).VersionInfo.FileVersion
      if ($raw -match '^\s*(\d+)\.(\d+)(?:\.(\d+))?') {
        $b = if ($Matches[3]) { [int]$Matches[3] } else { 0 }
        if ((New-Object Version ([int]$Matches[1]), ([int]$Matches[2]), $b) -ge [Version]'0.9.5') { return @{ path = $c; version = $raw } }
      }
    }
  }
  return $null
}

function Open-Lhm {
  $dll = Get-TrustedLhmDll
  if (-not $dll) { throw 'No trusted LibreHardwareMonitorLib.dll >= 0.9.5 under Program Files' }
  Push-Location (Split-Path -Parent $dll.path)
  try { Add-Type -Path $dll.path } finally { Pop-Location }
  $c = [LibreHardwareMonitor.Hardware.Computer]::new()
  $c.IsMotherboardEnabled = $true
  $c.IsGpuEnabled = $true
  $c.IsCpuEnabled = $true
  try { $c.IsControllerEnabled = $true } catch { }
  $c.Open()
  return @{ computer = $c; dll = $dll }
}

function Get-AllHardware($computer) {
  $list = @()
  foreach ($h in @($computer.Hardware)) { $list += $h; foreach ($s in @($h.SubHardware)) { $list += $s } }
  return $list
}

function Update-All($computer) { foreach ($h in (Get-AllHardware $computer)) { try { $h.Update() } catch { } } }

function Find-Sensor($computer, [string]$id) {
  foreach ($h in (Get-AllHardware $computer)) { foreach ($s in @($h.Sensors)) { if ($s.Identifier.ToString() -eq $id) { return $s } } }
  return $null
}

function Get-Snapshot($computer) {
  Update-All $computer
  $fans = [ordered]@{}
  foreach ($h in (Get-AllHardware $computer)) {
    foreach ($s in @($h.Sensors)) {
      $t = $s.SensorType.ToString()
      if ($t -eq 'Fan' -or $t -eq 'Control') { $fans[$s.Identifier.ToString()] = if ($null -eq $s.Value) { $null } else { [Math]::Round([double]$s.Value, 1) } }
    }
  }
  return $fans
}

function Watch-Fans($computer, [double]$seconds, [string]$label) {
  $rows = @()
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $rows += [pscustomobject]@{ t = (Get-Date).ToString('HH:mm:ss.fff'); phase = $label; values = (Get-Snapshot $computer) }
    Start-Sleep -Milliseconds 500
  }
  return $rows
}

function Get-Inventory($computer) {
  Update-All $computer
  $items = @()
  foreach ($h in (Get-AllHardware $computer)) {
    foreach ($s in @($h.Sensors)) {
      $t = $s.SensorType.ToString()
      if ($t -notin @('Fan', 'Control', 'Temperature')) { continue }
      $row = [ordered]@{ hw = [string]$h.Name; hwType = $h.HardwareType.ToString(); id = $s.Identifier.ToString(); type = $t; name = [string]$s.Name; value = $s.Value }
      if ($t -eq 'Control' -and $s.Control) {
        $row.controlMode = $s.Control.ControlMode.ToString()
        $row.softwareValue = $s.Control.SoftwareValue
        $row.min = $s.Control.MinSoftwareValue
        $row.max = $s.Control.MaxSoftwareValue
      }
      $items += [pscustomobject]$row
    }
  }
  return $items
}

# Every control this process writes is listed here and handed back in the finally
# at the bottom, so an exception halfway through never leaves a fan where we put it.
$script:touched = @{}

function Test-Control($computer, [string]$id, [int]$pct, [int]$secs) {
  $s = Find-Sensor $computer $id
  if (-not $s -or -not $s.Control) { return @{ id = $id; error = 'control not found' } }
  $script:touched[$id] = $s
  $rows = @()
  $rows += Watch-Fans $computer 3 'before'
  $s.Control.SetSoftware([single]$pct)
  $rows += Watch-Fans $computer $secs ("software-$pct")
  $s.Control.SetDefault()
  $rows += Watch-Fans $computer 12 'after-default'
  return @{ id = $id; percent = $pct; rows = $rows; modeAfter = $s.Control.ControlMode.ToString() }
}

$outFile = Join-Path $Out $(if ($Only) { 'airflow-spike-' + ($Only -replace ',', '-') + '.json' } else { 'airflow-spike.json' })
$lhm = Open-Lhm
$computer = $lhm.computer

if ($Mode -eq 'orphan') {
  # Child 1: set the header and exit WITHOUT SetDefault, the way a crash would.
  $s = Find-Sensor $computer $Control
  $s.Control.SetSoftware([single]$Percent)
  Start-Sleep -Milliseconds 800
  [Environment]::Exit(0)
}
if ($Mode -eq 'gpu-probe') {
  # Run by a one-shot SYSTEM task: can the sensor service's context (session 0) drive
  # the GPU fans at all, and does SetDefault give the card its zero-RPM stop back?
  $probe = [ordered]@{ user = [Security.Principal.WindowsIdentity]::GetCurrent().Name; session = [Diagnostics.Process]::GetCurrentProcess().SessionId }
  $inv = Get-Inventory $computer
  $probe.gpu = @($inv | Where-Object { $_.hwType -like 'Gpu*' -and $_.type -ne 'Temperature' })
  $g = @($probe.gpu | Where-Object { $_.type -eq 'Control' })
  if ($g.Count) {
    try { $probe.test = Test-Control $computer $g[0].id 40 6 } finally { foreach ($t in $script:touched.Values) { try { $t.Control.SetDefault() } catch { } } }
  }
  $probe | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Out 'airflow-spike-gpu-system.json') -Encoding UTF8
  [Environment]::Exit(0)
}
if ($Mode -eq 'fresh-default') {
  # Child 2: a brand-new process (like the service restarted after a crash) asks for
  # SetDefault on a header it never touched. Does the BIOS curve come back?
  $s = Find-Sensor $computer $Control
  $before = $s.Control.ControlMode.ToString()
  $s.Control.SetDefault()
  $rows = Watch-Fans $computer 8 'fresh-default'
  $rows | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Out 'airflow-spike-fresh.json') -Encoding UTF8
  [Environment]::Exit(0)
}

$result = [ordered]@{ at = (Get-Date).ToString('o'); dll = $lhm.dll.version; elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); errors = @() }
function Save-Result { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outFile -Encoding UTF8 }
# One stage failing must not cost the others: each records its error and the file is
# saved after every stage, so a crash halfway still leaves what was learned.
function Invoke-Stage([string]$name, [scriptblock]$body) {
  try { & $body } catch { $result.errors += ($name + ': ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage) }
  Save-Result
}

try {
Start-Transcript -LiteralPath (Join-Path $Out 'airflow-spike.log') -Force | Out-Null
Invoke-Stage 'inventory' {
  $result.inventory = Get-Inventory $computer
}
$boardControls = @($result.inventory | Where-Object { $_.type -eq 'Control' -and $_.hwType -eq 'SuperIO' })
if (-not $GpuControl) { $g = @($result.inventory | Where-Object { $_.type -eq 'Control' -and $_.hwType -like 'Gpu*' }); if ($g.Count) { $GpuControl = $g[0].id } }

# Which tach answers which control, and does it answer at all: 30 % for 8 s on every
# board control in turn (a 3-pin fan on a PWM header does not slow down).
$result.board = @()
foreach ($bc in @($boardControls | Where-Object { Test-Stage 'board' })) {
  Invoke-Stage ('board ' + $bc.id) { $result.board += Test-Control $computer $bc.id 30 8 }
}
if ($GpuControl -and (Test-Stage 'gpu')) { Invoke-Stage 'gpu' { $result.gpu = Test-Control $computer $GpuControl 40 8 } }

if (-not $Control -and $boardControls.Count -ge 2) { $Control = $boardControls[1].id }
if ($Control -and (Test-Stage 'crash')) {
  Invoke-Stage 'crash' {
    # Crash simulation with a rescue: this process takes the header first (LHM saves the
    # BIOS state here), children play crash + fresh restart, then this process restores.
    $s = Find-Sensor $computer $Control
    $script:touched[$Control] = $s
    Update-All $computer
    $hold = [Math]::Max(30, [int][Math]::Round([double]$s.Value))
    $s.Control.SetSoftware([single]$hold)
    $self = $PSCommandPath
    $orphanPct = if ($hold -ge 70) { 50 } else { 80 }
    Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Mode', 'orphan', '-Control', $Control, '-Percent', $orphanPct, '-Out', $Out) -Wait -WindowStyle Hidden
    $afterOrphan = Watch-Fans $computer 8 "orphan-$orphanPct"
    Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Mode', 'fresh-default', '-Control', $Control, '-Out', $Out) -Wait -WindowStyle Hidden
    $s.Control.SetDefault()
    $rescued = Watch-Fans $computer 12 'rescued-by-first-process'
    $result.crash = [ordered]@{ control = $Control; hold = $hold; orphanPercent = $orphanPct; afterOrphan = $afterOrphan; rescued = $rescued }
  }
}

if ($GpuControl -and (Test-Stage 'gpu-system')) {
  Invoke-Stage 'gpu-system' {
    # The same GPU question from SYSTEM, the account the sensor service runs as. The task
    # lives for seconds and is removed in the finally below. Dev rig only: it runs this
    # file from the repo, which a shipped task must never do (Program Files only).
    $task = 'XenonAirflowSpike'
    $ps = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $act = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Mode gpu-probe -Out "' + $Out + '"')
    $who = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    try {
      Register-ScheduledTask -TaskName $task -Action $act -Principal $who -Force | Out-Null
      Start-ScheduledTask -TaskName $task
      $probeFile = Join-Path $Out 'airflow-spike-gpu-system.json'
      $until = (Get-Date).AddSeconds(90)
      while (-not (Test-Path -LiteralPath $probeFile) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500 }
      Start-Sleep -Seconds 1
    } finally {
      try { Unregister-ScheduledTask -TaskName $task -Confirm:$false } catch { }
    }
    $result.gpuSystemAfter = Watch-Fans $computer 6 'after-system-probe'
  }
}
} finally {
  foreach ($t in $script:touched.Values) { try { $t.Control.SetDefault() } catch { } }
  Invoke-Stage 'final' { $result.final = Get-Inventory $computer }
  try { Stop-Transcript | Out-Null } catch { }
  try { $computer.Close() } catch { }
}

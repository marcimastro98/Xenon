$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$gpuName = $null
$gpuTemp = $null
$vramUsed = $null
$vramTotal = $null
$gpuWatts = $null
$gpuFanRpm = $null
$gpuFans = @()
$gpuClockMHz = $null
$vramClockMHz = $null

# GPU temperature via LibreHardwareMonitor - works for AMD, Intel, and NVIDIA without nvidia-smi.
# LHM is already installed by INSTALL.bat for CPU temps, so no new dependency is introduced.
function Get-LibreHardwareMonitorDll {
  $candidates = @()
  try {
    $command = Get-Command LibreHardwareMonitor.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += Join-Path (Split-Path -Parent $command.Source) 'LibreHardwareMonitorLib.dll' }
  } catch { }
  if ($env:LOCALAPPDATA) {
    $wingetPackages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    try {
      $packageDirs = @(Get-ChildItem -Path $wingetPackages -Directory -Filter 'LibreHardwareMonitor*' -ErrorAction SilentlyContinue)
      foreach ($packageDir in $packageDirs) {
        $found = Get-ChildItem -Path $packageDir.FullName -Filter LibreHardwareMonitorLib.dll -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $candidates += $found.FullName }
      }
    } catch { }
  }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\LibreHardwareMonitor\LibreHardwareMonitorLib.dll' }
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'LibreHardwareMonitor\LibreHardwareMonitorLib.dll' }
  $x86 = ${env:ProgramFiles(x86)}
  if ($x86) { $candidates += Join-Path $x86 'LibreHardwareMonitor\LibreHardwareMonitorLib.dll' }
  return ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

# When each GPU was last Update()d, so sensors.ps1 (Settings -> Sensor sources,
# the SDK `sensors` stream) refreshes a card only when this collector has not
# just done it. Keyed by LHM hardware identifier: one stamp per card.
function Set-LhmUpdated($Hardware) {
  if ($null -eq $global:XenonLhmUpdatedAt) { $global:XenonLhmUpdatedAt = @{} }
  $global:XenonLhmUpdatedAt[[string]$Hardware.Identifier] = Get-Date
}

# Persistent LHM session (same pattern as cpu-temp.ps1): inside pwsh-worker the
# script runs every few seconds in one process, so the Computer is built once
# and only Update() runs per read. Process exit reclaims the driver handles.
function Get-GpuLhmComputer {
  if ($global:XenonGpuLhm) { return $global:XenonGpuLhm }
  if ($global:XenonGpuLhmFailedAt -and ((Get-Date) - $global:XenonGpuLhmFailedAt).TotalSeconds -lt 300) { return $null }
  $locationPushed = $false
  try {
    $dll = Get-LibreHardwareMonitorDll
    if (-not $dll) { $global:XenonGpuLhmFailedAt = Get-Date; return $null }
    Push-Location (Split-Path -Parent $dll)
    $locationPushed = $true
    Add-Type -Path $dll
    $computer = [LibreHardwareMonitor.Hardware.Computer]::new()
    $computer.IsGpuEnabled = $true
    $computer.Open()
    $global:XenonGpuLhm = $computer
    $global:XenonGpuLhmFailedAt = $null
    return $computer
  } catch {
    $global:XenonGpuLhmFailedAt = Get-Date
    return $null
  } finally {
    try { if ($locationPushed) { Pop-Location } } catch { }
  }
}

# The ONE card the readings come from. Every field used to take the first value
# any GPU offered, so a PC with two (a Ryzen 7000's integrated Radeon beside a
# Radeon card is the common case) mixed them: the name from WMI, VRAM, clock and
# watts from the integrated GPU, the fans from the card (Discord, Oct 2026: a
# 9070 XT shown with 512 MB of VRAM and 2 W). The card WMI names wins, and WMI
# is sorted by memory, so that is the discrete one; without a match, the most
# dedicated memory, which an integrated GPU's small carve-out never beats.
# Remembered per session: the cards do not change while it is open.
function Read-LhmDedicatedMemoryMB($Hardware) {
  foreach ($sensor in @($Hardware.Sensors)) {
    try {
      $sname = [string]$sensor.Name
      if ($sensor.SensorType.ToString() -eq 'SmallData' -and $sname -match 'Memory Total' -and $sname -notmatch 'Shared' -and $null -ne $sensor.Value) {
        return [double]$sensor.Value
      }
    } catch { }
  }
  return 0.0
}

function Select-LhmGpu {
  param($Computer, [string]$Name)
  $gpus = @($Computer.Hardware | Where-Object { $_.HardwareType.ToString() -match 'Gpu' })
  if ($gpus.Count -le 1) { return ($gpus | Select-Object -First 1) }
  $remembered = [string]$global:XenonGpuLhmPick
  if ($remembered) {
    $hit = $gpus | Where-Object { [string]$_.Identifier -eq $remembered } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  $pick = $null
  if ($Name) { $pick = $gpus | Where-Object { ([string]$_.Name).Trim() -eq $Name.Trim() } | Select-Object -First 1 }
  if (-not $pick) {
    $best = -1.0
    foreach ($candidate in $gpus) {
      try { $candidate.Update(); Set-LhmUpdated $candidate } catch { }
      $mb = Read-LhmDedicatedMemoryMB $candidate
      if ($mb -gt $best) { $best = $mb; $pick = $candidate }
    }
  }
  if ($pick) { $global:XenonGpuLhmPick = [string]$pick.Identifier }
  return $pick
}

# NVIDIA fans read the way NvidiaGpu.Update() reads them (fan-cooler status,
# else the single tachometer), named by LHM's own sensors so the list is the same
# one the full walk produces. Private members, so: $null whenever anything is not
# as expected and the caller falls back to Update(); an empty array when the card
# has no fan sensors at all.
function Read-NvidiaFansDirect {
  param($Hardware)
  try {
    $flags = [Reflection.BindingFlags]'NonPublic,Public,Instance'
    $type = $Hardware.GetType()
    $sensors = $type.GetField('_fans', $flags).GetValue($Hardware)
    if ($null -eq $sensors -or $sensors.Length -eq 0) { return ,@() }
    $argv = New-Object 'System.Object[]' 1
    $status = $type.GetMethod('GetFanCoolersStatus', $flags).Invoke($Hardware, $argv)
    $statusType = $status.GetType()
    $count = [int]$statusType.GetField('Count', $flags).GetValue($status)
    $rpms = @()
    if ([string]$argv[0] -eq 'OK' -and $count -gt 0) {
      $items = $statusType.GetField('Items', $flags).GetValue($status)
      $rpmField = $items[0].GetType().GetField('CurrentRpm', $flags)
      for ($i = 0; $i -lt [Math]::Min($count, $sensors.Length); $i++) { $rpms += [double]$rpmField.GetValue($items[$i]) }
    } else {
      $argv = New-Object 'System.Object[]' 1
      $tach = $type.GetMethod('GetTachReading', $flags).Invoke($Hardware, $argv)
      if ([string]$argv[0] -ne 'OK') { return $null }
      $rpms = @([double]$tach)
    }
    $fans = @()
    for ($i = 0; $i -lt $rpms.Count; $i++) {
      $rpm = [int][Math]::Round($rpms[$i])
      if ($rpm -lt 0 -or $rpm -gt 20000) { continue }
      $name = ([string]$sensors[$i].Name).Trim()
      if (-not $name) { $name = 'GPU Fan' }
      if ($name.Length -gt 48) { $name = $name.Substring(0, 48) }
      $fans += [pscustomobject]@{ name = $name; rpm = $rpm }
    }
    return ,$fans
  } catch {
    return $null
  }
}

# Per-fan RPM straight from each card's tachometer, plus the core and memory
# clocks off the same enumeration. Cards with the fans stopped (idle zero-RPM
# mode) legitimately report 0 - that is a reading, not a gap, so it is kept. A
# GPU with no fan sensors at all (integrated graphics, a passive card)
# contributes nothing and the caller falls back to whatever it has.
#
# Clocks ride this walk rather than one of their own: the tree is already
# enumerated and Update()d here, so they cost nothing on top. Returns a hashtable
# so a card that exposes clocks but no fans is still worth the call.
#
# -FansOnly (nvidia-smi already answered both clocks): an NVIDIA card's fans are
# read straight from NVAPI instead of through Update(), which refreshes every
# sensor LHM has for the card (power topology, PCIe, D3D memory...) and cost
# ~60-80 ms a read on an RTX 5080 for the two RPM values used here. The direct
# read takes well under a millisecond and returns the same tachometers.
function Get-LhmGpuReadings {
  param([switch]$FansOnly)
  $fans = @()
  $coreClock = $null
  $memClock = $null
  $nvidiaTemp = $null
  try {
    $computer = Get-GpuLhmComputer
    if ($null -eq $computer) { return @{ fans = $fans; coreClock = $null; memClock = $null; nvidiaTemp = $null } }
    foreach ($hardware in @($computer.Hardware)) {
      if ($hardware.HardwareType.ToString() -notmatch 'Gpu') { continue }
      if ($FansOnly -and $hardware.HardwareType.ToString() -eq 'GpuNvidia') {
        $direct = Read-NvidiaFansDirect $hardware
        if ($null -ne $direct) { $fans += $direct; continue }
      }
      try { $hardware.Update(); Set-LhmUpdated $hardware } catch { }
      foreach ($sensor in @($hardware.Sensors)) {
        try {
          if ($null -eq $sensor.Value) { continue }
          $stype = $sensor.SensorType.ToString()
          if ($stype -eq 'Clock') {
            # LHM names them "GPU Core" and "GPU Memory"; "GPU Shader" exists on
            # older cards and is not what a monitoring widget asks for. Both are
            # taken from the FIRST card that reports them - a machine with a
            # discrete card and an iGPU would otherwise have the iGPU overwrite
            # the reading anyone is actually looking at.
            $cname = [string]$sensor.Name
            $mhz = [double]$sensor.Value
            if ($mhz -lt 1 -or $mhz -gt 20000) { continue }
            if ($null -eq $coreClock -and $cname -match 'Core') { $coreClock = [int][Math]::Round($mhz) }
            elseif ($null -eq $memClock -and $cname -match 'Memory|VRAM') { $memClock = [int][Math]::Round($mhz) }
            continue
          }
          # Only asked for when nvidia-smi gave no temperature, so only the
          # NVIDIA card's own core reading counts, never an iGPU's.
          if ($stype -eq 'Temperature') {
            $celsius = [double]$sensor.Value
            if ($null -eq $nvidiaTemp -and $hardware.HardwareType.ToString() -eq 'GpuNvidia' -and
                [string]$sensor.Name -match 'Core' -and $celsius -gt 0 -and $celsius -lt 150) {
              $nvidiaTemp = [int][Math]::Round($celsius)
            }
            continue
          }
          if ($stype -ne 'Fan') { continue }
          $rpm = [int][Math]::Round([double]$sensor.Value)
          if ($rpm -lt 0 -or $rpm -gt 20000) { continue }
          $name = ([string]$sensor.Name).Trim()
          if (-not $name) { $name = 'GPU Fan' }
          if ($name.Length -gt 48) { $name = $name.Substring(0, 48) }
          $fans += [pscustomobject]@{ name = $name; rpm = $rpm }
        } catch { }
      }
    }
  } catch {
    # Broken session (sleep/resume, driver reset): drop it and rebuild next read.
    try { $global:XenonGpuLhm.Close() } catch { }
    $global:XenonGpuLhm = $null
    $global:XenonGpuLhmPick = $null
  }
  return @{ fans = $fans; coreClock = $coreClock; memClock = $memClock; nvidiaTemp = $nvidiaTemp }
}

# nvidia-smi numbers, whole or decimal. Driver 621.01 began printing
# temperature.gpu as "52.56" where every earlier driver printed "52", and a
# whole-number-only match turned that into "no temperature" on every NVIDIA
# card. Any field may go the same way, so all of them take either form; "[N/A]"
# and anything else that is not a number gives $null. nvidia-smi always writes a
# dot, whatever the Windows locale, hence the invariant culture.
function ConvertFrom-SmiNumber([string]$Text) {
  if ($Text -notmatch '^\d+(\.\d+)?$') { return $null }
  return [double]::Parse($Text, [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertFrom-SmiWhole([string]$Text) {
  $value = ConvertFrom-SmiNumber $Text
  if ($null -eq $value) { return $null }
  return [int64][Math]::Round($value, [MidpointRounding]::AwayFromZero)
}

# One line of the --query-gpu below. Split on commas rather than one
# all-or-nothing regex: any field can be "[N/A]" on some cards/drivers, so each
# is parsed independently. The name is LAST and rejoined in case a model name
# ever contains a comma, so every new field goes BEFORE it and the count moves
# with the query.
function ConvertFrom-NvidiaSmiLine([string]$Line) {
  $parts = $Line -split '\s*,\s*'
  if ($parts.Count -lt 9) { return $null }
  $out = @{
    gpu     = ConvertFrom-SmiWhole $parts[0]
    gpuTemp = ConvertFrom-SmiWhole $parts[1]
    gpuName = ($parts[8..($parts.Count - 1)] -join ', ').Trim()
  }
  # nvidia-smi reports memory in MiB (nounits); convert to bytes so the client
  # formats VRAM with the same helper it uses for RAM/disk.
  $used = ConvertFrom-SmiNumber $parts[2]
  if ($null -ne $used) { $out.vramUsed = [int64][Math]::Round($used * 1048576) }
  $total = ConvertFrom-SmiNumber $parts[3]
  if ($null -ne $total) { $out.vramTotal = [int64][Math]::Round($total * 1048576) }
  # power.draw is in watts; fan.speed is a PERCENT (0-100).
  $watts = ConvertFrom-SmiNumber $parts[4]
  if ($null -ne $watts) { $out.gpuWatts = [Math]::Round($watts, 1) }
  $fanPct = ConvertFrom-SmiWhole $parts[5]
  if ($null -ne $fanPct) { $out.gpuFanPct = $fanPct }
  # clocks.gr is the graphics/core clock, clocks.mem the memory clock, both in
  # MHz. "[N/A]" on a card or driver that does not report one leaves the key
  # absent, which the server reads as "no answer" rather than zero.
  $coreMhz = ConvertFrom-SmiWhole $parts[6]
  if ($null -ne $coreMhz) { $out.gpuClockMHz = $coreMhz }
  $memMhz = ConvertFrom-SmiWhole $parts[7]
  if ($null -ne $memMhz) { $out.vramClockMHz = $memMhz }
  return $out
}

try {
  # Path cached across worker calls ($global: survives the per-call child scope);
  # the PATH lookup is repeated only while nvidia-smi is absent.
  if (-not $global:XenonNvidiaSmiPath) {
    $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($nvidiaSmi) { $global:XenonNvidiaSmiPath = $nvidiaSmi.Source }
  }
  if ($global:XenonNvidiaSmiPath) {
    $line = & $global:XenonNvidiaSmiPath --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,fan.speed,clocks.gr,clocks.mem,name --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    # The two clock fields (clocks.gr / clocks.mem) cost nothing: the same
    # invocation was already reading temperature and power.
    if ($line) {
      $out = ConvertFrom-NvidiaSmiLine $line
      if ($null -ne $out) {
        # Real per-fan RPM beats nvidia-smi's fan.speed, which is the fan curve's
        # TARGET rather than the fan itself: an idle card in zero-RPM mode reports
        # "32%" while both fans are stopped. LHM reads each fan's tachometer, so a
        # two-fan card shows two true readings instead of one aggregate guess.
        # Read straight from NVAPI when nvidia-smi answered both clocks and the
        # temperature (well under 1 ms; a full LHM Update() was ~60-80 ms);
        # gpuFanPct stays in the payload as the fallback for cards LHM exposes no
        # fan sensors for.
        # Always emitted, even empty: the server tells "no fans reported" (drop
        # the stale list) from "no read happened" (keep it) by the key's mere
        # presence, so omitting it on an empty result would freeze old RPM
        # forever on a card that genuinely stopped reporting.
        # The fans-only shortcut skips Update(), so it is taken only when
        # nvidia-smi answered every reading LHM could fill in.
        $haveRest = ($null -ne $out.gpuClockMHz) -and ($null -ne $out.vramClockMHz) -and ($null -ne $out.gpuTemp)
        $lhm = Get-LhmGpuReadings -FansOnly:$haveRest
        $out.gpuFans = @($lhm.fans)
        # LHM only fills a gap here - nvidia-smi is the authority on an NVIDIA card.
        if ($null -eq $out.gpuClockMHz  -and $null -ne $lhm.coreClock)  { $out.gpuClockMHz  = $lhm.coreClock }
        if ($null -eq $out.vramClockMHz -and $null -ne $lhm.memClock)   { $out.vramClockMHz = $lhm.memClock }
        if ($null -eq $out.gpuTemp      -and $null -ne $lhm.nvidiaTemp) { $out.gpuTemp      = $lhm.nvidiaTemp }
        $out | ConvertTo-Json -Compress
        # `return` (not `exit`) ends the script for both the one-shot `-File` run and
        # the persistent worker's call-operator invocation, without killing the host.
        return
      }
    }
  }
} catch { }

# No nvidia-smi - GPU name from WMI (cached: the GPU does not change at runtime)
try {
  if (-not $global:XenonGpuWmiName) {
    $global:XenonGpuWmiName = (Get-CimInstance Win32_VideoController |
      Where-Object { $_.Name -and $_.Status -eq 'OK' } |
      Sort-Object AdapterRAM -Descending |
      Select-Object -First 1 -ExpandProperty Name)
  }
  $gpuName = $global:XenonGpuWmiName
} catch { }

try {
  $computer = Get-GpuLhmComputer
  if ($null -ne $computer) {
    try {
      foreach ($hardware in @(Select-LhmGpu -Computer $computer -Name $gpuName)) {
        if ($null -eq $hardware) { continue }
        try { $hardware.Update(); Set-LhmUpdated $hardware } catch { }
        foreach ($sensor in @($hardware.Sensors)) {
          try {
            $stype = $sensor.SensorType.ToString()
            if ($stype -eq 'Temperature') {
              if ($null -ne $sensor.Value -and $null -eq $gpuTemp) { $gpuTemp = [int]$sensor.Value }
            } elseif ($stype -eq 'SmallData') {
              # LHM exposes dedicated VRAM as SmallData in MB: "GPU Memory Used" /
              # "GPU Memory Total" (skip the "Shared"/system-memory variants).
              $sname = [string]$sensor.Name
              if ($sname -notmatch 'Shared' -and $null -ne $sensor.Value) {
                if ($sname -match 'Memory Used'  -and $null -eq $vramUsed)  { $vramUsed  = [int64]([double]$sensor.Value * 1048576) }
                if ($sname -match 'Memory Total' -and $null -eq $vramTotal) { $vramTotal = [int64]([double]$sensor.Value * 1048576) }
              }
            } elseif ($stype -eq 'Clock') {
              # Core and memory clocks in MHz, off the walk that is already here.
              # "GPU Shader" also lands in this bucket on older cards and is not
              # what a monitoring widget asks for, so only Core/Memory are taken.
              $cname = [string]$sensor.Name
              if ($null -ne $sensor.Value) {
                $mhz = [double]$sensor.Value
                if ($mhz -ge 1 -and $mhz -le 20000) {
                  if ($cname -match 'Core' -and $null -eq $gpuClockMHz) { $gpuClockMHz = [int][Math]::Round($mhz) }
                  elseif ($cname -match 'Memory|VRAM' -and $null -eq $vramClockMHz) { $vramClockMHz = [int][Math]::Round($mhz) }
                }
              }
            } elseif ($stype -eq 'Power') {
              # Board/package power draw in watts (AMD/Intel path - NVIDIA returns
              # early above with nvidia-smi's power.draw).
              if ($null -ne $sensor.Value -and $null -eq $gpuWatts) { $gpuWatts = [Math]::Round([double]$sensor.Value, 1) }
            } elseif ($stype -eq 'Fan') {
              # LHM reports every GPU fan in RPM (unlike nvidia-smi's single
              # percent), so multi-fan cards are collected individually here;
              # gpuFanRpm keeps the first one for older clients.
              if ($null -ne $sensor.Value) {
                $rpm = [int][Math]::Round([double]$sensor.Value)
                if ($rpm -ge 0 -and $rpm -le 20000) {
                  if ($null -eq $gpuFanRpm) { $gpuFanRpm = $rpm }
                  $fname = ([string]$sensor.Name).Trim()
                  if (-not $fname) { $fname = 'GPU Fan' }
                  if ($fname.Length -gt 48) { $fname = $fname.Substring(0, 48) }
                  $gpuFans += [pscustomobject]@{ name = $fname; rpm = $rpm }
                }
              }
            }
          } catch { }
        }
        if (-not $gpuName) { try { $gpuName = $hardware.Name } catch { } }
      }
    } catch {
      # Broken session (sleep/resume, driver reset): drop it and rebuild next read.
      try { $computer.Close() } catch { }
      $global:XenonGpuLhm = $null
      $global:XenonGpuLhmPick = $null
    }
  }
} catch { }

# GPU utilization via the GPU Engine performance counters - vendor-agnostic, no
# external tool. Read RAW with ReadCategory() and turned into a percentage against
# the previous call, NOT with Get-Counter: that costs 2.8 s per call and up to
# 13 s on a busy desktop (measured; see also the header of processes.ps1), longer
# than the 5 s tick itself, so on every machine without nvidia-smi the sensor
# worker never rested. The raw read costs a few ms. Same figure as before: the sum over
# every 3d/compute/video engine instance, clamped to 100; it is now the average
# over the whole tick instead of a one-second sample inside it.
$GPU_ENGINE_RE = 'engtype_(3d|compute|videoencode|videodecode)'
# A delta older than this is a guess (the tick stopped, or the PC slept): re-prime.
$GPU_STALE_MS = 30000
# Priming window, paid only on the first read after a (re)start, or on every run
# of the one-shot fallback, which has no previous call to diff against.
$GPU_PRIME_MS = 250

function Read-GpuEngineBusy {
  # Constructed once per worker: the first ReadCategory() builds PDH's instance
  # map (~330 ms), every later one costs a few ms. 'none' = checked, absent.
  if ($null -eq $global:XenonGpuEngineCat) {
    $global:XenonGpuEngineCat = 'none'
    try {
      if ([System.Diagnostics.PerformanceCounterCategory]::Exists('GPU Engine')) {
        $global:XenonGpuEngineCat = New-Object System.Diagnostics.PerformanceCounterCategory 'GPU Engine'
      }
    } catch { }
  }
  $cat = $global:XenonGpuEngineCat
  if ($cat -is [string]) { throw 'GPU Engine performance counters are not available' }
  $col = $cat.ReadCategory()['Utilization Percentage']
  if ($null -eq $col) { throw 'GPU Engine performance counters are not available' }
  # Raw = cumulative busy time in 100 ns units, per engine instance.
  $busy = @{}
  foreach ($k in $col.Keys) {
    if ($k -match $GPU_ENGINE_RE) { $busy[$k] = [double]$col[$k].RawValue }
  }
  return $busy
}

function Get-NowMs { [double](([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()) }

try {
  $now = Get-NowMs
  $curr = Read-GpuEngineBusy
  $prev = $global:XenonGpuEnginePrev
  $prevAt = 0.0
  if ($null -ne $global:XenonGpuEnginePrevAt) { $prevAt = [double]$global:XenonGpuEnginePrevAt }
  if ($null -eq $prev -or $prevAt -le 0 -or ($now - $prevAt) -gt $GPU_STALE_MS) {
    $prev = $curr
    $prevAt = $now
    Start-Sleep -Milliseconds $GPU_PRIME_MS
    $now = Get-NowMs
    $curr = Read-GpuEngineBusy
  }
  $global:XenonGpuEnginePrev = $curr
  $global:XenonGpuEnginePrevAt = $now
  $windowTicks = [Math]::Max(1.0, $now - $prevAt) * 10000.0   # ms -> 100 ns
  $sum = 0.0
  foreach ($k in $curr.Keys) {
    # An engine that appeared this tick has no baseline; it counts from the next.
    if (-not $prev.ContainsKey($k)) { continue }
    $d = $curr[$k] - $prev[$k]
    if ($d -gt 0) { $sum += ($d / $windowTicks) * 100.0 }
  }
  $gpu = [Math]::Min(100, [Math]::Max(0, [Math]::Round($sum, 0)))
  @{ gpu = $gpu; gpuTemp = $gpuTemp; gpuName = $gpuName; vramUsed = $vramUsed; vramTotal = $vramTotal; gpuWatts = $gpuWatts; gpuFanRpm = $gpuFanRpm; gpuFans = @($gpuFans); gpuClockMHz = $gpuClockMHz; vramClockMHz = $vramClockMHz } | ConvertTo-Json -Compress
} catch {
  @{ gpu = $null; gpuTemp = $gpuTemp; gpuName = $gpuName; vramUsed = $vramUsed; vramTotal = $vramTotal; gpuWatts = $gpuWatts; gpuFanRpm = $gpuFanRpm; gpuFans = @($gpuFans); gpuClockMHz = $gpuClockMHz; vramClockMHz = $vramClockMHz; error = $_.Exception.Message } | ConvertTo-Json -Compress
}

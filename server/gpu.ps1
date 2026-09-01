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

# Per-fan RPM straight from each card's tachometer, plus the core and memory
# clocks off the same enumeration. Cards with the fans stopped (idle zero-RPM
# mode) legitimately report 0 - that is a reading, not a gap, so it is kept. A
# GPU with no fan sensors at all (integrated graphics, a passive card)
# contributes nothing and the caller falls back to whatever it has.
#
# Clocks ride this walk rather than one of their own: the tree is already
# enumerated and Update()d here, so they cost nothing on top. Returns a hashtable
# so a card that exposes clocks but no fans is still worth the call.
function Get-LhmGpuReadings {
  $fans = @()
  $coreClock = $null
  $memClock = $null
  try {
    $computer = Get-GpuLhmComputer
    if ($null -eq $computer) { return @{ fans = $fans; coreClock = $null; memClock = $null } }
    foreach ($hardware in @($computer.Hardware)) {
      if ($hardware.HardwareType.ToString() -notmatch 'Gpu') { continue }
      try { $hardware.Update() } catch { }
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
  }
  return @{ fans = $fans; coreClock = $coreClock; memClock = $memClock }
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
    if ($line) {
      # Split on commas rather than one all-or-nothing regex: any field can be
      # "[N/A]" on some cards/drivers, so each is parsed independently. The name is
      # the last field (rejoined in case a model name ever contains a comma).
      $parts = $line -split '\s*,\s*'
      # The name is LAST and rejoined, so every new field goes BEFORE it and the
      # count below moves with the query above. Two clock fields were added here
      # (clocks.gr / clocks.mem): they cost nothing, being answered by the same
      # invocation that was already reading temperature and power.
      if ($parts.Count -ge 9) {
        $out = @{
          gpu     = $(if ($parts[0] -match '^\d+$') { [int]$parts[0] } else { $null })
          gpuTemp = $(if ($parts[1] -match '^\d+$') { [int]$parts[1] } else { $null })
          gpuName = ($parts[8..($parts.Count - 1)] -join ', ').Trim()
        }
        # nvidia-smi reports memory in MiB (nounits); convert to bytes so the client
        # formats VRAM with the same helper it uses for RAM/disk.
        if ($parts[2] -match '^\d+$') { $out.vramUsed  = [int64]$parts[2] * 1048576 }
        if ($parts[3] -match '^\d+$') { $out.vramTotal = [int64]$parts[3] * 1048576 }
        # power.draw is a float in watts; fan.speed is a PERCENT (0-100).
        if ($parts[4] -match '^\d+(\.\d+)?$') { $out.gpuWatts  = [Math]::Round([double]$parts[4], 1) }
        if ($parts[5] -match '^\d+$')         { $out.gpuFanPct = [int]$parts[5] }
        # Real per-fan RPM beats nvidia-smi's fan.speed, which is the fan curve's
        # TARGET rather than the fan itself: an idle card in zero-RPM mode reports
        # "32%" while both fans are stopped. LHM reads each fan's tachometer, so a
        # two-fan card shows two true readings instead of one aggregate guess.
        # Costs ~77ms on top of nvidia-smi's ~30ms, amortized by the server's 5s
        # cache; gpuFanPct stays in the payload as the fallback for cards LHM
        # exposes no fan sensors for.
        # Always emitted, even empty: the server tells "no fans reported" (drop
        # the stale list) from "no read happened" (keep it) by the key's mere
        # presence, so omitting it on an empty result would freeze old RPM
        # forever on a card that genuinely stopped reporting.
        # clocks.gr is the graphics/core clock, clocks.mem the memory clock, both
        # in MHz. "[N/A]" on a card or driver that does not report one leaves the
        # key absent, which the server reads as "no answer" rather than zero.
        if ($parts[6] -match '^\d+$') { $out.gpuClockMHz  = [int]$parts[6] }
        if ($parts[7] -match '^\d+$') { $out.vramClockMHz = [int]$parts[7] }
        $lhm = Get-LhmGpuReadings
        $out.gpuFans = @($lhm.fans)
        # LHM only fills a gap here - nvidia-smi is the authority on an NVIDIA card.
        if ($null -eq $out.gpuClockMHz  -and $null -ne $lhm.coreClock) { $out.gpuClockMHz  = $lhm.coreClock }
        if ($null -eq $out.vramClockMHz -and $null -ne $lhm.memClock)  { $out.vramClockMHz = $lhm.memClock }
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
      foreach ($hardware in @($computer.Hardware)) {
        if ($hardware.HardwareType.ToString() -notmatch 'Gpu') { continue }
        try { $hardware.Update() } catch { }
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
    }
  }
} catch { }

# GPU utilization via Windows Performance Counters - vendor-agnostic, no external tool required
try {
  $samples = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop
  $sum = 0
  foreach ($sample in $samples.CounterSamples) {
    if ($sample.InstanceName -match 'engtype_(3d|compute|videoencode|videodecode)') {
      $sum += $sample.CookedValue
    }
  }
  $gpu = [Math]::Min(100, [Math]::Max(0, [Math]::Round($sum, 0)))
  @{ gpu = $gpu; gpuTemp = $gpuTemp; gpuName = $gpuName; vramUsed = $vramUsed; vramTotal = $vramTotal; gpuWatts = $gpuWatts; gpuFanRpm = $gpuFanRpm; gpuFans = @($gpuFans); gpuClockMHz = $gpuClockMHz; vramClockMHz = $vramClockMHz } | ConvertTo-Json -Compress
} catch {
  @{ gpu = $null; gpuTemp = $gpuTemp; gpuName = $gpuName; vramUsed = $vramUsed; vramTotal = $vramTotal; gpuWatts = $gpuWatts; gpuFanRpm = $gpuFanRpm; gpuFans = @($gpuFans); gpuClockMHz = $gpuClockMHz; vramClockMHz = $vramClockMHz; error = $_.Exception.Message } | ConvertTo-Json -Compress
}

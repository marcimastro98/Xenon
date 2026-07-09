$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$gpuName = $null
$gpuTemp = $null
$vramUsed = $null
$vramTotal = $null

try {
  # Path cached across worker calls ($global: survives the per-call child scope);
  # the PATH lookup is repeated only while nvidia-smi is absent.
  if (-not $global:XenonNvidiaSmiPath) {
    $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($nvidiaSmi) { $global:XenonNvidiaSmiPath = $nvidiaSmi.Source }
  }
  if ($global:XenonNvidiaSmiPath) {
    $line = & $global:XenonNvidiaSmiPath --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($line) {
      # Split on commas rather than one all-or-nothing regex: any field can be
      # "[N/A]" on some cards/drivers, so each is parsed independently. The name is
      # the last field (rejoined in case a model name ever contains a comma).
      $parts = $line -split '\s*,\s*'
      if ($parts.Count -ge 5) {
        $out = @{
          gpu     = $(if ($parts[0] -match '^\d+$') { [int]$parts[0] } else { $null })
          gpuTemp = $(if ($parts[1] -match '^\d+$') { [int]$parts[1] } else { $null })
          gpuName = ($parts[4..($parts.Count - 1)] -join ', ').Trim()
        }
        # nvidia-smi reports memory in MiB (nounits); convert to bytes so the client
        # formats VRAM with the same helper it uses for RAM/disk.
        if ($parts[2] -match '^\d+$') { $out.vramUsed  = [int64]$parts[2] * 1048576 }
        if ($parts[3] -match '^\d+$') { $out.vramTotal = [int64]$parts[3] * 1048576 }
        $out | ConvertTo-Json -Compress
        # `return` (not `exit`) ends the script for both the one-shot `-File` run and
        # the persistent worker's call-operator invocation, without killing the host.
        return
      }
    }
  }
} catch { }

# No nvidia-smi — get GPU name from WMI (cached: the GPU does not change at runtime)
try {
  if (-not $global:XenonGpuWmiName) {
    $global:XenonGpuWmiName = (Get-CimInstance Win32_VideoController |
      Where-Object { $_.Name -and $_.Status -eq 'OK' } |
      Sort-Object AdapterRAM -Descending |
      Select-Object -First 1 -ExpandProperty Name)
  }
  $gpuName = $global:XenonGpuWmiName
} catch { }

# GPU temperature via LibreHardwareMonitor — works for AMD, Intel, and NVIDIA without nvidia-smi.
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

# GPU utilization via Windows Performance Counters — vendor-agnostic, no external tool required
try {
  $samples = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop
  $sum = 0
  foreach ($sample in $samples.CounterSamples) {
    if ($sample.InstanceName -match 'engtype_(3d|compute|videoencode|videodecode)') {
      $sum += $sample.CookedValue
    }
  }
  $gpu = [Math]::Min(100, [Math]::Max(0, [Math]::Round($sum, 0)))
  @{ gpu = $gpu; gpuTemp = $gpuTemp; gpuName = $gpuName; vramUsed = $vramUsed; vramTotal = $vramTotal } | ConvertTo-Json -Compress
} catch {
  @{ gpu = $null; gpuTemp = $gpuTemp; gpuName = $gpuName; vramUsed = $vramUsed; vramTotal = $vramTotal; error = $_.Exception.Message } | ConvertTo-Json -Compress
}

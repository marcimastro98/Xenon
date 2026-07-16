$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$script:tempCandidates = @()
$script:fanReadings = @()
$script:cpuWattCandidates = @()
$script:psuWattCandidates = @()

function Add-CpuTempCandidate {
  param(
    [string]$Name,
    $Value,
    [int]$Priority = 0
  )

  if ($null -eq $Value) { return }
  $number = 0.0
  if (-not [double]::TryParse(([string]$Value), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return
  }
  if ($number -le 5 -or $number -ge 120) { return }

  $script:tempCandidates += [pscustomobject]@{
    Name = $Name
    Value = $number
    Priority = $Priority
  }
}

function Get-LibreHardwareMonitorDll {
  $candidates = @()

  try {
    $command = Get-Command LibreHardwareMonitor.exe -ErrorAction SilentlyContinue
    if ($command) {
      $candidates += Join-Path (Split-Path -Parent $command.Source) 'LibreHardwareMonitorLib.dll'
    }
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
  $programFilesX86 = ${env:ProgramFiles(x86)}
  if ($programFilesX86) { $candidates += Join-Path $programFilesX86 'LibreHardwareMonitor\LibreHardwareMonitorLib.dll' }

  return ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

function Update-HardwareTree {
  param($Hardware)

  if ($null -eq $Hardware) { return }
  try { $Hardware.Update() } catch { }
  foreach ($subHardware in @($Hardware.SubHardware)) {
    Update-HardwareTree $subHardware
  }
}

function Add-HardwareTemperatureSensors {
  param($Hardware)

  if ($null -eq $Hardware) { return }
  foreach ($sensor in @($Hardware.Sensors)) {
    try {
      if ($sensor.SensorType.ToString() -ne 'Temperature') { continue }
      $name = [string]$sensor.Name
      $priority = 1
      if ($name -match 'Package|Tctl|Tdie|CCD|Core Average') { $priority = 3 }
      elseif ($name -match 'Core') { $priority = 2 }
      Add-CpuTempCandidate -Name $name -Value $sensor.Value -Priority $priority
    } catch { }
  }

  foreach ($subHardware in @($Hardware.SubHardware)) {
    Add-HardwareTemperatureSensors $subHardware
  }
}

# Fan RPM and power (watts) live on the same LHM trees the temps come from:
# Cpu (package power), Motherboard→SubHardware/SuperIO (chassis/CPU fan headers)
# and Psu (digital PSUs like Corsair HXi/RMi). 0 RPM is kept — a stopped fan is
# real data, not a missing sensor.
function Add-HardwareFanPowerSensors {
  param($Hardware, [string]$Context)

  if ($null -eq $Hardware) { return }
  foreach ($sensor in @($Hardware.Sensors)) {
    try {
      if ($null -eq $sensor.Value) { continue }
      $stype = $sensor.SensorType.ToString()
      if ($stype -eq 'Fan') {
        $name = ([string]$sensor.Name).Trim()
        if (-not $name) { $name = 'Fan' }
        if ($name.Length -gt 48) { $name = $name.Substring(0, 48) }
        $rpm = [int][Math]::Round([double]$sensor.Value)
        if ($rpm -lt 0 -or $rpm -gt 20000) { continue }
        $script:fanReadings += [pscustomobject]@{ name = $name; rpm = $rpm }
      } elseif ($stype -eq 'Power') {
        $watts = [Math]::Round([double]$sensor.Value, 1)
        if ($watts -lt 0 -or $watts -gt 5000) { continue }
        $name = [string]$sensor.Name
        if ($Context -eq 'Cpu') {
          $priority = 1
          if ($name -match 'Package|PPT') { $priority = 3 }
          elseif ($name -match 'CPU') { $priority = 2 }
          $script:cpuWattCandidates += [pscustomobject]@{ Value = $watts; Priority = $priority }
        } elseif ($Context -eq 'Psu') {
          $priority = if ($name -match 'Total|Power$') { 2 } else { 1 }
          $script:psuWattCandidates += [pscustomobject]@{ Value = $watts; Priority = $priority }
        }
      }
    } catch { }
  }

  foreach ($subHardware in @($Hardware.SubHardware)) {
    Add-HardwareFanPowerSensors $subHardware $Context
  }
}

# Persistent LHM session. Inside pwsh-worker this script runs every few seconds
# in the SAME process, and rebuilding the Computer each time (DLL discovery on
# disk, hardware enumeration, kernel-driver open/close) cost ~10x the read
# itself — it was the worker's dominant CPU draw. $global: survives the
# worker's per-call child scope ($script: resets by design). Not Close()-ing is
# safe in both modes: the OS reclaims the driver handles on process exit.
function Get-CpuLhmComputer {
  if ($global:XenonCpuLhm) { return $global:XenonCpuLhm }
  # A failed init (LHM not installed) is re-tried at most every 5 minutes so a
  # long-lived worker doesn't pay the disk scan on every read, but still picks
  # LHM up if the user installs it later.
  if ($global:XenonCpuLhmFailedAt -and ((Get-Date) - $global:XenonCpuLhmFailedAt).TotalSeconds -lt 300) { return $null }
  $locationPushed = $false
  try {
    $dll = Get-LibreHardwareMonitorDll
    if (-not $dll) { $global:XenonCpuLhmFailedAt = Get-Date; return $null }
    Push-Location (Split-Path -Parent $dll)
    $locationPushed = $true
    Add-Type -Path $dll
    $computer = [LibreHardwareMonitor.Hardware.Computer]::new()
    $computer.IsCpuEnabled = $true
    # Motherboard (SuperIO fan headers) and PSU (digital PSUs) trees feed the
    # fans/power readings; their per-read Update() cost is amortized by the
    # server-side cache the same way the CPU tree's is.
    $computer.IsMotherboardEnabled = $true
    $computer.IsPsuEnabled = $true
    $computer.Open()
    $global:XenonCpuLhm = $computer
    $global:XenonCpuLhmFailedAt = $null
    return $computer
  } catch {
    $global:XenonCpuLhmFailedAt = Get-Date
    return $null
  } finally {
    try { if ($locationPushed) { Pop-Location } } catch { }
  }
}

function Add-SensorsFromLibreHardwareMonitorLibrary {
  $computer = Get-CpuLhmComputer
  if ($null -eq $computer) { return }
  try {
    foreach ($hardware in @($computer.Hardware)) {
      $htype = $hardware.HardwareType.ToString()
      if ($htype -match 'Cpu') {
        Update-HardwareTree $hardware
        Add-HardwareTemperatureSensors $hardware
        Add-HardwareFanPowerSensors $hardware 'Cpu'
      } elseif ($htype -match 'Motherboard') {
        Update-HardwareTree $hardware
        Add-HardwareFanPowerSensors $hardware 'Motherboard'
      } elseif ($htype -match 'Psu') {
        Update-HardwareTree $hardware
        Add-HardwareFanPowerSensors $hardware 'Psu'
      }
    }
  } catch {
    # Broken session (sleep/resume, driver reset): drop it and rebuild next read.
    try { $computer.Close() } catch { }
    $global:XenonCpuLhm = $null
  }
}

function Add-TempsFromHardwareMonitorWmi {
  param(
    [string]$Namespace,
    [switch]$UseCim
  )

  try {
    if ($UseCim) {
      $sensors = Get-CimInstance -Namespace $Namespace -ClassName Sensor -ErrorAction Stop
    } else {
      $sensors = Get-WmiObject -Namespace $Namespace -Class Sensor -ErrorAction Stop
    }

    foreach ($sensor in @($sensors)) {
      if ($sensor.SensorType -ne 'Temperature') { continue }
      $name = [string]$sensor.Name
      if ($name -notmatch 'CPU|Package|CCD|Tctl|Tdie|Core') { continue }
      $priority = 1
      if ($name -match 'Package|Tctl|Tdie|CCD|Core Average') { $priority = 3 }
      elseif ($name -match 'Core') { $priority = 2 }
      Add-CpuTempCandidate -Name $name -Value $sensor.Value -Priority $priority
    }
  } catch { }
}

function Add-TempsFromWindowsThermalZones {
  try {
    $rawValues = @(Get-WmiObject -Namespace root/wmi -Class MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
      Select-Object -ExpandProperty CurrentTemperature)
    foreach ($rawValue in $rawValues) {
      Add-CpuTempCandidate -Name 'Windows Thermal Zone' -Value (($rawValue - 2732) / 10) -Priority 0
    }
  } catch { }
}

Add-SensorsFromLibreHardwareMonitorLibrary
# WMI fallbacks only when the library gave nothing: each is a WMI roundtrip
# that used to run on EVERY read even with a perfectly good LHM result.
# (They provide temperatures only — fans/power are LHM-only by design.)
if ($script:tempCandidates.Count -eq 0) {
  Add-TempsFromHardwareMonitorWmi -Namespace 'root/LibreHardwareMonitor' -UseCim
  Add-TempsFromHardwareMonitorWmi -Namespace 'root/OpenHardwareMonitor'
  Add-TempsFromWindowsThermalZones
}

$cpuTemp = $script:tempCandidates |
  Sort-Object @{ Expression = 'Priority'; Descending = $true }, @{ Expression = 'Value'; Descending = $true } |
  Select-Object -First 1 -ExpandProperty Value

$cpuWatts = $script:cpuWattCandidates |
  Sort-Object @{ Expression = 'Priority'; Descending = $true }, @{ Expression = 'Value'; Descending = $true } |
  Select-Object -First 1 -ExpandProperty Value

$psuWatts = $script:psuWattCandidates |
  Sort-Object @{ Expression = 'Priority'; Descending = $true }, @{ Expression = 'Value'; Descending = $true } |
  Select-Object -First 1 -ExpandProperty Value

[pscustomobject]@{
  cpuTemp  = if ($null -ne $cpuTemp) { [double]$cpuTemp } else { $null }
  fans     = @($script:fanReadings)
  cpuWatts = if ($null -ne $cpuWatts) { [double]$cpuWatts } else { $null }
  psuWatts = if ($null -ne $psuWatts) { [double]$psuWatts } else { $null }
} | ConvertTo-Json -Compress -Depth 4
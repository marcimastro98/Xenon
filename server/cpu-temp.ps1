$ErrorActionPreference = 'Stop'

$script:tempCandidates = @()

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

function Add-TempsFromLibreHardwareMonitorLibrary {
  $dll = Get-LibreHardwareMonitorDll
  if (-not $dll) { return }

  $computer = $null
  $locationPushed = $false
  try {
    Push-Location (Split-Path -Parent $dll)
    $locationPushed = $true
    Add-Type -Path $dll

    $computer = [LibreHardwareMonitor.Hardware.Computer]::new()
    $computer.IsCpuEnabled = $true
    $computer.Open()

    foreach ($hardware in @($computer.Hardware)) {
      if ($hardware.HardwareType.ToString() -notmatch 'Cpu') { continue }
      Update-HardwareTree $hardware
      Add-HardwareTemperatureSensors $hardware
    }
  } catch { }
  finally {
    try { if ($computer) { $computer.Close() } } catch { }
    try { if ($locationPushed) { Pop-Location } } catch { }
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

Add-TempsFromLibreHardwareMonitorLibrary
Add-TempsFromHardwareMonitorWmi -Namespace 'root/LibreHardwareMonitor' -UseCim
Add-TempsFromHardwareMonitorWmi -Namespace 'root/OpenHardwareMonitor'
Add-TempsFromWindowsThermalZones

$cpuTemp = $script:tempCandidates |
  Sort-Object @{ Expression = 'Priority'; Descending = $true }, @{ Expression = 'Value'; Descending = $true } |
  Select-Object -First 1 -ExpandProperty Value

[pscustomobject]@{
  cpuTemp = if ($null -ne $cpuTemp) { [double]$cpuTemp } else { $null }
} | ConvertTo-Json -Compress
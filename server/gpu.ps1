$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$gpuName = $null
$gpuTemp = $null

try {
  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($nvidiaSmi) {
    $line = & $nvidiaSmi.Source --query-gpu=utilization.gpu,temperature.gpu,name --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($line -match '^\s*(\d+)\s*,\s*(\d+)\s*,\s*(.+?)\s*$') {
      @{ gpu = [int]$matches[1]; gpuTemp = [int]$matches[2]; gpuName = $matches[3] } | ConvertTo-Json -Compress
      # `return` (not `exit`) ends the script for both the one-shot `-File` run and
      # the persistent worker's call-operator invocation, without killing the host.
      return
    }
    if ($line -match '^\s*(\d+)\s*,\s*(.+?)\s*$') {
      @{ gpu = [int]$matches[1]; gpuTemp = $null; gpuName = $matches[2] } | ConvertTo-Json -Compress
      return
    }
  }
} catch { }

# No nvidia-smi — get GPU name from WMI
try {
  $gpuName = (Get-CimInstance Win32_VideoController |
    Where-Object { $_.Name -and $_.Status -eq 'OK' } |
    Sort-Object AdapterRAM -Descending |
    Select-Object -First 1 -ExpandProperty Name)
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

try {
  $dll = Get-LibreHardwareMonitorDll
  if ($dll) {
    $computer = $null
    $locationPushed = $false
    try {
      Push-Location (Split-Path -Parent $dll)
      $locationPushed = $true
      Add-Type -Path $dll
      $computer = [LibreHardwareMonitor.Hardware.Computer]::new()
      $computer.IsGpuEnabled = $true
      $computer.Open()
      foreach ($hardware in @($computer.Hardware)) {
        if ($hardware.HardwareType.ToString() -notmatch 'Gpu') { continue }
        try { $hardware.Update() } catch { }
        foreach ($sensor in @($hardware.Sensors)) {
          try {
            if ($sensor.SensorType.ToString() -ne 'Temperature') { continue }
            if ($null -ne $sensor.Value -and $null -eq $gpuTemp) {
              $gpuTemp = [int]$sensor.Value
            }
          } catch { }
        }
        if (-not $gpuName) { try { $gpuName = $hardware.Name } catch { } }
      }
    } finally {
      try { if ($computer) { $computer.Close() } } catch { }
      try { if ($locationPushed) { Pop-Location } } catch { }
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
  @{ gpu = $gpu; gpuTemp = $gpuTemp; gpuName = $gpuName } | ConvertTo-Json -Compress
} catch {
  @{ gpu = $null; gpuTemp = $gpuTemp; gpuName = $gpuName; error = $_.Exception.Message } | ConvertTo-Json -Compress
}

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

# LibreHardwareMonitor reads CPU power/temperature over the MSR and fan RPM over
# the SuperIO chip; both go through a kernel driver it can only load with admin
# rights. Unelevated it still opens and still exposes the sensor nodes — they
# just read 0/null forever. So elevation, not the DLL's presence, is what decides
# whether these sensors can work, and the dashboard must be able to say which of
# the two is missing instead of telling a user with LHM installed to install LHM.
function Test-SensorAdmin {
  if ($null -ne $global:XenonIsAdmin) { return $global:XenonIsAdmin }
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $global:XenonIsAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    $global:XenonIsAdmin = $false
  }
  return $global:XenonIsAdmin
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
  param($Hardware, [string]$Context, [string]$NamePrefix)

  if ($null -eq $Hardware) { return }
  foreach ($sensor in @($Hardware.Sensors)) {
    try {
      if ($null -eq $sensor.Value) { continue }
      $stype = $sensor.SensorType.ToString()
      if ($stype -eq 'Fan') {
        $name = ([string]$sensor.Name).Trim()
        if (-not $name) { $name = 'Fan' }
        # Controllers name their sensors "Fan 1"/"Pump" — with two of them (an
        # Octo + a Kraken) those collide, and alone they identify nothing. The
        # device name disambiguates and tells the user what it belongs to.
        if ($NamePrefix) { $name = "$NamePrefix $name" }
        if ($name.Length -gt 48) { $name = $name.Substring(0, 48) }
        $rpm = [int][Math]::Round([double]$sensor.Value)
        if ($rpm -lt 0 -or $rpm -gt 20000) { continue }
        # Where the fan physically is, so the client can group by origin: a PSU's
        # own fan must not be presented as a motherboard header, and a fan on an
        # AIO/hub controller ('ctrl') isn't a header either.
        $kind = if ($Context -eq 'Psu') { 'psu' } elseif ($Context -eq 'Cooler') { 'ctrl' } else { 'mb' }
        $script:fanReadings += [pscustomobject]@{ name = $name; rpm = $rpm; kind = $kind }
      } elseif ($stype -eq 'Power') {
        $watts = [Math]::Round([double]$sensor.Value, 1)
        # Exactly 0 W is never a real reading from a powered rail: LHM keeps the
        # sensor node but reports 0 when it cannot reach the MSR/SuperIO (no
        # admin rights → no kernel driver). Emitting it would render a confident
        # "0 W" card where the truth is "no data".
        if ($watts -le 0 -or $watts -gt 5000) { continue }
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
    Add-HardwareFanPowerSensors $subHardware $Context $NamePrefix
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
    # Fan/pump controllers and AIOs (HardwareType.Cooler): NZXT Kraken/Grid,
    # Aquacomputer Octo/Quadro/D5 Next, MSI CoreLiquid, Razer, Arctic, AeroCool.
    # These carry the fans that bypass the motherboard headers entirely — the
    # very ones users count in their case and don't find in the widget.
    # Own try: on a DLL old enough to lack the property, the set must cost only
    # the controller fans — not (via the outer catch) the whole LHM session.
    try { $computer.IsControllerEnabled = $true } catch { }
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

# --- Corsair digital PSUs LHM's own group refuses ---------------------------
# LHM reads Corsair i-series PSUs over HID, but CorsairPsuGroup gates that on a
# hard-coded product-id allowlist (0x1c03-0x1c0d, 0x1c1e, 0x1c1f) which has not
# kept up with the hardware: an HX1200i (2023) reports 0x1c27 and is dropped, so
# no Psu tree ever appears and wall watts silently never work. The driver class
# itself handles it perfectly — only the doorman is out of date.
#
# So when no Psu tree turned up, we walk past the doorman: find Corsair HIDs
# whose USB product string says "Power Supply" (generic — no product id is
# hard-coded here either, so future models work untouched) and drive LHM's own
# CorsairPsu against them. Read-only, and verified to coexist with iCUE polling
# the same PSU. Reflection over an internal ctor is fragile by nature, so every
# step fails soft: a broken build simply means no PSU card, never an error.
function Get-CorsairPsuDirect {
  if ($global:XenonCorsairPsu) { return $global:XenonCorsairPsu }
  if ($global:XenonCorsairPsuFailedAt -and ((Get-Date) - $global:XenonCorsairPsuFailedAt).TotalSeconds -lt 300) { return $null }
  try {
    $dll = Get-LibreHardwareMonitorDll
    if (-not $dll) { $global:XenonCorsairPsuFailedAt = Get-Date; return $null }
    $dir = Split-Path -Parent $dll
    $hidSharp = Join-Path $dir 'HidSharp.dll'
    if (-not (Test-Path $hidSharp)) { $global:XenonCorsairPsuFailedAt = Get-Date; return $null }
    # LoadFrom is idempotent: the LHM assembly already pulled HidSharp in.
    $hidAsm = [Reflection.Assembly]::LoadFrom($hidSharp)
    $lhmAsm = [Reflection.Assembly]::LoadFrom($dll)

    $psuType = $lhmAsm.GetType('LibreHardwareMonitor.Hardware.Psu.Corsair.CorsairPsu')
    $settingsType = $lhmAsm.GetType('LibreHardwareMonitor.Hardware.Computer+Settings')
    if (-not $psuType -or -not $settingsType) { $global:XenonCorsairPsuFailedAt = Get-Date; return $null }
    $ctor = @($psuType.GetConstructors([Reflection.BindingFlags]'NonPublic,Public,Instance'))[0]
    $settingsCtor = @($settingsType.GetConstructors([Reflection.BindingFlags]'NonPublic,Public,Instance'))[0]
    if (-not $ctor -or -not $settingsCtor) { $global:XenonCorsairPsuFailedAt = Get-Date; return $null }

    $deviceListType = $hidAsm.GetType('HidSharp.DeviceList')
    $local = $deviceListType.GetProperty('Local').GetValue($null)
    $psuHid = $null
    $psuModel = $null
    foreach ($hid in @($local.GetHidDevices(0x1B1C))) {
      $product = try { $hid.GetProductName() } catch { '' }
      if ($product -match 'Power Supply') {
        $psuHid = $hid
        # "HX1200i Power Supply" -> "HX1200i". The model is the only name a user
        # recognizes: LHM calls the PSU's own fan sensor "Case" (its internal
        # case, not the PC's), which reads as a mystery chassis fan stuck at 0.
        $psuModel = ([string]$product -replace '\s*Power Supply\s*$', '').Trim()
        break
      }
    }
    if ($null -eq $psuHid) { $global:XenonCorsairPsuFailedAt = Get-Date; return $null }
    $global:XenonCorsairPsuModel = if ($psuModel) { $psuModel } else { 'PSU' }

    # The reflection binder rejects PowerShell's PSObject wrappers.
    $argv = New-Object 'System.Object[]' 3
    $argv[0] = $psuHid.PSObject.BaseObject
    $argv[1] = $settingsCtor.Invoke(@())
    $argv[2] = [int]0
    $psu = $ctor.Invoke($argv)
    $global:XenonCorsairPsu = $psu
    $global:XenonCorsairPsuFailedAt = $null
    return $psu
  } catch {
    $global:XenonCorsairPsuFailedAt = Get-Date
    return $null
  }
}

# How long a PSU reading may stand in for a contended one. Each watt/fan value
# is a multi-step request/response exchange with the PSU controller, so when
# iCUE (which polls the same PSU constantly) is mid-exchange, ours comes back
# with voltages and temperatures but no power — empirically ~1 read in 3, purely
# transient, and never the same sensor twice in a row. Without this the wall-draw
# card would blink in and out of existence every few seconds. 30s = 6 read cycles:
# long enough to bridge the gaps, short enough that a PSU which genuinely stopped
# answering disappears promptly instead of freezing a number on screen forever.
$script:PsuGraceSeconds = 30

# One sensor's last good reading, and how long it may stand in for a contended
# one. Watts and the fan fail INDEPENDENTLY, so each gets its own slot and its
# own clock — a read where only one answered must never blank the other's cached
# value. A cached value is returned but never re-stamped: the window ages from
# the last real reading, so a PSU that genuinely stopped answering goes quiet
# after PsuGraceSeconds instead of echoing its own output forever.
function Resolve-PsuReading {
  param([string]$Key, $Fresh, [datetime]$Now)

  if ($null -eq $global:XenonPsuCache) { $global:XenonPsuCache = @{} }
  if ($null -ne $Fresh) {
    $global:XenonPsuCache[$Key] = [pscustomobject]@{ value = $Fresh; at = $Now }
    return $Fresh
  }
  $slot = $global:XenonPsuCache[$Key]
  if ($slot -and ($Now - $slot.at).TotalSeconds -lt $script:PsuGraceSeconds) { return $slot.value }
  return $null
}

function Add-CorsairPsuDirectSensors {
  $psu = Get-CorsairPsuDirect
  if ($null -eq $psu) { return }
  $watts = $null
  $fanName = $null
  $fanRpm = $null
  try {
    $psu.Update()
    foreach ($sensor in @($psu.Sensors)) {
      try {
        if ($null -eq $sensor.Value) { continue }
        $stype = $sensor.SensorType.ToString()
        $sname = ([string]$sensor.Name).Trim()
        # "Total watts" is the PSU's OUTPUT power — measured, not the wall draw:
        # over 27 clean samples it tracked LHM's "Total Output" (the rail sum) at
        # a mean ratio of 1.005, where the input would sit ~1.10x higher at this
        # PSU's 91% efficiency. So it is what the whole PC pulls from the supply.
        # Picked by exact name: a sort tie-break against "Total Output" would
        # silently swap meaning between reads. "Total Output" is deliberately NOT
        # used even though it means the same — it is a SUM LHM computes from the
        # rails, so a read where one rail is contended yields a plausible, wrong,
        # lower number, while "Total watts" is one atomic register.
        if ($stype -eq 'Power' -and $sname -eq 'Total watts') {
          $w = [Math]::Round([double]$sensor.Value, 1)
          if ($w -gt 0 -and $w -le 5000) { $watts = $w }
        } elseif ($stype -eq 'Fan' -and $null -eq $fanRpm) {
          $rpm = [int][Math]::Round([double]$sensor.Value)
          if ($rpm -ge 0 -and $rpm -le 20000) {
            $fanRpm = $rpm
            # NOT $sensor.Name: LHM names this fan "Case", which lands in the
            # widget as a phantom chassis fan permanently at 0. The model is what
            # the user recognizes ("HX1200i"), and 0 RPM then reads correctly —
            # an i-series PSU stops its fan below ~40% load.
            $fanName = if ($global:XenonCorsairPsuModel) { [string]$global:XenonCorsairPsuModel } else { 'PSU' }
            if ($fanName.Length -gt 48) { $fanName = $fanName.Substring(0, 48) }
          }
        }
      } catch { }
    }
  } catch {
    # Broken session (sleep/resume, USB reset): drop it and rebuild next read —
    # but behind the same cooldown as every other failure here, so a device stuck
    # in a bad state can't turn this into a rebuild-the-HID-handle-every-5s loop
    # that fights iCUE for the PSU instead of backing off from it.
    try { $psu.Close() } catch { }
    $global:XenonCorsairPsu = $null
    $global:XenonCorsairPsuFailedAt = Get-Date
    return
  }

  $now = Get-Date
  $watts = Resolve-PsuReading 'watts' $watts $now
  $fan = Resolve-PsuReading 'fan' $(if ($null -ne $fanRpm) { [pscustomobject]@{ name = $fanName; rpm = $fanRpm } } else { $null }) $now

  if ($null -ne $watts) { $script:psuWattCandidates += [pscustomobject]@{ Value = $watts; Priority = 2 } }
  if ($null -ne $fan) { $script:fanReadings += [pscustomobject]@{ name = $fan.name; rpm = $fan.rpm; kind = 'psu' } }
}

function Add-SensorsFromLibreHardwareMonitorLibrary {
  $computer = Get-CpuLhmComputer
  if ($null -eq $computer) { return }
  $sawPsu = $false
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
        $sawPsu = $true
      } elseif ($htype -match 'Cooler') {
        # AIO / fan-hub controllers: their Fan sensors (fans AND pump) are the
        # readings a motherboard-only scan can never see.
        Update-HardwareTree $hardware
        $prefix = try { ([string]$hardware.Name).Trim() } catch { '' }
        Add-HardwareFanPowerSensors $hardware 'Cooler' $prefix
      }
    }
  } catch {
    # Broken session (sleep/resume, driver reset): drop it and rebuild next read.
    try { $computer.Close() } catch { }
    $global:XenonCpuLhm = $null
  }
  # Only when LHM produced nothing itself — never open the same PSU twice.
  if (-not $sawPsu) { Add-CorsairPsuDirectSensors }
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

# Why fans/watts are empty, so the widgets can give the ONE hint that actually
# helps: 'ok' (sensors reachable), 'needs_admin' (LHM there, no kernel driver),
# 'missing' (no LHM at all).
$sensorAccess = 'missing'
if ($global:XenonCpuLhm) { $sensorAccess = if (Test-SensorAdmin) { 'ok' } else { 'needs_admin' } }

[pscustomobject]@{
  cpuTemp      = if ($null -ne $cpuTemp) { [double]$cpuTemp } else { $null }
  fans         = @($script:fanReadings)
  cpuWatts     = if ($null -ne $cpuWatts) { [double]$cpuWatts } else { $null }
  psuWatts     = if ($null -ne $psuWatts) { [double]$psuWatts } else { $null }
  sensorAccess = $sensorAccess
} | ConvertTo-Json -Compress -Depth 4
# Airflow's hands on Windows, the service's side (dot-sourced by sensor-service.ps1
# after fan-hands.ps1, whose rules it runs): what the open LHM session shows, and the
# files - fan-held.json before any write, fan.json every tick while active.

# What the session shows: controls (motherboard headers, graphics cards, USB coolers), fan
# speeds, and the temperatures and watts the engine's brain and the rules (fan-hands.ps1)
# need. cpu-temp.ps1 has just updated the CPU, motherboard and cooler trees this
# tick; only the graphics cards, which it skips, are updated here.
#
# Graphics card controls: NVIDIA, and AMD where LHM offers one (it uses the old
# Overdrive5 calls; on RDNA3 and later a fixed speed often does nothing, which the fan
# check sees). Cooler controls: the USB coolers LHM drives (NZXT Kraken and Grid, MSI
# CoreLiquid, ARCTIC, Razer). The engine drives an AMD card or a cooler only once the
# fan check saw its fan go back when let go (server/airflow/calibrate-back.js). Intel
# cards have no control in LHM; their fans stay with the card.
function Get-FanHardware($Computer) {
  $r = @{ controls = @(); fans = @(); cpuName = ''
    temps = @{ cpu = $null; gpu = $null; gpuHot = $null; gpuMem = $null; liquid = $null; board = $null }
    power = @{ cpu = $null; gpu = $null } }
  $cpuPri = -1; $cpuWPri = -1
  $todo = New-Object System.Collections.Stack
  foreach ($hw in @($Computer.Hardware)) { $todo.Push(@($hw, [string]$hw.HardwareType)) }
  while ($todo.Count) {
    $item = $todo.Pop(); $hw = $item[0]; $top = $item[1]
    $kind = switch -regex ($top) { '^Gpu' { 'gpu' } '^Motherboard$' { 'mb' } '^Cpu$' { 'cpu' } '^Cooler$' { 'ctrl' } default { $null } }
    if (-not $kind) { continue }
    if ($kind -eq 'gpu' -and [string]$hw.HardwareType -eq $top) { try { $hw.Update() } catch { } }
    if ($kind -eq 'cpu' -and -not $r.cpuName) { $r.cpuName = [string]$hw.Name }
    foreach ($sub in @($hw.SubHardware)) { $todo.Push(@($sub, $top)) }
    foreach ($s in @($hw.Sensors)) {
      try {
        $type = $s.SensorType.ToString(); $name = [string]$s.Name; $v = $s.Value
        if ($type -eq 'Control' -and $s.Control -and ($kind -eq 'mb' -or $kind -eq 'ctrl' -or $top -eq 'GpuNvidia' -or $top -eq 'GpuAmd')) {
          $c = $s.Control
          # value: the duty the header runs at now, whoever sets it (BIOS or Xenon).
          $r.controls += @{ id = $s.Identifier.ToString(); hw = [string]$hw.Name; type = $kind; gpu = $(if ($top -eq 'GpuAmd') { 'amd' } else { 'nvidia' }); name = $name; value = $(if ($null -ne $v) { [Math]::Round([double]$v, 1) } else { $null })
            min = [int][Math]::Ceiling([double]$c.MinSoftwareValue); max = [int][Math]::Floor([double]$c.MaxSoftwareValue); control = $c }
        } elseif ($type -eq 'Fan' -and $null -ne $v) {
          $r.fans += [ordered]@{ id = $s.Identifier.ToString(); hw = [string]$hw.Name; type = $kind; name = $name; rpm = [int][Math]::Round([double]$v) }
        } elseif ($type -eq 'Temperature' -and $null -ne $v) {
          $t = [double]$v
          if ($kind -eq 'cpu') {
            $p = if ($name -match 'Package|Tctl|Tdie|CCD|Core Average') { 3 } elseif ($name -match 'Core') { 2 } else { 1 }
            if ($p -gt $cpuPri -or ($p -eq $cpuPri -and $t -gt $r.temps.cpu)) { $cpuPri = $p; $r.temps.cpu = $t }
          } elseif ($kind -eq 'gpu') {
            # The hottest card: the safe reading when a PC has two.
            $key = if ($name -match 'Memory') { 'gpuMem' } elseif ($name -match 'Hot ?Spot') { 'gpuHot' } elseif ($name -match 'Core') { 'gpu' } else { $null }
            if ($key -and ($null -eq $r.temps[$key] -or $t -gt $r.temps[$key])) { $r.temps[$key] = $t }
          } elseif ($kind -eq 'mb') {
            if ($null -eq $r.temps.board -and $name -match '^(System|Motherboard|Mainboard)') { $r.temps.board = $t }
          } elseif ($name -match 'Liquid|Coolant|Water') {
            if ($null -eq $r.temps.liquid -or $t -gt $r.temps.liquid) { $r.temps.liquid = $t }
          }
        } elseif ($type -eq 'Power' -and $null -ne $v -and [double]$v -gt 0) {
          $w = [Math]::Round([double]$v, 1)
          if ($kind -eq 'cpu') {
            $p = if ($name -match 'Package|PPT') { 2 } else { 1 }
            if ($p -gt $cpuWPri) { $cpuWPri = $p; $r.power.cpu = $w }
          } elseif ($kind -eq 'gpu' -and $name -match 'Package|Board|Total|Power') {
            if ($null -eq $r.power.gpu -or $w -gt $r.power.gpu) { $r.power.gpu = $w }
          }
        }
      } catch { }
    }
  }
  return $r
}

$FanMarkerLeaf = 'fan-held.json'

# Called once by the service, after $OutDir, Test-OutDir and Write-Snapshot exist.
function Initialize-FanHands {
  $script:FanDir = Join-Path $OutDir 'fan'
  $script:FanState = New-FanHandsState
  $script:FanBootMs = try { ([DateTimeOffset](Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime).ToUnixTimeMilliseconds() } catch { [long]0 }
  $script:FanState.marker = Read-FanMarker (Join-Path $OutDir $FanMarkerLeaf) $script:FanBootMs
  $script:FanSaveMarker = {
    param($Ids)
    try {
      if (-not (Test-OutDir)) { return $false }
      Write-Snapshot $FanMarkerLeaf ((@{ boot = $FanBootMs; ids = @($Ids) }) | ConvertTo-Json -Compress)
      return $true
    } catch { return $false }
  }
}

# Whether the engine asked lately, or a control is still held: the service then
# ticks every second and keeps the CPU readings fresh for this.
function Test-FanHandsActive([string]$Name, [long]$Now) {
  return ($Name -and $Name -ne $FanState.lastName) -or ($Now - $FanState.seenAt -lt $FanActiveMs) -or ($FanState.held.Count -gt 0) -or ($FanState.marker.Count -gt 0)
}

# The task starts this service below normal priority, and below normal waits behind
# every busy normal thread: on a real PC a test run on every core kept these rules from
# running for minutes (23 Nov 2026). While the hands are active the service runs above
# normal (a light tick, once a second); resting, it goes back to the task's own place.
# A place someone else chose meanwhile, or one already higher, is kept.
$script:FanBasePriority = $null
function Set-FanHandsPriority([bool]$Active) {
  $p = $null
  try {
    $p = [Diagnostics.Process]::GetCurrentProcess()
    $above = [Diagnostics.ProcessPriorityClass]::AboveNormal
    if ($Active -and $null -eq $script:FanBasePriority) {
      $now = $p.PriorityClass
      if ($now -eq 'Idle' -or $now -eq 'BelowNormal' -or $now -eq 'Normal') {
        $p.PriorityClass = $above
        $script:FanBasePriority = $now
      }
    } elseif (-not $Active -and $null -ne $script:FanBasePriority) {
      if ($p.PriorityClass -eq $above) { $p.PriorityClass = $script:FanBasePriority }
      $script:FanBasePriority = $null
    }
  } catch { } finally { if ($p) { $p.Dispose() } }
}

function Invoke-FanHands([string]$Name, [long]$Now) {
  $computer = $global:XenonCpuLhm
  if ($computer) { try { if (-not $computer.IsGpuEnabled) { $computer.IsGpuEnabled = $true } } catch { } }
  $hw = if ($computer) { Get-FanHardware $computer } else { @{ controls = @(); fans = @(); cpuName = ''; temps = @{}; power = @{} } }
  $status = Step-FanHands $FanState $hw $Name $Now $computer $FanSaveMarker
  if ($null -eq $status) {
    # Nobody asks and nothing is held: the cards go back out of the session.
    if ($computer) { try { $computer.IsGpuEnabled = $false } catch { } }
    return
  }
  $status.at = $Now; $status.lhm = [bool]$computer
  $status.fans = @($hw.fans); $status.temps = $hw.temps; $status.power = $hw.power
  try { Write-Snapshot 'fan.json' ('{"at":' + $Now + ',"data":' + ($status | ConvertTo-Json -Compress -Depth 5) + '}') } catch { }
}

function Stop-FanHands {
  $computer = $global:XenonCpuLhm
  if (-not $computer -or $FanState.held.Count -eq 0) { return }
  Stop-FanHandsControls $FanState (Get-FanHardware $computer).controls $FanSaveMarker
}

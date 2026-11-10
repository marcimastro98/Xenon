# Every hardware sensor Xenon can read, by LibreHardwareMonitor's own
# identifier (/amdcpu/0/temperature/2, /gpu-nvidia/0/power/0...), for
# Settings -> Performance -> Sensor sources and the SDK `sensors` stream.
#
#   sensors.ps1 list          every temperature, fan, power, clock and load
#   sensors.ps1 read "a|b"    only the sensors with those identifiers
#
# Worker-only, and it opens nothing: it walks the LHM sessions cpu-temp.ps1
# ($global:XenonCpuLhm, plus the direct Corsair PSU) and gpu.ps1
# ($global:XenonGpuLhm) already keep alive. A second Computer would load the
# kernel driver twice and double the ring-0 reads the worker is careful to
# amortize. Until those two have run once, or on a PC without LHM, the list is
# simply empty.
#
# Cost: the CPU session is Update()d by cpu-temp.ps1 on every system poll, so
# its values are as fresh as the dashboard's and nothing is re-read here. The
# GPU session is NOT (on NVIDIA gpu.ps1 reads fans straight from NVAPI, because
# a GPU Update() costs 60-80 ms), so a GPU is refreshed here only when a
# requested sensor lives on it, and at most once every two seconds.
param([string]$Mode = 'list', [string]$Ids = '')

$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$TypeMap = @{ Temperature = 'temperature'; Fan = 'fan'; Power = 'power'; Clock = 'clock'; Load = 'load' }
$GpuFreshMs = 2000

# $null = everything (list mode); otherwise the identifiers asked for.
$want = $null
if ($Mode -eq 'read') {
  $want = @{}
  foreach ($id in ($Ids -split '\|')) { if ($id) { $want[$id] = $true } }
}

$script:rows = New-Object System.Collections.Generic.List[object]

function Get-HwKind([string]$Type) {
  switch -Regex ($Type) {
    '^Cpu$' { return 'cpu' }
    '^Gpu' { return 'gpu' }
    'Motherboard|SuperIO|EmbeddedController' { return 'board' }
    '^Psu$' { return 'psu' }
    '^Cooler$' { return 'cooler' }
    '^Memory$' { return 'memory' }
    'Storage' { return 'storage' }
  }
  return 'other'
}

function Test-Wanted([string]$HwId) {
  if ($null -eq $want) { return $true }
  foreach ($k in $want.Keys) { if ($k.StartsWith($HwId + '/')) { return $true } }
  return $false
}

function Update-GpuIfStale($Hardware) {
  $hwId = [string]$Hardware.Identifier
  if (-not (Test-Wanted $hwId)) { return }
  if ($null -eq $global:XenonLhmUpdatedAt) { $global:XenonLhmUpdatedAt = @{} }
  $at = $global:XenonLhmUpdatedAt[$hwId]
  if ($at -and ((Get-Date) - $at).TotalMilliseconds -lt $GpuFreshMs) { return }
  try { $Hardware.Update(); $global:XenonLhmUpdatedAt[$hwId] = Get-Date } catch { }
}

function Add-HardwareRows($Hardware, [string]$Kind, [string]$HwName) {
  if ($null -eq $Hardware) { return }
  foreach ($sensor in @($Hardware.Sensors)) {
    try {
      $type = $TypeMap[$sensor.SensorType.ToString()]
      if (-not $type) { continue }
      $id = [string]$sensor.Identifier
      if ($null -ne $want -and -not $want.ContainsKey($id)) { continue }
      $value = $null
      # NaN/Infinity would serialize as bare NaN, which is not JSON.
      if ($null -ne $sensor.Value) { $v = [double]$sensor.Value; if (-not ([double]::IsNaN($v) -or [double]::IsInfinity($v))) { $value = [Math]::Round($v, 1) } }
      $script:rows.Add([pscustomobject]@{ id = $id; hw = $HwName; hwKind = $Kind; type = $type; name = [string]$sensor.Name; value = $value })
    } catch { }
  }
  # Sub-hardware (the SuperIO chip under a motherboard) keeps its parent's kind
  # and shows its own name, which is the one other monitoring apps use.
  foreach ($sub in @($Hardware.SubHardware)) {
    $subName = try { ([string]$sub.Name).Trim() } catch { $HwName }
    Add-HardwareRows $sub $Kind $subName
  }
}

function Add-ComputerRows($Computer, [switch]$RefreshGpu) {
  if ($null -eq $Computer) { return }
  foreach ($hardware in @($Computer.Hardware)) {
    $htype = $hardware.HardwareType.ToString()
    if ($RefreshGpu -and $htype -match '^Gpu') { Update-GpuIfStale $hardware }
    $name = try { ([string]$hardware.Name).Trim() } catch { '' }
    Add-HardwareRows $hardware (Get-HwKind $htype) $name
  }
}

$lhm = $false
try {
  if ($global:XenonCpuLhm) { $lhm = $true; Add-ComputerRows $global:XenonCpuLhm }
  if ($global:XenonCorsairPsu) {
    $psuName = if ($global:XenonCorsairPsuModel) { [string]$global:XenonCorsairPsuModel } else { 'PSU' }
    Add-HardwareRows $global:XenonCorsairPsu 'psu' $psuName
  }
  if ($global:XenonGpuLhm) { $lhm = $true; Add-ComputerRows $global:XenonGpuLhm -RefreshGpu }
  # ToArray(), not @(): Windows PowerShell 5.1's ConvertTo-Json throws on a
  # generic List wrapped that way ("argument types do not match").
  [pscustomobject]@{ ok = $true; lhm = $lhm; sensors = $script:rows.ToArray() } | ConvertTo-Json -Compress -Depth 4
} catch {
  [pscustomobject]@{ ok = $false; lhm = $lhm; sensors = @() } | ConvertTo-Json -Compress -Depth 4
}

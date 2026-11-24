# Airflow's hands on Windows: the part of the sensor service (sensor-service.ps1,
# SYSTEM) that sets fan speeds through LibreHardwareMonitor. Dot-sourced by the
# service; does nothing until the engine asks. These are the rules; reading the LHM
# session and writing the files is fan-hands-lhm.ps1.
#
# The engine (server/airflow/driver-lhm.js) never opens a file here and the service
# never opens one of the engine's: commands are NAMES of empty files the engine
# creates in "%ProgramData%\Xenon Sensors\fan" (a folder enable-sensors.ps1 makes,
# where this user may add files and delete them again), read from the folder
# listing only:
#   fan-<gen>-<seq>[-c<k>_<duty>|-c<k>_d ...]
# <gen> is the control list this service published in fan.json (0 = "just read"),
# <seq> grows with every command, <k> is a control's index in that list, <duty>
# 0-100 or d (back to the firmware). A control a command leaves out goes back too.
# The engine deletes each name once a newer one is there; the highest <seq> wins.
#
# This side keeps its own rules, whatever the engine asks (server/airflow/safety.js
# is the engine's, finer; these are the backstop if the engine is gone or wrong):
#   - no new name for FanLeaseMs: every control back to the firmware;
#   - a die at its hot level: every control Xenon holds to 100 % until all are
#     10 degrees cooler for a minute;
#   - the temperature a control cools unreadable for FanSensorMs: that control back;
#   - duties clamped to the control's own range, a pump's never under FanPumpFloor;
#     only controls this service found.
# "Back to the firmware" is LHM's SetDefault, which restores what LHM saved when
# it first took the control. If that save is not the BIOS's own (this service took
# the control in an earlier run of this boot and never gave it back: crash, broken
# session), SetDefault would restore Xenon's last value; so such a control stays
# on SAFETY CURVE below until the PC restarts and the BIOS sets it up again. The
# controls held are listed in fan-held.json (boot time + ids) before each first
# write, so a new run knows.

$FanLeaseMs = 5000
$FanActiveMs = 30000
$FanSensorMs = 5000
$FanCoolForMs = 60000
$FanCoolBelow = 10
$FanMaxNames = 200
# Above the engine's own `full` levels (server/airflow/limits.js: GPU 83, hot spot
# 100, memory 95, CPU TjMax - 5): the engine acts first; these only matter when it
# does not. The CPU's sits just under the chip's own throttle point.
$FanHotGpu = @{ gpu = 88; gpuHot = 105; gpuMem = 102 }
$FanCpuHotUnder = 2
# The same table as limits.js TJMAX (a test keeps them equal); first match wins.
$FanTjMax = @(
  @('Ryzen.*\b5\d{3}X3D\b', 90), @('Ryzen.*\b7\d{3}X3D\b', 89), @('Ryzen.*\b9\d{3}X3D\b', 95),
  @('Ryzen.*\b[79]\d{3}', 95), @('Ryzen.*\b5\d{3}', 90), @('Ryzen.*\b3\d{3}', 95),
  @('Core.*Ultra', 105), @('Intel', 100)
)
$FanTjMaxUnknown = 90
# The engine's PUMP_FLOOR (limits.js; a test keeps them equal): a control named for a
# pump (a cooler's, an AIO header's) never runs slower, whatever it is asked.
$FanPumpFloor = 50
$FanNameRe = '^fan-(\d{1,15})-(\d{1,15})((?:-c\d{1,2}_(?:\d{1,3}|d)){0,32})$'

function New-FanHandsState {
  [pscustomobject]@{
    gen = [long]0; ids = ''; session = $null
    lastName = $null; seenAt = [long]0; leaseAt = [long]0; cmd = $null
    held = @{}; marker = @(); hot = $false; coolSince = [long]0; badSince = @{}
  }
}

# The newest valid command name in the folder, or $null. Listing only: nothing is
# opened, links are skipped, and a flooded folder costs at most FanMaxNames entries.
function Get-FanCommandName([string]$Dir) {
  try {
    $di = New-Object IO.DirectoryInfo $Dir
    if (-not $di.Exists -or ($di.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
    $best = $null; $bestSeq = [long]-1; $n = 0
    foreach ($fi in $di.EnumerateFiles('fan-*')) {
      if (++$n -gt $FanMaxNames) { break }
      if ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      $c = ConvertFrom-FanCommandName $fi.Name
      if ($c -and $c.seq -gt $bestSeq) { $best = $fi.Name; $bestSeq = $c.seq }
    }
    return $best
  } catch { return $null }
}

# A name -> @{ gen; seq; set = @{ k = duty | 'd' } }, or $null when it breaks the grammar.
function ConvertFrom-FanCommandName([string]$Name) {
  if (-not ($Name -cmatch $FanNameRe)) { return $null }
  $set = @{}
  foreach ($part in ($Matches[3] -split '-')) {
    if (-not $part) { continue }
    $kv = $part.Substring(1) -split '_'
    $k = [int]$kv[0]
    if ($set.ContainsKey($k)) { return $null }
    if ($kv[1] -eq 'd') { $set[$k] = 'd' } else {
      $v = [int]$kv[1]
      if ($v -gt 100) { return $null }
      $set[$k] = $v
    }
  }
  return @{ gen = [long]$Matches[1]; seq = [long]$Matches[2]; set = $set }
}

function Test-FanTemp($v) { return ($null -ne $v) -and ($v -is [ValueType]) -and ([double]$v -gt -20) -and ([double]$v -lt 130) }

# What a control may not be trusted to the firmware for, it gets from here: a line
# from 30 % to 100 % over the temperature it cools; unknown temperature = 100 %.
function Get-FanSafetyDuty($Control, $Temps) {
  if ($Control.type -eq 'gpu') { $t = $Temps.gpu; $lo = 50 } else {
    $t = $Temps.cpu
    if ((Test-FanTemp $Temps.gpu) -and (-not (Test-FanTemp $t) -or $Temps.gpu -gt $t)) { $t = $Temps.gpu }
    $lo = 40
  }
  if (-not (Test-FanTemp $t)) { return 100 }
  $d = 30 + ([double]$t - $lo) * 70 / 30
  return [int][Math]::Round([Math]::Min(100, [Math]::Max(30, $d)))
}

function Get-FanHotLimits([string]$CpuName) {
  $tj = $FanTjMaxUnknown
  foreach ($row in $FanTjMax) { if ($CpuName -match $row[0]) { $tj = $row[1]; break } }
  $limits = @{ cpu = $tj - $FanCpuHotUnder }
  foreach ($k in $FanHotGpu.Keys) { $limits[$k] = $FanHotGpu[$k] }
  return $limits
}

# Hot: any die at its level; stays hot until every one is FanCoolBelow under it for FanCoolForMs.
function Update-FanHot($St, $Temps, $Limits, [long]$Now) {
  $over = $false; $allCool = $true
  foreach ($name in $Limits.Keys) {
    $v = $Temps[$name]
    if (-not (Test-FanTemp $v)) { continue }
    if ($v -ge $Limits[$name]) { $over = $true }
    if ($v -gt $Limits[$name] - $FanCoolBelow) { $allCool = $false }
  }
  if ($over) { $St.hot = $true; $St.coolSince = 0; return }
  if (-not $St.hot) { return }
  if (-not $allCool) { $St.coolSince = 0; return }
  if ($St.coolSince -eq 0) { $St.coolSince = $Now }
  if ($Now - $St.coolSince -ge $FanCoolForMs) { $St.hot = $false; $St.coolSince = 0 }
}

# Seconds a temperature has been unreadable, per name; 0 while it reads.
function Update-FanBad($St, $Temps, [long]$Now) {
  foreach ($name in @('cpu', 'gpu')) {
    if (Test-FanTemp $Temps[$name]) { $St.badSince.Remove($name) }
    elseif (-not $St.badSince.ContainsKey($name)) { $St.badSince[$name] = $Now }
  }
}

function Test-FanSensorLost($St, $Control, [long]$Now) {
  $name = if ($Control.type -eq 'gpu') { 'gpu' } else { 'cpu' }
  return $St.badSince.ContainsKey($name) -and ($Now - $St.badSince[$name] -ge $FanSensorMs)
}

# Take a control (first time: note it in the marker BEFORE touching the hardware)
# and set it; a write only when the value changes.
function Set-FanHeld($St, $Control, [int]$Duty, [string]$Mode, [scriptblock]$SaveMarker) {
  $h = $St.held[$Control.id]
  if (-not $h) {
    $restorable = -not ($St.marker -contains $Control.id)
    $next = @($St.marker | Where-Object { $_ -ne $Control.id }) + $Control.id
    # No note on disk, no control: a later run could not tell it was ever taken.
    if (-not (& $SaveMarker $next)) { throw 'fan-held.json could not be written' }
    $St.marker = $next
    $h = @{ restorable = $restorable; value = $null; mode = $Mode }
    $St.held[$Control.id] = $h
  }
  $h.mode = $Mode
  $lo = [int]$Control.min
  if ([string]$Control.name -match 'Pump') { $lo = [Math]::Max($lo, $FanPumpFloor) }
  $Duty = [Math]::Min([int]$Control.max, [Math]::Max($lo, $Duty))
  if ($h.value -ne $Duty) {
    $Control.control.SetSoftware([single]$Duty)
    $h.value = $Duty
  }
}

# Give a control back: to the firmware when LHM holds the BIOS's own state, else
# onto the safety curve.
function Reset-FanHeld($St, $Control, $Temps, [scriptblock]$SaveMarker) {
  $h = $St.held[$Control.id]
  # Not held, but an earlier run of this boot left it at its last value: adopt it on the curve.
  if (-not $h) { if ($St.marker -contains $Control.id) { Set-FanHeld $St $Control (Get-FanSafetyDuty $Control $Temps) 'curve' $SaveMarker }; return }
  if (-not $h.restorable) { Set-FanHeld $St $Control (Get-FanSafetyDuty $Control $Temps) 'curve' $SaveMarker; return }
  try { $Control.control.SetDefault() } catch { Set-FanHeld $St $Control 100 'curve' $SaveMarker; $h.restorable = $false; return }
  $St.held.Remove($Control.id)
  $St.marker = @($St.marker | Where-Object { $_ -ne $Control.id })
  [void](& $SaveMarker $St.marker)
}

# One tick. $Hw: Get-FanHardware's answer, whose controls are each @{ id; hw; type
# ('mb'|'gpu'|'ctrl'); gpu ('nvidia'|'amd'); name; min; max; control (LHM IControl:
# SetSoftware, SetDefault) }.
# $Name: the newest command name. Answers the status for fan.json, or $null while
# nobody asks and nothing is held.
function Step-FanHands($St, $Hw, [string]$Name, [long]$Now, $Session, [scriptblock]$SaveMarker) {
  if ($Name -and $Name -ne $St.lastName) {
    $St.lastName = $Name; $St.seenAt = $Now
    $c = ConvertFrom-FanCommandName $Name
    if ($c -and $c.gen -ne 0 -and $c.gen -eq $St.gen) { $St.cmd = $c; $St.leaseAt = $Now }
  }
  if ($Now - $St.seenAt -ge $FanActiveMs -and $St.held.Count -eq 0 -and $St.marker.Count -eq 0) { return $null }
  $Temps = $Hw.temps
  $sorted = @($Hw.controls | Sort-Object { $_.id })
  $ids = ($sorted | ForEach-Object { $_.id }) -join '|'
  # A noted control the hardware no longer has (a card taken out) needs nothing more.
  # Only judged on a list that has controls: a session that failed to list is no proof.
  if ($sorted.Count -and @($St.marker | Where-Object { $ids.Split('|') -notcontains $_ }).Count) {
    $keep = @($St.marker | Where-Object { $ids.Split('|') -contains $_ })
    if (& $SaveMarker $keep) { $St.marker = $keep }
  }
  # A different control list re-numbers the keys: commands for the old one are not obeyed.
  if ($ids -ne $St.ids) { $St.ids = $ids; $St.gen = [long][Math]::Max($Now, $St.gen + 1); $St.cmd = $null }
  # A new LHM session: what the old one saved is gone with it.
  if (-not [object]::ReferenceEquals($Session, $St.session)) {
    if ($null -ne $St.session) { foreach ($h in $St.held.Values) { $h.restorable = $false } }
    $St.session = $Session
  }
  Update-FanHot $St $Temps (Get-FanHotLimits $Hw.cpuName) $Now
  Update-FanBad $St $Temps $Now
  $lease = $St.cmd -and ($Now - $St.leaseAt -lt $FanLeaseMs)
  $guard = $null
  $out = @()
  for ($k = 0; $k -lt $sorted.Count; $k++) {
    $ctl = $sorted[$k]
    $want = if ($lease -and $St.cmd.set.ContainsKey($k)) { $St.cmd.set[$k] } else { $null }
    $was = $St.held[$ctl.id]
    try {
      if ($St.hot -and ($was -or $null -ne $want)) { Set-FanHeld $St $ctl 100 'hot' $SaveMarker; $guard = 'hot' }
      elseif ($was -and -not $lease) { if ($was.mode -eq 'set') { $guard = 'lease' }; Reset-FanHeld $St $ctl $Temps $SaveMarker }
      elseif (Test-FanSensorLost $St $ctl $Now) { if ($was -or $null -ne $want) { $guard = 'sensor' }; Reset-FanHeld $St $ctl $Temps $SaveMarker }
      elseif ($null -eq $want -or $want -is [string] -or ($want -eq 0 -and $ctl.min -gt 0)) { Reset-FanHeld $St $ctl $Temps $SaveMarker }
      else { Set-FanHeld $St $ctl ([int]$want) 'set' $SaveMarker }
    } catch { }
    $h = $St.held[$ctl.id]
    $out += [ordered]@{ k = $k; id = $ctl.id; hw = $ctl.hw; type = $ctl.type; name = $ctl.name; min = $ctl.min; max = $ctl.max; value = $ctl.value
      held = $(if ($h) { $h.mode } else { $null }); duty = $(if ($h) { $h.value } else { $null })
      # False: back to the BIOS only at the next restart (until then, the safety curve).
      restorable = $(if ($h) { $h.restorable } else { -not ($St.marker -contains $ctl.id) }) }
  }
  # Held ids the hardware no longer lists (a device gone): nothing to write to, forget them.
  foreach ($id in @($St.held.Keys)) { if (-not ($sorted | Where-Object { $_.id -eq $id })) { $St.held.Remove($id) } }
  return [ordered]@{ v = 1; gen = $St.gen; guard = $guard; hot = $St.hot; controls = $out }
}

# Every held control back (service stopping): firmware where LHM can, 100 % where not.
function Stop-FanHandsControls($St, [object[]]$Controls, [scriptblock]$SaveMarker) {
  foreach ($ctl in @($Controls)) {
    $h = $St.held[$ctl.id]
    if (-not $h) { continue }
    try {
      if ($h.restorable) { $ctl.control.SetDefault(); $St.held.Remove($ctl.id); $St.marker = @($St.marker | Where-Object { $_ -ne $ctl.id }) }
      else { $ctl.control.SetSoftware([single]100) }
    } catch { }
  }
  [void](& $SaveMarker $St.marker)
}

# fan-held.json: { boot: <ms>, ids: [...] }. Ids from an earlier boot are dropped:
# the BIOS set every header up again at power-on.
function Read-FanMarker([string]$Path, [long]$BootMs) {
  try {
    if (-not [IO.File]::Exists($Path)) { return @() }
    $o = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    # Boot time unknown: every id stays (a safety curve rather than a guess).
    if ($BootMs -ne 0 -and [Math]::Abs([long]$o.boot - $BootMs) -gt 120000) { return @() }
    return @($o.ids | Where-Object { $_ -is [string] -and $_.Length -le 128 })
  } catch { return @() }
}

// Breaks each rule of Airflow's hands in the sensor service (server/fan-hands.ps1)
// once and checks the tests notice:
//   node tools/mutate/mutate.mjs tools/airflow-sim/hands-mutations.mjs
// Windows only (the rules run in Windows PowerShell). Rerun after any change to
// fan-hands.ps1, fan-hands-lhm.ps1 or sensor-service.ps1; every mutation must be caught. About a minute.
const H = 'server/fan-hands.ps1';
const LHM = 'server/fan-hands-lhm.ps1';
const SERVICE = 'server/sensor-service.ps1';
const m = (name, from, to, file = H) => ({ name, file, from, to });

export default {
  tests: ['server/test/airflow-hands.test.mjs', 'server/test/sensor-service-snapshot.test.mjs'],
  mutations: [
    m('names: any case', 'if (-not ($Name -cmatch $FanNameRe)) { return $null }', 'if (-not ($Name -match $FanNameRe)) { return $null }'),
    m('names: duties over 100', 'if ($v -gt 100) { return $null }', ''),
    m('names: a control twice', 'if ($set.ContainsKey($k)) { return $null }', ''),
    m('names: the last listed wins', 'if ($c -and $c.seq -gt $bestSeq)', 'if ($c)'),
    m('gen: any list obeyed', 'if ($c -and $c.gen -ne 0 -and $c.gen -eq $St.gen)', 'if ($c -and $c.gen -ne 0)'),
    m('gen: a new list keeps the old command', "$St.gen = [long][Math]::Max($Now, $St.gen + 1); $St.cmd = $null }", "$St.gen = [long][Math]::Max($Now, $St.gen + 1) }"),
    m('lease: never runs out', '$lease = $St.cmd -and ($Now - $St.leaseAt -lt $FanLeaseMs)', '$lease = [bool]$St.cmd'),
    m('clamp: under the floor', '[Math]::Max($lo, $Duty)', '$Duty'),
    m('clamp: a pump under its floor', "if ([string]$Control.name -match 'Pump') { $lo = [Math]::Max($lo, $FanPumpFloor) }", ''),
    m('writes: every tick', 'if ($h.value -ne $Duty) {', 'if ($true) {'),
    m('note: write without it', "if (-not (& $SaveMarker $next)) { throw 'fan-held.json could not be written' }", '[void](& $SaveMarker $next)'),
    m('note: every take restorable', '$restorable = -not ($St.marker -contains $Control.id)', '$restorable = $true'),
    m('note: a fan left behind not adopted', 'if (-not $h) { if ($St.marker -contains $Control.id) {', 'if (-not $h) { if ($false) {'),
    m('note: idle ignores it', ' -and $St.marker.Count -eq 0) { return $null }', ') { return $null }'),
    m('note: pruned on an empty list', 'if ($sorted.Count -and @($St.marker', 'if (@($St.marker'),
    m('release: SetDefault for every fan', "if (-not $h.restorable) { Set-FanHeld $St $Control (Get-FanSafetyDuty $Control $Temps) 'curve' $SaveMarker; return }", ''),
    m('session: a new one keeps the old save', 'foreach ($h in $St.held.Values) { $h.restorable = $false }', ''),
    m('heat: only past the level', 'if ($v -ge $Limits[$name]) { $over = $true }', 'if ($v -gt $Limits[$name]) { $over = $true }'),
    m('heat: back at once', 'if ($Now - $St.coolSince -ge $FanCoolForMs)', 'if ($true)'),
    m('heat: back just under the level', 'if ($v -gt $Limits[$name] - $FanCoolBelow)', 'if ($v -gt $Limits[$name])'),
    m('heat: grabs fans nobody asked for', "if ($St.hot -and ($was -or $null -ne $want))", 'if ($St.hot)'),
    m('heat: CPU level at TjMax', '$limits = @{ cpu = $tj - $FanCpuHotUnder }', '$limits = @{ cpu = $tj }'),
    m('sensor: lost at once', '($Now - $St.badSince[$name] -ge $FanSensorMs)', '$true'),
    m('zero: a card with a floor held at it', ' -or ($want -eq 0 -and $ctl.min -gt 0)', ''),
    m('curve: a case fan ignores the card', "if ((Test-FanTemp $Temps.gpu) -and (-not (Test-FanTemp $t) -or $Temps.gpu -gt $t)) { $t = $Temps.gpu }", ''),
    m('curve: blind is quiet', 'if (-not (Test-FanTemp $t)) { return 100 }', 'if (-not (Test-FanTemp $t)) { return 30 }'),
    m('readings: cold nonsense believed', '($v -is [ValueType]) -and ([double]$v -gt -20)', '($v -is [ValueType])'),
    m('gone: a lost device kept held', 'foreach ($id in @($St.held.Keys)) { if (-not ($sorted | Where-Object { $_.id -eq $id })) { $St.held.Remove($id) } }', ''),
    m('stop: a fan left at its last value', 'else { $ctl.control.SetSoftware([single]100) }', 'else { }'),
    m('note file: any boot', 'if ($BootMs -ne 0 -and [Math]::Abs([long]$o.boot - $BootMs) -gt 120000) { return @() }', ''),
    m('note file: unknown boot drops it', 'if ($BootMs -ne 0 -and [Math]::Abs', 'if ([Math]::Abs'),
    m('note file: any id', '$_ -is [string] -and $_.Length -le 128', '$_ -is [string]'),
    // The service runs above normal while the hands work (fan-hands-lhm.ps1).
    m('priority: never moves up', '        $p.PriorityClass = $above\n', '', LHM),
    m('priority: never goes back', 'if ($p.PriorityClass -eq $above) { $p.PriorityClass = $script:FanBasePriority }', '', LHM),
    m('priority: a higher place moved down', "if ($now -eq 'Idle' -or $now -eq 'BelowNormal' -or $now -eq 'Normal') {", 'if ($true) {', LHM),
    m('priority: a later choice overridden', 'if ($p.PriorityClass -eq $above) { $p.PriorityClass = $script:FanBasePriority }', '$p.PriorityClass = $script:FanBasePriority', LHM),
    m('priority: the loop does not follow', '    Set-FanHandsPriority $fanActive\n', '', SERVICE),
    // Every reading is swapped in by a rename, never File.Replace, which stalls under load (sensor-service.ps1).
    m('snapshot: File.Replace again', '$SnapshotMove = New-SnapshotMove', '$SnapshotMove = $null', SERVICE),
    m('snapshot: the old file not replaced', '$MoveReplaceExisting = 1', '$MoveReplaceExisting = 0', SERVICE),
    m('snapshot: a failed swap taken as written', 'if (-not $SnapshotMove::MoveFileExW($tmp, $dest, $MoveReplaceExisting)) { throw "$Leaf could not be moved into place" }', '[void]$SnapshotMove::MoveFileExW($tmp, $dest, $MoveReplaceExisting)', SERVICE),
  ],
};

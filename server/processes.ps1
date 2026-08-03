# Per-process CPU / RAM / GPU snapshot for the SDK `processes` stream.
#
# Runs on pwsh-worker.ps1 (the permanent sensor host), NEVER as a one-shot spawn.
# That is the whole design: every figure here is a delta between THIS call and the
# previous one, so the steady state contains no Start-Sleep and no sampling
# window. The worker keeps $global: state alive between calls (the same mechanism
# gpu.ps1 uses for its LibreHardwareMonitor session), which is what makes that
# possible. Spawned per call, this script would have to sleep for its deltas and
# would cost more than the data is worth.
#
# performance.ps1 -stats stays exactly as it is: a one-shot for the optimization
# sheet that pays a 350ms sleep for its delta. Correct for something that runs
# when a panel opens; wrong for something that runs every two seconds forever.
#
# Why NOT Get-Counter for the GPU figures, which is the obvious way to write this.
# Measured under powershell.exe on a normal desktop (390 processes, 735 GPU Engine
# instances), both calls warm, in the same session:
#     Get-Counter '\GPU Engine(*)\Utilization Percentage'   2767-2809 ms
#     $cat.ReadCategory()['Utilization Percentage']              2-5 ms
# PDH samples rate counters over its own window and PowerShell then materialises
# 735 rich objects; ReadCategory returns the RAW cumulative values in one shot.
# Raw is cumulative busy time in 100ns units, which is exactly the shape this
# script already works in, so we take the delta against our own clock and get the
# same number three orders of magnitude cheaper. Do NOT "simplify" this back to
# Get-Counter -- it would make one stream cost more than the rest of the server.
#
# Considered and rejected for the CPU/RAM half: the 'Process' counter category
# gives name+pid+working set+CPU in one 11 ms read, against 41 ms for Get-Process.
# Not worth it. The counter registry is corruptible (the classic `lodctr /R`
# repair), and routing the ONLY always-available half of this stream through it
# would turn a broken registry into a dead feature instead of a missing GPU
# column. 30 ms every two seconds is not worth a new way to be wrong.
#
# Output (short keys -- this rides an SSE broadcast every couple of seconds):
#   {"ok":true,"cores":N,"totalMB":N,"usedMB":N,"gpuAvail":bool,"win":ms,
#    "apps":[{"n":"chrome","c":2.1,"m":1840,"g":3.4},...]}
param([int]$top = 8)

$ErrorActionPreference = 'Continue'

# A delta older than this is not a delta, it is a guess: the stream was stopped
# and restarted, or the machine slept. Re-prime instead of reporting nonsense.
$STALE_MS = 30000
# Priming window, paid ONLY on the first call after a (re)start, so the very
# first frame the widget paints already carries real numbers instead of zeros.
$PRIME_MS = 250
# Engines a person means by "GPU usage". Copy/video-processing engines are
# excluded deliberately: a file copy to a GPU-attached surface is not load.
$ENGINE_RE = '^pid_(\d+)_.*engtype_(3d|compute|videoencode|videodecode)$'

# -- Counter categories: constructed once, kept for the life of the worker -----
# The first ReadCategory() on a category costs ~330ms (PDH builds its instance
# map); every later one costs ~1ms. Rebuilding the object per call would pay that
# every time, which is the whole cost this script exists to avoid. The string
# 'none' records "checked, absent" so a missing category is not re-probed on
# every call -- a counter category does not appear without a reboot.
function Get-Cat([string]$name) {
  $obj = 'none'
  try {
    if ([System.Diagnostics.PerformanceCounterCategory]::Exists($name)) {
      $obj = New-Object System.Diagnostics.PerformanceCounterCategory $name
    }
  } catch { $obj = 'none' }
  return $obj
}

function Read-GpuRaw {
  $cat = $global:XenonProcGpuCat
  if ($null -eq $cat -or $cat -is [string]) { return $null }
  try {
    $col = $cat.ReadCategory()['Utilization Percentage']
    if ($null -eq $col) { return $null }
    $h = @{}
    foreach ($k in $col.Keys) { $h[$k] = [double]$col[$k].RawValue }
    return $h
  } catch { return $null }
}

function Get-ProcSnapshot {
  $snap = @{}
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
    if ($p.Id -le 4) { continue }
    $cpu = $null
    try { $cpu = $p.TotalProcessorTime.TotalMilliseconds } catch { }
    # A protected or exiting process has no readable CPU time. Keep the row for
    # its RAM rather than dropping the app from the list entirely.
    $snap[$p.Id] = New-Object psobject -Property @{ Name = $p.ProcessName; Cpu = $cpu; Mem = $p.WorkingSet64 }
  }
  return $snap
}

try {
  if ($null -eq $global:XenonProcGpuCat) { $global:XenonProcGpuCat = Get-Cat 'GPU Engine' }
  if ($null -eq $global:XenonProcMemCat) { $global:XenonProcMemCat = Get-Cat 'Memory' }

  $now  = [double](([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds())
  $prev = $global:XenonProcPrev
  $prevGpu = $global:XenonProcGpuPrev
  $prevAt = 0.0
  if ($null -ne $global:XenonProcPrevAt) { $prevAt = [double]$global:XenonProcPrevAt }

  $curr = Get-ProcSnapshot
  $currGpu = Read-GpuRaw

  # First call, or a gap long enough that the delta would be meaningless: take a
  # second pair of snapshots after a short window so THIS call still answers with
  # real numbers. Paid once per stream start, never in the steady state.
  if ($null -eq $prev -or $prevAt -le 0 -or ($now - $prevAt) -gt $STALE_MS) {
    $prev = $curr
    $prevGpu = $currGpu
    $prevAt = $now
    Start-Sleep -Milliseconds $PRIME_MS
    $now = [double](([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds())
    $curr = Get-ProcSnapshot
    $currGpu = Read-GpuRaw
  }

  $windowMs = [math]::Max(1.0, $now - $prevAt)   # 1.0: see the overload note below
  $cores = [Environment]::ProcessorCount

  # -- Per-pid GPU: max across engines, not the sum -----------------------------
  # A process rendering and decoding at the same time is not using 180% of the
  # GPU, and the max is also what Task Manager's GPU column shows -- so the two
  # agree instead of quietly disagreeing at the user.
  $gpuByPid = $null
  if ($null -ne $currGpu -and $null -ne $prevGpu) {
    $gpuByPid = @{}
    $scale = $windowMs * 10000.0        # ms -> 100ns ticks, the raw counter's unit
    foreach ($k in $currGpu.Keys) {
      if ($k -notmatch $ENGINE_RE) { continue }
      if (-not $prevGpu.ContainsKey($k)) { continue }
      $d = $currGpu[$k] - $prevGpu[$k]
      if ($d -le 0) { continue }
      $u = ($d / $scale) * 100.0
      $procId = [int]$Matches[1]
      if (-not $gpuByPid.ContainsKey($procId) -or $u -gt $gpuByPid[$procId]) { $gpuByPid[$procId] = $u }
    }
  }

  # -- Aggregate per process NAME (one row per app, how a task manager shows it)
  $rows = @{}
  foreach ($procId in $curr.Keys) {
    $c = $curr[$procId]
    $name = $c.Name
    if (-not $rows.ContainsKey($name)) {
      $rows[$name] = New-Object psobject -Property @{ n = $name; cpuMs = [double]0; mem = [long]0; gpu = [double]0 }
    }
    $r = $rows[$name]
    $r.mem += $c.Mem
    if ($null -ne $c.Cpu -and $prev.ContainsKey($procId) -and $null -ne $prev[$procId].Cpu) {
      $d = $c.Cpu - $prev[$procId].Cpu
      if ($d -gt 0) { $r.cpuMs += $d }
    }
    if ($null -ne $gpuByPid -and $gpuByPid.ContainsKey($procId)) { $r.gpu += $gpuByPid[$procId] }
  }

  $global:XenonProcPrev = $curr
  $global:XenonProcGpuPrev = $currGpu
  $global:XenonProcPrevAt = $now

  # The sum across EVERY process, not just the rows that survive the top-N cut.
  # Without it the widget shows ten rows adding up to less than the machine's own
  # CPU figure and looks wrong, when the difference is simply the long tail of
  # processes too small to list.
  $allCpuMs = [double]0
  foreach ($r in $rows.Values) { $allCpuMs += $r.cpuMs }
  $cpuAll = [math]::Round([math]::Min(100.0, [math]::Max(0.0,
    ($allCpuMs / $windowMs) * 100.0 / [math]::Max(1, $cores))), 1)

  $apps = @()
  foreach ($r in $rows.Values) {
    $cpuPct = ($r.cpuMs / $windowMs) * 100.0 / [math]::Max(1, $cores)
    $apps += New-Object psobject -Property @{
      n = $r.n.ToLower()
      # 100.0 / 0.0, NOT 100 / 0. An INTEGER literal makes PowerShell bind the
      # [math]::Min(int,int) overload and convert the double argument on the way
      # in, so [math]::Min(100, 0.78) is 1 -- the value is rounded to a whole
      # percent BEFORE the Round(...,1) here ever runs. That silently erased
      # every process under 0.5% (they became 0) and inflated the rest to whole
      # numbers, which is what made the column disagree with the CPU total.
      c = [math]::Round([math]::Min(100.0, [math]::Max(0.0, $cpuPct)), 1)
      m = [int][math]::Round($r.mem / 1MB)
      g = [math]::Round([math]::Min(100.0, [math]::Max(0.0, $r.gpu)), 1)
    }
  }

  # The widget renders three lists, so send the UNION of the top $top of each
  # metric rather than one sorted list -- otherwise the RAM column could only ever
  # show apps that also happen to be busy on the CPU. Typically ~15 rows.
  $keep = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($k in @('c', 'm', 'g')) {
    foreach ($a in ($apps | Sort-Object -Property $k -Descending | Select-Object -First $top)) {
      if (($a.$k) -gt 0) { [void]$keep.Add($a.n) }
    }
  }
  $out = @($apps | Where-Object { $keep.Contains($_.n) } | Sort-Object -Property c -Descending)

  # -- System memory ------------------------------------------------------------
  # Total physical never changes, so it is read once via CIM (~45ms) and kept.
  # Available comes off the Memory counter category, which is ~0ms once warm --
  # Get-CimInstance Win32_OperatingSystem costs ~80ms on every call and would be
  # the most expensive thing left in this script.
  if ($null -eq $global:XenonProcTotalMB) {
    $global:XenonProcTotalMB = 0
    try { $global:XenonProcTotalMB = [int][math]::Round((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory / 1MB) } catch { }
  }
  $totalMB = [int]$global:XenonProcTotalMB
  $usedMB = 0
  $memCat = $global:XenonProcMemCat
  if ($null -ne $memCat -and -not ($memCat -is [string]) -and $totalMB -gt 0) {
    try {
      $avail = $memCat.ReadCategory()['Available MBytes']
      foreach ($n in $avail.Keys) { $usedMB = [int]($totalMB - [int]$avail[$n].RawValue); break }
    } catch { $usedMB = 0 }
  }
  if ($usedMB -lt 0) { $usedMB = 0 }

  @{
    ok       = $true
    cpu      = $cpuAll
    cores    = $cores
    totalMB  = $totalMB
    usedMB   = $usedMB
    gpuAvail = ($null -ne $gpuByPid)
    win      = [int]$windowMs
    apps     = @($out)
  } | ConvertTo-Json -Depth 3 -Compress
} catch {
  $msg = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"')
  @{ ok = $false; error = $msg } | ConvertTo-Json -Compress
}

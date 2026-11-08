param([string]$verb)
# Process stats for Performance Mode, used only where the native process table
# (perf-session/) cannot be read. The power plan moved to perf-session/power-plan.js.
#   stats             -> { ok, totalMB, freeMB, apps }  per-process RAM + CPU%
# Only this verb is accepted, and it is read-only: it feeds the optimization sheet
# and the AI planner with real memory/CPU numbers instead of guesses.
$ErrorActionPreference = 'Stop'

try {
  switch ($verb) {
    'stats' {
      # System memory pressure + the top processes by RAM, with a CPU% estimate
      # from two TotalProcessorTime samples ~350ms apart. Aggregated per process
      # name (one row per app, like the optimization sheet shows them).
      $os = Get-CimInstance Win32_OperatingSystem
      $totalMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
      $freeMB  = [math]::Round($os.FreePhysicalMemory / 1024)
      $cores   = [Environment]::ProcessorCount

      $t0 = @{}
      foreach ($p in (Get-Process | Where-Object { $_.Id -gt 4 })) {
        try { $t0[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {}
      }
      Start-Sleep -Milliseconds 350

      $apps = @()
      $groups = Get-Process | Where-Object { $_.Id -gt 4 } | Group-Object -Property ProcessName
      foreach ($g in $groups) {
        $mem = [long]0; $cpuMs = [double]0
        foreach ($p in $g.Group) {
          $mem += $p.WorkingSet64
          try {
            if ($t0.ContainsKey($p.Id)) {
              # 0.0, not 0: an integer literal binds [math]::Max(int,int) and rounds
            # the double on the way in, so every per-process delta was truncated to
            # a whole millisecond before being summed over a 350ms window.
            $cpuMs += [math]::Max(0.0, $p.TotalProcessorTime.TotalMilliseconds - $t0[$p.Id])
            }
          } catch {}
        }
        $apps += [pscustomobject]@{
          proc   = $g.Name.ToLower()
          memMB  = [math]::Round($mem / 1MB)
          cpuPct = [math]::Round(($cpuMs / 350.0) * 100.0 / [math]::Max(1, $cores), 1)
        }
      }
      $apps = @($apps | Sort-Object memMB -Descending | Select-Object -First 40)
      @{ ok = $true; totalMB = $totalMB; freeMB = $freeMB; apps = $apps } | ConvertTo-Json -Depth 3 -Compress
    }
    default {
      Write-Output '{"ok":false,"error":"bad_verb"}'
    }
  }
} catch {
  $msg = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}

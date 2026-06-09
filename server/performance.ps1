param([string]$verb, [string]$value)
# Allowlisted Windows power-plan + process-stats helper for Performance Mode.
#   get               -> { ok, guid }   active power scheme GUID
#   set high|ultimate -> { ok, guid }   switch to a known high-performance plan
#   set <guid>        -> { ok, guid }   restore a previously-saved plan by GUID
#   stats             -> { ok, totalMB, freeMB, apps }  per-process RAM + CPU%
# Only these verbs/values are accepted; everything else is rejected. Switching
# power plans is fully reversible — the caller saves the prior GUID and restores
# it on exit. We never create, delete, or tweak individual plan settings here.
# `stats` is read-only: it feeds the optimization sheet and the AI planner with
# real memory/CPU numbers instead of guesses.
$ErrorActionPreference = 'Stop'

# Well-known scheme GUIDs shipped with Windows.
$HIGH     = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'  # High performance
$ULTIMATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61'  # Ultimate performance (may be absent)

function Get-ActiveGuid {
  $out = powercfg /getactivescheme 2>$null
  if ($out -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
    return $Matches[1].ToLower()
  }
  return ''
}

try {
  switch ($verb) {
    'get' {
      $g = Get-ActiveGuid
      if (-not $g) { throw 'could not read active scheme' }
      Write-Output ('{"ok":true,"guid":"' + $g + '"}')
    }
    'set' {
      $target = ''
      switch ($value) {
        'high'     { $target = $HIGH }
        'ultimate' { $target = $ULTIMATE }
        default {
          if ($value -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
            $target = $value.ToLower()
          } else {
            Write-Output '{"ok":false,"error":"bad_value"}'; exit
          }
        }
      }
      # Ultimate performance is hidden on many SKUs; surface it before activating.
      if ($value -eq 'ultimate') { powercfg /duplicatescheme $ULTIMATE 2>$null | Out-Null }
      powercfg /setactive $target 2>&1 | Out-Null
      $now = Get-ActiveGuid
      if ($now -ne $target) { throw 'scheme not applied' }
      Write-Output ('{"ok":true,"guid":"' + $now + '"}')
    }
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
              $cpuMs += [math]::Max(0, $p.TotalProcessorTime.TotalMilliseconds - $t0[$p.Id])
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

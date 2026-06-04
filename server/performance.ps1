param([string]$verb, [string]$value)
# Allowlisted Windows power-plan helper for Performance Mode.
#   get               -> { ok, guid }   active power scheme GUID
#   set high|ultimate -> { ok, guid }   switch to a known high-performance plan
#   set <guid>        -> { ok, guid }   restore a previously-saved plan by GUID
# Only these verbs/values are accepted; everything else is rejected. Switching
# power plans is fully reversible — the caller saves the prior GUID and restores
# it on exit. We never create, delete, or tweak individual plan settings here.
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
    default {
      Write-Output '{"ok":false,"error":"bad_verb"}'
    }
  }
} catch {
  $msg = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}

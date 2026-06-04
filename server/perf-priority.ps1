param([string]$verb, [string]$name, [string]$level)
# Allowlisted process-priority helper for Performance Mode.
#   set <name> high   -> raise the named process to AboveNormal (a gentle boost)
#   set <name> normal -> restore it to Normal (the reversal)
# Only user-owned, non-critical processes are touched: OS-critical names are
# refused. We never use Realtime/High (which can starve the system) — AboveNormal
# is the strongest level offered, and it's fully reversible.
$ErrorActionPreference = 'Stop'

$protected = @('explorer','csrss','winlogon','wininit','services','lsass','smss',
  'dwm','system','registry','fontdrvhost','sihost','ctfmon','searchhost',
  'shellexperiencehost','startmenuexperiencehost','textinputhost','runtimebroker',
  'applicationframehost')

try {
  if ($verb -ne 'set') { Write-Output '{"ok":false,"error":"bad_verb"}'; exit }
  $n = ($name -replace '\.exe$', '').Trim()
  if ([string]::IsNullOrWhiteSpace($n) -or ($protected -contains $n.ToLower())) {
    Write-Output '{"ok":false,"error":"protected"}'; exit
  }
  if ($level -eq 'high') { $pc = [System.Diagnostics.ProcessPriorityClass]::AboveNormal }
  else                   { $pc = [System.Diagnostics.ProcessPriorityClass]::Normal }

  $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
  if (-not $procs) { Write-Output '{"ok":false,"error":"not_found"}'; exit }

  $count = 0
  foreach ($p in $procs) { try { $p.PriorityClass = $pc; $count++ } catch {} }
  Write-Output ('{"ok":' + $(if ($count -gt 0) { 'true' } else { 'false' }) + ',"count":' + $count + '}')
} catch {
  $msg = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}

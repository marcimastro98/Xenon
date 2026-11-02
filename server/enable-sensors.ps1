# Raise Xenon's startup task to run elevated, so LibreHardwareMonitor can load
# its kernel driver and the CPU temperature / fan RPM / CPU-watt sensors work.
#
# Why this exists: install.ps1 registers the per-logon task with
# RunLevel = Highest ONLY when INSTALL.bat itself was run as administrator.
# Double-clicking the .bat (the common case) registers it Limited, and NOTHING
# repairs that afterwards - update-apply.ps1 never touches the task, so the level
# stays frozen for the life of the install and those users silently never get CPU
# temperature. Re-running the installer as admin fixes it; this is the one-tap
# equivalent, launched from the dashboard (POST /system/enable-sensors).
#
# The script relaunches ITSELF through UAC when it isn't already elevated: the
# backend deliberately runs unelevated in the user's session (see the process
# invariant in .claude/CLAUDE.md), so the prompt is the only way up. Everything it
# runs is a fixed command - no value from the request reaches a command line.
#
# The elevated copy is the text of THIS script as it was already loaded, handed
# over in -EncodedCommand, never `-File <this path>`: the install folder is
# writable by the user, and a file swapped between the UAC prompt and the moment
# the elevated PowerShell opened it would run as administrator with nobody the
# wiser. The task name travels inside that text as a checked, quoted literal.

param(
  [string]$TaskName = 'Xenon Edge Widget',
  [switch]$Elevated
)

# Captured first, before any prompt can be shown: this is what the elevated copy
# will run (see above).
$selfText = $null
try { $selfText = $MyInvocation.MyCommand.ScriptBlock.ToString() } catch { }

$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Out-Result($ok, $status, $message) {
  [pscustomobject]@{ ok = $ok; status = $status; message = $message } | ConvertTo-Json -Compress
}

function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# A value as a PowerShell single-quoted literal. Inside single quotes only the
# quote character is special, and PowerShell accepts four Unicode quote marks
# (U+2018 to U+201B) as that character too, so every one of the five is doubled.
function ConvertTo-PsLiteral([string]$Value) {
  $quotes = [string]([char]0x27) + [char]0x2018 + [char]0x2019 + [char]0x201A + [char]0x201B
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $Value.ToCharArray()) {
    if ($quotes.IndexOf($ch) -ge 0) { [void]$sb.Append($ch) }
    [void]$sb.Append($ch)
  }
  return "'" + $sb.ToString() + "'"
}

# This script's own text with its comments taken out (the parser decides what a
# comment is, so nothing inside a string is touched): the encoded command is
# limited by the 32767-character command line, and comments are most of it.
function Get-ElevationScriptText([string]$Text) {
  if (-not $Text) { return $null }
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count) { return $null }
  $sb = New-Object System.Text.StringBuilder $Text
  foreach ($t in @($tokens | Where-Object { $_.Kind -eq 'Comment' } | Sort-Object { $_.Extent.StartOffset } -Descending)) {
    [void]$sb.Remove($t.Extent.StartOffset, $t.Extent.EndOffset - $t.Extent.StartOffset)
  }
  return $sb.ToString()
}

# Task names are plain: refuse anything else before it goes near a prompt or a
# schtasks command line.
if ($TaskName -notmatch '^[A-Za-z0-9 ._()-]{1,128}$') {
  Out-Result $false 'failed' 'Invalid task name.'
  return
}

# Nothing to raise if the task was never registered (a dev/manual `node
# server/server.js`, or an install that never completed). Say so plainly instead
# of throwing a UAC prompt that cannot help.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Out-Result $false 'no_task' 'The Xenon startup task is not registered on this PC.'
  return
}

if (-not $Elevated) {
  if (Test-Elevated) {
    # Already admin (rare: the whole hub was started elevated) - do the work here.
  } else {
    $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $body = Get-ElevationScriptText $selfText
    if (-not $body) {
      Out-Result $false 'failed' 'The elevated step could not be prepared.'
      return
    }
    $command = "& {`n" + $body + "`n} -TaskName " + (ConvertTo-PsLiteral $TaskName) + ' -Elevated'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    if ($encoded.Length -gt 30000) {
      Out-Result $false 'failed' 'The elevated step is too large to start.'
      return
    }
    # NOT $args - that is an automatic variable; shadowing it is a trap for the
    # next reader even where it happens to work.
    $psArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    try {
      # -Verb RunAs raises the UAC prompt; a decline throws, and is reported as
      # such rather than swallowed - the dashboard must tell "declined" from
      # "failed".
      #
      # Do NOT wait on the child. An unelevated process cannot get SYNCHRONIZE
      # access to an ELEVATED child's process object, so Start-Process's own -Wait
      # blocked indefinitely here: the parent was observed still waiting minutes
      # after the elevated child had already exited having done the work, which
      # left the dashboard stuck on "waiting for the prompt" while the change had
      # in fact succeeded. Start and move on; the poll below is the real
      # completion signal, and it needs no rights we don't have.
      $null = Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $psArgs -WindowStyle Hidden -ErrorAction Stop
    } catch {
      Out-Result $false 'declined' 'The administrator prompt was declined.'
      return
    }

    # The child writes its result to its own hidden console, which we cannot read,
    # so never report its word for it. The task's run level IS the outcome, and
    # reading it needs no elevation - so poll that, and return the moment it lands.
    $deadline = (Get-Date).AddSeconds(20)
    do {
      $after = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($after -and $after.Principal.RunLevel -eq 'Highest') {
        Out-Result $true 'raised' 'The Xenon startup task now runs with administrator rights.'
        return
      }
      Start-Sleep -Milliseconds 400
    } while ((Get-Date) -lt $deadline)
    Out-Result $false 'failed' 'The task run level could not be raised.'
    return
  }
}

# -- Elevated from here --------------------------------------------------------
if (-not (Test-Elevated)) {
  Out-Result $false 'not_elevated' 'This step needs administrator rights.'
  return
}

try {
  $schtasks = Join-Path $env:WINDIR 'System32\schtasks.exe'
  # Raise the level FIRST and unconditionally: it is the permanent half of the fix
  # and must survive even if the restart below goes wrong.
  & $schtasks /Change /TN $TaskName /RL HIGHEST | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Out-Result $false 'failed' "schtasks could not change the task run level (exit $LASTEXITCODE)."
    return
  }

  # Raising the task does nothing for the backend that is ALREADY running - it
  # keeps the unelevated token it was born with, so the sensors stay dark and the
  # user is told to "restart Xenon" with no way to know which restart counts:
  # closing the native app doesn't restart the backend (the task does, at logon),
  # and relaunching it by hand starts it unelevated all over again. So finish the
  # job here, where we still hold the rights: stop the backend and start it THROUGH
  # the task, which now hands it an elevated token.
  #
  # Stop-then-start, in that order and never the reverse: a second backend cannot
  # bind port 3030, and the loser lingers holding settings.json open, which makes
  # every settings save fail with EPERM. Same shape as update-apply.ps1's
  # Stop-Server/Start-Server.
  try {
    $owner = (Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue).OwningProcess
    if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
  } catch { }
  Start-Sleep -Milliseconds 900

  & $schtasks /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Out-Result $false 'raised_no_restart' 'Administrator rights are enabled, but Xenon could not be restarted automatically.'
    return
  }
  Out-Result $true 'raised' 'The Xenon startup task now runs with administrator rights.'
} catch {
  Out-Result $false 'failed' $_.Exception.Message
}

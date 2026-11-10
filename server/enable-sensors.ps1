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
#
# Since 5.1.0 the setup no longer installs LibreHardwareMonitor or the PawnIO
# driver, so the elevated step also adds whichever of the two is missing, through
# winget with fixed package ids (winget checks each installer against the hash in
# its manifest). LHM goes machine-wide, under Program Files: cpu-temp.ps1 runs it
# elevated and prefers copies only administrators can write.
#
# The elevated copy reports back through one status file in server\data, written
# the way compact-vhdx.ps1 writes its own (fixed name, no link on the way, created
# fresh). Its console is hidden and unreadable from here, and the install can take
# minutes, so the task's run level alone no longer says when it has finished.

param(
  [string]$TaskName = 'Xenon Edge Widget',
  [string]$DataDir,
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

if (-not $DataDir -and $PSScriptRoot) { $DataDir = Join-Path $PSScriptRoot 'data' }
$StatusLeaf = 'xenon-sensors-setup.json'
$Status = if ($DataDir) { Join-Path $DataDir $StatusLeaf } else { $null }

function Test-IsLink($item) {
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Written with administrator rights, so the place is checked, not trusted:
# exactly <install>\server\data\<StatusLeaf>, no junction or symbolic link on
# the data folder, the server folder, the file or its .tmp.
function Test-StatusPath {
  try {
    if (-not $Status -or -not [IO.Path]::IsPathRooted($DataDir)) { return $false }
    $full = [IO.Path]::GetFullPath($Status)
    $dir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
    if ((Split-Path -Leaf $dir) -ne 'data') { return $false }
    $serverDir = Split-Path -Parent $dir
    if (-not $serverDir -or (Split-Path -Leaf $serverDir) -ne 'server') { return $false }
    if (-not [string]::Equals((Split-Path -Parent $full), $dir, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    foreach ($d in @($dir, $serverDir)) {
      $di = Get-Item -LiteralPath $d -Force -ErrorAction Stop
      if (-not $di.PSIsContainer -or (Test-IsLink $di)) { return $false }
    }
    foreach ($p in @($full, "$full.tmp")) {
      $fi = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
      if ($fi -and ($fi.PSIsContainer -or (Test-IsLink $fi))) { return $false }
    }
    return $true
  } catch { return $false }
}

function Write-Status($ok, $state, $message) {
  if (-not (Test-StatusPath)) { return }
  $o = [ordered]@{ state = 'done'; ok = [bool]$ok; status = $state; message = $message }
  $tmp = "$Status.tmp"
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = (New-Object Text.UTF8Encoding $false).GetBytes(($o | ConvertTo-Json -Compress))
    $fs.Write($bytes, 0, $bytes.Length)
  } finally { $fs.Dispose() }
  Move-Item -LiteralPath $tmp -Destination $Status -Force
}

function Get-PawnIoDriver {
  try { return Get-CimInstance Win32_SystemDriver -Filter "Name = 'PawnIO'" -ErrorAction Stop } catch { return $null }
}

# A LibreHardwareMonitorLib.dll of 0.9.5 or newer (no WinRing0) under Program
# Files, the copy cpu-temp.ps1 tries first.
function Test-MachineLhm {
  foreach ($sf in @([Environment+SpecialFolder]::ProgramFiles, [Environment+SpecialFolder]::ProgramFilesX86)) {
    $pf = [Environment]::GetFolderPath($sf)
    if (-not $pf) { continue }
    $dlls = @(Join-Path $pf 'LibreHardwareMonitor\LibreHardwareMonitorLib.dll')
    foreach ($pkg in @(Get-ChildItem -LiteralPath (Join-Path $pf 'WinGet\Packages') -Directory -Filter 'LibreHardwareMonitor*' -ErrorAction SilentlyContinue)) {
      $dlls += @(Get-ChildItem -LiteralPath $pkg.FullName -Filter LibreHardwareMonitorLib.dll -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    }
    foreach ($dll in $dlls) {
      if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) { continue }
      $raw = '' + (Get-Item -LiteralPath $dll).VersionInfo.FileVersion
      if ($raw -match '^\s*(\d+)\.(\d+)(?:\.(\d+))?') {
        $build = if ($Matches[3]) { [int]$Matches[3] } else { 0 }
        $v = New-Object -TypeName Version -ArgumentList @([int]$Matches[1], [int]$Matches[2], $build)
        if ($v -ge [Version]'0.9.5') { return $true }
      }
    }
  }
  return $false
}

function Invoke-Winget([string[]]$WingetArgs) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { return }
  $common = @('--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  $p = Start-Process -FilePath $winget.Source -ArgumentList ($WingetArgs + $common) -WindowStyle Hidden -PassThru
  if (-not $p.WaitForExit(300000)) { try { $p.Kill() } catch { } }
}

# 'ok' when LHM is in place (PawnIO is added when missing, but some sensors
# read without it), 'no_winget' or 'install_failed' otherwise.
function Install-SensorParts {
  $needPawn = -not (Get-PawnIoDriver)
  $needLhm = -not (Test-MachineLhm)
  if (-not $needPawn -and -not $needLhm) { return 'ok' }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { return $(if ($needLhm) { 'no_winget' } else { 'ok' }) }
  if ($needPawn) { Invoke-Winget @('install', '--id', 'namazso.PawnIO') }
  if ($needLhm) {
    Invoke-Winget @('install', '--id', 'LibreHardwareMonitor.LibreHardwareMonitor', '--scope', 'machine')
    if (-not (Test-MachineLhm)) { Invoke-Winget @('upgrade', '--id', 'LibreHardwareMonitor.LibreHardwareMonitor', '--scope', 'machine') }
  }
  if (Test-MachineLhm) { return 'ok' }
  return 'install_failed'
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
    if (-not (Test-StatusPath)) {
      Out-Result $false 'failed' 'The Xenon data folder is not where it should be.'
      return
    }
    Remove-Item -LiteralPath $Status -Force -ErrorAction SilentlyContinue
    $command = "& {`n" + $body + "`n} -TaskName " + (ConvertTo-PsLiteral $TaskName) +
      ' -DataDir ' + (ConvertTo-PsLiteral $DataDir) + ' -Elevated'
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
      $child = Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $psArgs -WindowStyle Hidden -PassThru -ErrorAction Stop
    } catch {
      Out-Result $false 'declined' 'The administrator prompt was declined.'
      return
    }

    # The child's console is hidden and unreadable, so its answer comes through
    # the status file. Whether it is still running is read by id, which needs no
    # rights over an elevated process. Installing can take minutes.
    $deadline = (Get-Date).AddMinutes(9)
    $goneAt = $null
    do {
      Start-Sleep -Milliseconds 500
      try {
        $s = Get-Content -LiteralPath $Status -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($s.state -eq 'done') { Out-Result ([bool]$s.ok) ([string]$s.status) ([string]$s.message); return }
      } catch { }
      if ($child -and -not (Get-Process -Id $child.Id -ErrorAction SilentlyContinue)) {
        if (-not $goneAt) { $goneAt = Get-Date } elseif (((Get-Date) - $goneAt).TotalSeconds -gt 3) { break }
      }
    } while ((Get-Date) -lt $deadline)
    Out-Result $false 'failed' 'The elevated step ended without a result.'
    return
  }
}

# -- Elevated from here --------------------------------------------------------
if (-not (Test-Elevated)) {
  Out-Result $false 'not_elevated' 'This step needs administrator rights.'
  return
}

try {
  $parts = 'ok'
  try { $parts = Install-SensorParts } catch { $parts = 'install_failed' }

  $schtasks = Join-Path $env:WINDIR 'System32\schtasks.exe'
  # Raise the level unconditionally, even when an install failed: it is the
  # permanent half of the fix and must survive even if the restart goes wrong.
  & $schtasks /Change /TN $TaskName /RL HIGHEST | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Status $false 'failed' "schtasks could not change the task run level (exit $LASTEXITCODE)."
    Out-Result $false 'failed' "schtasks could not change the task run level (exit $LASTEXITCODE)."
    return
  }
  if ($parts -ne 'ok') {
    Write-Status $false $parts 'The sensor reader could not be installed.'
  } else {
    Write-Status $true 'raised' 'The Xenon startup task now runs with administrator rights.'
  }
  # Time for the waiting copy to read the answer and the server to send it,
  # before that server is stopped below.
  Start-Sleep -Milliseconds 1500

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
  try { Write-Status $false 'failed' $_.Exception.Message } catch { }
  Out-Result $false 'failed' $_.Exception.Message
}

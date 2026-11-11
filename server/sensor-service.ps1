# Xenon's sensor service: the one part of Xenon that runs with administrator
# rights, so LibreHardwareMonitor can reach the kernel sensors (CPU temperature,
# fans, CPU and PSU watts, CPU clock).
#
# Why it exists: the engine (node + server) lives in a folder the user can write,
# so it must never run elevated: any program running as the user could change a
# file there and be handed administrator rights at the next sign-in. This script
# is copied, with cpu-temp.ps1 and sensors.ps1, to "%ProgramFiles%\Xenon Sensors"
# by enable-sensors.ps1 (after one UAC prompt) and started by the "Xenon Sensors"
# scheduled task, as SYSTEM: an account whose environment, profile and registry
# the user cannot touch (a task as the user, even elevated, loads the user's
# environment, and with it, for example, a .NET profiler DLL). Only
# administrators can change those files.
#
# It takes nothing from the engine but the NAME and time of the newest entry in
# "%ProgramData%\Xenon Sensors\want" (want-<ms>, touched by the engine while
# someone looks; nothing for 30 s = nobody is looking, nothing is read). Both
# come from the folder listing: no file the user can write is ever opened, so no
# link can lead this process anywhere. It writes three files to
# "%ProgramData%\Xenon Sensors", which enable-sensors.ps1 creates owned by
# Administrators with Users read-only (in its want folder this user may add files):
#   cpu.json      {"at": <ms>, "data": <cpu-temp.ps1 output>}
#   sensors.json  {"at": <ms>, "data": <sensors.ps1 list output>}
#   service.json  {"v": 1, "hash": <sha256 of the three scripts>, "pid", "at", "wanted"}
# The engine reads them (server/sensor-service/reader.js) and compares the hash
# with its own copies of the scripts to tell an out-of-date service.
#
# -OutDir and -Once exist for the tests, which run unelevated. An elevated run
# is accepted only from the Program Files folder, with its fixed folder.

param(
  [string]$OutDir,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

$here = $PSScriptRoot
$elevated = Test-Elevated
if ($elevated) {
  # Only the copy administrators own may run elevated, and only with the fixed
  # folders: a copy anywhere else would be a file the user can change.
  $expected = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'Xenon Sensors'
  if (-not [string]::Equals($here.TrimEnd('\'), $expected, [StringComparison]::OrdinalIgnoreCase)) { exit 2 }
  $OutDir = $null
}
if (-not $OutDir) { $OutDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'Xenon Sensors' }
$WantDir = Join-Path $OutDir 'want'

# Nothing from the user's environment decides what this process loads: system
# folders only on PATH and the module path, and its own folder as the current one.
$sys = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
$env:PATH = $sys + ';' + [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows) + ';' + (Join-Path $sys 'WindowsPowerShell\v1.0')
$env:PSModulePath = Join-Path $sys 'WindowsPowerShell\v1.0\Modules'
Set-Location -LiteralPath $here

# cpu-temp.ps1 loads LibreHardwareMonitor only from Program Files when this is set.
$global:XenonTrustedLhmOnly = $true

$CpuScript = Join-Path $here 'cpu-temp.ps1'
$SensorsScript = Join-Path $here 'sensors.ps1'
$WantedForMs = 30000
$IdleCheckMs = 2000
$HeartbeatMs = 15000
$ReleaseAfterIdleMs = 600000

function Get-ScriptsHash {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $all = New-Object System.Collections.Generic.List[byte]
    foreach ($f in @('sensor-service.ps1', 'cpu-temp.ps1', 'sensors.ps1')) {
      $all.AddRange([IO.File]::ReadAllBytes((Join-Path $here $f)))
    }
    return ([BitConverter]::ToString($sha.ComputeHash($all.ToArray())) -replace '-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# The interval the engine asked for, while it keeps asking: $null = not wanted.
# Name, time and attributes come from the directory listing (FindFirstFile
# data): nothing is opened, so an entry that is a link leads nowhere, and one
# is skipped anyway.
function Get-WantedInterval {
  try {
    $di = New-Object IO.DirectoryInfo $WantDir
    if (-not $di.Exists -or ($di.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
    $best = $null
    foreach ($fi in $di.EnumerateFiles('want-*')) {
      if ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if ($fi.Name -notmatch '^want-(\d{4,5})$') { continue }
      if (-not $best -or $fi.LastWriteTimeUtc -gt $best.LastWriteTimeUtc) { $best = $fi }
    }
    if (-not $best -or ([DateTime]::UtcNow - $best.LastWriteTimeUtc).TotalMilliseconds -gt $WantedForMs) { return $null }
    return [Math]::Min(10000, [Math]::Max(1000, [int]$best.Name.Substring(5)))
  } catch { return $null }
}

# Elevated, the folder must still be the one enable-sensors.ps1 made: no link,
# owned by Administrators or SYSTEM (a folder the user made could hold links).
function Test-OutDir {
  try {
    $di = New-Object IO.DirectoryInfo $OutDir
    if (-not $di.Exists -or ($di.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    if (-not $elevated) { return $true }
    $owner = $di.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
    return ($owner -eq 'S-1-5-32-544' -or $owner -eq 'S-1-5-18')
  } catch { return $false }
}

function Write-Snapshot([string]$Leaf, [string]$Json) {
  if (-not (Test-OutDir)) { return }
  $dest = Join-Path $OutDir $Leaf
  $tmp = "$dest.tmp"
  # A leftover .tmp is deleted, never written through: deleting a link removes
  # the link itself.
  if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
  [IO.File]::WriteAllText($tmp, $Json, $utf8NoBom)
  if ([IO.File]::Exists($dest)) { [IO.File]::Replace($tmp, $dest, $null) } else { [IO.File]::Move($tmp, $dest) }
}

function Write-Reading([string]$Leaf, [string]$Script, [object[]]$ScriptArgs) {
  try {
    $raw = ((& $Script @ScriptArgs) | Out-String).Trim()
    if (-not $raw.StartsWith('{')) { return }
    Write-Snapshot $Leaf ('{"at":' + (Get-NowMs) + ',"data":' + $raw + '}')
  } catch { }
}

function Close-Sessions {
  foreach ($name in @('XenonCpuLhm', 'XenonCorsairPsu')) {
    $v = Get-Variable -Scope Global -Name $name -ValueOnly -ErrorAction SilentlyContinue
    if ($v) { try { $v.Close() } catch { } }
    Set-Variable -Scope Global -Name $name -Value $null
  }
}

# One service per session, even if the task is started twice.
$mutex = New-Object Threading.Mutex($false, 'Global\XenonSensorService')
try { if (-not $mutex.WaitOne(0)) { exit 0 } } catch [Threading.AbandonedMutexException] { }

$hash = Get-ScriptsHash
$lastBeat = 0
$lastWanted = Get-NowMs
try {
  while ($true) {
    $interval = Get-WantedInterval
    $now = Get-NowMs
    if ($interval) {
      $lastWanted = $now
      Write-Reading 'cpu.json' $CpuScript @()
      Write-Reading 'sensors.json' $SensorsScript @('list')
    } elseif ($global:XenonCpuLhm -and ($now - $lastWanted) -gt $ReleaseAfterIdleMs) {
      Close-Sessions
    }
    if ($Once -or ($now - $lastBeat) -ge $HeartbeatMs) {
      $beat = [ordered]@{ v = 1; hash = $hash; pid = $PID; at = $now; wanted = [bool]$interval }
      try { Write-Snapshot 'service.json' ($beat | ConvertTo-Json -Compress) } catch { }
      $lastBeat = $now
    }
    if ($Once) { break }
    Start-Sleep -Milliseconds $(if ($interval) { $interval } else { $IdleCheckMs })
  }
} finally {
  Close-Sessions
  try { $mutex.ReleaseMutex() } catch { }
}

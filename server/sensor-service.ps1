# Xenon's sensor service: the one part of Xenon that runs with administrator
# rights, so LibreHardwareMonitor can reach the kernel sensors (CPU temperature,
# fans, CPU and PSU watts, CPU clock).
#
# Why it exists: the engine (node + server) lives in a folder the user can write,
# so it must never run elevated: any program running as the user could change a
# file there and be handed administrator rights at the next sign-in. This script
# is copied, with cpu-temp.ps1 and sensors.ps1, to "%ProgramFiles%\Xenon Sensors"
# by enable-sensors.ps1 (after one UAC prompt) and started by the "Xenon Sensors"
# scheduled task. Only administrators can change those files.
#
# It reads nothing from the engine but two things: the time the engine last
# touched %LOCALAPPDATA%\Xenon\sensor-want (no touch for 30 s = nobody is
# looking, nothing is read) and the refresh interval written in it (a number,
# clamped). It writes three files to "%ProgramData%\Xenon Sensors", a folder
# enable-sensors.ps1 creates with Users read-only:
#   cpu.json      {"at": <ms>, "data": <cpu-temp.ps1 output>}
#   sensors.json  {"at": <ms>, "data": <sensors.ps1 list output>}
#   service.json  {"v": 1, "hash": <sha256 of the three scripts>, "pid", "at", "wanted"}
# The engine reads them (server/sensor-service/reader.js) and compares the hash
# with its own copies of the scripts to tell an out-of-date service.
#
# -OutDir, -WantFile and -Once exist for the tests, which run unelevated. An
# elevated run is accepted only from the Program Files folder.

param(
  [string]$OutDir,
  [string]$WantFile,
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
  $WantFile = $null
}
if (-not $OutDir) { $OutDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) 'Xenon Sensors' }
if (-not $WantFile) { $WantFile = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Xenon\sensor-want' }

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
function Get-WantedInterval {
  try {
    $fi = New-Object IO.FileInfo $WantFile
    if (-not $fi.Exists -or $fi.Length -gt 64) { return $null }
    if (([DateTime]::UtcNow - $fi.LastWriteTimeUtc).TotalMilliseconds -gt $WantedForMs) { return $null }
    $n = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($WantFile)).Trim(), [ref]$n)) { $n = 5000 }
    return [Math]::Min(10000, [Math]::Max(1000, $n))
  } catch { return $null }
}

function Test-OutDir {
  try {
    $di = New-Object IO.DirectoryInfo $OutDir
    return ($di.Exists -and -not ($di.Attributes -band [IO.FileAttributes]::ReparsePoint))
  } catch { return $false }
}

function Write-Snapshot([string]$Leaf, [string]$Json) {
  if (-not (Test-OutDir)) { return }
  $dest = Join-Path $OutDir $Leaf
  $tmp = "$dest.tmp"
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

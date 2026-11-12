# Turn on the hardware sensors Windows protects (CPU temperature, fans, CPU and
# PSU watts, CPU clock) with ONE administrator prompt, launched from the
# dashboard (POST /system/enable-sensors).
#
# Since 5.1.0 the engine never runs elevated. It lives in a folder the user can
# write (node, the server, start-hidden.vbs), so an elevated startup task would
# hand administrator rights to any program that changed a file there. Instead the
# elevated step installs a small sensor service that only administrators can
# change:
#   - "%ProgramFiles%\Xenon Sensors": sensor-service.ps1, cpu-temp.ps1, sensors.ps1
#   - "%ProgramData%\Xenon Sensors": where the service writes its readings,
#     created with SYSTEM and Administrators full control, Users read only; in
#     its "want" folder this user may add files (the engine's "please read")
#   - the "Xenon Sensors" scheduled task: at this user's sign-in, as SYSTEM, so
#     no console ever shows and nothing of the user's environment comes along
#   - this user in Performance Log Users, so PresentMon reads FPS without
#     administrator rights (from the next sign-in)
#   - LibreHardwareMonitor (machine-wide) and the PawnIO driver when missing,
#     through winget with fixed ids
# and sets the engine's own task to normal rights. An engine that still runs
# elevated (enabled before 5.1.0) is restarted through that task.
#
# The elevated PowerShell never runs a file it reads after the prompt. The
# unelevated copy hashes the four scripts; the elevated one gets a short command
# (-EncodedCommand) holding those hashes, reads each file ONCE into memory,
# refuses any that changed, runs this script from those bytes and copies the
# service files from the same bytes. Values travel as checked, quoted literals.
#
# The elevated copy reports back through one status file in server\data (fixed
# name, no link on the way, created fresh): its console is hidden and the install
# can take minutes.

param(
  [string]$TaskName = 'Xenon Edge Widget',
  [string]$DataDir,
  [string]$UserSid,
  [switch]$Elevated,
  [switch]$RestartEngine,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$ServiceTask = 'Xenon Sensors'
$ServiceFiles = @('sensor-service.ps1', 'cpu-temp.ps1', 'sensors.ps1')
# A local or domain account (S-1-5-21-...) or a Microsoft Entra one (S-1-12-1-...).
$SidPattern = '^S-1-(5-21|12-1)(-\d{1,10}){4}$'

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
# Files: the only copy the sensor service loads.
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

# winget.exe from its own package under Program Files\WindowsApps, which only
# the system can change. Never through PATH: the usual winget.exe is an alias in
# the user's own WindowsApps folder, and this runs as administrator.
function Get-WingetPath {
  try {
    $pkg = @(Get-AppxPackage -Name 'Microsoft.DesktopAppInstaller' -ErrorAction Stop) | Sort-Object Version -Descending | Select-Object -First 1
    $pf = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    if (-not $pkg -or -not $pkg.InstallLocation -or -not $pkg.InstallLocation.StartsWith($pf + '\WindowsApps\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $exe = Join-Path $pkg.InstallLocation 'winget.exe'
    if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
  } catch { }
  return $null
}

function Invoke-Winget([string[]]$WingetArgs) {
  $winget = Get-WingetPath
  if (-not $winget) { return }
  $common = @('--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  $p = Start-Process -FilePath $winget -ArgumentList ($WingetArgs + $common) -WindowStyle Hidden -PassThru
  if (-not $p.WaitForExit(300000)) { try { $p.Kill() } catch { } }
}

# 'ok' when LHM is in place (PawnIO is added when missing, but some sensors
# read without it), 'no_winget' or 'install_failed' otherwise.
function Install-SensorParts {
  $needPawn = -not (Get-PawnIoDriver)
  $needLhm = -not (Test-MachineLhm)
  if (-not $needPawn -and -not $needLhm) { return 'ok' }
  if (-not (Get-WingetPath)) { return $(if ($needLhm) { 'no_winget' } else { 'ok' }) }
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

function Get-Sha256Hex([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '') } finally { $sha.Dispose() }
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

# The command the elevated PowerShell runs: read each script once, refuse it
# unless its hash is the one taken before the prompt, then run this script from
# those bytes. $global:XenonSensorFiles hands the same bytes to Install-SensorService.
function New-ElevatedCommand([string]$Dir, [hashtable]$Hashes, [string]$Sid, [switch]$Restart) {
  $pairs = ($Hashes.Keys | Sort-Object | ForEach-Object { (ConvertTo-PsLiteral $_) + '=' + (ConvertTo-PsLiteral $Hashes[$_]) }) -join ';'
  # First, before any command can load a module: system folders only, so no
  # module or program from the user's folders runs with these rights.
  $lines = @(
    "`$ErrorActionPreference='Stop';`$y=[Environment]::SystemDirectory;`$env:PSModulePath=`$y+'\WindowsPowerShell\v1.0\Modules';`$env:PATH=`$y+';'+[Environment]::GetFolderPath('Windows')"
    "`$d=" + (ConvertTo-PsLiteral $Dir) + ";`$h=@{" + $pairs + "};`$f=@{}"
    "foreach(`$k in `$h.Keys){`$b=[IO.File]::ReadAllBytes((Join-Path `$d `$k));`$s=[Security.Cryptography.SHA256]::Create();if(([BitConverter]::ToString(`$s.ComputeHash(`$b)) -replace '-','') -ne `$h[`$k]){exit 3};`$f[`$k]=`$b}"
    "`$global:XenonSensorFiles=`$f"
    "`$t=[Text.Encoding]::UTF8.GetString(`$f['enable-sensors.ps1']).TrimStart([char]0xFEFF)"
    "& ([ScriptBlock]::Create(`$t)) -TaskName " + (ConvertTo-PsLiteral $TaskName) + ' -DataDir ' + (ConvertTo-PsLiteral $DataDir) + ' -UserSid ' + (ConvertTo-PsLiteral $Sid) + ' -Elevated' + $(if ($Restart) { ' -RestartEngine' } else { '' })
  )
  return ($lines -join "`n")
}

# Deletes a file or folder without ever following a link inside it: a link is
# removed as a link, so nothing outside the folder can be reached.
function Remove-TreeNoFollow([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -and -not (Test-IsLink $item)) {
    foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) { Remove-TreeNoFollow $child.FullName }
  }
  if ($item.PSIsContainer) { [IO.Directory]::Delete($Path) } else { $item.Attributes = 'Normal'; [IO.File]::Delete($Path) }
}

function Test-AdminOwned([string]$Path) {
  $owner = [IO.Directory]::GetAccessControl($Path, [Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
  return ($owner -eq 'S-1-5-32-544' -or $owner -eq 'S-1-5-18')
}

# SYSTEM and Administrators full, Users read, nothing inherited; $Writer (the
# user's SID) may also add files and write them, never folders or links.
function New-FolderAcl([string]$Writer) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
  $both = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $none = [Security.AccessControl.PropagationFlags]::None
  foreach ($rule in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
    $sid = New-Object Security.Principal.SecurityIdentifier $rule[0]
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rule[1], $both, $none, 'Allow')))
  }
  if ($Writer) {
    $sid = New-Object Security.Principal.SecurityIdentifier $Writer
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'CreateFiles', 'None', $none, 'Allow')))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Write', 'ObjectInherit', 'InheritOnly', 'Allow')))
  }
  return $acl
}

# %ProgramData% lets every user create folders, and a folder made there by the
# user would let them plant links inside. So the folder is made under a random
# name with its rules from the first instant and renamed into place (a rename
# never lands on something already there); one someone else made first is
# removed, never trusted. One that is already ours is emptied: the service
# writes everything again.
function New-AdminFolder([string]$Path, [string]$Writer) {
  $acl = New-FolderAcl $Writer
  for ($i = 0; $i -lt 3; $i++) {
    if (Test-Path -LiteralPath $Path) {
      $item = Get-Item -LiteralPath $Path -Force
      if (-not (Test-IsLink $item) -and (Test-AdminOwned $Path)) {
        $item.SetAccessControl($acl)
        foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) { Remove-TreeNoFollow $child.FullName }
        return
      }
      Remove-TreeNoFollow $Path
    }
    $tmp = Join-Path (Split-Path -Parent $Path) ('.xenon-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($tmp, $acl)
    try { [IO.Directory]::Move($tmp, $Path); return } catch { Remove-TreeNoFollow $tmp }
  }
  throw 'The readings folder could not be created.'
}

function Register-SensorTask([string]$Dir, [string]$Account) {
  $ps = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $Dir 'sensor-service.ps1'
  $action = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $Dir -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"')
  # At this user's sign-in, but as SYSTEM: the service never runs with the
  # user's environment, profile or registry.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Account
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  $settings.Hidden = $true
  [void](Register-ScheduledTask -TaskName $ServiceTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force)
}

# The service, its folders and its task. Every file comes from the bytes checked
# before the prompt ($global:XenonSensorFiles), never from a second read.
function Install-SensorService([string]$Sid) {
  $files = $global:XenonSensorFiles
  foreach ($f in $ServiceFiles) { if (-not $files -or -not $files[$f]) { throw "The sensor service file $f is missing." } }
  $account = (New-Object Security.Principal.SecurityIdentifier $Sid).Translate([Security.Principal.NTAccount]).Value
  $schtasks = Join-Path ([Environment]::SystemDirectory) 'schtasks.exe'
  if (Get-ScheduledTask -TaskName $ServiceTask -ErrorAction SilentlyContinue) { & $schtasks /End /TN $ServiceTask 2>&1 | Out-Null; Start-Sleep -Milliseconds 800 }

  $pfDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) $ServiceTask
  if ((Test-Path -LiteralPath $pfDir) -and (Test-IsLink (Get-Item -LiteralPath $pfDir -Force))) { Remove-TreeNoFollow $pfDir }
  [void][IO.Directory]::CreateDirectory($pfDir)
  foreach ($f in $ServiceFiles) { [IO.File]::WriteAllBytes((Join-Path $pfDir $f), $files[$f]) }

  $readings = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)) $ServiceTask
  New-AdminFolder $readings $null
  New-AdminFolder (Join-Path $readings 'want') $Sid
  Register-SensorTask $pfDir $account
  try { Add-LocalGroupMember -SID 'S-1-5-32-559' -Member $Sid -ErrorAction Stop } catch { }
  & $schtasks /Run /TN $ServiceTask 2>&1 | Out-Null
}

if ($TaskName -notmatch '^[A-Za-z0-9 ._()-]{1,128}$') {
  Out-Result $false 'failed' 'Invalid task name.'
  return
}

if (-not $Elevated) {
  $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if (Test-Elevated) {
    # Already admin: an engine started elevated before 5.1.0 (migrate.js, or its
    # Enable sensors button). The engine's environment is the user's: system
    # folders only from here on.
    $env:PSModulePath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\Modules'
    $env:PATH = [Environment]::SystemDirectory + ';' + [Environment]::GetFolderPath('Windows')
    if (-not $NoRestart) {
      # This process sits in Node's kill-on-close job and dies with the engine it
      # must stop, so the work goes to a PowerShell started from here, which
      # leaves that job (silent breakaway): the same short command the UAC path
      # runs, files read once and checked. Never detached from Node: a console-
      # less powershell exits without running anything (VM, 11 Nov 2026).
      $hashes = @{}
      foreach ($f in @('enable-sensors.ps1') + $ServiceFiles) { $hashes[$f] = Get-Sha256Hex ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $f))) }
      $command = New-ElevatedCommand $PSScriptRoot $hashes $UserSid -Restart
      $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
      $psExe = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
      Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) -WindowStyle Hidden
      Out-Result $true 'restarting' 'The sensor service is being installed and Xenon restarts with normal rights.'
      return
    }
    $global:XenonSensorFiles = @{}
    foreach ($f in $ServiceFiles) { $global:XenonSensorFiles[$f] = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $f)) }
  } else {
    if (-not $PSScriptRoot -or -not (Test-StatusPath)) {
      Out-Result $false 'failed' 'The Xenon data folder is not where it should be.'
      return
    }
    $hashes = @{}
    foreach ($f in @('enable-sensors.ps1') + $ServiceFiles) { $hashes[$f] = Get-Sha256Hex ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $f))) }
    $command = New-ElevatedCommand $PSScriptRoot $hashes $UserSid
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Remove-Item -LiteralPath $Status -Force -ErrorAction SilentlyContinue
    $psExe = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $psArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    try {
      # -Verb RunAs raises the UAC prompt; a decline throws and is reported as
      # such. Never wait on the child: an unelevated process cannot get
      # SYNCHRONIZE access to an elevated one, so -Wait blocked for good. The
      # status file below is the completion signal.
      $child = Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $psArgs -WindowStyle Hidden -PassThru -ErrorAction Stop
    } catch {
      Out-Result $false 'declined' 'The administrator prompt was declined.'
      return
    }
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
if ($UserSid -notmatch $SidPattern) {
  Write-Status $false 'failed' 'The Windows account could not be read.'
  Out-Result $false 'failed' 'The Windows account could not be read.'
  return
}

try {
  $parts = 'ok'
  try { $parts = Install-SensorParts } catch { $parts = 'install_failed' }
  Install-SensorService $UserSid

  # The engine's own task back to normal rights, whatever it was before. Through
  # the task object, never `schtasks /Change`: on a task that runs as a user it
  # waits for that user's password on a console nobody sees (VM, 11 Nov 2026).
  $schtasks = Join-Path ([Environment]::SystemDirectory) 'schtasks.exe'
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $engineTask = [bool]$task
  if ($task -and $task.Principal.RunLevel -ne 'Limited') {
    $task.Principal.RunLevel = 'Limited'
    [void](Set-ScheduledTask -InputObject $task)
  }

  if ($parts -ne 'ok') { Write-Status $false $parts 'The sensor reader could not be installed.' }
  else { Write-Status $true 'service' 'The Xenon sensor service is installed.' }
  # Without its task (a manual `node server.js`) nothing could start the engine
  # again, so it is left running as it is.
  if (-not $RestartEngine -or -not $engineTask) { Out-Result ($parts -eq 'ok') $(if ($parts -eq 'ok') { 'service' } else { $parts }) 'The Xenon sensor service is installed.'; return }

  # An elevated engine keeps its token until it restarts. Stop it, then start
  # it through its task, now at normal rights. Stop first, never the reverse: a
  # second engine cannot bind the port, and the loser keeps settings.json open.
  Start-Sleep -Milliseconds 1500
  try {
    $owner = (Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue).OwningProcess
    if ($owner) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
  } catch { }
  Start-Sleep -Milliseconds 900
  & $schtasks /Run /TN $TaskName 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Out-Result $false 'raised_no_restart' 'The sensor service is installed, but Xenon could not be restarted automatically.'; return }
  Out-Result $true 'restarting' 'The sensor service is installed and Xenon restarted with normal rights.'
} catch {
  try { Write-Status $false 'failed' $_.Exception.Message } catch { }
  Out-Result $false 'failed' $_.Exception.Message
}

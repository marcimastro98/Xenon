# Compact one WSL / Docker Desktop virtual disk (.vhdx) so Windows gets back the
# space the Linux side already freed. Launched from the Dev cleanup widget
# (POST /api/devclean/compact), Windows only.
#
# WSL disks grow and never shrink on their own: deleting 50 GB of images inside
# Docker leaves the .vhdx file just as large. diskpart's `compact vdisk` is the
# tool that works on every Windows edition (Optimize-VHD needs Hyper-V), and it
# needs administrator rights, so the script relaunches ITSELF through UAC, the
# same way enable-sensors.ps1 does. The backend stays unelevated.
#
# The elevated copy is the text of THIS script as it was already loaded, handed
# over in -EncodedCommand, never `-File <this path>`: the install folder is
# writable by the user, and a file swapped between the UAC prompt and the moment
# the elevated PowerShell opened it would run as administrator with nobody the
# wiser. The parameters travel inside that text as quoted literals, after the
# same checks the elevated half repeats.
#
# The path arrives from the server, and the elevated half trusts none of it: it
# re-checks that the file is a .vhdx that THIS user's Docker Desktop or one of
# THIS user's registered WSL distros owns. Anything else is refused.
#
# Progress and outcome go to a status file the server polls (an unelevated parent
# cannot wait on an elevated child - see enable-sensors.ps1). The elevated half
# writes it, so it must sit directly in this install's server\data folder, with
# no link anywhere on the way (see Test-StatusPath).

param(
  [Parameter(Mandatory = $true)][string]$Vhdx,
  [Parameter(Mandatory = $true)][string]$Status,
  # Set only on the elevated relaunch: the server\data folder the unelevated
  # half resolved from its own location (an -EncodedCommand has no script path).
  [string]$DataDir,
  [switch]$Elevated
)

# Captured first, before any prompt can be shown: this is what the elevated copy
# will run (see the header). Empty inside the elevated copy itself, which never
# relaunches.
$selfText = $null
try { $selfText = $MyInvocation.MyCommand.ScriptBlock.ToString() } catch { }

$ErrorActionPreference = 'Stop'
$StatusLeaf = 'xenon-devclean-compact.json'
if (-not $DataDir -and $PSScriptRoot) { $DataDir = Join-Path $PSScriptRoot 'data' }

function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

function Test-IsLink($item) {
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# The status file is written with administrator rights, so where it goes is
# checked, not taken on trust: exactly <install>\server\data\<StatusLeaf>, with
# neither the data folder, the server folder, the file nor its .tmp a junction or
# symbolic link (a link there would turn this into "write a file anywhere").
function Test-StatusPath {
  try {
    if (-not $Status -or -not $DataDir) { return $false }
    if (-not [IO.Path]::IsPathRooted($Status) -or -not [IO.Path]::IsPathRooted($DataDir)) { return $false }
    $full = [IO.Path]::GetFullPath($Status)
    $dir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
    if ((Split-Path -Leaf $dir) -ne 'data') { return $false }
    $serverDir = Split-Path -Parent $dir
    if (-not $serverDir -or (Split-Path -Leaf $serverDir) -ne 'server') { return $false }
    if ((Split-Path -Leaf $full) -ne $StatusLeaf) { return $false }
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

function Write-Status($state, $extra) {
  # Re-checked on every write: the folder belongs to the user, who could swap
  # in a link after the first check.
  if (-not (Test-StatusPath)) { return }
  $o = [ordered]@{ state = $state; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  $tmp = "$Status.tmp"
  # Removing first unlinks a stale .tmp (a hard link to some other file would
  # otherwise be written THROUGH), and CreateNew refuses anything that appears
  # in between. The rename then replaces the status entry itself.
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = (New-Object Text.UTF8Encoding $false).GetBytes(($o | ConvertTo-Json -Compress))
    $fs.Write($bytes, 0, $bytes.Length)
  } finally { $fs.Dispose() }
  Move-Item -LiteralPath $tmp -Destination $Status -Force
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

# The disks this user actually owns: Docker Desktop's data disks and the
# ext4.vhdx of every registered WSL distro.
#
# A WSL BasePath comes from HKCU, which the user (and anything running as the
# user) can write, and this list decides what diskpart attaches as
# administrator. So a path from it is accepted only when it is either
#   - inside the user's profile folder (where Docker Desktop, Store distros and
#     `wsl --install` keep their disks: %LOCALAPPDATA%\Docker\wsl,
#     %LOCALAPPDATA%\Packages\...\LocalState, %LOCALAPPDATA%\wsl\{guid}) with no
#     junction or symbolic link on the way down from the profile root, or
#   - anywhere else (a `wsl --import` to another drive) but owned by this user,
#     which a disk the user created is and a disk belonging to the system, to
#     Hyper-V or to another account is not.
# The profile root comes from the known-folder API (HKLM's profile list), not
# from %USERPROFILE%, which the user can set.
function Test-UserOwnedDisk([string]$Path) {
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (Test-IsLink $item)) { return $false }
    $profileRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($item.FullName)
    if ($profileRoot -and $full.StartsWith($profileRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      $d = Split-Path -Parent $full
      $clean = $true
      while ($d -and $d.Length -gt $profileRoot.Length) {
        $di = Get-Item -LiteralPath $d -Force -ErrorAction Stop
        if (Test-IsLink $di) { $clean = $false; break }
        $d = Split-Path -Parent $d
      }
      if ($clean) { return $true }
    }
    $owner = (Get-Acl -LiteralPath $full).GetOwner([Security.Principal.SecurityIdentifier])
    return ($owner -and $owner.Equals([Security.Principal.WindowsIdentity]::GetCurrent().User))
  } catch { return $false }
}

function Get-AllowedVhdx {
  $list = @()
  $docker = Join-Path $env:LOCALAPPDATA 'Docker\wsl'
  if (Test-Path -LiteralPath $docker) {
    $list += Get-ChildItem -LiteralPath $docker -Recurse -Filter '*.vhdx' -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName }
  }
  $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (Test-Path $lxss) {
    foreach ($k in Get-ChildItem $lxss -ErrorAction SilentlyContinue) {
      $base = (Get-ItemProperty -LiteralPath $k.PSPath -Name BasePath -ErrorAction SilentlyContinue).BasePath
      if ($base) { $list += (Join-Path ($base -replace '^\\\\\?\\', '') 'ext4.vhdx') }
    }
  }
  return $list | Where-Object { Test-UserOwnedDisk $_ } | ForEach-Object { $_.ToLowerInvariant() }
}

# Checked in both halves: the unelevated one must not hand anything odd to the
# prompt, and the elevated one trusts nothing it was given.
if (-not (Test-StatusPath)) { exit 2 }
if ($Vhdx -notmatch '(?i)\.vhdx$' -or $Vhdx -match '[\x00-\x1F]' -or -not [IO.Path]::IsPathRooted($Vhdx)) {
  Write-Status 'error' @{ error = 'not_allowed' }
  exit 2
}

if (-not $Elevated -and -not (Test-Elevated)) {
  $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $body = Get-ElevationScriptText $selfText
  if (-not $body) { Write-Status 'error' @{ error = 'failed'; detail = 'could not prepare the elevated step' }; return }
  # The script block gets its parameters as literals; -DataDir pins the folder
  # the status file must be in to the one resolved here, from this script's
  # own location.
  $command = "& {`n" + $body + "`n} -Vhdx " + (ConvertTo-PsLiteral $Vhdx) +
    ' -Status ' + (ConvertTo-PsLiteral $Status) +
    ' -DataDir ' + (ConvertTo-PsLiteral $DataDir) + ' -Elevated'
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  if ($encoded.Length -gt 30000) { Write-Status 'error' @{ error = 'failed'; detail = 'elevated step too large' }; return }
  $psArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
  Write-Status 'prompt' $null
  try {
    $null = Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $psArgs -WindowStyle Hidden -ErrorAction Stop
  } catch {
    Write-Status 'declined' $null
  }
  return
}

try {
  $item = Get-Item -LiteralPath $Vhdx -ErrorAction Stop
  $full = $item.FullName.ToLowerInvariant()
  if ($item.Extension -ne '.vhdx' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      -not ((Get-AllowedVhdx) -contains $full)) {
    Write-Status 'error' @{ error = 'not_allowed' }
    return
  }
  $before = $item.Length

  # The disk must be detached from WSL: close Docker Desktop, then stop WSL.
  Write-Status 'stopping' @{ before = $before }
  Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  & (Join-Path $env:WINDIR 'System32\wsl.exe') --shutdown | Out-Null
  Start-Sleep -Seconds 3

  Write-Status 'compacting' @{ before = $before }
  # The commands go to diskpart on its standard input. A script file under
  # %TEMP% (diskpart /s) could be rewritten by anything running as the user
  # between being written and being read by the elevated diskpart; a pipe
  # cannot. Read from stdin, diskpart carries on after a failing command, so the
  # final `detach vdisk` always runs and a failed compact never leaves the disk
  # attached (which kept WSL from starting until a reboot).
  $diskpart = Join-Path ([Environment]::SystemDirectory) 'diskpart.exe'
  $commands = @(
    "select vdisk file=`"$($item.FullName)`"",
    'attach vdisk readonly',
    'compact vdisk',
    'detach vdisk',
    'exit'
  )
  # Continue for this call only: under Stop, Windows PowerShell 5.1 turns any
  # line a native tool writes to stderr into a terminating error once 2>&1 is
  # in play, and diskpart's own message is exactly what the status should carry.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = $commands | & $diskpart 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap }
  $after = (Get-Item -LiteralPath $item.FullName).Length
  # Interactive diskpart reports an error in its output rather than through its
  # exit code, so both are read. The patterns are diskpart's English messages;
  # on another display language a failure falls back to the exit code alone and
  # the before/after sizes show what happened.
  $failed = ($code -ne 0) -or ($out -match 'DiskPart has encountered an error|Virtual Disk Service error|There is no virtual disk selected|The system cannot find the file specified')
  if ($failed) {
    Write-Status 'error' @{ error = 'diskpart'; before = $before; after = $after; detail = ($out.Trim() -split "`r?`n" | Select-Object -Last 2) -join ' ' }
    return
  }
  Write-Status 'done' @{ before = $before; after = $after }
} catch {
  Write-Status 'error' @{ error = 'failed'; detail = $_.Exception.Message }
}

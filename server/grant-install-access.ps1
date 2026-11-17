# Gives the signed-in Windows account write access to Xenon's own folder.
#
# Started by install-access.js, only when the self-update cannot write its
# staging folder and only on the user's own Update tap. Run plainly, it asks
# for elevation once (UAC) and waits; the elevated copy grants Modify on this
# script's own install root to the account that asked, and nothing else. That
# is the state every installer leaves: the engine runs at normal rights and its
# files are the user's to change (see Register-StartupTask in install.ps1).
#
# Exit codes, read by install-access.js:
#   0  granted          3  the prompt was declined or could not be shown
#   4  bad account id   5  not a Xenon folder, or a folder Windows owns
#   anything else: icacls' own failure

param([switch]$Elevated, [string]$Sid)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not $Elevated) {
  # The account is read HERE, unelevated: an administrator who answers the
  # prompt for someone else must not end up granting the folder to themselves.
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-Sid', $me)
  try {
    $p = Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $relaunch -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
    exit $p.ExitCode
  } catch {
    exit 3
  }
}

# A local, Microsoft or domain account (S-1-5-21-...) or an Entra ID one
# (S-1-12-1-...): never a well-known group such as Everyone or Users.
if ($Sid -notmatch '^S-1-(5-21|12-1)(-\d+){1,14}$') { exit 4 }

$full = [IO.Path]::GetFullPath($root).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $full 'server\server.js'))) { exit 5 }

# Never a folder Windows itself owns, whatever this script was copied into.
$owned = @(
  [IO.Path]::GetPathRoot($full),
  [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
  [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),
  [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows),
  $env:ProgramW6432
) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
if ($owned -contains $full) { exit 5 }

$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
# (OI)(CI)M: Modify, inherited by every file and folder below; /T applies it to
# what is already there, files an elevated update left behind included.
& $icacls $full /grant "*${Sid}:(OI)(CI)M" /T /C /Q | Out-Null
exit $LASTEXITCODE

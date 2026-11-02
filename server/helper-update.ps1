# Xenon Helper updater - the single source of truth for the helper's minimum
# version and its download. Invoked as a CHILD process (never dot-sourced) by:
#   - install.ps1 (first install / reinstall): with -InstallIfMissing, so a fresh
#     machine always gets the helper.
#   - server.js at boot, right after a self-update: WITHOUT -InstallIfMissing, so it
#     only refreshes an EXISTING but outdated exe.
#
# Why this exists: the in-app updater applies only the GitHub SOURCE zip, and
# xenon-helper.exe is NOT in that zip - it is gitignored and attached to each
# release by CI (.github/workflows/helper.yml). Without this, "Update now" would
# leave users on a stale helper until they re-ran INSTALL.bat. The running server
# heals it here instead, so one click updates everything, exe included.
#
# The download is verified, not just version-checked: the server starts this exe,
# so TLS and a FileVersion are not enough (a swapped release asset, a compromised
# mirror or a man in the middle with a trusted root would otherwise get code run
# at the next start). release-asset-cli.js holds it to the same chain as every
# update - the release's SHA256SUMS must carry a valid Ed25519 signature from the
# pinned key and the file must hash to its line - and this script hashes it again
# right before it goes into place. Anything that does not verify is deleted and
# the helper simply stays as it was (or absent: Xenon works without it, and the
# server's own verified refresh, helper-update.js, can install it later).
#
# Exit codes: 0 = the helper is at/above the required version (already, or after a
# successful download), or there was nothing to do. Non-zero = a refresh was needed
# but could not be completed (release asset not attached yet, or a network error);
# the caller uses this to retry later instead of recording success.

[CmdletBinding()]
param(
  [switch]$InstallIfMissing,   # download even when no exe exists yet (installer path)
  [string]$HelperDir,          # defaults to <this script's dir>\helper
  [string]$NodePath            # the node.exe install.ps1 resolved (runs the verifier)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# THE required helper version. Bump this together with helper/XenonHelper.csproj
# <Version> whenever a helper stdio protocol or behaviour changes, so BOTH a re-run
# of INSTALL.bat and the in-app self-update refresh an outdated exe.
$minVersion = [Version]'0.15.0'
$repo = 'marcimastro98/Xenon'

if (-not $HelperDir) { $HelperDir = Join-Path $PSScriptRoot 'helper' }
$exe = Join-Path $HelperDir 'xenon-helper.exe'

function Write-HU($m) { Write-Host "[helper-update] $m" }

function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# The node.exe that runs the verifier. install.ps1 passes the one it already
# checked and runs everything else with. Otherwise the machine-wide install under
# Program Files (admin-only; the folder from the known-folder API, not from an
# environment variable the user can set), and PATH only when this process is not
# elevated: PATH holds user-writable folders, and an elevated run must not start
# a node.exe that anyone could have put there.
function Get-VerifierNode {
  if ($NodePath -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $NodePath }
  foreach ($sf in @([Environment+SpecialFolder]::ProgramFiles, [Environment+SpecialFolder]::ProgramFilesX86)) {
    try {
      $pf = [Environment]::GetFolderPath($sf)
      if ($pf) {
        $p = Join-Path $pf 'nodejs\node.exe'
        if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
      }
    } catch { }
  }
  if (Test-Elevated) { return $null }
  $c = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}

# Clean up renamed leftovers from a previous update (kept while a running server
# still had the old image mapped; deletable once it has restarted). The pattern
# covers BOTH spellings: the swap below appends to the full filename, producing
# 'xenon-helper.exe.old-<ts>', while older tooling wrote 'xenon-helper.old-'.
# Matching only the second meant this never cleaned what it created itself.
try { Get-ChildItem -Path $HelperDir -Filter 'xenon-helper*.old-*' -ErrorAction Stop | Remove-Item -Force -ErrorAction SilentlyContinue } catch { }

$have = $null
if (Test-Path $exe) {
  try { $have = [Version](Get-Item $exe).VersionInfo.FileVersion } catch { }
  if ($have -and $have -ge $minVersion) { Write-HU "up to date (v$have)"; exit 0 }
} elseif (-not $InstallIfMissing) {
  # No exe and not asked to install one: this machine is on the PowerShell fallback
  # path by choice. Nothing to do - never a surprise download at boot.
  Write-HU 'no helper present; nothing to refresh'
  exit 0
}

if ($have) { Write-HU "outdated (v$have, need v$minVersion+) - refreshing..." }
else { Write-HU "installing helper (need v$minVersion+)..." }

$stage = $null
try {
  if (-not (Test-Path $HelperDir)) { New-Item -ItemType Directory -Path $HelperDir -Force | Out-Null }
  # Verified download into a staging folder of its own (never straight over
  # the exe a running server may still have mapped). release-asset-cli.js keeps
  # the file only if it hashes to its line in the release's signed SHA256SUMS.
  # Start-Process with the answer written to a file, the way install.ps1 runs
  # native-installer-cli.js: under ErrorActionPreference Stop, PowerShell 5.1
  # would turn any line node writes to stderr into a terminating error.
  $verifier = Join-Path $PSScriptRoot 'release-asset-cli.js'
  if (-not (Test-Path -LiteralPath $verifier)) { throw 'release-asset-cli.js is missing, so the download cannot be verified' }
  $nodeExe = Get-VerifierNode
  if (-not $nodeExe) {
    # Fail closed. Nothing unverified is ever installed; the server installs and
    # refreshes the helper itself (helper-update.js, verified) once it runs.
    throw 'Node.js is not available to verify the download; the Xenon server will install the helper itself (verified) once it runs'
  }
  $stage = Join-Path $HelperDir 'download'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $answerFile = Join-Path $HelperDir 'helper-verify.json'
  Remove-Item -LiteralPath $answerFile -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $nodeExe -ArgumentList "`"$verifier`"", 'xenon-helper.exe', "`"$stage`"" `
    -WorkingDirectory $PSScriptRoot -Wait -NoNewWindow -RedirectStandardOutput $answerFile | Out-Null
  $verified = $null
  try { $verified = (Get-Content -LiteralPath $answerFile -Raw).Trim() | ConvertFrom-Json } catch { }
  Remove-Item -LiteralPath $answerFile -Force -ErrorAction SilentlyContinue
  if (-not $verified -or -not $verified.ok) {
    $why = if ($verified -and $verified.error) { [string]$verified.error } else { 'no answer' }
    if ($why -eq 'no_asset') { throw 'the latest release has no xenon-helper.exe asset yet' }
    throw "the downloaded helper could not be verified ($why)"
  }
  $download = Join-Path $stage 'xenon-helper.exe'
  $wantSha = ([string]$verified.sha256).ToLowerInvariant()
  if ([IO.Path]::GetFullPath([string]$verified.path) -ne [IO.Path]::GetFullPath($download) -or $wantSha -notmatch '^[0-9a-f]{64}$' -or -not (Test-Path -LiteralPath $download -PathType Leaf)) {
    throw 'the verifier answered with an unexpected file'
  }

  # Refuse to install a stale asset. Just after a release is published, CI may not
  # have attached the new exe yet, so releases/latest can still carry the OLD one;
  # committing it would look "done" while leaving the helper below the minimum, and
  # the caller's retry would never fire. Treat "downloaded but still too old" as a
  # failure so it is retried later.
  $dlVer = $null
  try { $dlVer = [Version](Get-Item $download).VersionInfo.FileVersion } catch { }
  if (-not $dlVer -or $dlVer -lt $minVersion) {
    Remove-Item $download -Force -ErrorAction SilentlyContinue
    throw "downloaded helper v$dlVer is older than required v$minVersion (release asset not updated yet)"
  }

  # Hashed again right before it goes into place, so a file swapped after the
  # check is refused too.
  if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wantSha) {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    throw 'the downloaded helper changed after it was verified'
  }

  # Move the old image ASIDE rather than deleting it, and drop the aside copy only
  # once the fresh one is in place. A running server still has the old exe mapped,
  # so deleting is blocked while renaming a running image is allowed, and if the
  # final move fails, the working helper goes back. Deleting first left machines
  # with no helper at all when that second step failed, which nothing heals
  # automatically: the in-app updater is an updater, not an installer, and returns
  # early when the exe is missing.
  $aside = $null
  if (Test-Path $exe) {
    $aside = "$exe.old-" + (Get-Date -Format 'yyyyMMddHHmmss')
    Move-Item $exe $aside -Force
  }
  try {
    Move-Item $download $exe -Force
  } catch {
    if ($aside -and (Test-Path $aside)) { Move-Item $aside $exe -Force }
    throw
  }
  # And once more where it will actually run from: the exe in place must be the
  # verified one, or the previous helper goes back.
  if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wantSha) {
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    if ($aside -and (Test-Path $aside)) { Move-Item $aside $exe -Force }
    throw 'the installed helper does not match the verified download'
  }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  # Best effort: still mapped by a running child; cleaned on the next run.
  if ($aside) { Remove-Item $aside -Force -ErrorAction SilentlyContinue }
  Write-HU "installed v$dlVer"
  exit 0
} catch {
  # Nothing half-verified is left lying around under the helper folder.
  try { if ($stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue } } catch { }
  Write-HU "could not refresh helper: $($_.Exception.Message)"
  exit 1
}

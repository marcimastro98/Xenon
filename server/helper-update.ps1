# Xenon Helper updater — the single source of truth for the helper's minimum
# version and its download. Invoked as a CHILD process (never dot-sourced) by:
#   - install.ps1 (first install / reinstall): with -InstallIfMissing, so a fresh
#     machine always gets the helper.
#   - server.js at boot, right after a self-update: WITHOUT -InstallIfMissing, so it
#     only refreshes an EXISTING but outdated exe.
#
# Why this exists: the in-app updater applies only the GitHub SOURCE zip, and
# xenon-helper.exe is NOT in that zip — it is gitignored and attached to each
# release by CI (.github/workflows/helper.yml). Without this, "Update now" would
# leave users on a stale helper until they re-ran INSTALL.bat. The running server
# heals it here instead, so one click updates everything, exe included.
#
# Exit codes: 0 = the helper is at/above the required version (already, or after a
# successful download), or there was nothing to do. Non-zero = a refresh was needed
# but could not be completed (release asset not attached yet, or a network error);
# the caller uses this to retry later instead of recording success.

[CmdletBinding()]
param(
  [switch]$InstallIfMissing,   # download even when no exe exists yet (installer path)
  [string]$HelperDir           # defaults to <this script's dir>\helper
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# THE required helper version. Bump this together with helper/XenonHelper.csproj
# <Version> whenever a helper stdio protocol or behaviour changes, so BOTH a re-run
# of INSTALL.bat and the in-app self-update refresh an outdated exe.
$minVersion = [Version]'0.5.2'
$repo = 'marcimastro98/Xenon'

if (-not $HelperDir) { $HelperDir = Join-Path $PSScriptRoot 'helper' }
$exe = Join-Path $HelperDir 'xenon-helper.exe'

function Write-HU($m) { Write-Host "[helper-update] $m" }

# Clean up renamed leftovers from a previous update (kept while a running server
# still had the old image mapped; deletable once it has restarted).
try { Get-ChildItem -Path $HelperDir -Filter 'xenon-helper.old*' -ErrorAction Stop | Remove-Item -Force -ErrorAction SilentlyContinue } catch { }

$have = $null
if (Test-Path $exe) {
  try { $have = [Version](Get-Item $exe).VersionInfo.FileVersion } catch { }
  if ($have -and $have -ge $minVersion) { Write-HU "up to date (v$have)"; exit 0 }
} elseif (-not $InstallIfMissing) {
  # No exe and not asked to install one: this machine is on the PowerShell fallback
  # path by choice. Nothing to do — never a surprise download at boot.
  Write-HU 'no helper present; nothing to refresh'
  exit 0
}

if ($have) { Write-HU "outdated (v$have, need v$minVersion+) - refreshing..." }
else { Write-HU "installing helper (need v$minVersion+)..." }

try {
  if (-not (Test-Path $HelperDir)) { New-Item -ItemType Directory -Path $HelperDir -Force | Out-Null }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ 'User-Agent' = 'XenonEdgeHub'; 'Accept' = 'application/vnd.github+json' }
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 25
  $asset = $rel.assets | Where-Object { $_.name -eq 'xenon-helper.exe' } | Select-Object -First 1
  if (-not $asset) { throw 'the latest release has no xenon-helper.exe asset yet' }

  $download = "$exe.download"
  if (Test-Path $download) { Remove-Item $download -Force -ErrorAction SilentlyContinue }
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $download -Headers @{ 'User-Agent' = 'XenonEdgeHub' } -TimeoutSec 180 -UseBasicParsing
  if (-not (Test-Path $download)) { throw 'download did not produce a file' }

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

  if (Test-Path $exe) {
    try {
      Remove-Item $exe -Force -ErrorAction Stop
    } catch {
      # A running server still has the old exe mapped: deleting is blocked, but
      # renaming a running image is allowed. The next server restart picks up the
      # fresh exe; the .old leftover is cleaned on the next run.
      Move-Item $exe ("$exe.old-" + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
    }
  }
  Move-Item $download $exe -Force
  Write-HU "installed v$dlVer"
  exit 0
} catch {
  Write-HU "could not refresh helper: $($_.Exception.Message)"
  exit 1
}

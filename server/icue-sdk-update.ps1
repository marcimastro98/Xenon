# ── CORSAIR iCUE SDK client component ────────────────────────────────────────
# Downloads the iCUE SDK client DLL that server/lighting.js talks to for CORSAIR
# RGB. Single source of truth for the pinned version and hash, shared by the
# installer (install.ps1 -> Install-ICueSdkIfNeeded) and the in-app fetch button
# on the lighting page (server/icue-sdk-install.js) — same shape as
# helper-update.ps1. Neither caller holds a version of its own.
#
# WHY IT IS DOWNLOADED AND NOT SHIPPED WITH XENON
# The SDK EULA (inside the zip's PDF; the cue-sdk repo carries no LICENSE file)
# grants "a nonexclusive, nontransferable ... royalty-free license to allow You
# to use the Software" and forbids transferring "all or any portion of the
# Software ... to any other person". The word "redistribute" never appears. So
# the DLL must never be committed to this repo or mirrored as one of our release
# assets, however convenient: each machine fetches its own copy from CORSAIR.
# The `redist/` folder name inside the archive does not override that text.
#
# WHY THE HASH IS PINNED
# This runs unattended and the result gets loaded into the server process as
# native code. A release asset that changed underneath us must fail loudly rather
# than be installed unverified. Bump $sdkVersion and $sdkZipSha together.

[CmdletBinding()]
param(
  [string]$SdkDir,          # destination folder; defaults to server\icue-sdk
  [switch]$Quiet            # machine-readable: emit only the final status line
)

$ErrorActionPreference = 'Stop'

$sdkVersion = '4.0.84'
$sdkZipSha  = 'EB4414CF505145F3E507DC839AD587BF7CA684D64BE3D9A834F416A136736D5D'
$dllName    = 'iCUESDK.x64_2019.dll'

if (-not $SdkDir) { $SdkDir = Join-Path $PSScriptRoot 'icue-sdk' }
$dll = Join-Path $SdkDir $dllName

function Say($msg, $color = 'Cyan') { if (-not $Quiet) { Write-Host "  $msg" -ForegroundColor $color } }
# One parseable line for the Node caller. Keep the prefixes stable.
function Finish($status, $detail) {
  if ($Quiet) { Write-Output "$status`t$detail" } else { Say $detail }
  if ($status -eq 'ok' -or $status -eq 'present') { exit 0 } else { exit 1 }
}

if (Test-Path $dll) { Finish 'present' $dll }

$zip   = Join-Path $env:TEMP "iCUESDK_$sdkVersion.zip"
$stage = Join-Path $env:TEMP "iCUESDK_$sdkVersion"
try {
  if (-not (Test-Path $SdkDir)) { New-Item -ItemType Directory -Path $SdkDir -Force | Out-Null }
  Say 'Downloading the CORSAIR iCUE SDK component...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $uri = "https://github.com/CorsairOfficial/cue-sdk/releases/download/v$sdkVersion/iCUESDK_$sdkVersion.zip"
  Invoke-WebRequest -Uri $uri -OutFile $zip -Headers @{ 'User-Agent' = 'XenonEdgeHub' } -TimeoutSec 120 -UseBasicParsing

  $hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
  if ($hash -ne $sdkZipSha) { throw "checksum mismatch (expected $sdkZipSha, got $hash)" }

  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  $src = Join-Path $stage "iCUESDK\redist\x64\$dllName"
  if (-not (Test-Path $src)) { throw "the archive did not contain redist\x64\$dllName" }
  Copy-Item -Path $src -Destination $dll -Force
  Finish 'ok' $dll
} catch {
  Finish 'error' $_.Exception.Message
} finally {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

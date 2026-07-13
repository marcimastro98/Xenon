# ─────────────────────────────────────────────────────────────────────────────
# xenon-bootstrap.ps1 — backend bootstrap for the Xenon setup.exe.
#
# Launched by the NSIS post-install hook (hooks.nsh) when the setup.exe was run
# on a machine with no Xenon backend (no "Xenon Edge Widget" scheduled task).
# It turns the one-click shell installer into a one-click FULL installer:
#   1. downloads the latest release source zip + its signed SHA256SUMS,
#   2. verifies the zip (Ed25519, fail-closed, BEFORE extraction),
#   3. extracts it into a canonical per-user install root,
#   4. runs the normal backend installer (server\install.ps1 -Mode native).
#
# Trust model: the source zip is verified against the pinned Ed25519 public key
# below — the SAME key server/self-update.js and server/helper-update.js pin
# (rotating the signing key means updating ALL THREE copies; see the rotation
# checklist in self-update.js). Node.js itself is fetched over TLS only: on a
# first install there is nothing local to anchor more trust to. That gap is
# known and accepted until the Authenticode code-signing certificate lands —
# identical to the INSTALL.bat path users have always used.
#
# This console IS the UI: every failure prints one clear line and pauses.
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'marcimastro98/Xenon'
$TaskName = 'Xenon Edge Widget'
$DashUrl = 'http://127.0.0.1:3030/'

# Canonical fresh-install root: per-user, so future self-updates can swap files
# without UAC, and never inside OneDrive-synced folders (Desktop/Documents).
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\Xenon'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail($m) {
  Write-Host ''
  Write-Host "  $m" -ForegroundColor Red
  Write-Host '  Nothing was changed on your PC beyond the Xenon app itself.' -ForegroundColor Gray
  Write-Host '  You can retry by running the Xenon setup again, or install manually:' -ForegroundColor Gray
  Write-Host "  https://github.com/$Repo#readme" -ForegroundColor Gray
  Write-Host ''
  Read-Host 'Press Enter to close this window'
  exit 1
}

Write-Host ''
Write-Host '  Xenon — completing your installation' -ForegroundColor Cyan
Write-Host '  The app you just installed is only the screen; this sets up the' -ForegroundColor Gray
Write-Host '  Xenon dashboard itself (one time, a few minutes).' -ForegroundColor Gray
Write-Host ''

# Defensive re-check (the NSIS hook already checks): backend present → done.
# The stderr redirect MUST happen inside cmd, not in PowerShell: under
# $ErrorActionPreference = 'Stop', PS 5.1 turns redirected native stderr into a
# terminating NativeCommandError — and schtasks writes to stderr precisely when
# the task is absent, i.e. on every fresh install this script exists for
# (issue #95: the bootstrap console flashed and died right here).
cmd /c "schtasks /Query /TN `"$TaskName`" >nul 2>&1"
if ($LASTEXITCODE -eq 0) {
  Write-Step 'The Xenon backend is already installed - nothing to do.'
  exit 0
}

# Second signal: the scheduled task is only a proxy for "backend installed" —
# a user who starts the server manually (task removed, dev checkout, task
# registered under another Windows account) has a live backend with no task.
# If anything already answers on the Xenon port, installing a SECOND backend
# would only fight it for 3030 — bail out.
try {
  $tcp = New-Object Net.Sockets.TcpClient
  $probe = $tcp.BeginConnect('127.0.0.1', 3030, $null, $null)
  $reached = $probe.AsyncWaitHandle.WaitOne(1500) -and $tcp.Connected
  $tcp.Close()
  if ($reached) {
    Write-Step 'A Xenon backend is already running on 127.0.0.1:3030 - nothing to do.'
    exit 0
  }
} catch { }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'XenonBootstrap'; 'Accept' = 'application/vnd.github+json' }
$tmp = Join-Path $env:TEMP 'xenon-bootstrap'
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# ── 1) Locate the latest release ─────────────────────────────────────────────
Write-Step 'Looking up the latest Xenon release...'
try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers -TimeoutSec 25
} catch {
  Fail "Could not reach GitHub to find the latest release ($($_.Exception.Message)). Check your connection and retry."
}
$tag = [string]$release.tag_name
if (-not $tag) { Fail 'The latest release has no tag - please retry later.' }
Write-Step "Latest release: $tag"

# ── 2) Download the source zip + its signed checksums ────────────────────────
$zipPath  = Join-Path $tmp 'source.zip'
$sumsPath = Join-Path $tmp 'SHA256SUMS'
$sigPath  = Join-Path $tmp 'SHA256SUMS.sig'
$zipUrl   = "https://github.com/$Repo/archive/refs/tags/$tag.zip"
$sumsUrl  = "https://github.com/$Repo/releases/download/$tag/SHA256SUMS"
$sigUrl   = "https://github.com/$Repo/releases/download/$tag/SHA256SUMS.sig"

Write-Step 'Downloading Xenon...'
$downloaded = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  if ($attempt -gt 1) {
    Write-Host "  Retrying the download (attempt $attempt of 3)..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
  }
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -Headers @{ 'User-Agent' = 'XenonBootstrap' } -TimeoutSec 300 -UseBasicParsing
    Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath -Headers @{ 'User-Agent' = 'XenonBootstrap' } -TimeoutSec 60 -UseBasicParsing
    Invoke-WebRequest -Uri $sigUrl -OutFile $sigPath -Headers @{ 'User-Agent' = 'XenonBootstrap' } -TimeoutSec 60 -UseBasicParsing
    $downloaded = $true
    break
  } catch {
    if ($attempt -eq 3) { Fail "The download failed ($($_.Exception.Message))." }
  }
}
if (-not $downloaded) { Fail 'The download failed.' }

# ── 3) Ensure Node.js (needed to verify the download, and by Xenon itself) ───
function Get-NodePath {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' }
  return ($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
}

$nodePath = Get-NodePath
if (-not $nodePath) {
  Write-Step 'Installing Node.js LTS (required by Xenon)...'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      $p = Start-Process -FilePath $winget.Source -ArgumentList @(
        'install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--silent'
      ) -Wait -PassThru
      if ($p.ExitCode -eq 0) { break }
      if ($attempt -lt 2) { Write-Host '  Retrying Node.js via winget...' -ForegroundColor Yellow; Start-Sleep -Seconds 5 }
    }
    $nodePath = Get-NodePath
  }
  if (-not $nodePath) {
    # No winget (or it failed): fetch the official LTS MSI directly.
    try {
      Write-Step 'Downloading Node.js LTS from nodejs.org...'
      $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
      $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
      if (-not $lts) { throw 'no LTS entry in the Node.js release index' }
      $msi = Join-Path $tmp "node-$($lts.version)-x64.msi"
      Invoke-WebRequest -Uri "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" -OutFile $msi -TimeoutSec 300 -UseBasicParsing
      # Per-machine MSI → one UAC prompt.
      Start-Process -FilePath (Join-Path $env:WINDIR 'System32\msiexec.exe') -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Verb RunAs -Wait
      $nodePath = Get-NodePath
    } catch {
      Fail "Node.js could not be installed automatically ($($_.Exception.Message)). Install it from https://nodejs.org and run the Xenon setup again."
    }
  }
  if (-not $nodePath) { Fail 'Node.js was installed but node.exe was not found yet. Restart Windows, then run the Xenon setup again.' }
}
Write-Step "Node.js: $nodePath"

# ── 4) Verify the download (Ed25519 over SHA256SUMS, then hash the zip) ──────
# Windows PowerShell 5.1 has no Ed25519, so the check runs in Node — the same
# primitive self-update.js uses. Fail-closed: no valid signature, no install.
Write-Step 'Verifying the download signature...'
$verifier = Join-Path $tmp 'verify.js'
@'
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const [zip, sums, sig] = process.argv.slice(2);
// Pinned Xenon release-signing public key (copy of UPDATE_PUBKEY_PEM in
// server/self-update.js — keep all copies in lockstep on rotation).
const PUB = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlH0Ju7LRPoy6sJlBwPHAhTCv1ck9RmPz9C2V1AzvOBk=
-----END PUBLIC KEY-----`;
let sumsBuf, sigB64;
try { sumsBuf = fs.readFileSync(sums); sigB64 = fs.readFileSync(sig, 'utf8').trim(); }
catch { console.error('integrity_missing'); process.exit(2); }
let ok = false;
try { ok = crypto.verify(null, sumsBuf, crypto.createPublicKey(PUB), Buffer.from(sigB64, 'base64')); }
catch { ok = false; }
if (!ok) { console.error('signature_invalid'); process.exit(3); }
let want = '';
for (const line of sumsBuf.toString('utf8').split(/\r?\n/)) {
  const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trim());
  if (m && m[2].trim() === 'source.zip') { want = m[1].toLowerCase(); break; }
}
if (!want) { console.error('integrity_missing'); process.exit(2); }
const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (got !== want) { console.error('integrity_mismatch'); process.exit(4); }
process.exit(0);
'@ | Set-Content -Path $verifier -Encoding ASCII

& $nodePath $verifier $zipPath $sumsPath $sigPath
if ($LASTEXITCODE -ne 0) {
  Remove-Item -Path $zipPath, $sumsPath, $sigPath -Force -ErrorAction SilentlyContinue
  Fail "The downloaded files failed the integrity check (code $LASTEXITCODE). This can happen right after a release is published - retry in a few minutes."
}
Write-Step 'Signature verified.'

# ── 5) Extract into the install root (merge, never a directory mirror) ───────
Write-Step "Installing to $InstallRoot..."
$extract = Join-Path $tmp 'extract'
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extract -Force
$top = @(Get-ChildItem -Path $extract -Directory)
if ($top.Count -ne 1) { Fail 'The downloaded archive has an unexpected layout.' }
$srcRoot = $top[0].FullName

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
robocopy $srcRoot $InstallRoot /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copying Xenon into $InstallRoot failed (robocopy $LASTEXITCODE)." }

# server\data is the user-data dir — create it if missing, never touch an
# existing one (an interrupted earlier bootstrap may have left real data).
$dataDir = Join-Path $InstallRoot 'server\data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }

# Seed the installed-file manifest so the FIRST self-update can already clean
# up files a newer version drops (see Remove-StaleAppFiles in update-apply.ps1).
try {
  $ver = ''
  try { $ver = ('' + (Get-Content (Join-Path $InstallRoot 'package.json') -Raw | ConvertFrom-Json).version).Trim() } catch { }
  $files = @()
  foreach ($fi in (Get-ChildItem -LiteralPath $srcRoot -Recurse -File)) {
    $rel = $fi.FullName.Substring($srcRoot.Length + 1)
    if ($rel -like 'server\data\*') { continue }
    $files += $rel
  }
  $manifest = @{ version = $ver; at = [DateTime]::UtcNow.ToString('o'); files = $files }
  $manifestPath = Join-Path $dataDir 'update-manifest.json'
  # BOM-less UTF-8 (WriteAllText, not Out-File): PS5.1's -Encoding utf8 prepends
  # a BOM that JSON.parse on the Node side rejects.
  [IO.File]::WriteAllText("$manifestPath.tmp", ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath "$manifestPath.tmp" -Destination $manifestPath -Force
} catch { }

Remove-Item -Path $extract -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue

# ── 6) Run the normal backend installer ──────────────────────────────────────
# Elevated when possible (full CPU-temperature sensor support and the reserved
# edge swipe); a declined UAC falls back to the unelevated path install.ps1
# already degrades gracefully on. -Mode native skips the surface prompt (the
# shell app is literally already installed - that's how we got here).
$installer = Join-Path $InstallRoot 'server\install.ps1'
if (-not (Test-Path $installer)) { Fail 'install.ps1 is missing from the downloaded release.' }
Write-Step 'Running the Xenon installer (a separate window opens)...'
$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$installer`"", '-Mode', 'native')
$ranInstaller = $false
try {
  Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $psArgs -Wait -ErrorAction Stop
  $ranInstaller = $true
} catch {
  Write-Host '  Administrator rights declined - continuing without them (CPU temperature on some systems may stay unavailable).' -ForegroundColor Yellow
  try {
    Start-Process -FilePath $psExe -ArgumentList $psArgs -Wait -ErrorAction Stop
    $ranInstaller = $true
  } catch {
    Fail "The Xenon installer could not be started ($($_.Exception.Message))."
  }
}
if (-not $ranInstaller) { Fail 'The Xenon installer did not run.' }

Write-Host ''
Write-Host '  ---------------------------------------------------' -ForegroundColor DarkGray
Write-Host '  Xenon is installed. The app on your Xeneon Edge will' -ForegroundColor Green
Write-Host '  come alive in a moment; the dashboard is also at:' -ForegroundColor Green
Write-Host "    $DashUrl" -ForegroundColor White
Write-Host '  ---------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''
Read-Host 'Press Enter to close this window'
exit 0

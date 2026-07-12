# ─────────────────────────────────────────────────────────────────────────
# install-native.ps1 — one-click install of the native Xenon kiosk app,
# triggered from the dashboard (POST /api/native/install).
#
# Downloads the latest signed NSIS installer (*-setup.exe) from the GitHub
# release and launches it silently. When the backend runs as the LocalSystem
# service (session 0), a GUI/user install must run in the INTERACTIVE user
# session, so we hand off through a one-shot scheduled task in that user's
# context; when the backend runs in the user session (dev), we launch directly.
#
# Best-effort and fail-soft: every step is wrapped so a failure just leaves the
# user on iCUE/browser (they can retry). On success it records install-mode.json
# = native so the dashboard stops offering the install.
# ─────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'
$Repo = 'marcimastro98/Xenon'

# Progress marker the dashboard polls (GET /api/native/install-status) so the
# install button can show downloading -> installing -> done/error instead of a
# single optimistic "launched" that looks frozen (the install is silent, so there
# is no window to watch). Best-effort: a write failure never aborts the install.
function Write-InstallStatus([string]$State, [string]$Err) {
  try {
    $dir = Join-Path $PSScriptRoot 'data'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $obj = [ordered]@{ state = $State; error = $Err; at = (Get-Date).ToString('o') }
    # WriteAllText = UTF-8 WITHOUT a BOM. Windows PowerShell's `-Encoding UTF8`
    # prepends one, and JSON.parse on the Node side rejects a BOM'd payload —
    # which froze the dashboard's progress feedback on the first message forever.
    [System.IO.File]::WriteAllText((Join-Path $dir 'native-install-status.json'), ($obj | ConvertTo-Json -Compress))
  } catch { }
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $dataDir = Join-Path $PSScriptRoot 'data'
  $dlDir = Join-Path $dataDir 'native-installer'
  New-Item -ItemType Directory -Path $dlDir -Force | Out-Null
  Write-InstallStatus 'downloading' ''

  # 1) Find the *-setup.exe asset on the latest release.
  $headers = @{ 'User-Agent' = 'XenonEdge'; 'Accept' = 'application/vnd.github+json' }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -like '*-setup.exe' } | Select-Object -First 1
  if (-not $asset) { Write-InstallStatus 'error' 'no_installer'; Write-Error 'No native installer (*-setup.exe) on the latest release yet.'; exit 2 }

  # 2) Download it.
  $exe = Join-Path $dlDir $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -Headers @{ 'User-Agent' = 'XenonEdge' }
  if (-not (Test-Path $exe)) { Write-InstallStatus 'error' 'download_failed'; Write-Error 'Download failed.'; exit 3 }
  Write-InstallStatus 'installing' ''

  # 3) Launch the silent installer in the right session, then start the app:
  # the silent NSIS install never launches it, and the kiosk registers its own
  # login autostart only on first run.
  $isSystem = [System.Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
  if ($isSystem) {
    # Running as LocalSystem: bounce through a one-shot interactive-user task so
    # the per-user install lands in the logged-in user's profile, not SYSTEM's.
    # The task runs a tiny cmd runner: install silently, then start the kiosk
    # (%LOCALAPPDATA% expands in the interactive user's context, where the
    # per-user NSIS bundle installs).
    $user = (Get-CimInstance Win32_ComputerSystem).UserName
    if (-not $user) { Write-Error 'No interactive user is logged on.'; exit 4 }
    $runner = Join-Path $dlDir 'install-and-launch.cmd'
    Set-Content -Path $runner -Encoding ASCII -Value @(
      '@echo off',
      ('"' + $exe + '" /S /NOBOOTSTRAP'),
      'if exist "%LOCALAPPDATA%\Xenon\xenon-native.exe" start "" "%LOCALAPPDATA%\Xenon\xenon-native.exe"'
    )
    $taskName = 'XenonInstallNativeOnce'
    try { schtasks /Delete /TN $taskName /F 2>$null | Out-Null } catch { }
    # /IT = run only when that user is logged on, in their interactive session.
    schtasks /Create /TN $taskName /TR "`"$runner`"" /SC ONCE /ST 00:00 /RU "$user" /IT /F | Out-Null
    schtasks /Run /TN $taskName | Out-Null
    # The task self-cleans on the next run of this script; leaving it is harmless.
    # We handed off to the interactive task and can't observe its result from here,
    # so leave the marker on 'installing' — the dashboard's poll times out gently.
    Write-InstallStatus 'installing' ''
  }
  else {
    # Backend runs in the user session already: install, then start the kiosk
    # (single-instance, so a second launch just refocuses).
    Start-Process -FilePath $exe -ArgumentList '/S', '/NOBOOTSTRAP' -Wait
    $appExe = Join-Path $env:LOCALAPPDATA 'Xenon\xenon-native.exe'
    if (Test-Path $appExe) {
      try { Start-Process -FilePath $appExe -WorkingDirectory (Split-Path -Parent $appExe) } catch { }
      Write-InstallStatus 'done' ''
    } else {
      Write-InstallStatus 'error' 'launch_missing'
    }
  }

  # 4) Record that native is now the chosen surface (hides the dashboard promo).
  try {
    $payload = [pscustomobject]@{ mode = 'native'; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    Set-Content -Path (Join-Path $dataDir 'install-mode.json') -Value $payload -Encoding UTF8
  } catch { }

  exit 0
}
catch {
  Write-InstallStatus 'error' $_.Exception.Message
  Write-Error $_.Exception.Message
  exit 1
}

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

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $dataDir = Join-Path $PSScriptRoot 'data'
  $dlDir = Join-Path $dataDir 'native-installer'
  New-Item -ItemType Directory -Path $dlDir -Force | Out-Null

  # 1) Find the *-setup.exe asset on the latest release.
  $headers = @{ 'User-Agent' = 'XenonEdge'; 'Accept' = 'application/vnd.github+json' }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -like '*-setup.exe' } | Select-Object -First 1
  if (-not $asset) { Write-Error 'No native installer (*-setup.exe) on the latest release yet.'; exit 2 }

  # 2) Download it.
  $exe = Join-Path $dlDir $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -Headers @{ 'User-Agent' = 'XenonEdge' }
  if (-not (Test-Path $exe)) { Write-Error 'Download failed.'; exit 3 }

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
      ('"' + $exe + '" /S'),
      'if exist "%LOCALAPPDATA%\Xenon\xenon-native.exe" start "" "%LOCALAPPDATA%\Xenon\xenon-native.exe"'
    )
    $taskName = 'XenonInstallNativeOnce'
    try { schtasks /Delete /TN $taskName /F 2>$null | Out-Null } catch { }
    # /IT = run only when that user is logged on, in their interactive session.
    schtasks /Create /TN $taskName /TR "`"$runner`"" /SC ONCE /ST 00:00 /RU "$user" /IT /F | Out-Null
    schtasks /Run /TN $taskName | Out-Null
    # The task self-cleans on the next run of this script; leaving it is harmless.
  }
  else {
    # Backend runs in the user session already: install, then start the kiosk
    # (single-instance, so a second launch just refocuses).
    Start-Process -FilePath $exe -ArgumentList '/S' -Wait
    $appExe = Join-Path $env:LOCALAPPDATA 'Xenon\xenon-native.exe'
    if (Test-Path $appExe) {
      try { Start-Process -FilePath $appExe -WorkingDirectory (Split-Path -Parent $appExe) } catch { }
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
  Write-Error $_.Exception.Message
  exit 1
}

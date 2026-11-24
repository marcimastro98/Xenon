<#
  session.ps1 - opens and closes a SimplySign cloud session on a GitHub-hosted
  Windows runner, so the release can be signed with no machine of ours on.

    session.ps1 -Action Connect     install SimplySign Desktop (pinned), log in,
                                    wait until the certificate is in the store
    session.ps1 -Action Disconnect  log out and stop SimplySign Desktop

  Connect needs, from the windows-signing environment:
    CERTUM_OTPAUTH_URI  the otpauth://totp/... text of the SimplySign activation QR
    IN_THUMBPRINT       WINDOWS_SIGN_THUMBPRINT, the certificate the session must show
  and optionally CERTUM_USERNAME when the login is not the one in the QR label.

  The login uses SimplySign Desktop's own "/autologin <login> <code>" switch, no
  GUI automation. The code comes from tools/simplysign/otp.mjs. Every secret
  value (the URI, the login, each code) is masked before anything can print it:
  this repo is public and so are its workflow logs.

  After Connect the certificate sits in Cert:\CurrentUser\My for the rest of the
  JOB, exactly as on the signing PC, so tools/sign-windows.ps1 and Tauri's
  signCommand work unchanged. Always pair it with a Disconnect step that runs
  with if: always().
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Connect', 'Disconnect')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

# Pinned: a new SimplySign Desktop is a reviewed change to these two lines, never
# whatever the download serves today. Hash checked on 24 Nov 2026 against the
# file on files.certum.eu, signed by Asseco Data Systems S.A.
$version = '9.4.5.95'
$sha256 = '6309E8B46F1F4E786288E777AEF515A2C30D885165B71A21191E9941BADEBD6B'
$url = "https://files.certum.eu/software/SimplySignDesktop/Windows/$version/SimplySignDesktop-$version-64-bit-en.msi"
$exe = Join-Path $env:ProgramFiles 'Certum\SimplySign Desktop\SimplySignDesktop.exe'
$otpTool = Join-Path $PSScriptRoot 'otp.mjs'

function Add-Mask([string]$Value) {
  if (-not [string]::IsNullOrEmpty($Value)) { Write-Host "::add-mask::$Value" }
}

function Install-SimplySign {
  if (Test-Path -LiteralPath $exe) {
    Write-Host 'SimplySign Desktop is already installed'
    return
  }
  $msi = Join-Path $env:RUNNER_TEMP "SimplySignDesktop-$version.msi"
  Write-Host "Downloading SimplySign Desktop $version"
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $msi).Hash
  if ($actual -ne $sha256) { throw "SimplySign Desktop installer hash $actual is not the pinned $sha256" }
  $sig = Get-AuthenticodeSignature -LiteralPath $msi
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Asseco Data Systems S\.A\.') {
    throw "SimplySign Desktop installer is not validly signed by Asseco Data Systems ($($sig.Status))"
  }
  $install = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
  if ($install.ExitCode -notin @(0, 3010)) { throw "SimplySign Desktop install failed (msiexec exit $($install.ExitCode))" }
  if (-not (Test-Path -LiteralPath $exe)) { throw "SimplySign Desktop is missing after install: $exe" }
}

function Test-Certificate([string]$Thumbprint) {
  $cert = Get-ChildItem "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction SilentlyContinue
  return [bool]($cert -and $cert.HasPrivateKey)
}

function Get-NextCode([long]$After) {
  $line = & node $otpTool next --after $After
  if ($LASTEXITCODE -ne 0) { throw 'could not compute the SimplySign code (see the message above)' }
  $otp = $line | ConvertFrom-Json
  Add-Mask $otp.code
  Add-Mask $otp.login
  return $otp
}

function Connect-SimplySign {
  if ([string]::IsNullOrWhiteSpace($env:CERTUM_OTPAUTH_URI)) {
    throw 'CERTUM_OTPAUTH_URI is empty: add it as a secret of the windows-signing environment'
  }
  Add-Mask $env:CERTUM_OTPAUTH_URI
  Add-Mask $env:CERTUM_USERNAME
  $thumb = ("$env:IN_THUMBPRINT" -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  if ($thumb.Length -ne 40) { throw 'WINDOWS_SIGN_THUMBPRINT is not set or not a SHA-1 thumbprint' }

  Install-SimplySign
  $last = -1
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $otp = Get-NextCode $last
    $last = [long]$otp.counter
    Write-Host "SimplySign login, attempt $attempt"
    $proc = Start-Process -FilePath $exe -ArgumentList @('/autologin', $otp.login, $otp.code) -PassThru
    # A refused login makes SimplySign Desktop exit; an accepted one keeps it
    # running and puts the cloud certificate in CurrentUser\My.
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
      if (Test-Certificate $thumb) {
        Write-Host "certificate $thumb is ready"
        return
      }
      if ($proc.HasExited) { break }
      Start-Sleep -Seconds 2
    }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  }
  Write-SimplySignLog
  throw "SimplySign login failed: certificate $thumb never reached Cert:\CurrentUser\My"
}

# Only on failure, and only the tail: the log is the one clue a refused login
# leaves. Masks registered above still apply to it.
function Write-SimplySignLog {
  $dir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'SimplySignLog'
  foreach ($log in @(Get-ChildItem -LiteralPath $dir -Filter '*log.txt' -File -ErrorAction SilentlyContinue)) {
    Write-Host "--- $($log.Name) (last 40 lines)"
    Get-Content -LiteralPath $log.FullName -Tail 40 | Write-Host
  }
}

function Disconnect-SimplySign {
  if (-not (Get-Process -Name SimplySignDesktop -ErrorAction SilentlyContinue)) {
    Write-Host 'no SimplySign session to close'
    return
  }
  # "/close" asks the running instance to quit, which also ends the cloud
  # session. Not waited on: it blocks until the running instance answers.
  Start-Process -FilePath $exe -ArgumentList '/close' | Out-Null
  Wait-Process -Name SimplySignDesktop -Timeout 15 -ErrorAction SilentlyContinue
  Get-Process -Name SimplySignDesktop -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Host 'SimplySign session closed'
}

if ($Action -eq 'Connect') { Connect-SimplySign } else { Disconnect-SimplySign }

<#
  sign-windows.ps1 - Authenticode-signs ONE file with the certificate named by
  $env:XENON_SIGN_THUMBPRINT.

  Two callers, one script on purpose:

    * Tauri, once per binary it bundles, through the `signCommand` in
      apps/native/src-tauri/windows/sign.conf.json. That covers BOTH
      xenon-native.exe and the NSIS setup that carries it - signing the setup
      alone would leave the exe inside it unsigned, and the exe inside it is
      the one antivirus quarantines mid-session.
    * release.yml directly, for xenon-helper.exe (built by dotnet, never seen
      by Tauri) and for windows/xenon-bootstrap.ps1.

  It signs a .ps1 through Set-AuthenticodeSignature and everything else through
  signtool, because signtool does not sign scripts. The caller does not have to
  care which is which.

  NOT OPTIONAL, and this is the point of the script: it fails loudly. It is only
  ever invoked when signing was explicitly asked for, so "no certificate" here
  means the release is about to ship unsigned while believing it is signed. The
  opt-out lives one level up, in the workflow, which simply does not call this
  when no thumbprint secret exists.

  Timestamping is not optional either: without it every signature stops
  validating the day the certificate expires, and since 27 February 2026 a code
  signing certificate lasts at most 459 days.

  Windows PowerShell 5.1 compatible on purpose - Tauri invokes it through
  powershell.exe, not pwsh.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
# PowerShell 7.4+ turns a non-zero exit code from a native command into a
# terminating error when ErrorActionPreference is Stop. That would jump straight
# past the retry loop below on the first flaky timestamp. Windows PowerShell 5.1
# (which is what Tauri invokes) has no such variable, hence the guard.
if (Test-Path -Path 'variable:PSNativeCommandUseErrorActionPreference') {
  $PSNativeCommandUseErrorActionPreference = $false
}

$thumbprint = $env:XENON_SIGN_THUMBPRINT
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
  throw 'XENON_SIGN_THUMBPRINT is not set, so there is nothing to sign with. This script is only called when signing was requested - the workflow decides whether to call it at all.'
}
# Copy-pasted thumbprints arrive with spaces, and the certmgr UI adds an
# invisible left-to-right mark in front of the first character.
$thumbprint = ($thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
if ($thumbprint.Length -ne 40) {
  throw "XENON_SIGN_THUMBPRINT is not a SHA-1 thumbprint: expected 40 hex characters, got $($thumbprint.Length)."
}

if (-not (Test-Path -LiteralPath $Path)) {
  throw "nothing to sign at '$Path'."
}
$file = (Resolve-Path -LiteralPath $Path).ProviderPath

$timestampUrl = $env:XENON_SIGN_TIMESTAMP_URL
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
  # Certum's own RFC 3161 server. Overridable because the certificate may not
  # stay with Certum forever.
  $timestampUrl = 'http://time.certum.pl/'
}

# signtool ships with the Windows SDK and is not on PATH on a bare runner. The
# newest x64 build wins; the SDK version is the directory ABOVE the arch one.
function Resolve-SignTool {
  $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $roots = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $candidates = Get-ChildItem -Path $root -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*\x64\*' } |
      Sort-Object -Descending -Property @{ Expression = {
        # Sort as a version, not as text: "10.0.22621" must beat "10.0.9".
        try { [version]$_.Directory.Parent.Name } catch { [version]'0.0.0.0' }
      } }
    if ($candidates) { return @($candidates)[0].FullName }
  }
  return $null
}

$extension = [System.IO.Path]::GetExtension($file).ToLowerInvariant()

if ($extension -eq '.ps1' -or $extension -eq '.psm1' -or $extension -eq '.psd1') {
  $cert = Get-ChildItem -Path ('Cert:\CurrentUser\My\' + $thumbprint) -ErrorAction SilentlyContinue
  if (-not $cert) {
    $cert = Get-ChildItem -Path ('Cert:\LocalMachine\My\' + $thumbprint) -ErrorAction SilentlyContinue
  }
  if (-not $cert) {
    throw "no certificate with thumbprint $thumbprint in Cert:\CurrentUser\My or Cert:\LocalMachine\My. With SimplySign, open a cloud session first - the virtual card is what puts the certificate in the store."
  }

  $result = Set-AuthenticodeSignature -FilePath $file -Certificate @($cert)[0] `
    -HashAlgorithm SHA256 -TimestampServer $timestampUrl
  if ($result.Status -ne 'Valid') {
    throw "signing '$file' produced status '$($result.Status)': $($result.StatusMessage)"
  }
  Write-Host "signed (script): $file"
  return
}

$signtool = Resolve-SignTool
if (-not $signtool) {
  throw 'signtool.exe was not found. Install the Windows SDK signing tools, or put signtool.exe on PATH.'
}

# A timestamp server is a third party over plain HTTP and it does go down. Three
# attempts, because losing a release to someone else's five second outage is a
# worse outcome than a slow job.
$attempt = 0
while ($true) {
  $attempt++
  & $signtool sign /sha1 $thumbprint /fd SHA256 /tr $timestampUrl /td SHA256 /v $file
  if ($LASTEXITCODE -eq 0) { break }
  if ($attempt -ge 3) {
    throw "signtool failed on '$file' after $attempt attempts (exit $LASTEXITCODE)."
  }
  Write-Host "signtool attempt $attempt failed (exit $LASTEXITCODE) - retrying"
  Start-Sleep -Seconds (5 * $attempt)
}

# Assert rather than trust: /pa uses the Authenticode policy, which is what
# Windows itself applies when it decides whether to trust the file.
& $signtool verify /pa /v $file
if ($LASTEXITCODE -ne 0) {
  throw "'$file' was signed but does not verify (exit $LASTEXITCODE)."
}
Write-Host "signed: $file"

#Requires -Version 5.1
<#
  uninstall-service.ps1 — stop and remove the Xenon backend Windows service.

  Removes ONLY the service and its generated artifacts (xenon-service.xml, logs,
  and the WinSW exe). It never touches server/ code or server/data/ user data, so
  Xenon stays fully usable via `npm start` in the browser and the iCUE iframe.

  Must run elevated.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServiceId  = 'XenonEdgeService'
$ServiceDir = $PSScriptRoot
$ExePath    = Join-Path $ServiceDir 'xenon-service.exe'
$XmlPath    = Join-Path $ServiceDir 'xenon-service.xml'
$LogDir     = Join-Path $ServiceDir 'logs'

function Write-Step($m) { Write-Host "[xenon-service] $m" -ForegroundColor Cyan }

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Removing a Windows service requires an elevated (Administrator) PowerShell.'
  }
}

Assert-Admin

$svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($svc -and (Test-Path $ExePath)) {
  Write-Step 'Stopping and uninstalling the service ...'
  & $ExePath stop 2>$null | Out-Null
  & $ExePath uninstall 2>$null | Out-Null
  Start-Sleep -Milliseconds 800
} elseif ($svc) {
  # Fallback if the WinSW exe is gone but the service registration lingers.
  Write-Step 'WinSW exe missing — removing the service registration with sc.exe.'
  & sc.exe stop $ServiceId 2>$null | Out-Null
  & sc.exe delete $ServiceId 2>$null | Out-Null
} else {
  Write-Step 'Service is not installed — nothing to stop.'
}

foreach ($p in @($XmlPath, $ExePath)) {
  if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}
if (Test-Path $LogDir) { Remove-Item $LogDir -Recurse -Force -ErrorAction SilentlyContinue }

Write-Step 'Done. The service is removed; server/ and server/data/ are untouched.'

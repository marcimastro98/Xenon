# Compact one WSL / Docker Desktop virtual disk (.vhdx) so Windows gets back the
# space the Linux side already freed. Launched from the Dev cleanup widget
# (POST /api/devclean/compact), Windows only.
#
# WSL disks grow and never shrink on their own: deleting 50 GB of images inside
# Docker leaves the .vhdx file just as large. diskpart's `compact vdisk` is the
# tool that works on every Windows edition (Optimize-VHD needs Hyper-V), and it
# needs administrator rights, so the script relaunches ITSELF through UAC, the
# same way enable-sensors.ps1 does. The backend stays unelevated.
#
# The path arrives from the server, and the elevated half trusts none of it: it
# re-checks that the file is a .vhdx that THIS user's Docker Desktop or one of
# THIS user's registered WSL distros owns. Anything else is refused.
#
# Progress and outcome go to a status file the server polls (an unelevated parent
# cannot wait on an elevated child - see enable-sensors.ps1).

param(
  [Parameter(Mandatory = $true)][string]$Vhdx,
  [Parameter(Mandatory = $true)][string]$Status,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$StatusLeaf = 'xenon-devclean-compact.json'

function Write-Status($state, $extra) {
  $o = [ordered]@{ state = $state; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  $tmp = "$Status.tmp"
  ($o | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Status -Force
}

function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# The disks this user actually owns: Docker Desktop's data disks and the
# ext4.vhdx of every registered WSL distro.
function Get-AllowedVhdx {
  $list = @()
  $docker = Join-Path $env:LOCALAPPDATA 'Docker\wsl'
  if (Test-Path -LiteralPath $docker) {
    $list += Get-ChildItem -LiteralPath $docker -Recurse -Filter '*.vhdx' -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName }
  }
  $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (Test-Path $lxss) {
    foreach ($k in Get-ChildItem $lxss -ErrorAction SilentlyContinue) {
      $base = (Get-ItemProperty -LiteralPath $k.PSPath -Name BasePath -ErrorAction SilentlyContinue).BasePath
      if ($base) { $list += (Join-Path ($base -replace '^\\\\\?\\', '') 'ext4.vhdx') }
    }
  }
  return $list | ForEach-Object { $_.ToLowerInvariant() }
}

if ((Split-Path -Leaf $Status) -ne $StatusLeaf) { exit 2 }

if (-not $Elevated -and -not (Test-Elevated)) {
  $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ("`"$PSCommandPath`""),
    '-Vhdx', ("`"$Vhdx`""), '-Status', ("`"$Status`""), '-Elevated')
  Write-Status 'prompt' $null
  try {
    $null = Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $psArgs -WindowStyle Hidden -ErrorAction Stop
  } catch {
    Write-Status 'declined' $null
  }
  return
}

try {
  $item = Get-Item -LiteralPath $Vhdx -ErrorAction Stop
  $full = $item.FullName.ToLowerInvariant()
  if ($item.Extension -ne '.vhdx' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      -not ((Get-AllowedVhdx) -contains $full)) {
    Write-Status 'error' @{ error = 'not_allowed' }
    return
  }
  $before = $item.Length

  # The disk must be detached from WSL: close Docker Desktop, then stop WSL.
  Write-Status 'stopping' @{ before = $before }
  Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  & (Join-Path $env:WINDIR 'System32\wsl.exe') --shutdown | Out-Null
  Start-Sleep -Seconds 3

  Write-Status 'compacting' @{ before = $before }
  $script = Join-Path $env:TEMP ('xenon-compact-' + [guid]::NewGuid().ToString('N') + '.txt')
  @(
    "select vdisk file=`"$($item.FullName)`"",
    'attach vdisk readonly',
    'compact vdisk',
    'detach vdisk'
  ) | Set-Content -LiteralPath $script -Encoding ASCII
  try {
    $out = & (Join-Path $env:WINDIR 'System32\diskpart.exe') /s $script 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue
  }
  $after = (Get-Item -LiteralPath $item.FullName).Length
  if ($code -ne 0) {
    # diskpart stops at the first failing command, which can leave the disk
    # attached and WSL unable to start until a reboot: detach it explicitly.
    @("select vdisk file=`"$($item.FullName)`"", 'detach vdisk') | Set-Content -LiteralPath $script -Encoding ASCII
    & (Join-Path $env:WINDIR 'System32\diskpart.exe') /s $script 2>&1 | Out-Null
    Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue
    Write-Status 'error' @{ error = 'diskpart'; before = $before; after = $after; detail = ($out.Trim() -split "`r?`n" | Select-Object -Last 2) -join ' ' }
    return
  }
  Write-Status 'done' @{ before = $before; after = $after }
} catch {
  Write-Status 'error' @{ error = 'failed'; detail = $_.Exception.Message }
}

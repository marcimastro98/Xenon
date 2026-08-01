<#
  Xenon - full uninstaller ("clean slate").

  Removes everything the installer put on the machine so a fresh install/test
  starts clean. What it touches (see the inventory printed with -DryRun):

    Xenon-owned (removed by default, after one confirmation):
      * the local server (stopped), the browser windows it opened (Deck popup,
        Spotlight, browser tile), scheduled tasks, the legacy Windows service
      * what Xenon set up inside other programs: its hooks and status line in
        Claude Code, and the "start Ollama at login" entry (Ollama itself stays)
      * the native kiosk app (%LOCALAPPDATA%\Xenon), its autostart + uninstall
        registry entries, and its config (%APPDATA%/%LOCALAPPDATA%\com.marcimastro98.xenon)
      * bundled/downloaded extras inside the folder: node_modules, PresentMon,
        Xenon Helper, Whisper.cpp, the embedded-browser adblock
      * the Windows edge-swipe policy the installer set (needs admin)
      * the second-screen virtual display device + its config (needs admin);
        the driver package itself is shared and asked for separately below
      * leftover %TEMP% files
      * your data (server\data: settings, notes, events, tasks, timers, deck, ...)
        unless you pass -KeepData
      * the install folder itself, unless you pass -KeepFiles or -KeepData

    Shared with the OS / other apps (only if you say yes, or with -RemoveShared):
      * Node.js, FFmpeg, LibreHardwareMonitor, PawnIO, Sunshine, Tailscale,
        Virtual Display Driver (each asked separately)
      * NOT touched: the Microsoft WebView2 Runtime and Ollama (shared / user-managed)

  Usage:
    UNINSTALL.bat                         (interactive, self-elevates)
    powershell -File server\uninstall.ps1 -DryRun          (preview, changes nothing)
    powershell -File server\uninstall.ps1 -KeepData        (keep notes/settings/...)
    powershell -File server\uninstall.ps1 -RemoveShared -Yes   (full unattended nuke)
#>
[CmdletBinding()]
param(
  [switch]$DryRun,        # show what would be removed; change nothing
  [switch]$Yes,           # skip the REMOVE confirmation prompt (shared packages still ask - see -RemoveShared)
  [switch]$KeepData,      # keep server\data (settings, notes, events, ...) and the folder
  [switch]$KeepFiles,     # keep the install folder itself (still removes external artifacts)
  [switch]$RemoveShared   # also remove the shared winget packages (Node, Tailscale, ...) without asking
)

$ErrorActionPreference = 'SilentlyContinue'

# -- paths --------------------------------------------------------------------
$appName     = 'Xenon Edge Widget'
$root        = Split-Path -Parent $PSScriptRoot          # repo/install root (parent of server\)
$serverDir   = Join-Path $root 'server'
$dataDir     = Join-Path $serverDir 'data'
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$appData      = [Environment]::GetFolderPath('ApplicationData')

# -- output helpers -----------------------------------------------------------
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   $m" -ForegroundColor Green }
function Info($m) { Write-Host "   $m" -ForegroundColor Gray }
function Warn($m) { Write-Host "   $m" -ForegroundColor Yellow }
$tag = if ($DryRun) { '[dry-run] ' } else { '' }

# Remove a file/folder, honouring -DryRun. Emits nothing to the pipeline.
function Remove-PathSafe($path, $label) {
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return }
  $what = if ($label) { $label } else { $path }
  if ($DryRun) { Info "$tag would remove: $what"; return }
  Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $path) { Warn "could not fully remove: $what (a file may be in use)" }
  else { Ok "removed: $what" }
}

function Remove-TaskSafe($name) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { return }
  if ($DryRun) { Info "$tag would remove scheduled task: $name"; return }
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Ok "removed scheduled task: $name"
}

function Remove-RegItem($path, $label) {
  if (-not (Test-Path $path)) { return }
  if ($DryRun) { Info "$tag would remove registry: $label"; return }
  Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
  Ok "removed registry: $label"
}
function Remove-RegValue($path, $name, $label) {
  $v = (Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue).$name
  if ($null -eq $v) { return }
  if ($DryRun) { Info "$tag would remove registry value: $label"; return }
  Remove-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue
  Ok "removed registry value: $label"
}

# -Yes only auto-confirms Xenon-owned prompts (the initial REMOVE confirmation).
# Shared system packages (-SharedPackage callers) are auto-confirmed ONLY by
# -RemoveShared; with -Yes alone they still ask, and their $false default means
# a non-interactive run without -RemoveShared simply keeps them.
function Ask-YesNo($question, $default = $false, [switch]$SharedPackage) {
  if ($SharedPackage) {
    if ($RemoveShared) { return $true }
  } elseif ($Yes -or $RemoveShared) { return $true }
  $suffix = if ($default) { '[Y/n]' } else { '[y/N]' }
  $ans = Read-Host "   $question $suffix"
  if ([string]::IsNullOrWhiteSpace($ans)) { return $default }
  return $ans -match '^(y|yes|s|si)$'
}

# -- elevation ----------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Warn 'Not running as Administrator.'
  Warn 'Per-user items still get removed, but these need admin and will be SKIPPED:'
  Warn '  the edge-swipe policy (HKLM), the legacy service, and shared packages (Node, Tailscale, ...).'
  Warn 'For a complete removal, run UNINSTALL.bat (it elevates) or start an elevated PowerShell.'
}

# -- what will happen ---------------------------------------------------------
$removeData   = -not $KeepData
$removeFolder = (-not $KeepFiles) -and (-not $KeepData)

Write-Host ''
Write-Host '  Xenon - full uninstall' -ForegroundColor White
Write-Host '  ----------------------' -ForegroundColor White
Info "Install folder : $root"
Info ("User data      : " + $(if ($removeData) { 'WILL BE DELETED (server\data)' } else { 'kept (-KeepData)' }))
Info ("Install folder : " + $(if ($removeFolder) { 'WILL BE DELETED' } elseif ($KeepFiles) { 'kept (-KeepFiles)' } else { 'kept (-KeepData implies keeping it)' }))
Info ("Shared apps    : " + $(if ($RemoveShared) { 'removed without asking (-RemoveShared)' } else { 'asked one by one (only -RemoveShared skips these prompts)' }))
if ($DryRun) { Warn 'DRY RUN - nothing will actually be removed.' }

if (-not $DryRun -and -not $Yes) {
  Write-Host ''
  $confirm = Read-Host '  Type REMOVE to proceed (anything else cancels)'
  if ($confirm -ne 'REMOVE') { Write-Host '  Cancelled. Nothing was removed.' -ForegroundColor Yellow; exit 0 }
}

# -- 1) stop running processes ------------------------------------------------
Step 'Stopping Xenon processes'

# Hunt by what a process IS, not by where this script happens to sit.
#
# This used to kill only the node.exe whose command line contained THIS folder's
# server\server.js, which left two ways to end up with a copy that will not
# delete ("The action can't be completed because the folder or a file in it is
# open in another program"):
#
#   1. Update by downloading a fresh zip - the natural move when the old folder's
#      uninstall is the one that is broken - and the OLD copy's backend is still
#      running. The new folder's uninstaller never matched it.
#   2. Even from the right folder: the backend spawns two PERSISTENT PowerShell
#      hosts whose scripts live inside server\, and Windows does not cascade a
#      kill to child processes. Both outlived the node.exe that started them and
#      kept the folder open on their own.
#
# So: match any process that runs a Xenon script, wherever it lives, plus anything
# whose own executable sits inside one of the installs those processes reveal.
#
#   node.exe        ...\server\server.js
#   powershell.exe  -File ...\server\pwsh-worker.ps1   (shared script worker)
#   powershell.exe  -File ...\server\media.ps1 -Serve  (SMTC host)
#   PresentMon / xenon-helper / SoundVolumeView / whisper-cli - all run FROM the
#   install folder and hold it open exactly the same way
#
# Every hit is confirmed against the filesystem before anything is killed, so an
# unrelated `node server.js` from someone else's project is never touched.

$xenonMarkers = @('pwsh-worker.ps1', 'media.ps1')

# True when $dir really is the server\ of a Xenon install. server.js alone is far
# too common; next to one of our PowerShell hosts it is unmistakable.
function Test-XenonServerDir($dir) {
  if (-not $dir) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'server.js') -PathType Leaf)) { return $false }
  foreach ($m in $xenonMarkers) {
    if (Test-Path -LiteralPath (Join-Path $dir $m) -PathType Leaf) { return $true }
  }
  return $false
}

# The server\ directory a command line runs Xenon out of, or $null for anything
# else. Plain string work on purpose: -like would read the [ and ] of a perfectly
# legal path (C:\Users\D[x]\...) as wildcards, and this input is arbitrary.
function Get-XenonServerDir($commandLine) {
  if (-not $commandLine) { return $null }
  foreach ($script in @('server.js') + $xenonMarkers) {
    $needle = "\server\$script"
    $at = $commandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase)
    while ($at -ge 0) {
      $upTo = $commandLine.Substring(0, $at + $needle.Length)
      # An unquoted command line can run several paths together, so try every
      # drive-letter start and let the filesystem say which one is real.
      foreach ($start in [regex]::Matches($upTo, '[A-Za-z]:\\')) {
        $path = $upTo.Substring($start.Index)
        if (Test-Path -LiteralPath $path -PathType Leaf) {
          $dir = Split-Path -Parent $path
          if (Test-XenonServerDir $dir) { return $dir }
        }
      }
      $at = $commandLine.IndexOf($needle, $at + 1, [System.StringComparison]::OrdinalIgnoreCase)
    }
  }
  return $null
}

$allProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID })
$targets      = @{}      # PID -> @{ name; label; isServer }
$installRoots = @($root) # folders to sweep for in-folder binaries; ours always counts
$foreignRoots = @()      # installs found running somewhere other than $root

foreach ($proc in $allProcs) {
  $dir = Get-XenonServerDir $proc.CommandLine
  if (-not $dir) { continue }
  $installRoot = Split-Path -Parent $dir
  if ($installRoots -notcontains $installRoot) { $installRoots += $installRoot }
  if ($installRoot -ne $root -and $foreignRoots -notcontains $installRoot) { $foreignRoots += $installRoot }
  $targets[[int]$proc.ProcessId] = @{
    name     = $proc.Name
    label    = "$($proc.Name) running Xenon from $installRoot"
    isServer = ($proc.Name -eq 'node.exe')
  }
}

foreach ($proc in $allProcs) {
  if (-not $proc.ExecutablePath) { continue }
  if ($targets.ContainsKey([int]$proc.ProcessId)) { continue }
  foreach ($r in $installRoots) {
    if ($proc.ExecutablePath.StartsWith("$r\", [System.StringComparison]::OrdinalIgnoreCase)) {
      $targets[[int]$proc.ProcessId] = @{
        name     = $proc.Name
        label    = "$($proc.Name) (running from $r)"
        isServer = $false
      }
      break
    }
  }
}

# The Edge windows WE opened escape both sweeps above: msedge.exe lives in
# Program Files, and its command line names no Xenon script. They are ours all
# the same - the Deck popup, the Spotlight popup and the browser tile each run
# Edge against a --user-data-dir inside server\data - and leaving one behind
# costs twice:
#
#   1. the profile holds server\data open, so the data folder (and with it the
#      install folder) refuses to delete;
#   2. an app-mode window still on screen at shutdown is relaunched by Windows'
#      "restart my apps when I sign back in" at the NEXT login, long after Xenon
#      is gone: a bare Edge window on http://127.0.0.1:3030, with nothing in the
#      startup list to explain it. Reported by a user after uninstalling, and
#      not fixable from our side once Windows has recorded the window - the only
#      moment we can stop it is here, while the window still exists.
#
# Matched on the data folder of an install already identified above, so another
# browser is never touched, and only the parent process (no --type= child) is
# listed: Chromium keeps its renderers in a job object that dies with it.
# IndexOf rather than -like for the reason given above - a real path may contain
# [ and ], which -like would read as wildcards.
foreach ($proc in $allProcs) {
  if (-not $proc.CommandLine) { continue }
  if ($targets.ContainsKey([int]$proc.ProcessId)) { continue }
  if ($proc.CommandLine.IndexOf('--type=', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
  foreach ($r in $installRoots) {
    $dataMarker = Join-Path $r 'server\data'
    if ($proc.CommandLine.IndexOf($dataMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $targets[[int]$proc.ProcessId] = @{
        name     = $proc.Name
        label    = "$($proc.Name) (browser window opened by Xenon from $r)"
        isServer = $false
      }
      break
    }
  }
}

# Servers first: kill a host while its parent backend still lives and the backend
# simply spawns a replacement.
$ordered = @($targets.Keys) | Sort-Object { if ($targets[$_].isServer) { 0 } else { 1 } }
foreach ($id in $ordered) {
  $label = $targets[$id].label
  if ($DryRun) { Info "$tag would stop $label (PID $id)" }
  else { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; Ok "stopped $label (PID $id)" }
}
if (-not $targets.Count) { Info 'no running Xenon backend found' }
# Stopping someone else's folder is surprising, so never do it silently.
if ($foreignRoots.Count) {
  Warn "also stopped Xenon running from another folder: $($foreignRoots -join ', ')"
}

# The kiosk shell lives in %LOCALAPPDATA%, outside any install folder, so it is
# still matched by name. xenon-helper/PresentMon repeat the sweep above for an
# install too old or too broken to have been mapped.
foreach ($p in @('xenon-native', 'Xenon', 'xenon-helper', 'PresentMon')) {
  Get-Process -Name $p -ErrorAction SilentlyContinue | ForEach-Object {
    if ($DryRun) { Info "$tag would stop process: $p (PID $($_.Id))" }
    else { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Ok "stopped process: $p" }
  }
}
Start-Sleep -Milliseconds 800   # let the helper/exe release their files

# -- 2) scheduled tasks + legacy service + shortcut ---------------------------
Step 'Removing startup tasks & legacy service'
Remove-TaskSafe $appName
Remove-TaskSafe 'Xenon Edge Dashboard'
Remove-TaskSafe 'XenonInstallNativeOnce'

$serviceUninstall = Join-Path (Join-Path $root 'service') 'uninstall-service.ps1'
if ((Get-Service -Name 'XenonEdgeService' -ErrorAction SilentlyContinue) -or (Test-Path $serviceUninstall)) {
  if ($DryRun) { Info "$tag would remove the legacy XenonEdgeService" }
  elseif ($isAdmin) {
    if (Test-Path $serviceUninstall) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $serviceUninstall | Out-Null }
    sc.exe stop XenonEdgeService | Out-Null; sc.exe delete XenonEdgeService | Out-Null
    Ok 'removed legacy XenonEdgeService'
  } else { Warn 'skipped XenonEdgeService (needs admin)' }
}

$startup = [Environment]::GetFolderPath('Startup')
Remove-PathSafe (Join-Path $startup "$appName.lnk") "legacy startup shortcut"

# -- 2b) what Xenon wrote into OTHER programs ---------------------------------
# Two entries that live outside every folder this script deletes, and that a
# user would never connect back to Xenon once Xenon is gone. Both are the
# "silently does nothing forever" kind of leftover.
Step 'Undoing what Xenon set up in other programs'

# Claude Code. Xenon adds hooks and a status line to the user's Claude Code
# settings.json; left behind, every session runs a status-line script that no
# longer exists and posts each hook at a port with nothing listening.
$claudeLink = Join-Path $serverDir 'claude-link.js'
if (-not (Test-Path -LiteralPath $claudeLink)) {
  Info 'Claude Code: nothing to undo'
} elseif ($DryRun) {
  Info "$tag would remove Xenon's hooks and status line from the Claude Code settings"
} else {
  # node.exe may not be on PATH in an elevated shell even when it is installed.
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) {
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$localAppData\Programs\nodejs\node.exe")) {
      if (Test-Path -LiteralPath $p) { $nodeExe = $p; break }
    }
  }
  if (-not $nodeExe) {
    Warn 'Node.js not found - if you use Claude Code, run "node server\claude-link.js unlink" before deleting the folder'
  } else {
    $out = & $nodeExe $claudeLink unlink 2>&1
    if ($LASTEXITCODE -ne 0) { Warn "could not unlink Claude Code ($out)" }
    elseif ($out -match 'unlinked')  { Ok "removed Xenon's hooks and status line from Claude Code" }
    else { Info 'Claude Code was not linked' }
  }
}

# The "start Ollama at login" entry. Ollama itself is the user's own install and
# is deliberately left alone (models are gigabytes and may be used by other
# tools), but this entry is ours: Xenon wrote it, it is named after Xenon, and
# on its own it would keep starting Ollama at every login for good.
Remove-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'XenonEdgeOllama' 'start Ollama at login (HKCU\...\Run\XenonEdgeOllama)'

# -- 3) native kiosk app ------------------------------------------------------
Step 'Removing the native app'
$nativeUninstaller = Join-Path (Join-Path $localAppData 'Xenon') 'uninstall.exe'
if (Test-Path -LiteralPath $nativeUninstaller) {
  if ($DryRun) { Info "$tag would run the native app uninstaller ($nativeUninstaller /S)" }
  else {
    Start-Process -FilePath $nativeUninstaller -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Ok 'ran the native app uninstaller'
  }
}
Remove-PathSafe (Join-Path $localAppData 'Xenon') 'native app folder (%LOCALAPPDATA%\Xenon)'
Remove-PathSafe (Join-Path $appData      'com.marcimastro98.xenon') 'native app config (%APPDATA%)'
Remove-PathSafe (Join-Path $localAppData 'com.marcimastro98.xenon') 'native app data/WebView2 cache (%LOCALAPPDATA%)'
# NSIS uninstall entry + login autostart Run value (per-user).
Remove-RegItem  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Xenon' 'native app uninstall entry (HKCU\...\Uninstall\Xenon)'
Remove-RegValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'Xenon' 'native app autostart (HKCU\...\Run\Xenon)'
# NSIS per-user Start Menu shortcut.
Remove-PathSafe (Join-Path $appData 'Microsoft\Windows\Start Menu\Programs\Xenon\Xenon.lnk') 'native app Start Menu shortcut'

# -- 4) bundled / downloaded extras inside the folder -------------------------
Step 'Removing bundled extras (PresentMon, Helper, Whisper, SDKs, adblock, node_modules)'
Remove-PathSafe (Join-Path $serverDir 'presentmon') 'PresentMon (in-game FPS)'
Remove-PathSafe (Join-Path $serverDir 'helper')     'Xenon Helper (native companion)'
Remove-PathSafe (Join-Path $serverDir 'whisper')    'Whisper.cpp (local speech-to-text)'
# Downloaded on demand like the three above, and just as much ours. They only
# survive a -KeepFiles/-KeepData run, which is exactly when this list is what
# decides whether the folder is left clean.
Remove-PathSafe (Join-Path $serverDir 'icue-sdk')   'CORSAIR iCUE SDK component (RGB)'
Remove-PathSafe (Join-Path $serverDir 'openrgb')    'OpenRGB (external lighting)'
Remove-PathSafe (Join-Path $dataDir   'embedded-browser-adblock') 'embedded-browser adblock'
Remove-PathSafe (Join-Path $dataDir   'native-installer') 'native app installer cache'
if (-not $removeFolder) {   # if the whole folder is going, node_modules goes with it
  Remove-PathSafe (Join-Path $root 'node_modules') 'node_modules (npm dependencies)'
  Remove-PathSafe (Join-Path $root 'apps\native\node_modules') 'apps\native\node_modules'
}

# -- 5) edge-swipe policy (admin) ---------------------------------------------
Step 'Restoring Windows touch edge-swipe'
$edgeKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI'
if ($null -ne (Get-ItemProperty -Path $edgeKey -Name 'AllowEdgeSwipe' -ErrorAction SilentlyContinue).AllowEdgeSwipe) {
  if ($DryRun) { Info "$tag would remove HKLM EdgeUI\AllowEdgeSwipe (restores edge swipe)" }
  elseif ($isAdmin) { Remove-RegValue $edgeKey 'AllowEdgeSwipe' 'edge-swipe policy (applies at next sign-in)' }
  else { Warn 'skipped edge-swipe policy (needs admin)' }
}
# Legacy per-user copy, if any.
Remove-RegValue 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI' 'AllowEdgeSwipe' 'legacy per-user edge-swipe policy'

# -- 6) leftover temp files ---------------------------------------------------
Step 'Clearing temp files'
# 'xenon*' already covers the 'xenonedge-*' sensor dumps - one pass, no duplicates.
Get-ChildItem -Path $env:TEMP -Filter 'xenon*' -Force -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-PathSafe $_.FullName "temp: $($_.Name)" }

# -- 6b) second-screen virtual display (admin) --------------------------------
# The device node is Xenon-owned: only our second-screen setup creates it, so it
# goes by default. It MUST be removed before the winget package below, because
# devcon.exe lives inside that package. Leaving it behind was what accumulated
# phantom "VDD by MTT" monitors on machines that had used the feature.
Step 'Removing the second-screen virtual display'
$vddNodes = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match 'Virtual Display Driver' })
if (-not $vddNodes) {
  Info 'no virtual display present'
} elseif ($DryRun) {
  Info "$tag would remove the virtual display device (devcon remove Root\MttVDD)"
} elseif (-not $isAdmin) {
  Warn 'skipped the virtual display (needs admin) - run UNINSTALL.bat to include it'
} else {
  $vddPkg = Get-ChildItem (Join-Path $localAppData 'Microsoft\WinGet\Packages') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'VirtualDrivers.Virtual-Display-Driver_*' } | Select-Object -First 1
  $devcon = if ($vddPkg) { Join-Path $vddPkg.FullName 'Dependencies\devcon.exe' } else { $null }
  if (-not $devcon -or -not (Test-Path -LiteralPath $devcon)) {
    Warn 'devcon.exe not found - remove "Virtual Display Driver" from Device Manager by hand'
  } else {
    & $devcon remove 'Root\MttVDD' 2>$null | Out-Null
    # devcon: 0 = removed, 1 = removed but a reboot is needed. Anything else failed.
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 1) {
      Ok 'removed the virtual display device'
      if ($LASTEXITCODE -eq 1) { Info 'a restart will finish clearing it' }
      # Only ours to delete once the device is gone; the driver reads it at start-up.
      Remove-PathSafe 'C:\VirtualDisplayDriver' 'virtual display config (C:\VirtualDisplayDriver)'
    } else {
      Warn "devcon exited $LASTEXITCODE - remove the virtual display from Device Manager by hand"
    }
  }
}

# -- 7) shared / system packages (ask or -RemoveShared) -----------------------
Step 'Shared system packages (installed via winget)'
$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) {
  Warn 'winget not found - skipping system packages (remove them from Windows Settings > Apps if wanted).'
} elseif (-not $isAdmin) {
  Warn 'not elevated - skipping system packages. Run UNINSTALL.bat (elevates) to include them.'
} else {
  # id, friendly label, shared-with-OS? (a shared package defaults to "keep")
  $pkgs = @(
    @{ id = 'OpenJS.NodeJS.LTS';                          name = 'Node.js';                shared = $true  },
    @{ id = 'Gyan.FFmpeg.Essentials';                     name = 'FFmpeg';                 shared = $false },
    @{ id = 'Gyan.FFmpeg';                                name = 'FFmpeg (full)';          shared = $false },
    @{ id = 'LibreHardwareMonitor.LibreHardwareMonitor';  name = 'LibreHardwareMonitor';   shared = $false },
    @{ id = 'namazso.PawnIO';                             name = 'PawnIO sensor driver';   shared = $true  },
    @{ id = 'LizardByte.Sunshine';                        name = 'Sunshine (remote play)'; shared = $false },
    @{ id = 'Tailscale.Tailscale';                        name = 'Tailscale (VPN)';        shared = $true  },
    @{ id = 'VirtualDrivers.Virtual-Display-Driver';      name = 'Virtual Display Driver'; shared = $false }
  )
  foreach ($p in $pkgs) {
    $listed = winget list --id $p.id -e --disable-interactivity 2>$null | Select-String -SimpleMatch $p.id
    if (-not $listed) { continue }   # not installed
    $note = if ($p.shared) { ' (shared with other apps - keep unless you are sure)' } else { '' }
    if (Ask-YesNo "Remove $($p.name)?$note" ($false) -SharedPackage) {
      if ($DryRun) { Info "$tag would run: winget uninstall --id $($p.id)" }
      else {
        Info "uninstalling $($p.name)..."
        winget uninstall --id $p.id -e --silent --disable-interactivity --accept-source-agreements 2>$null | Out-Null
        Ok "requested removal of $($p.name)"
      }
    } else { Info "kept $($p.name)" }
  }
  Info 'Not touched: Microsoft WebView2 Runtime (shared by many apps) and Ollama (if you installed it - remove via Windows Settings, models live in %USERPROFILE%\.ollama).'
}

# -- 8) user data -------------------------------------------------------------
if ($removeData) {
  Step 'Removing user data (server\data)'
  Remove-PathSafe $dataDir 'user data (settings, notes, events, tasks, timers, deck, uploads, ...)'
} else {
  Step 'Keeping user data'
  Info "server\data was kept (-KeepData)."
}

# -- 9) the install folder itself ---------------------------------------------
if ($removeFolder) {
  Step 'Removing the install folder'
  if ($DryRun) {
    Info "$tag would delete the whole folder: $root"
  } else {
    # The uninstaller lives inside $root, so it can't delete its own folder while
    # running. Hand the final delete to a short detached PowerShell that waits for
    # this process to actually exit, removes the folder (retrying for up to ~60s
    # while the console that launched us still holds a handle in it), then
    # removes itself.
    $selfDel = Join-Path $env:TEMP ("xenon-selfdelete-" + [Guid]::NewGuid().ToString('N') + ".ps1")
    # Paths land inside single-quoted literals below - double any apostrophe
    # (C:\Users\D'Amico\...) so the generated script still parses.
    $rootEsc    = $root.Replace("'", "''")
    $selfDelEsc = $selfDel.Replace("'", "''")
    $body = @"
Wait-Process -Id $PID -Timeout 60 -ErrorAction SilentlyContinue
foreach (`$attempt in 1..30) {
  Remove-Item -LiteralPath '$rootEsc' -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath '$rootEsc')) { break }
  Start-Sleep -Seconds 2
}
Remove-Item -LiteralPath '$selfDelEsc' -Force -ErrorAction SilentlyContinue
"@
    Set-Content -LiteralPath $selfDel -Value $body -Encoding UTF8
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', "`"$selfDel`"")
    Ok "the install folder will be removed shortly after this window closes ($root)"
  }
}

Write-Host ''
if ($DryRun) {
  Write-Host '  Dry run complete - nothing was changed. Re-run without -DryRun to apply.' -ForegroundColor Cyan
} else {
  Write-Host '  Uninstall complete.' -ForegroundColor Green
  if (-not $removeData) { Write-Host '  Your data in server\data was kept.' -ForegroundColor Green }
  if (-not $isAdmin)    { Write-Host '  Some admin-only steps were skipped - re-run elevated for a full clean.' -ForegroundColor Yellow }
}

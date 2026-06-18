# Xenon self-update applier (Phase 2, "safer variant").
# Runs OUTSIDE the Node server. The new version has already been downloaded,
# extracted and validated into server\data\update\app by the server's prepare
# step - this script only performs the final swap, with backup + rollback, then
# restarts the app. It re-launches an independent worker that elevates (one UAC
# prompt) only when the install dir isn't user-writable; otherwise no UAC at all.

param([switch]$Worker, [switch]$NoElevate)

$ErrorActionPreference = 'Stop'

$server    = $PSScriptRoot                         # ...\server
$root      = Split-Path -Parent $server            # install root (parent of server\)
$dataDir   = Join-Path $server 'data'
$updDir    = Join-Path $dataDir 'update'
$appDir    = Join-Path $updDir 'app'               # staged new version (validated by prepare)
$backupDir = Join-Path $updDir 'backup'
$log       = Join-Path $updDir 'update.log'
$runner    = Join-Path $server 'start-hidden.vbs'
$dashUrl   = 'http://127.0.0.1:3030/'

function Log($m) {
  try {
    if (-not (Test-Path $updDir)) { New-Item -ItemType Directory -Force -Path $updDir | Out-Null }
    "$([DateTime]::Now.ToString('s'))  $m" | Out-File -FilePath $log -Append -Encoding utf8
  } catch {}
}

# Re-launch as an INDEPENDENT -Worker before doing anything. This first instance is
# spawned by the Node server, so it lives inside Node's job object (kill-on-close):
# when step 2 stops the server, the job would kill US too — which left an update
# dying right after "backup done", server down, page stuck on "Updating…". The
# relaunched -Worker is a grandchild of Node, which breaks out of the job (Windows
# "silent breakaway"), so it survives the restart. -Worker marks it so we can't
# recurse. The FULL powershell.exe path as FilePath keeps the launch from being
# misread as "open this .ps1 file" (the app picker).
#
# How we relaunch depends on whether admin is needed:
# - $NoElevate (install dir is user-writable): a PLAIN Start-Process — no 'runas',
#   so NO UAC prompt. This is what lets the update run on multi-monitor / touchscreen
#   setups (e.g. the Xeneon Edge) where the UAC secure-desktop prompt is unreachable.
# - otherwise: ShellExecute 'runas' — one UAC prompt — so the swap can write a
#   protected install location.
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
$isAdmin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log "launcher invoked (elevated=$isAdmin, worker=$Worker, noElevate=$NoElevate)"
if (-not $Worker) {
  $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $relArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',("`"$PSCommandPath`""),'-Worker')
  try {
    if ($NoElevate) {
      Start-Process -FilePath $psExe -ArgumentList $relArgs -WindowStyle Hidden -ErrorAction Stop
      Log 'worker instance launched (no elevation)'
    } else {
      Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $relArgs -ErrorAction Stop
      Log 'worker instance launched (elevated)'
    }
  } catch {
    Log "relaunch failed: $($_.Exception.Message)"
  }
  exit
}

function Stop-Server {
  try {
    $p = (Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue).OwningProcess
    if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  } catch {}
  Start-Sleep -Milliseconds 900
}

function Start-Server {
  try {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
      -ArgumentList ('"' + $runner + '"') -WorkingDirectory $server
  } catch { Log "restart failed: $($_.Exception.Message)" }
}

try {
  Log '=== apply start ==='
  if (-not (Test-Path (Join-Path $appDir 'server\server.js'))) { Log 'no staged build; abort'; exit 1 }

  # 1) Back up the current install (exclude user data, node_modules, .git - those
  #    are never overwritten, so they don't need backing up and keep it small).
  if (Test-Path $backupDir) { Remove-Item $backupDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  robocopy $root $backupDir /E /XD (Join-Path $root 'node_modules') $dataDir (Join-Path $root '.git') /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "backup failed ($LASTEXITCODE)" }
  Log 'backup done'

  # 2) Free port 3030 (stop the running server that launched us).
  Stop-Server

  # 3) Swap in the new files. MERGE only (never /MIR), so nothing in the install
  #    gets deleted; the staged tree carries no data\ folder, so user data under
  #    server\data is untouched. Exclude any data dir defensively.
  robocopy $appDir $root /E /XD (Join-Path $appDir 'server\data') /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy failed ($LASTEXITCODE)" }
  Log 'files copied'

  # 4) Reconcile dependencies (the release zip has no node_modules; deps may have
  #    changed). Resolve npm.cmd explicitly: 'Get-Command npm' can return npm.ps1
  #    (an ExternalScript), and 'cmd /c "...npm.ps1"' cannot run a .ps1 - it pops
  #    the Windows "select an app for this .ps1" picker and stalls the update. The
  #    .cmd shim runs cleanly under cmd. If it's absent, keep node_modules as-is.
  $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if ($npmCmd) {
    $proc = Start-Process -FilePath $env:ComSpec `
      -ArgumentList '/c', "`"$npmCmd`"", 'install', '--no-audit', '--no-fund' `
      -WorkingDirectory $root -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0) { throw "npm install failed ($($proc.ExitCode))" }
    Log 'npm install done'
  } else {
    Log 'npm.cmd not found; keeping existing node_modules'
  }

  # 5) Success - clean up staging + backup and relaunch.
  Remove-Item $appDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $updDir 'staged.json') -Force -ErrorAction SilentlyContinue
  Log 'apply OK; restarting'
  Start-Server
  Start-Sleep -Seconds 2
  try { Start-Process $dashUrl } catch {}
  exit 0
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  # Roll back from the backup so the install returns to the working version.
  try {
    if (Test-Path (Join-Path $backupDir 'server\server.js')) {
      robocopy $backupDir $root /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
      Log 'rolled back from backup'
    }
  } catch { Log "rollback failed: $($_.Exception.Message)" }
  Start-Server
  exit 1
}

# Xenon self-update applier (Phase 2, "safer variant").
# Runs OUTSIDE the Node server. The new version has already been downloaded,
# extracted, integrity-verified and validated into server\data\update\app by the
# server's prepare step - this script only performs the final swap, then restarts
# the app. It re-launches an independent worker that elevates (one UAC prompt)
# only when the install dir isn't user-writable; otherwise no UAC at all.
#
# Failure guarantees (rollback completeness):
# - node_modules is snapshotted by RENAME before npm touches it, so a failed
#   install is undone exactly - no dependence on npm/network to recover.
# - Rollback restores the backup AND deletes every file the update had added
#   (the staged tree is the precise manifest), returning the exact pre-update set.
# - Success is only declared after the new server actually answers /version with
#   the staged version; until then the backup is kept, and a build that cannot
#   boot is rolled back instead of stranding the user.

param([switch]$Worker, [switch]$NoElevate)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$server    = $PSScriptRoot                         # ...\server
$root      = Split-Path -Parent $server            # install root (parent of server\)
$dataDir   = Join-Path $server 'data'
$updDir    = Join-Path $dataDir 'update'
$appDir    = Join-Path $updDir 'app'               # staged new version (validated by prepare)
$backupDir = Join-Path $updDir 'backup'
$log       = Join-Path $updDir 'update.log'
$runner    = Join-Path $server 'start-hidden.vbs'
$dashUrl   = 'http://127.0.0.1:3030/'
$nm        = Join-Path $root 'node_modules'
$nmBak     = Join-Path $root 'node_modules.xenon-rollback'

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

# Poll GET /version until the server answers with the expected version (leading
# "v" ignored on both sides). An answer with a DIFFERENT version is a hard
# mismatch, not something more waiting can fix. Empty $expected = any answer.
function Wait-ServerVersion($expected, $timeoutSec) {
  $want = ('' + $expected).Trim() -replace '^[vV]', ''
  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSec)
  while ([DateTime]::UtcNow -lt $deadline) {
    $v = ''
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3030/version' -UseBasicParsing -TimeoutSec 3
      $v = ('' + (ConvertFrom-Json $r.Content).version).Trim() -replace '^[vV]', ''
    } catch {}
    if ($v) {
      if (-not $want -or $v -eq $want) { return $true }
      Log "server answered with unexpected version '$v' (wanted '$want')"
      return $false
    }
    Start-Sleep -Milliseconds 900
  }
  return $false
}

# Remove the files the update ADDED: present in the staged tree but not in the
# backup. The staged tree is the exact manifest of what the merge could have
# written, so this returns the install to the exact pre-update file set without
# any risky directory mirroring. server\data and node_modules never come from
# the merge; skipped defensively.
function Remove-UpdateAdditions {
  if (-not (Test-Path $appDir) -or -not (Test-Path $backupDir)) { return }
  $removed = 0
  foreach ($fi in (Get-ChildItem -LiteralPath $appDir -Recurse -File)) {
    $rel = $fi.FullName.Substring($appDir.Length + 1)
    if ($rel -like 'server\data\*' -or $rel -like 'node_modules\*') { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $backupDir $rel))) {
      $tgt = Join-Path $root $rel
      if (Test-Path -LiteralPath $tgt) {
        try { Remove-Item -LiteralPath $tgt -Force; $removed++ } catch {}
      }
    }
  }
  Log "removed $removed file(s) the update had added"
}

# npm.cmd resolved explicitly: 'Get-Command npm' can return npm.ps1 (an
# ExternalScript), and 'cmd /c "...npm.ps1"' cannot run a .ps1 - it pops the
# Windows "select an app for this .ps1" picker and stalls the update.
$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
function Invoke-Npm {
  $proc = Start-Process -FilePath $env:ComSpec `
    -ArgumentList '/c', "`"$npmCmd`"", 'install', '--no-audit', '--no-fund' `
    -WorkingDirectory $root -Wait -PassThru -NoNewWindow
  return $proc.ExitCode
}

$script:depsTouched = $false   # npm ran (in either mode) — node_modules may be mixed
$script:nmBakActive = $false   # the rename-aside snapshot exists for THIS run

try {
  Log '=== apply start ==='
  if (-not (Test-Path (Join-Path $appDir 'server\server.js'))) { Log 'no staged build; abort'; exit 1 }

  # Versions for the post-swap / post-rollback health checks. Best effort — an
  # empty value degrades the check to "any version answered".
  $newVer = ''
  try { $newVer = ('' + (Get-Content (Join-Path $updDir 'staged.json') -Raw | ConvertFrom-Json).version).Trim() } catch {}
  $oldVer = ''
  try { $oldVer = ('' + (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version).Trim() } catch {}
  Log "applying v$newVer over v$oldVer"

  # Recover a node_modules snapshot left by a previous interrupted run. Only the
  # "snapshot exists, live dir gone" case is unambiguous (died mid-restore; the
  # snapshot is the only copy). Snapshot alongside a live dir is stale — this run
  # is about to take a fresh one.
  if (Test-Path $nmBak) {
    if (Test-Path $nm) {
      Remove-Item -LiteralPath $nmBak -Recurse -Force
      Log 'discarded stale node_modules snapshot from a previous interrupted run'
    } else {
      Move-Item -LiteralPath $nmBak -Destination $nm
      Log 'restored node_modules snapshot from a previous interrupted run'
    }
  }

  # 1) Back up the current install (exclude user data, node_modules, .git - those
  #    are never overwritten by the merge; node_modules gets its own rename
  #    snapshot in step 4, which keeps this copy small and fast).
  if (Test-Path $backupDir) { Remove-Item $backupDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  robocopy $root $backupDir /E /XD $nm $nmBak $dataDir (Join-Path $root '.git') /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
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
  #    changed). The old tree is snapshotted by RENAME first — instant, and a
  #    failed install is undone exactly by renaming back, with no dependence on
  #    npm or the network to recover. npm then rebuilds node_modules fresh
  #    (mostly links from the local npm cache). If the rename is blocked (e.g. a
  #    straggler process holds a native module), fall back to installing in
  #    place; the catch block then reconciles against the restored old lockfile.
  if ($npmCmd) {
    $script:depsTouched = $true
    if (Test-Path $nm) {
      try {
        Move-Item -LiteralPath $nm -Destination $nmBak -ErrorAction Stop
        $script:nmBakActive = $true
        Log 'node_modules snapshotted (renamed aside)'
      } catch {
        Log "node_modules rename blocked ($($_.Exception.Message)); installing in place"
      }
    }
    $code = Invoke-Npm
    if ($code -ne 0) { throw "npm install failed ($code)" }
    Log 'npm install done'
  } else {
    Log 'npm.cmd not found; keeping existing node_modules'
  }

  # 5) Verify the update actually boots before declaring success: the new server
  #    must answer /version with the staged version. Until it does, the backup
  #    stays — a build that cannot start is rolled back instead of stranding the
  #    user with no working install and no backup.
  Start-Server
  if (-not (Wait-ServerVersion $newVer 60)) {
    throw 'post-update verification failed (new version did not come up)'
  }
  Log "verified: v$newVer is up"

  # 6) Success - drop staging, backup and the deps snapshot, then open the dash.
  Remove-Item (Join-Path $updDir 'staged.json') -Force -ErrorAction SilentlyContinue
  Remove-Item $appDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $nmBak -Recurse -Force -ErrorAction SilentlyContinue
  Log 'apply OK'
  try { Start-Process $dashUrl } catch {}
  exit 0
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  # Return the install to EXACTLY the pre-update state. The (possibly broken)
  # new server may be up after step 5 and holding files — stop it first.
  Stop-Server
  try {
    if (Test-Path (Join-Path $backupDir 'server\server.js')) {
      robocopy $backupDir $root /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -ge 8) { Log "rollback copy incomplete ($LASTEXITCODE)" } else { Log 'rolled back from backup' }
      Remove-UpdateAdditions
    }
  } catch { Log "rollback failed: $($_.Exception.Message)" }
  # Dependencies back to the pre-update state: exact rename-back when the
  # snapshot exists; otherwise (in-place install had already mutated the tree)
  # converge against the OLD package-lock.json just restored above. Best effort.
  try {
    if ($script:nmBakActive -and (Test-Path $nmBak)) {
      if (Test-Path $nm) { Remove-Item -LiteralPath $nm -Recurse -Force }
      Move-Item -LiteralPath $nmBak -Destination $nm
      Log 'node_modules restored from snapshot'
    } elseif ($script:depsTouched -and $npmCmd) {
      $code = Invoke-Npm
      Log "node_modules reconciled against restored lockfile (npm exit $code)"
    }
  } catch { Log "node_modules restore failed: $($_.Exception.Message)" }
  # Staging (app + staged.json) is deliberately KEPT so the dashboard still
  # offers the update and the user can simply retry.
  Start-Server
  if (Wait-ServerVersion $oldVer 45) { Log "rollback verified: v$oldVer is serving again" }
  else { Log 'rollback NOT verified: previous version did not answer within 45s' }
  exit 1
}

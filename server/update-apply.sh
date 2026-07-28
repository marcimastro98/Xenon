#!/bin/bash
# Xenon self-update applier — macOS and Linux.
#
# The counterpart of update-apply.ps1, with the SAME failure guarantees. Runs
# OUTSIDE the Node server: the new version has already been downloaded,
# integrity-verified (Ed25519 over SHA256SUMS) and validated into
# server/data/update/app by the server's prepare step; this script only performs
# the final swap and restarts the backend.
#
# Failure guarantees (rollback completeness) — keep all three:
# - node_modules is snapshotted by RENAME before npm touches it, so a failed
#   install is undone exactly, with no dependence on npm or the network.
# - Rollback restores the backup AND deletes every file the update had added
#   (the staged tree is the precise manifest), returning the exact pre-update set.
# - Success is only declared after the new server actually answers /version with
#   the staged version; until then the backup is kept, and a build that cannot
#   boot is rolled back instead of stranding the user.
#
# Two things differ from the Windows applier, both because the platform differs:
#
# - No elevation. There is no UAC and the install root is per-user, so the
#   Windows -Worker/runas dance has nothing to do here.
# - The backend is stopped with SIGTERM rather than through the service manager.
#   _gracefulShutdown always exits 0, and both service definitions restart only
#   on FAILURE (launchd KeepAlive.SuccessfulExit=false, systemd
#   Restart=on-failure), so a clean stop leaves the backend down for the swap
#   and neither manager races to bring it back.
#
# Surviving the server we stop is the subtle part, and it differs by platform:
#
# - macOS: `spawn(..., {detached: true})` calls setsid(), which is enough — and
#   `launchctl bootout` is avoided precisely because it kills everything in the
#   job and could take this script with it, leaving the backend down with nobody
#   left to restart it.
# - Linux: setsid does NOT escape a cgroup, so a script spawned by a systemd user
#   unit is still inside it. self-update.js therefore launches this applier via
#   `systemd-run --user` when it can, which puts it in a transient unit of its
#   own. When it could not (no systemd-run), stop_server detects that it is still
#   inside the backend's cgroup and refuses `systemctl stop`, which would kill
#   itself. If the process dies during the stop phase anyway, NOTHING has been
#   modified yet — the backup exists, no file has been copied — so the tree is
#   left exactly as it was and the user simply retries.

set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SERVER_DIR")"
DATA_DIR="$SERVER_DIR/data"
UPD_DIR="$DATA_DIR/update"
APP_DIR="$UPD_DIR/app"                    # staged new version (validated by prepare)
BACKUP_DIR="$UPD_DIR/backup"
LOG="$UPD_DIR/update.log"
NM="$ROOT_DIR/node_modules"
NM_BAK="$ROOT_DIR/node_modules.xenon-rollback"
PORT=3030
DASH_URL="http://127.0.0.1:$PORT/"
LABEL='com.marcimastro98.xenon.backend'
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# The native app, when it is what owns the backend (macOS). Both install
# locations, in the order `open -a` itself would resolve them.
XENON_APP=''
for _candidate in "/Applications/Xenon.app" "$HOME/Applications/Xenon.app"; do
  [ -d "$_candidate" ] && { XENON_APP="$_candidate"; break; }
done
UNIT_NAME='xenon-backend.service'
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"

case "$(uname -s)" in
  Darwin) XENON_OS='macos' ;;
  *)      XENON_OS='linux' ;;
esac

# Durable side-channel files live directly in DATA_DIR, NOT under update/ —
# prepare() wipes update/ at the start of every run and these must survive it.
RESULT_PATH="$DATA_DIR/update-result.json"
MANIFEST_PATH="$DATA_DIR/update-manifest.json"

mkdir -p "$UPD_DIR" 2>/dev/null
log() { printf '%s  %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$LOG" 2>/dev/null; }

# Homebrew prefixes: this script is launched by a server whose own PATH came
# from a LaunchAgent, and node may only exist in one of them.
for p in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && PATH="$p:$PATH" ;; esac
done
export PATH
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

PHASE='start'          # last stage entered — maps to a reason code on failure
DEPS_TOUCHED=0         # npm ran — node_modules may be mixed
NM_BAK_ACTIVE=0        # the rename-aside snapshot exists for THIS run
NEW_VER=''
OLD_VER=''

# ── JSON helpers ─────────────────────────────────────────────────────────────
# Node does the JSON, for the same reason the Windows applier uses ConvertTo-Json
# rather than hand-built strings: a version or a path with a quote in it must not
# be able to produce a file the server cannot parse. Written temp+rename, so a
# crash mid-write never leaves a truncated file behind.
json_write_atomic() { # $1 = destination path, $2 = the JSON text to write
  [ -n "$NODE_BIN" ] || return 0
  [ -n "${2:-}" ] || { log "json write skipped, empty payload ($1)"; return 0; }
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [dest, payload] = process.argv.slice(1);
    fs.writeFileSync(dest + ".tmp", payload);
    fs.renameSync(dest + ".tmp", dest);
  ' "$1" "$2" 2>/dev/null || log "json write failed ($1)"
}

write_result() { # $1 = a JSON object as text
  json_write_atomic "$RESULT_PATH" "$1"
}

read_pkg_version() { # $1 = directory holding package.json
  [ -n "$NODE_BIN" ] || return 0
  "$NODE_BIN" -e '
    try {
      const v = require(require("path").join(process.argv[1], "package.json")).version;
      process.stdout.write(String(v || "").trim());
    } catch { /* absent or unreadable → empty, checks degrade to "any version" */ }
  ' "$1" 2>/dev/null
}

# ── Server lifecycle ─────────────────────────────────────────────────────────
server_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    # ss is what a minimal Linux install has; lsof often is not there.
    ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}

# True when this script is running inside the backend unit's own cgroup, i.e.
# stopping that unit would also kill us. See the header.
in_backend_cgroup() {
  [ "$XENON_OS" = 'linux' ] || return 1
  grep -q "$UNIT_NAME" /proc/self/cgroup 2>/dev/null
}

systemd_user_ready() {
  [ "$XENON_OS" = 'linux' ] || return 1
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

stop_server() {
  # Linux + systemd: ask the manager, so the unit is marked inactive rather than
  # looking like a crash. Skipped when it would kill this script.
  if [ -f "$UNIT" ] && systemd_user_ready && ! in_backend_cgroup; then
    systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1
  elif in_backend_cgroup; then
    log 'running inside the backend cgroup; stopping by signal instead of systemctl'
  fi
  local pids; pids="$(server_pids)"
  [ -n "$pids" ] || return 0
  # SIGTERM → _gracefulShutdown → exit 0, which both managers treat as a clean
  # stop and do not restart; see the header.
  for pid in $pids; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  for _ in $(seq 1 20); do
    sleep 0.5
    [ -z "$(server_pids)" ] && return 0
  done
  # It refused to go: the swap cannot proceed over a live process holding files.
  for pid in $(server_pids); do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null; done
  sleep 1
}

start_server() {
  # macOS, app install: the backend is a CHILD of Xenon.app, so the thing to
  # restart is the app — kickstarting the agent would only run `open -a` against
  # an app that is already up, which starts no backend at all. Quitting it first
  # is what makes the relaunch spawn a fresh one (the app stops its child on
  # exit), and it is also how the new backend inherits the app's Full Disk
  # Access, which is the entire reason it is a child in the first place.
  if [ "$XENON_OS" = 'macos' ] && [ -d "$XENON_APP" ]; then
    osascript -e 'tell application "Xenon" to quit' >/dev/null 2>&1
    for _ in $(seq 1 20); do
      pgrep -f 'Xenon.app/Contents/MacOS' >/dev/null 2>&1 || break
      sleep 0.5
    done
    pkill -f 'Xenon.app/Contents/MacOS' >/dev/null 2>&1
    sleep 1
    open -a "$XENON_APP" >/dev/null 2>&1 && return 0
    log 'relaunching Xenon.app failed; starting node directly'
  elif [ "$XENON_OS" = 'macos' ] && [ -f "$PLIST" ]; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && return 0
    log 'launchctl kickstart failed; starting node directly'
  elif [ -f "$UNIT" ] && systemd_user_ready; then
    # daemon-reload first: the update may have shipped nothing here, but a unit
    # file the user edited between versions would otherwise start from systemd's
    # stale copy.
    systemctl --user daemon-reload >/dev/null 2>&1
    systemctl --user start "$UNIT_NAME" >/dev/null 2>&1 && return 0
    log 'systemctl start failed; starting node directly'
  fi
  # No service (a manual/dev install, or the XDG autostart fallback): start it
  # the way the user did. nohup + & so it outlives this script.
  if [ -n "$NODE_BIN" ]; then
    (cd "$ROOT_DIR" && nohup "$NODE_BIN" "$SERVER_DIR/server.js" >/dev/null 2>&1 &) || log 'direct node start failed'
  else
    log 'node not found; cannot restart the server'
  fi
}

# Open the dashboard once the update is in. Best effort: a headless or
# unsupported session simply gets no window, which is not a failure.
open_dashboard() {
  if [ "$XENON_OS" = 'macos' ]; then
    open "$DASH_URL" >/dev/null 2>&1
  else
    command -v xdg-open >/dev/null 2>&1 && xdg-open "$DASH_URL" >/dev/null 2>&1
  fi
}

# Poll GET /version until the server answers with the expected version (leading
# "v" ignored on both sides). An answer with a DIFFERENT version is a hard
# mismatch, not something more waiting can fix. Empty $1 = any answer will do.
wait_server_version() { # $1 = expected version, $2 = timeout in seconds
  local want="${1#[vV]}" deadline=$(( SECONDS + $2 )) body v
  while [ "$SECONDS" -lt "$deadline" ]; do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/version" 2>/dev/null)"
    if [ -n "$body" ]; then
      v="$(printf '%s' "$body" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')"
      v="${v#[vV]}"
      if [ -n "$v" ]; then
        # An empty $want means staged.json did not name a version, so there is
        # nothing to compare against and "it answers at all" is the strongest
        # check left. That is a real weakening of the guarantee in the header —
        # say so in the log rather than let a success line claim more than was
        # actually verified.
        if [ -z "$want" ]; then
          log "no staged version to compare against; accepting '$v' because the server answers"
          return 0
        fi
        [ "$v" = "$want" ] && return 0
        log "server answered with unexpected version '$v' (wanted '$want')"
        return 1
      fi
    fi
    sleep 1
  done
  return 1
}

# ── File-set helpers ─────────────────────────────────────────────────────────
# Relative paths of every file in the staged tree (= what the new version ships).
staged_file_list() {
  ( cd "$APP_DIR" && find . -type f -print | sed 's|^\./||' | grep -v '^server/data/' )
}

# Remove the files the update ADDED: present in the staged tree but not in the
# backup. The staged tree is the exact manifest of what the merge could have
# written, so this returns the install to the exact pre-update file set without
# any risky directory mirroring.
remove_update_additions() {
  [ -d "$APP_DIR" ] && [ -d "$BACKUP_DIR" ] || return 0
  local removed=0 rel
  while IFS= read -r rel; do
    case "$rel" in server/data/*|node_modules/*) continue ;; esac
    [ -e "$BACKUP_DIR/$rel" ] && continue
    if [ -e "$ROOT_DIR/$rel" ]; then
      rm -f "$ROOT_DIR/$rel" 2>/dev/null && removed=$((removed + 1))
    fi
  done < <(staged_file_list)
  log "removed $removed file(s) the update had added"
}

# ── Manifest-based stale-file cleanup ────────────────────────────────────────
# The staged tree is exactly what the source zip ships, so runtime files
# (server/data, node_modules, anything downloaded) can never enter the manifest —
# that is the primary safety guarantee. The prefix denylist is defense in depth.
# This deliberately deletes ONE known file at a time from the updater's own
# previous manifest, never a directory mirror.
is_protected_path() { # $1 = relative path
  case "$1" in
    server/data/*|node_modules/*|.git/*|server/shared/*|server/helper/*|server/presentmon/*|server/icue-sdk/*|server/whisper/*|server/mediaremote/*) return 0 ;;
    */node_modules/*) return 0 ;;
  esac
  return 1
}

# Delete files the PREVIOUS update installed that the new version no longer
# ships. Skips entirely when there is no trustworthy manifest: absent, unreadable,
# or written for a version other than the one currently on disk (a manual
# reinstall happened in between — the manifest no longer describes reality).
remove_stale_app_files() { # $1 = path to a file holding the staged list
  local staged_list="$1" removed=0 rel tgt dir
  [ -n "$NODE_BIN" ] || { log 'node unavailable; skipping stale-file cleanup'; return 0; }
  [ -f "$MANIFEST_PATH" ] || { log 'no previous manifest; skipping stale-file cleanup'; return 0; }

  # Node reads the manifest and subtracts the staged set, ONCE (stdout = the
  # candidate list, stderr = the one reason it produced nothing). The version
  # gate lives in here too, so a mismatch is logged rather than looking like a
  # tree that simply had nothing stale in it.
  local candidates="$UPD_DIR/stale-candidates.txt" why
  why="$("$NODE_BIN" -e '
    const fs = require("fs");
    const [manifestPath, stagedListPath, oldVer, outPath] = process.argv.slice(1);
    let mf = null;
    try { mf = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { }
    if (!mf || !Array.isArray(mf.files)) { console.error("manifest unreadable"); process.exit(0); }
    const norm = (s) => String(s || "").trim().replace(/^v/i, "");
    if (!norm(mf.version) || !norm(oldVer) || norm(mf.version) !== norm(oldVer)) {
      console.error(`manifest is for v${norm(mf.version)} but install was v${norm(oldVer)}`);
      process.exit(0);
    }
    const staged = new Set(fs.readFileSync(stagedListPath, "utf8").split("\n").filter(Boolean));
    const stale = mf.files.map((r) => String(r || "").trim()).filter((r) => r && !staged.has(r));
    fs.writeFileSync(outPath, stale.join("\n") + (stale.length ? "\n" : ""));
  ' "$MANIFEST_PATH" "$staged_list" "$OLD_VER" "$candidates" 2>&1 >/dev/null)"
  if [ -n "$why" ]; then
    log "skipping stale-file cleanup: $why"
    rm -f "$candidates" 2>/dev/null
    return 0
  fi
  [ -f "$candidates" ] || return 0

  # Only directories that a deletion may have emptied are swept, and only after
  # every deletion — the same narrow rule the Windows applier follows. A blanket
  # "delete every empty directory under the install root" would also remove
  # empty ones the app itself expects to find.
  local touched="$UPD_DIR/stale-dirs.txt"
  : > "$touched"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    is_protected_path "$rel" && continue
    tgt="$ROOT_DIR/$rel"
    # Plain files only — never follow into directories or symlinks (server/shared
    # is a link that reaches real sources outside the install).
    [ -L "$tgt" ] && continue
    [ -f "$tgt" ] || continue
    if rm -f "$tgt" 2>/dev/null; then
      removed=$((removed + 1))
      # Queue the whole ancestor chain, so a fully emptied nested tree collapses
      # instead of leaving hollow parents behind.
      dir="$(dirname "$rel")"
      while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
        printf '%s\n' "$dir" >> "$touched"
        dir="$(dirname "$dir")"
      done
    fi
  done < "$candidates"

  # Deepest first (longest path first), so a parent is only tried once its
  # children are gone. rmdir refuses a non-empty directory by itself, which is
  # the check — no separate emptiness test that could race it.
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    is_protected_path "$dir/" && continue
    rmdir "$ROOT_DIR/$dir" 2>/dev/null
  done < <(sort -u "$touched" | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)

  rm -f "$candidates" "$touched" 2>/dev/null
  log "removed $removed stale file(s) from the previous version"
}

# ── Rollback ─────────────────────────────────────────────────────────────────
die() { # $1 = message
  log "ERROR: $1"
  local reason
  case "$PHASE" in
    backup)      reason='backup_failed' ;;
    stop_server) reason='stop_server_failed' ;;
    copy)        reason='copy_failed' ;;
    cleanup)     reason='cleanup_failed' ;;
    npm_install) reason='npm_install_failed' ;;
    verify)      reason='verify_failed' ;;
    *)           reason='unknown' ;;
  esac
  # Failures before the copy never modified the install — there is nothing to
  # roll back, the tree is already in its pre-update state.
  local restored=0
  case "$PHASE" in start|backup|stop_server) restored=1 ;; esac

  # The (possibly broken) new server may be up after the verify step and holding
  # files — stop it before restoring.
  stop_server
  if [ -f "$BACKUP_DIR/server/server.js" ]; then
    if rsync -a "$BACKUP_DIR"/ "$ROOT_DIR"/ 2>/dev/null; then
      log 'rolled back from backup'
      restored=1
    else
      log 'rollback copy incomplete'
    fi
    remove_update_additions
  fi
  # Dependencies back to the pre-update state: exact rename-back when the
  # snapshot exists; otherwise converge against the OLD lockfile just restored.
  if [ "$NM_BAK_ACTIVE" = "1" ] && [ -d "$NM_BAK" ]; then
    rm -rf "$NM" 2>/dev/null
    mv "$NM_BAK" "$NM" 2>/dev/null && log 'node_modules restored from snapshot'
  elif [ "$DEPS_TOUCHED" = "1" ] && [ -n "$NPM_BIN" ]; then
    ( cd "$ROOT_DIR" && "$NPM_BIN" install --no-audit --no-fund >/dev/null 2>&1 )
    log "node_modules reconciled against restored lockfile (npm exit $?)"
  fi

  # Staging is deliberately KEPT so the dashboard still offers the update and the
  # user can simply retry.
  start_server
  local verified=false
  if wait_server_version "$OLD_VER" 45; then
    verified=true
    log "rollback verified: v$OLD_VER is serving again"
  else
    log 'rollback NOT verified: previous version did not answer within 45s'
  fi
  write_result "$( "$NODE_BIN" -e '
    const [reason, rolledBack, verified, from, to] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      ok: false, reason, rolledBack: rolledBack === "1", rollbackVerified: verified === "true",
      from, to, at: new Date().toISOString(),
    }));
  ' "$reason" "$restored" "$verified" "$OLD_VER" "$NEW_VER" 2>/dev/null )"
  exit 1
}

# ── Apply ────────────────────────────────────────────────────────────────────
log '=== apply start ==='
[ -f "$APP_DIR/server/server.js" ] || { log 'no staged build; abort'; exit 1; }
[ -n "$NODE_BIN" ] || { log 'node not found; abort'; exit 1; }

NEW_VER="$("$NODE_BIN" -e '
  try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || "").trim()); } catch {}
' "$UPD_DIR/staged.json" 2>/dev/null)"
OLD_VER="$(read_pkg_version "$ROOT_DIR")"
log "applying v$NEW_VER over v$OLD_VER"

# Recover a node_modules snapshot left by a previous interrupted run. Only the
# "snapshot exists, live dir gone" case is unambiguous (died mid-restore; the
# snapshot is the only copy). A snapshot alongside a live dir is stale.
if [ -d "$NM_BAK" ]; then
  if [ -d "$NM" ]; then
    rm -rf "$NM_BAK"
    log 'discarded stale node_modules snapshot from a previous interrupted run'
  else
    mv "$NM_BAK" "$NM" && log 'restored node_modules snapshot from a previous interrupted run'
  fi
fi

# 1) Back up the current install (exclude user data, node_modules, .git — those
#    are never overwritten by the merge; node_modules gets its own rename
#    snapshot in step 4, which keeps this copy small and fast).
PHASE='backup'
rm -rf "$BACKUP_DIR" 2>/dev/null
mkdir -p "$BACKUP_DIR" || die 'could not create the backup folder'
rsync -a \
  --exclude 'node_modules/' \
  --exclude 'node_modules.xenon-rollback/' \
  --exclude 'server/data/' \
  --exclude '.git/' \
  "$ROOT_DIR"/ "$BACKUP_DIR"/ || die 'backup failed'
log 'backup done'

# 2) Stop the running server (frees the port and any file handles).
PHASE='stop_server'
stop_server
[ -z "$(server_pids)" ] || die "the server on port $PORT would not stop"

# 3) Swap in the new files. MERGE only (never --delete), so nothing in the
#    install gets deleted; the staged tree carries no data/ folder, so user data
#    under server/data is untouched. Excluded defensively anyway.
PHASE='copy'
rsync -a --exclude 'server/data/' "$APP_DIR"/ "$ROOT_DIR"/ || die 'copy failed'
log 'files copied'

# 3b) Remove files the previous version shipped that the new one no longer does.
#     Runs after the backup exists and before the health check, so a failure here
#     rolls back like any other. The list is captured NOW, before anything can
#     delete the staged tree.
PHASE='cleanup'
STAGED_LIST="$UPD_DIR/staged-files.txt"
staged_file_list > "$STAGED_LIST" || die 'could not enumerate the staged tree'
remove_stale_app_files "$STAGED_LIST"

# 4) Reconcile dependencies (the release zip has no node_modules; deps may have
#    changed). The old tree is snapshotted by RENAME first — instant, and a
#    failed install is undone exactly by renaming back, with no dependence on npm
#    or the network. If the rename is blocked, fall back to installing in place;
#    the rollback then reconciles against the restored old lockfile.
PHASE='npm_install'
if [ -n "$NPM_BIN" ]; then
  DEPS_TOUCHED=1
  if [ -d "$NM" ]; then
    if mv "$NM" "$NM_BAK" 2>/dev/null; then
      NM_BAK_ACTIVE=1
      log 'node_modules snapshotted (renamed aside)'
    else
      log 'node_modules rename blocked; installing in place'
    fi
  fi
  ( cd "$ROOT_DIR" && "$NPM_BIN" install --no-audit --no-fund ) >> "$LOG" 2>&1 || die "npm install failed"
  log 'npm install done'
else
  log 'npm not found; keeping existing node_modules'
fi

# 5) Verify the update actually boots before declaring success: the new server
#    must answer /version with the staged version. Until it does, the backup
#    stays — a build that cannot start is rolled back instead of stranding the
#    user with no working install and no backup.
PHASE='verify'
start_server
wait_server_version "$NEW_VER" 60 || die 'post-update verification failed (new version did not come up)'
log "verified: v$NEW_VER is up"

# 6) Success — persist the outcome + the installed-file manifest (consumed by the
#    NEXT update's stale-file cleanup), then drop staging, backup and the deps
#    snapshot, and open the dashboard.
json_write_atomic "$MANIFEST_PATH" "$( "$NODE_BIN" -e '
  const fs = require("fs");
  const [version, listPath] = process.argv.slice(1);
  const files = fs.readFileSync(listPath, "utf8").split("\n").filter(Boolean);
  process.stdout.write(JSON.stringify({ version, at: new Date().toISOString(), files }));
' "$NEW_VER" "$STAGED_LIST" )"
write_result "$( "$NODE_BIN" -e '
  const [from, to] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ ok: true, from, to, at: new Date().toISOString() }));
' "$OLD_VER" "$NEW_VER" )"

rm -f "$UPD_DIR/staged.json" "$STAGED_LIST" 2>/dev/null
rm -rf "$APP_DIR" "$BACKUP_DIR" "$NM_BAK" 2>/dev/null
log 'apply OK'
open_dashboard
exit 0

#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# uninstall.sh — remove Xenon from this Mac or Linux machine (the twin of
# uninstall.ps1 on Windows, and it removes the same things).
#
# "Uninstalled" has to mean uninstalled: nothing running, nothing starting at
# login, and no Xenon icon left in Spotlight, Launchpad or the app menu. This
# script used to stop the backend and then print a list of what it had left
# behind on purpose — the app, the folder, the data. That reads as "it did not
# work" to anyone who is not the person who wrote it, which is everyone.
#
#   ./server/uninstall.sh              remove everything (asks once first)
#   ./server/uninstall.sh --keep-data  keep server/data and the install folder
#   ./server/uninstall.sh --keep-files keep the install folder, delete the data
#   ./server/uninstall.sh --dry-run    list what would go; change nothing
#   ./server/uninstall.sh --yes        skip the confirmation (for scripts)
#
# Every removal is attempted regardless of which mechanism was used to install,
# so a tree set up one way and re-installed another does not leave a second copy
# behind starting a second server on the port.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SERVER_DIR/.." && pwd)"
DATA_DIR="$SERVER_DIR/data"
PORT=3030

KEEP_DATA=0
KEEP_FILES=0
ASSUME_YES=0
DRY_RUN=0

APP_ID='com.marcimastro98.xenon'
LABEL="$APP_ID.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MAC_LOG_DIR="$HOME/Library/Logs/Xenon"
UNIT_NAME="xenon-backend.service"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/xenon-backend.desktop"

IS_MAC=0
[ "$(uname -s)" = 'Darwin' ] && IS_MAC=1

usage() {
  printf 'Usage: %s [--keep-data] [--keep-files] [--dry-run] [--yes]\n' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --keep-data)  KEEP_DATA=1 ;;
    --keep-files) KEEP_FILES=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    # Kept working rather than rejected: it is in the README, in the FAQ and in
    # every older copy of this file, and what it asked for is now what happens
    # anyway. Erroring out on it would be a worse answer than doing the job.
    --purge-data) : ;;
    -h|--help)    usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_DIM=$'\033[90m'; C_OFF=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_WARN=''; C_DIM=''; C_OFF=''
fi
step() { printf '%s==>%s %s\n' "$C_STEP" "$C_OFF" "$1"; }
ok()   { printf '    %s%s%s\n' "$C_OK" "$1" "$C_OFF"; }
info() { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
warn() { printf '    %s%s%s\n' "$C_WARN" "$1" "$C_OFF"; }

# Remove a file or directory, honouring --dry-run. Never fatal: one path that
# refuses must not stop the rest of the uninstall.
rm_path() {
  local target="$1" label="${2:-$1}"
  [ -e "$target" ] || return 0
  if [ "$DRY_RUN" = 1 ]; then info "would remove: $label"; return 0; fi
  rm -rf "$target" 2>/dev/null
  if [ -e "$target" ]; then warn "could not remove: $label"; return 1; fi
  ok "removed: $label"
}

# ── What is going, decided before anything is touched ────────────────────────
REMOVE_DATA=1
[ "$KEEP_DATA" = 1 ] && REMOVE_DATA=0
REMOVE_ROOT=1
{ [ "$KEEP_DATA" = 1 ] || [ "$KEEP_FILES" = 1 ]; } && REMOVE_ROOT=0

# A git checkout is somebody's working copy, not an install: it holds their
# branches, their unpushed commits and whatever else they keep next to it. A
# release download has no .git, so this costs a real user nothing.
ROOT_SKIP=''
if [ "$REMOVE_ROOT" = 1 ] && [ -e "$ROOT_DIR/.git" ]; then
  REMOVE_ROOT=0
  ROOT_SKIP='kept: this is a git checkout, not an install'
fi

# ── Finding the app ──────────────────────────────────────────────────────────
# macOS: the bundle identifier is the test, never the name or the location. A
# folder called Xenon.app that is not ours must survive this, and one of ours
# that the user dragged somewhere else must not.
is_xenon_app() {
  local bundle="$1" plist id
  [ -d "$bundle" ] || return 1
  [ "$(basename "$bundle")" = 'Xenon.app' ] || return 1
  plist="$bundle/Contents/Info.plist"
  [ -f "$plist" ] || return 1
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null)"
  [ "$id" = "$APP_ID" ]
}

# Every copy of Xenon.app on this machine, one per line. Spotlight is asked as
# well as the two standard folders, because "I still see it when I search" is
# the whole complaint this exists to answer, and a copy in ~/Downloads or in a
# build folder is exactly as visible there as one in /Applications.
mac_app_bundles() {
  local found='' candidate
  for candidate in "/Applications/Xenon.app" "$HOME/Applications/Xenon.app"; do
    is_xenon_app "$candidate" || continue
    case "$found" in *"$candidate"$'\n'*) continue ;; esac
    found="$found$candidate"$'\n'
  done
  local extra
  # Spotlight's own index, and a bounded sweep of the install folder for a build
  # output Spotlight may not have indexed yet. /Volumes is skipped: a copy on an
  # external disk or in a Time Machine backup is not this machine's install.
  extra="$( { command -v mdfind >/dev/null 2>&1 &&
                mdfind "kMDItemCFBundleIdentifier == '$APP_ID'" 2>/dev/null
              find "$ROOT_DIR" -maxdepth 8 -type d -name 'Xenon.app' 2>/dev/null
            } )"
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in /Volumes/*) continue ;; esac
    case "$found" in *"$line"$'\n'*) continue ;; esac
    is_xenon_app "$line" || continue
    found="$found$line"$'\n'
  done <<EOF
$extra
EOF
  printf '%s' "$found"
}

# Linux: the .deb/.rpm package, if the app was installed from one.
linux_pkg_kind() {
  if command -v dpkg-query >/dev/null 2>&1 &&
     dpkg-query -W -f='${Status}' xenon 2>/dev/null | grep -q 'install ok installed'; then
    printf 'deb'; return 0
  fi
  if command -v rpm >/dev/null 2>&1 && rpm -q xenon >/dev/null 2>&1; then
    printf 'rpm'; return 0
  fi
  return 1
}

# Linux: AppImages, which live wherever the user put them. Only the folders a
# person actually drops one into, one level deep, so this cannot turn into a
# scan of the whole home directory.
linux_appimages() {
  local dir
  for dir in "$HOME/Applications" "$HOME/.local/bin" "$HOME/bin" \
             "$HOME/Downloads" "$HOME/Desktop" "$HOME/Scaricati" /opt; do
    [ -d "$dir" ] || continue
    find "$dir" -maxdepth 1 -type f -iname 'Xenon*.AppImage' 2>/dev/null
  done
}

# Linux: the launcher entries that put the icon in the app menu. The package
# owns the one in /usr/share and takes it with it; these are the ones written
# per-user, by AppImage integration or by the app itself, which nothing else
# would ever remove. Matched on content, so a launcher of the user's own that
# merely has "xenon" in its filename is left alone.
linux_desktop_entries() {
  local dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  [ -d "$dir" ] || return 0
  local entry
  for entry in "$dir"/*.desktop; do
    [ -f "$entry" ] || continue
    grep -qi -e "^Exec=.*[Xx]enon" -e "^Icon=.*[Xx]enon" -e "$APP_ID" "$entry" 2>/dev/null &&
      printf '%s\n' "$entry"
  done
}

APP_BUNDLES=''
LINUX_PKG=''
LINUX_APPIMAGES=''
LINUX_ENTRIES=''
if [ "$IS_MAC" = 1 ]; then
  APP_BUNDLES="$(mac_app_bundles)"
else
  LINUX_PKG="$(linux_pkg_kind)"
  LINUX_APPIMAGES="$(linux_appimages)"
  LINUX_ENTRIES="$(linux_desktop_entries)"
fi

# ── What is about to happen, then one confirmation ───────────────────────────
printf '\n  %sXenon — uninstall%s\n' "$C_STEP" "$C_OFF"
printf '  %s-----------------%s\n' "$C_STEP" "$C_OFF"

app_summary() {
  if [ "$IS_MAC" = 1 ]; then
    if [ -n "$APP_BUNDLES" ]; then printf '%s' "$APP_BUNDLES" | tr '\n' ' '
    else printf 'not installed'; fi
  else
    local parts=''
    [ -n "$LINUX_PKG" ] && parts="the $LINUX_PKG package"
    if [ -n "$LINUX_APPIMAGES" ]; then
      [ -n "$parts" ] && parts="$parts + "
      parts="$parts$(printf '%s' "$LINUX_APPIMAGES" | tr '\n' ' ')"
    fi
    [ -n "$parts" ] && printf '%s' "$parts" || printf 'not installed'
  fi
}
info "The app        : $(app_summary)"
info "Login service  : stopped and unregistered"
if [ "$REMOVE_DATA" = 1 ]; then
  info "Your data      : WILL BE DELETED ($DATA_DIR)"
else
  info "Your data      : kept (--keep-data)"
fi
if [ "$REMOVE_ROOT" = 1 ]; then
  info "Install folder : WILL BE DELETED ($ROOT_DIR)"
elif [ -n "$ROOT_SKIP" ]; then
  info "Install folder : $ROOT_SKIP ($ROOT_DIR)"
else
  info "Install folder : kept ($ROOT_DIR)"
fi
[ "$DRY_RUN" = 1 ] && warn 'DRY RUN — nothing will actually be removed.'

if [ "$DRY_RUN" != 1 ] && [ "$ASSUME_YES" != 1 ]; then
  if [ ! -t 0 ]; then
    printf '\n  %sNothing was removed: there is no terminal here to ask for confirmation.\n  Re-run with --yes to proceed without asking.%s\n\n' "$C_WARN" "$C_OFF" >&2
    exit 1
  fi
  printf '\n  Type REMOVE to proceed (anything else cancels): '
  read -r REPLY_CONFIRM
  if [ "$REPLY_CONFIRM" != 'REMOVE' ]; then
    printf '\n  %sCancelled. Nothing was removed.%s\n\n' "$C_WARN" "$C_OFF"
    exit 0
  fi
fi
printf '\n'

# ── 1) Stop everything that is running ───────────────────────────────────────
step 'Stopping Xenon'

if [ "$DRY_RUN" != 1 ]; then
  if [ "$IS_MAC" = 1 ]; then
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 && sleep 1
  fi
  # Whatever a polite quit did not reach. The bundle is about to be deleted and
  # a live app would keep answering on the port and re-registering its own login
  # item on the way out — which is precisely how a "finished" uninstall ends up
  # with Xenon starting again at the next login.
  if pgrep -x 'xenon-native' >/dev/null 2>&1; then
    pkill -x 'xenon-native' >/dev/null 2>&1
    sleep 1
    pkill -9 -x 'xenon-native' >/dev/null 2>&1
    ok 'stopped the Xenon app'
  fi
  pkill -f 'Xenon[^ ]*\.AppImage' >/dev/null 2>&1
fi

# macOS: the LaunchAgent.
if command -v launchctl >/dev/null 2>&1; then
  if [ "$DRY_RUN" = 1 ]; then
    [ -f "$PLIST" ] && info "would remove: $PLIST"
  else
    # Both spellings, so an agent registered by an older install.sh is caught.
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
    launchctl unload -w "$PLIST" >/dev/null 2>&1
    [ -f "$PLIST" ] && rm_path "$PLIST" 'the backend login item'
  fi
  # The pointer install.sh leaves for Xenon.app so it knows where the backend
  # is. Removing it is what stops the app starting a backend that is no longer
  # installed.
  rm_path "$HOME/Library/Application Support/Xenon/backend.json" 'the backend location pointer'
  [ "$DRY_RUN" = 1 ] || rmdir "$HOME/Library/Application Support/Xenon" >/dev/null 2>&1
fi

# Linux: the systemd user unit.
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  if [ -f "$UNIT" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      info "would remove: $UNIT"
    else
      systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1
      rm_path "$UNIT" 'the systemd user unit'
      systemctl --user daemon-reload >/dev/null 2>&1
      # Drops the unit from systemd's view; without it `systemctl --user status`
      # keeps reporting a unit whose file no longer exists.
      systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1
    fi
  fi
fi

# Linux: the XDG autostart fallback.
rm_path "$AUTOSTART" 'the autostart entry'

# Anything still holding the port: a manually started server, or one the service
# manager has not reaped yet. "Uninstalled" must not leave a dashboard answering
# on 3030.
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    # ss is what a minimal Linux install has; lsof often is not there.
    ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  else
    # Neither tool present: an `if` with no matching branch exits 0 with no
    # output, which would leave "uninstalled" with a dashboard still answering
    # on the port. Our own pid and our parent's are excluded.
    pgrep -f "$SERVER_DIR/server.js" 2>/dev/null | grep -v -e "^$$\$" -e "^$PPID\$"
  fi
}
PIDS="$(port_pids)"
if [ -n "$PIDS" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    info "would stop the server listening on port $PORT"
  else
    # Braced on purpose: bash 3.2 (what macOS ships) folds the bytes of the
    # following non-ASCII character into the variable NAME. See the note in
    # xenon-bootstrap.sh and scripts-ascii.test.mjs.
    step "Stopping the server on port ${PORT}…"
    for pid in $PIDS; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
    sleep 1
    for pid in $PIDS; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done
  fi
fi

# The browser windows Xenon opened — the Deck popup, the Spotlight popup, the
# browser tile. Each runs against a --user-data-dir inside server/data, so they
# are ours, and each would otherwise be left on screen pointing at a port with
# nothing behind it. Matched on our own data folder, so no other window of the
# user's is ever touched.
if [ "$DRY_RUN" != 1 ] && command -v pgrep >/dev/null 2>&1; then
  BROWSER_PIDS="$(pgrep -f -- "$DATA_DIR" 2>/dev/null | grep -v -e "^$$\$" -e "^$PPID\$")"
  for pid in $BROWSER_PIDS; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
fi

# Logs are ours and hold nothing the user needs after this (macOS only: the
# systemd unit's output lives in the journal, which is not ours to prune).
[ "$DRY_RUN" = 1 ] || rm -rf "$MAC_LOG_DIR" 2>/dev/null

# ── 2) What Xenon set up inside OTHER programs ───────────────────────────────
# All of this outlives the install folder, so none of it is reachable by
# deleting Xenon, and none of it says "Xenon" anywhere the user will look. They
# are the same class of leftover: something that still runs at login, or inside
# another program, pointing at a Xenon that is no longer there.
step 'Undoing what Xenon set up in other programs'

# The Claude Code link. Xenon writes hooks and a status line into the user's own
# Claude Code settings.json — the only configuration of another program Xenon
# touches. Left behind, every Claude Code session runs a status-line script that
# no longer exists and posts each hook at a port with nothing listening.
if [ -f "$SERVER_DIR/claude-link.js" ] && command -v node >/dev/null 2>&1; then
  if [ "$DRY_RUN" = 1 ]; then
    info "would remove Xenon's hooks and status line from Claude Code"
  else
    CLAUDE_OUT="$(node "$SERVER_DIR/claude-link.js" unlink 2>&1)"
    case "$CLAUDE_OUT" in
      unlinked)   ok "removed Xenon's hooks and status line from Claude Code" ;;
      not-linked) : ;;
      *)          warn "could not unlink Claude Code: $CLAUDE_OUT" ;;
    esac
  fi
fi

if [ "$IS_MAC" = 1 ]; then
  # The app's OWN login item, which is not the backend's. Xenon.app registers it
  # itself on first run (tauri-plugin-autostart, MacosLauncher::LaunchAgent), so
  # it sits outside the bundle and survives dragging Xenon.app to the Trash.
  APP_AGENT="$HOME/Library/LaunchAgents/Xenon.plist"
  if [ -f "$APP_AGENT" ]; then
    [ "$DRY_RUN" = 1 ] || launchctl bootout "gui/$(id -u)/Xenon" >/dev/null 2>&1
    rm_path "$APP_AGENT" 'the Xenon app login item'
  fi
  # The "start Ollama at login" agent. Ollama itself is the user's own install
  # and stays (its models are gigabytes and other tools may use them), but this
  # agent is ours: Xenon wrote it, it carries Xenon's name, and alone it would
  # keep starting Ollama at every login for good.
  OLLAMA_AGENT="$HOME/Library/LaunchAgents/$APP_ID.ollama.plist"
  if [ -f "$OLLAMA_AGENT" ]; then
    [ "$DRY_RUN" = 1 ] || launchctl bootout "gui/$(id -u)/$APP_ID.ollama" >/dev/null 2>&1
    rm_path "$OLLAMA_AGENT" 'the Ollama login item Xenon added'
  fi
else
  # The Linux twins of the two above: the app's own autostart entry (written by
  # the app, so it outlives removing the .deb or deleting the AppImage) and the
  # one Xenon writes for Sunshine where Sunshine has no user service of its own.
  for entry in \
    "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/Xenon.desktop" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/xenon-sunshine.desktop"
  do
    rm_path "$entry"
  done

  # The global search shortcut. Xenon registers a real GNOME custom keybinding,
  # so leaving it behind means a key combination that silently does nothing
  # forever — the worst kind of leftover, because nothing on the system explains
  # it. Removed by path, so a shortcut the user made themselves is untouched.
  HOTKEY_SCHEMA='org.gnome.settings-daemon.plugins.media-keys'
  HOTKEY_PATH='/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/xenon-spotlight/'
  if command -v gsettings >/dev/null 2>&1 &&
     gsettings list-schemas 2>/dev/null | grep -qx "$HOTKEY_SCHEMA"; then
    CUR="$(gsettings get "$HOTKEY_SCHEMA" custom-keybindings 2>/dev/null)"
    case "$CUR" in
      *"$HOTKEY_PATH"*)
        if [ "$DRY_RUN" = 1 ]; then
          info 'would remove the global search shortcut'
        else
          step 'Removing the global search shortcut…'
          LEFT="$(printf '%s' "$CUR" | tr ',' '\n' | grep -v "$HOTKEY_PATH" |
                  sed "s/^[[:space:]]*\[*//; s/\]*[[:space:]]*$//" |
                  grep "'" | paste -sd, -)"
          # "[]" alone is an ambiguous GVariant that gsettings refuses; the empty
          # array has to be spelled out.
          [ -n "$LEFT" ] && LEFT="[$LEFT]" || LEFT='@as []'
          gsettings set "$HOTKEY_SCHEMA" custom-keybindings "$LEFT" 2>/dev/null
          for k in name command binding; do
            gsettings reset "${HOTKEY_SCHEMA}.custom-keybinding:${HOTKEY_PATH}" "$k" 2>/dev/null
          done
        fi
        ;;
    esac
  fi

  # MangoHud's FPS logs, which Xenon asked it to write into a folder of ours.
  rm_path "${XDG_STATE_HOME:-$HOME/.local/state}/xenon" 'the MangoHud FPS logs Xenon collected'
  # The four logging lines Xenon added to the user's MangoHud config. Their own
  # settings in that file are theirs and stay; only our block goes, and only if
  # the marker comment we wrote is there to identify it.
  MH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/MangoHud/MangoHud.conf"
  if [ -f "$MH_CONF" ] && grep -q '^# Added by Xenon' "$MH_CONF" 2>/dev/null; then
    if [ "$DRY_RUN" = 1 ]; then
      info 'would remove the MangoHud logging lines Xenon added'
    else
      step 'Removing the MangoHud logging lines Xenon added…'
      # `|| true` is load-bearing: grep exits 1 when it selects NO lines, which
      # is precisely the common case here — a MangoHud.conf that Xenon created
      # and that therefore contains nothing but Xenon's lines. Chained with &&
      # that exit status skipped the write, so the one config we were surest
      # about removing was the one always left behind.
      TMP_MH="$(mktemp)" || TMP_MH=''
      if [ -n "$TMP_MH" ]; then
        grep -v -e '^# Added by Xenon' -e '^output_folder=' -e '^autostart_log=' \
                -e '^log_interval=' -e '^log_duration=' "$MH_CONF" > "$TMP_MH" || true
        cat "$TMP_MH" > "$MH_CONF"
        rm -f "$TMP_MH"
      fi
      # If our lines were the ONLY thing in there, the file was ours: leaving an
      # empty MangoHud.conf behind would be litter for a tool the user may not
      # even have. rmdir only succeeds on an empty directory, so a config folder
      # holding anything else of theirs survives.
      if [ ! -s "$MH_CONF" ] || ! grep -q '[^[:space:]]' "$MH_CONF" 2>/dev/null; then
        rm -f "$MH_CONF"
        rmdir "$(dirname "$MH_CONF")" 2>/dev/null
      fi
    fi
  fi
fi

# ── 3) The app itself ────────────────────────────────────────────────────────
step 'Removing the Xenon app'

if [ "$IS_MAC" = 1 ]; then
  if [ -z "$APP_BUNDLES" ]; then
    info 'no copy of Xenon.app found'
  else
    LSREGISTER='/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'
    while IFS= read -r bundle; do
      [ -n "$bundle" ] || continue
      # Unregister BEFORE deleting. LaunchServices is what Spotlight, Launchpad
      # and "Open with" read from, and it keeps its record of a bundle that is
      # simply deleted — which is why an app dragged to the Trash can still be
      # found and opened from a search.
      if [ "$DRY_RUN" != 1 ] && [ -x "$LSREGISTER" ]; then
        "$LSREGISTER" -u "$bundle" >/dev/null 2>&1
      fi
      rm_path "$bundle" "$bundle" ||
        warn "  remove it by hand, or drag it to the Trash: $bundle"
    done <<EOF
$APP_BUNDLES
EOF
  fi
else
  if [ -n "$LINUX_PKG" ]; then
    case "$LINUX_PKG" in
      deb) PKG_CMD='apt-get remove -y xenon' ;;
      *)   PKG_CMD='rpm -e xenon' ;;
    esac
    if [ "$DRY_RUN" = 1 ]; then
      info "would remove the $LINUX_PKG package: $PKG_CMD"
    elif [ "$(id -u)" = 0 ]; then
      sh -c "$PKG_CMD" >/dev/null 2>&1 && ok "removed the $LINUX_PKG package" ||
        warn "the package manager refused — remove it with: $PKG_CMD"
    elif command -v sudo >/dev/null 2>&1; then
      # Removing a system package needs root, and asking for the password here
      # is honest: the alternative is telling the user the uninstall is done
      # while the icon is still in their menu.
      info 'Removing the Xenon package needs administrator rights.'
      if sudo -n true >/dev/null 2>&1 || [ -t 0 ]; then
        sudo sh -c "$PKG_CMD" && ok "removed the $LINUX_PKG package" ||
          warn "the package manager refused — remove it with: sudo $PKG_CMD"
      else
        warn "not removed (no terminal to ask for a password) — run: sudo $PKG_CMD"
      fi
    else
      warn "sudo is not installed — remove the package as root with: $PKG_CMD"
    fi
  fi
  while IFS= read -r img; do
    [ -n "$img" ] || continue
    rm_path "$img" "$img"
  done <<EOF
$LINUX_APPIMAGES
EOF
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    rm_path "$entry" "$entry"
  done <<EOF
$LINUX_ENTRIES
EOF
  if [ "$DRY_RUN" != 1 ] && [ -n "$LINUX_ENTRIES" ] &&
     command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${XDG_DATA_HOME:-$HOME/.local/share}/applications" >/dev/null 2>&1
  fi
  if [ -z "$LINUX_PKG" ] && [ -z "$LINUX_APPIMAGES" ] && [ -z "$LINUX_ENTRIES" ]; then
    info 'the Xenon app is not installed'
  fi
fi

# ── 4) The app's own preferences and caches ──────────────────────────────────
# The kiosk app keeps these outside the install folder, under the bundle
# identifier, so removing the app never removes them. They are settings, so they
# go with the rest of the user data rather than in a --keep-data run.
if [ "$REMOVE_DATA" = 1 ]; then
  step "Removing the app's preferences and cache"
  if [ "$IS_MAC" = 1 ]; then
    APP_STATE_DIRS="$HOME/Library/Application Support/$APP_ID
$HOME/Library/Caches/$APP_ID
$HOME/Library/WebKit/$APP_ID
$HOME/Library/Preferences/$APP_ID.plist
$HOME/Library/Saved Application State/$APP_ID.savedState"
  else
    APP_STATE_DIRS="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID
${XDG_DATA_HOME:-$HOME/.local/share}/$APP_ID
${XDG_CACHE_HOME:-$HOME/.cache}/$APP_ID"
  fi
  # One path per line, and paths may contain spaces: split on newlines only.
  OLD_IFS="$IFS"; IFS=$'\n'
  for d in $APP_STATE_DIRS; do rm_path "$d"; done
  IFS="$OLD_IFS"
fi

# ── 5) User data ─────────────────────────────────────────────────────────────
if [ "$REMOVE_DATA" = 1 ]; then
  step 'Removing your data'
  rm_path "$DATA_DIR" 'settings, notes, events, tasks, timers, deck, backgrounds'
else
  step 'Keeping your data'
  info "$DATA_DIR was kept (--keep-data)."
fi

# ── 6) The install folder ────────────────────────────────────────────────────
if [ "$REMOVE_ROOT" = 1 ]; then
  step 'Removing the install folder'
  if [ "$DRY_RUN" = 1 ]; then
    info "would remove: $ROOT_DIR"
  else
    # This script lives inside the folder it is deleting. Unlinking an open file
    # is legal here — unlike on Windows — but the shell is still reading from it
    # and the user's own working directory is inside it, so the delete is handed
    # to a detached copy that waits for this process to exit first and then
    # removes itself.
    SELF_DEL="$(mktemp -t xenon-selfdelete.XXXXXX 2>/dev/null)"
    if [ -z "$SELF_DEL" ]; then
      warn "could not schedule the folder delete — remove it by hand: $ROOT_DIR"
    else
      {
        printf '#!/bin/bash\n'
        printf 'target=%q\n' "$ROOT_DIR"
        printf 'self=%q\n'   "$SELF_DEL"
        printf 'parent=%d\n' "$$"
        cat <<'SELFDEL'
# Wait for the uninstaller to exit (bounded: never outlive a stuck parent).
waited=0
while kill -0 "$parent" 2>/dev/null && [ "$waited" -lt 60 ]; do
  sleep 1
  waited=$((waited + 1))
done
attempt=0
while [ -d "$target" ] && [ "$attempt" -lt 15 ]; do
  rm -rf "$target" 2>/dev/null
  [ -d "$target" ] || break
  sleep 2
  attempt=$((attempt + 1))
done
rm -f "$self"
SELFDEL
      } > "$SELF_DEL"
      chmod +x "$SELF_DEL" 2>/dev/null
      nohup bash "$SELF_DEL" >/dev/null 2>&1 &
      ok "the install folder will be removed once this window closes ($ROOT_DIR)"
    fi
  fi
elif [ -n "$ROOT_SKIP" ]; then
  step 'Keeping the install folder'
  info "$ROOT_DIR — $ROOT_SKIP"
  info 'Delete it yourself when you no longer want it.'
fi

# ── Done ─────────────────────────────────────────────────────────────────────
printf '\n'
if [ "$DRY_RUN" = 1 ]; then
  printf '  %sDry run complete — nothing was changed. Re-run without --dry-run to apply.%s\n\n' "$C_STEP" "$C_OFF"
  exit 0
fi

printf '  %sXenon has been removed.%s\n' "$C_OK" "$C_OFF"
[ "$REMOVE_DATA" = 1 ] || printf '  %sYour data in %s was kept.%s\n' "$C_OK" "$DATA_DIR" "$C_OFF"

# What is deliberately NOT removed, named rather than left to be discovered.
# Both are things only the user can remove, or that are theirs to keep — the
# list is short now precisely because everything that was ours has gone.
printf '\n  %sStill yours to keep or remove:%s\n' "$C_DIM" "$C_OFF"
printf '  %s  * anything Xenon offered to install for you: Node.js, Ollama and its%s\n' "$C_DIM" "$C_OFF"
printf '  %s    models (~/.ollama), Tailscale, Sunshine, ffmpeg. Remove them the way%s\n' "$C_DIM" "$C_OFF"
printf '  %s    you would any other package.%s\n' "$C_DIM" "$C_OFF"
if [ "$IS_MAC" = 1 ]; then
  printf '  %s  * the Xenon entries in System Settings > Privacy & Security%s\n' "$C_DIM" "$C_OFF"
  printf '  %s    (Accessibility, Screen Recording, Automation): macOS only lets you%s\n' "$C_DIM" "$C_OFF"
  printf '  %s    remove those yourself.%s\n' "$C_DIM" "$C_OFF"
fi
printf '\n'
exit 0

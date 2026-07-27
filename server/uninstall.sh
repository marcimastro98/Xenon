#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# uninstall.sh — remove the Xenon backend's login service (macOS and Linux).
#
# Counterpart of install.sh (and of uninstall.ps1 on Windows). It stops the
# backend and unregisters whichever login mechanism install.sh used. It does NOT
# delete the install folder and it does NOT delete your settings, notes, events,
# deck or backgrounds — those live in server/data and are only removed when you
# explicitly pass --purge-data.
#
#   ./server/uninstall.sh              stop + unregister, keep everything
#   ./server/uninstall.sh --purge-data also delete server/data (irreversible)
#
# Every removal is attempted regardless of which one was used to install, so a
# tree that was set up by one mechanism and later re-installed under another
# does not leave a second copy behind starting a second server on the port.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SERVER_DIR/data"
PORT=3030
PURGE=0

LABEL="com.marcimastro98.xenon.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MAC_LOG_DIR="$HOME/Library/Logs/Xenon"
UNIT_NAME="xenon-backend.service"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/xenon-backend.desktop"

for arg in "$@"; do
  case "$arg" in
    --purge-data) PURGE=1 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_DIM=$'\033[90m'; C_OFF=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_DIM=''; C_OFF=''
fi
step() { printf '%s==>%s %s\n' "$C_STEP" "$C_OFF" "$1"; }

printf '\n  %sXenon — removing the backend login service%s\n\n' "$C_STEP" "$C_OFF"

FOUND=0

# ── macOS: the LaunchAgent ───────────────────────────────────────────────────
if command -v launchctl >/dev/null 2>&1; then
  # Both the modern and the legacy spellings, so an agent registered by an older
  # install.sh is caught too.
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  launchctl unload -w "$PLIST" >/dev/null 2>&1
  if [ -f "$PLIST" ]; then
    step 'Stopping the LaunchAgent…'
    rm -f "$PLIST" && step "Removed $PLIST"
    FOUND=1
  fi
  # The pointer install.sh leaves for Xenon.app so it knows where the backend
  # is. Removing it is what stops the app starting a backend that is no longer
  # installed. User data under server/data is never touched, here or anywhere.
  LOCATION="$HOME/Library/Application Support/Xenon/backend.json"
  if [ -f "$LOCATION" ]; then
    rm -f "$LOCATION" && step "Removed $LOCATION"
    rmdir "$HOME/Library/Application Support/Xenon" >/dev/null 2>&1 || true
    FOUND=1
  fi
fi

# ── Linux: the systemd user unit ─────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  if [ -f "$UNIT" ]; then
    step 'Stopping the systemd user unit…'
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1
    rm -f "$UNIT" && step "Removed $UNIT"
    systemctl --user daemon-reload >/dev/null 2>&1
    # Drops the unit from systemd's view; without it `systemctl --user status`
    # keeps reporting a unit whose file no longer exists.
    systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1
    FOUND=1
  fi
fi

# ── Linux: the XDG autostart fallback ────────────────────────────────────────
if [ -f "$AUTOSTART" ]; then
  step 'Removing the autostart entry…'
  rm -f "$AUTOSTART" && step "Removed $AUTOSTART"
  FOUND=1
fi

[ "$FOUND" = "1" ] || step 'No login service was registered.'

# ── Anything still holding the port ──────────────────────────────────────────
# A manually started server, or one the service manager has not reaped yet.
# "uninstalled" must not leave a dashboard answering on 3030.
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    # ss is what a minimal Linux install has; lsof often is not there.
    ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}
PIDS="$(port_pids)"
if [ -n "$PIDS" ]; then
  step "Stopping the server on port $PORT…"
  for pid in $PIDS; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  for pid in $PIDS; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done
fi

# Logs are ours and hold nothing the user needs after this (macOS only: the
# systemd unit's output lives in the journal, which is not ours to prune).
rm -rf "$MAC_LOG_DIR" 2>/dev/null

# ── Things Xenon wrote OUTSIDE its own folder ────────────────────────────────
# These are the only two, and both would otherwise outlive the uninstall in a
# way the user would notice.
if [ "$(uname -s)" != 'Darwin' ]; then
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
        ;;
    esac
  fi

  # MangoHud's FPS logs, which Xenon asked it to write into a folder of ours.
  rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/xenon" 2>/dev/null
  # The four logging lines Xenon added to the user's MangoHud config. Their own
  # settings in that file are theirs and stay; only our block goes, and only if
  # the marker comment we wrote is there to identify it.
  MH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/MangoHud/MangoHud.conf"
  if [ -f "$MH_CONF" ] && grep -q '^# Added by Xenon' "$MH_CONF" 2>/dev/null; then
    step 'Removing the MangoHud logging lines Xenon added…'
    # `|| true` is load-bearing: grep exits 1 when it selects NO lines, which is
    # precisely the common case here — a MangoHud.conf that Xenon created and
    # that therefore contains nothing but Xenon's lines. Chained with && that
    # exit status skipped the write, so the one config we were surest about
    # removing was the one always left behind.
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

# ── User data, only on an explicit request ───────────────────────────────────
if [ "$PURGE" = "1" ]; then
  if [ -d "$DATA_DIR" ]; then
    step 'Deleting server/data (settings, notes, events, deck, backgrounds)…'
    rm -rf "$DATA_DIR"
  fi
else
  printf '\n  %sYour settings and data were kept in:%s\n' "$C_DIM" "$C_OFF"
  printf '  %s  %s%s\n' "$C_DIM" "$DATA_DIR" "$C_OFF"
  printf '  %sRe-run with --purge-data to delete them as well.%s\n' "$C_DIM" "$C_OFF"
fi

printf '\n  %sDone.%s' "$C_OK" "$C_OFF"
if [ "$(uname -s)" = 'Darwin' ]; then
  printf ' %sThe Xenon app itself (if installed) is removed by%s\n' "$C_OK" "$C_OFF"
  printf '  %sdragging Xenon.app from Applications to the Trash.%s\n' "$C_OK" "$C_OFF"
else
  printf ' %sThe install folder itself was left in place.%s\n' "$C_OK" "$C_OFF"
fi
printf '\n'
exit 0

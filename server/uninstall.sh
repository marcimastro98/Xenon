#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# uninstall.sh — remove the Xenon backend's macOS login agent.
#
# Counterpart of install.sh (and of uninstall.ps1 on Windows). It stops the
# backend and unregisters the LaunchAgent. It does NOT delete the install folder
# and it does NOT delete your settings, notes, events, deck or backgrounds —
# those live in server/data and are only removed when you explicitly pass
# --purge-data.
#
#   ./server/uninstall.sh              stop + unregister, keep everything
#   ./server/uninstall.sh --purge-data also delete server/data (irreversible)
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SERVER_DIR/data"
LABEL="com.marcimastro98.xenon.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Xenon"
PORT=3030
PURGE=0

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

printf '\n  %sXenon — removing the backend login agent%s\n\n' "$C_STEP" "$C_OFF"

# 1) Unload the agent (both the modern and the legacy launchctl spellings, so an
#    agent registered by an older install.sh is caught too).
GUI="gui/$(id -u)"
step 'Stopping the login agent…'
launchctl bootout "$GUI/$LABEL" >/dev/null 2>&1
launchctl unload -w "$PLIST" >/dev/null 2>&1

# 2) Remove the plist.
if [ -f "$PLIST" ]; then
  rm -f "$PLIST" && step "Removed $PLIST"
else
  step 'No login agent was registered.'
fi

# 3) Anything still holding the port is a manually started server — stop it too,
#    so "uninstalled" does not leave a dashboard answering on 3030. lsof is part
#    of the base system; the guard keeps this from ever killing pid 0/empty.
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    step "Stopping the server on port $PORT…"
    for pid in $PIDS; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
    sleep 1
    for pid in $PIDS; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done
  fi
fi

# 4) Logs are ours and hold nothing the user needs after this.
rm -rf "$LOG_DIR" 2>/dev/null

# 5) User data, only on an explicit request.
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

printf '\n  %sDone. The Xenon app itself (if installed) is removed by dragging%s\n' "$C_OK" "$C_OFF"
printf '  %sXenon.app from Applications to the Trash.%s\n\n' "$C_OK" "$C_OFF"
exit 0

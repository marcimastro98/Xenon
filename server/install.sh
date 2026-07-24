#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# install.sh — macOS installer for the Xenon backend.
#
# The macOS counterpart of install.ps1. It is deliberately much smaller, because
# most of what install.ps1 does has no macOS equivalent: there is no
# LibreHardwareMonitor, no PawnIO driver, no PresentMon, no iCUE SDK dll and no
# xenon-helper.exe on this platform (see docs/MACOS_PORTABILITY.md). What remains
# is the part that actually matters:
#
#   1. make sure Node.js is present,
#   2. install the npm dependencies,
#   3. register a per-user LaunchAgent so the backend starts at login,
#   4. start it and wait until it answers.
#
# A LaunchAgent — never a LaunchDaemon. The invariant that keeps the Windows
# build out of a session-0 service applies here for the same reason: a daemon
# runs outside the user's GUI session, where `osascript`, the app switcher, the
# microphone and the audio device list are all unavailable. `gui/<uid>` is the
# only domain this backend can work in.
#
# Safe to re-run: every step is idempotent and user data under server/data is
# never touched.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SERVER_DIR")"
DATA_DIR="$SERVER_DIR/data"
LABEL="com.marcimastro98.xenon.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Xenon"
PORT=3030
DASH_URL="http://127.0.0.1:$PORT/"

# Colours only when stdout is a terminal, so a run from the app bootstrap (piped
# into a log) stays readable.
if [ -t 1 ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[90m'; C_OFF=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_OFF=''
fi

step() { printf '%s==>%s %s\n' "$C_STEP" "$C_OFF" "$1"; }
warn() { printf '%s  ! %s%s\n' "$C_WARN" "$1" "$C_OFF"; }
fail() {
  printf '\n%s  %s%s\n' "$C_ERR" "$1" "$C_OFF"
  printf '%s  Nothing was left running. See https://github.com/marcimastro98/Xenon#readme%s\n\n' "$C_DIM" "$C_OFF"
  exit 1
}

printf '\n  %sXenon — installing the dashboard backend%s\n' "$C_STEP" "$C_OFF"
printf '  %s%s%s\n\n' "$C_DIM" "$ROOT_DIR" "$C_OFF"

# ── 0) Platform ──────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows run INSTALL.bat instead."

# ── 1) Node.js ───────────────────────────────────────────────────────────────
# Homebrew is not on the PATH of a non-login shell (and never is under the app
# bootstrap), so both prefixes are probed explicitly before giving up.
for p in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && PATH="$p:$PATH" ;; esac
done
export PATH

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  if command -v brew >/dev/null 2>&1; then
    step 'Installing Node.js with Homebrew…'
    brew install node || true
    NODE_BIN="$(command -v node || true)"
  fi
fi
[ -n "$NODE_BIN" ] || fail "Node.js is required and was not found. Install it with 'brew install node' or from https://nodejs.org, then run this script again."

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "${NODE_MAJOR:-0}" -ge 18 ] 2>/dev/null || fail "Node.js 18 or newer is required (found $("$NODE_BIN" -v 2>/dev/null || echo 'none'))."
step "Node.js: $NODE_BIN ($("$NODE_BIN" -v))"

NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || fail "npm was not found next to Node.js. Reinstall Node.js and run this script again."

# ── 2) Dependencies ──────────────────────────────────────────────────────────
# `npm install` (not `npm ci`): a release tarball ships package-lock.json, but a
# user may have edited the tree, and ci would delete node_modules on any drift.
step 'Installing Node.js dependencies…'
if ! (cd "$ROOT_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund); then
  warn 'npm install failed once; retrying…'
  (cd "$ROOT_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund) \
    || fail "npm install failed. Run it manually in $ROOT_DIR and re-run this script."
fi

mkdir -p "$DATA_DIR" "$LOG_DIR"

# ── 3) Optional extras ───────────────────────────────────────────────────────
# None of these is required; each one lights up a specific widget. They are
# reported, never installed behind the user's back.
MISSING=()
command -v ffmpeg  >/dev/null 2>&1 || MISSING+=("ffmpeg — voice input and text-to-speech playback:  brew install ffmpeg")
command -v macmon  >/dev/null 2>&1 || MISSING+=("macmon — CPU/GPU temperature and GPU load:          brew install vladkens/tap/macmon")
command -v SwitchAudioSource >/dev/null 2>&1 || MISSING+=("switchaudio-osx — switching the output device:     brew install switchaudio-osx")
if [ ${#MISSING[@]} -gt 0 ]; then
  printf '\n%s  Optional, not installed:%s\n' "$C_DIM" "$C_OFF"
  for m in "${MISSING[@]}"; do printf '%s    %s%s\n' "$C_DIM" "$m" "$C_OFF"; done
  printf '\n'
fi

# ── 4) LaunchAgent ───────────────────────────────────────────────────────────
# KeepAlive restarts the backend if it ever exits — the in-session equivalent of
# the crash-restart a Windows service would give, without leaving the GUI
# session. SuccessfulExit=false means "restart on a crash, respect a clean exit",
# so `launchctl bootout` (and the uninstaller) can actually stop it.
step 'Registering the login agent…'
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/backend.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/backend.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

# ── 5) (Re)start ─────────────────────────────────────────────────────────────
# bootout before bootstrap so a re-run reloads the plist instead of silently
# keeping the old definition. Both are best-effort: bootout fails when nothing
# is loaded, which is the normal first-install case.
GUI="gui/$(id -u)"
launchctl bootout "$GUI/$LABEL" >/dev/null 2>&1
launchctl bootstrap "$GUI" "$PLIST" >/dev/null 2>&1 \
  || launchctl load -w "$PLIST" >/dev/null 2>&1 \
  || fail "launchctl refused to load $PLIST."
launchctl kickstart "$GUI/$LABEL" >/dev/null 2>&1

step 'Waiting for the dashboard to answer…'
UP=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/version" >/dev/null 2>&1; then UP=1; break; fi
  sleep 1
done

printf '\n  %s---------------------------------------------------%s\n' "$C_DIM" "$C_OFF"
if [ "$UP" = "1" ]; then
  VER="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/version" 2>/dev/null | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')"
  printf '  %sXenon %s is running.%s\n' "$C_OK" "${VER:-}" "$C_OFF"
  printf '  %sDashboard: %s%s\n' "$C_OK" "$DASH_URL" "$C_OFF"
else
  printf '  %sThe backend was registered but did not answer within 40s.%s\n' "$C_WARN" "$C_OFF"
  printf '  %sCheck the log: %s/backend.err.log%s\n' "$C_DIM" "$LOG_DIR" "$C_OFF"
fi
printf '  %s---------------------------------------------------%s\n\n' "$C_DIM" "$C_OFF"

printf '  %sIt starts again automatically at every login.%s\n' "$C_DIM" "$C_OFF"
printf '  %sTo remove it: %s/uninstall.sh%s\n\n' "$C_DIM" "$SERVER_DIR" "$C_OFF"

# macOS asks for these the first time the feature is used, not now — say so, so
# a prompt weeks later is not a surprise.
printf '  %smacOS will ask for permission the first time you use:%s\n' "$C_DIM" "$C_OFF"
printf '  %s  Automation (System Events) — the app switcher widget%s\n' "$C_DIM" "$C_OFF"
printf '  %s  Microphone                 — voice input%s\n' "$C_DIM" "$C_OFF"
printf '  %s  Screen Recording           — the screenshot the AI can take%s\n\n' "$C_DIM" "$C_OFF"

[ "$UP" = "1" ] || exit 1
exit 0

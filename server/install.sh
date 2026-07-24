#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# install.sh — installer for the Xenon backend on macOS and Linux.
#
# The counterpart of install.ps1. It is deliberately much smaller, because most
# of what install.ps1 does has no equivalent here: there is no
# LibreHardwareMonitor, no PawnIO driver, no PresentMon, no iCUE SDK dll and no
# xenon-helper.exe on either platform (see docs/MACOS_PORTABILITY.md). What
# remains is the part that actually matters:
#
#   1. make sure Node.js is present,
#   2. install the npm dependencies,
#   3. register a per-user login service so the backend starts at login,
#   4. start it and wait until it answers.
#
# A per-USER service — never a system one. The invariant that keeps the Windows
# build out of a session-0 service applies to both platforms for the same
# reason: outside the user's graphical session there is no audio device list, no
# window list, no microphone and no way to open an app. That is why macOS gets a
# LaunchAgent in `gui/<uid>` and Linux a `systemd --user` unit, and why neither
# is given lingering (which would keep it running with nobody logged in).
#
# Safe to re-run: every step is idempotent and user data under server/data is
# never touched.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SERVER_DIR")"
DATA_DIR="$SERVER_DIR/data"
PORT=3030
DASH_URL="http://127.0.0.1:$PORT/"

# macOS
LABEL="com.marcimastro98.xenon.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MAC_LOG_DIR="$HOME/Library/Logs/Xenon"
# Linux
UNIT_NAME="xenon-backend.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$UNIT_NAME"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
AUTOSTART="$AUTOSTART_DIR/xenon-backend.desktop"

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

# ── 0) Platform ──────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) XENON_OS='macos' ;;
  Linux)  XENON_OS='linux' ;;
  *) fail "This installer supports macOS and Linux. On Windows run INSTALL.bat instead." ;;
esac

printf '\n  %sXenon — installing the dashboard backend%s\n' "$C_STEP" "$C_OFF"
printf '  %s%s (%s)%s\n\n' "$C_DIM" "$ROOT_DIR" "$XENON_OS" "$C_OFF"

# ── 1) Node.js ───────────────────────────────────────────────────────────────
# Homebrew is not on the PATH of a non-login shell (and never is under the macOS
# app bootstrap), so both prefixes are probed explicitly before giving up.
for p in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && PATH="$p:$PATH" ;; esac
done
export PATH

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ "$XENON_OS" = 'macos' ] && command -v brew >/dev/null 2>&1; then
  # macOS has exactly one package manager worth assuming, and installing Node
  # from it is what the Windows installer's winget path does. On Linux the
  # package manager varies by distro and installing system packages unasked is
  # a bigger imposition, so that side only points at the command to run.
  step 'Installing Node.js with Homebrew…'
  brew install node || true
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  if [ "$XENON_OS" = 'macos' ]; then
    fail "Node.js is required and was not found. Install it with 'brew install node' or from https://nodejs.org, then run this script again."
  fi
  fail "Node.js 18+ is required and was not found. Install it with your package manager (apt install nodejs npm / dnf install nodejs / pacman -S nodejs npm) or from https://nodejs.org, then run this script again."
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "${NODE_MAJOR:-0}" -ge 18 ] 2>/dev/null || fail "Node.js 18 or newer is required (found $("$NODE_BIN" -v 2>/dev/null || echo 'none'))."
step "Node.js: $NODE_BIN ($("$NODE_BIN" -v))"

NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || fail "npm was not found next to Node.js. Install it (on Debian/Ubuntu it is a separate 'npm' package) and run this script again."

# ── 2) Dependencies ──────────────────────────────────────────────────────────
# `npm install` (not `npm ci`): a release tarball ships package-lock.json, but a
# user may have edited the tree, and ci would delete node_modules on any drift.
step 'Installing Node.js dependencies…'
if ! (cd "$ROOT_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund); then
  warn 'npm install failed once; retrying…'
  (cd "$ROOT_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund) \
    || fail "npm install failed. Run it manually in $ROOT_DIR and re-run this script."
fi

mkdir -p "$DATA_DIR"

# ── 3) Optional extras ───────────────────────────────────────────────────────
# None of these is required; each one lights up a specific widget or path. They
# are reported, never installed behind the user's back.
# A newline-joined string, not an array, on purpose: macOS ships bash 3.2 as
# /bin/bash, where an empty array under `set -u` is a minefield — the installer
# would abort here on the machine that needs nothing, before registering the
# login service. None of the entries contains a newline, so a plain string
# carries the same information with none of the risk.
MISSING=''
have() { command -v "$1" >/dev/null 2>&1; }
miss() { MISSING="$MISSING$1"$'\n'; }
have unzip || miss "unzip   — needed to install in-app updates"
have ffmpeg || miss "ffmpeg  — voice input and text-to-speech playback"
if [ "$XENON_OS" = 'macos' ]; then
  have macmon || miss "macmon  — CPU/GPU temperature and GPU load:   brew install vladkens/tap/macmon"
  have SwitchAudioSource || miss "switchaudio-osx — switching the output device: brew install switchaudio-osx"
else
  # The tools linux-collectors.js shells out to; each one degrades to the "--"
  # the tile showed before Linux support existed.
  have nvidia-smi || miss "nvidia-smi — GPU load, temperature and VRAM (NVIDIA only)"
  have wpctl || miss "wireplumber — the volume mixer and audio devices"
  have wmctrl || miss "wmctrl + xdotool + x11-utils — the open-applications widget (X11 sessions)"
fi
if [ -n "$MISSING" ]; then
  printf '\n%s  Optional, not installed:%s\n' "$C_DIM" "$C_OFF"
  printf '%s' "$MISSING" | while IFS= read -r m; do
    [ -n "$m" ] && printf '%s    %s%s\n' "$C_DIM" "$m" "$C_OFF"
  done
  printf '\n'
fi

# ── 4) Register the login service ────────────────────────────────────────────
register_macos() {
  # KeepAlive restarts the backend if it ever exits — the in-session equivalent
  # of the crash-restart a Windows service would give, without leaving the GUI
  # session. SuccessfulExit=false means "restart on a crash, respect a clean
  # exit", which is also what lets update-apply.sh stop the backend with a plain
  # SIGTERM and have launchd leave it stopped while it swaps files in.
  mkdir -p "$HOME/Library/LaunchAgents" "$MAC_LOG_DIR"
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
  <string>$MAC_LOG_DIR/backend.log</string>
  <key>StandardErrorPath</key>
  <string>$MAC_LOG_DIR/backend.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

  # bootout before bootstrap so a re-run reloads the plist instead of silently
  # keeping the old definition. Both are best-effort: bootout fails when nothing
  # is loaded, which is the normal first-install case.
  local gui="gui/$(id -u)"
  launchctl bootout "$gui/$LABEL" >/dev/null 2>&1
  launchctl bootstrap "$gui" "$PLIST" >/dev/null 2>&1 \
    || launchctl load -w "$PLIST" >/dev/null 2>&1 \
    || fail "launchctl refused to load $PLIST."
  launchctl kickstart "$gui/$LABEL" >/dev/null 2>&1
}

register_linux_systemd() {
  # Restart=on-failure is the exact counterpart of macOS's
  # KeepAlive.SuccessfulExit=false, and load-bearing for the same second reason:
  # the server's shutdown always exits 0, so update-apply.sh can stop it without
  # systemd racing to bring it back mid-swap.
  #
  # graphical-session.target only in After=, not WantedBy=: some minimal window
  # managers never reach that target, and a unit wanted by it would then never
  # autostart at all. WantedBy=default.target always fires; the After= just
  # orders it behind the session when there IS one.
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Xenon dashboard backend
Documentation=https://github.com/marcimastro98/Xenon
After=graphical-session.target network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $SERVER_DIR/server.js
WorkingDirectory=$ROOT_DIR
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT_EOF

  # The window and audio collectors need the session's own variables, and a user
  # unit does not inherit them unless the desktop exported them into the user
  # manager. Most desktops do this themselves at login; doing it here as well
  # covers the ones that do not, and costs nothing when they already have.
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR >/dev/null 2>&1

  systemctl --user daemon-reload >/dev/null 2>&1
  # On failure the unit file is removed again: falling through to the autostart
  # fallback while leaving a disabled unit behind would give the next
  # update-apply.sh two plausible ways to start the server and let it pick the
  # one that was never enabled.
  if ! systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 \
    || ! systemctl --user restart "$UNIT_NAME" >/dev/null 2>&1; then
    systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1
    rm -f "$UNIT"
    systemctl --user daemon-reload >/dev/null 2>&1
    return 1
  fi
  return 0
}

register_linux_autostart() {
  # Fallback for a desktop without a systemd user manager (Devuan, Void, some
  # Alpine setups). An XDG autostart entry is the portable equivalent; it has no
  # crash-restart, which is stated rather than hidden.
  mkdir -p "$AUTOSTART_DIR"
  cat > "$AUTOSTART" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=Xenon dashboard backend
Comment=Starts the local Xenon server on port $PORT
Exec=$NODE_BIN $SERVER_DIR/server.js
Path=$ROOT_DIR
Terminal=false
X-GNOME-Autostart-enabled=true
DESKTOP_EOF
  # Start it now too, so this run ends with a working dashboard rather than one
  # that only appears after the next login.
  if [ -z "$(pgrep -f "$SERVER_DIR/server.js" 2>/dev/null)" ]; then
    ( cd "$ROOT_DIR" && nohup "$NODE_BIN" "$SERVER_DIR/server.js" >/dev/null 2>&1 & )
  fi
}

step 'Registering the login service…'
SERVICE_KIND=''
if [ "$XENON_OS" = 'macos' ]; then
  register_macos
  SERVICE_KIND='launchd'
else
  # `systemctl --user` can exist as a binary while there is no user manager to
  # talk to (a container, a non-systemd init, an ssh session without a bus), so
  # the probe is a real call, not `command -v`.
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 && register_linux_systemd; then
    SERVICE_KIND='systemd'
  else
    warn 'no systemd user session; falling back to an XDG autostart entry (no crash-restart)'
    register_linux_autostart
    SERVICE_KIND='autostart'
  fi
fi

# ── 5) Wait for it to answer ─────────────────────────────────────────────────
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
  printf '  %sThe service was registered but did not answer within 40s.%s\n' "$C_WARN" "$C_OFF"
  case "$SERVICE_KIND" in
    launchd)   printf '  %sCheck the log: %s/backend.err.log%s\n' "$C_DIM" "$MAC_LOG_DIR" "$C_OFF" ;;
    systemd)   printf '  %sCheck the log: journalctl --user -u %s -n 50%s\n' "$C_DIM" "$UNIT_NAME" "$C_OFF" ;;
    autostart) printf '  %sTry starting it by hand: node %s/server.js%s\n' "$C_DIM" "$SERVER_DIR" "$C_OFF" ;;
  esac
fi
printf '  %s---------------------------------------------------%s\n\n' "$C_DIM" "$C_OFF"

printf '  %sIt starts again automatically at every login.%s\n' "$C_DIM" "$C_OFF"
printf '  %sTo remove it: %s/uninstall.sh%s\n\n' "$C_DIM" "$SERVER_DIR" "$C_OFF"

if [ "$XENON_OS" = 'macos' ]; then
  # macOS asks for these the first time the feature is used, not now — say so, so
  # a prompt weeks later is not a surprise.
  printf '  %smacOS will ask for permission the first time you use:%s\n' "$C_DIM" "$C_OFF"
  printf '  %s  Automation (System Events) — the app switcher widget%s\n' "$C_DIM" "$C_OFF"
  printf '  %s  Microphone                 — voice input%s\n' "$C_DIM" "$C_OFF"
  printf '  %s  Screen Recording           — the screenshot the AI can take%s\n\n' "$C_DIM" "$C_OFF"
else
  printf '  %sLinux support is experimental. The app switcher needs an X11%s\n' "$C_DIM" "$C_OFF"
  printf '  %ssession; on Wayland it stays empty, and CPU temperature comes%s\n' "$C_DIM" "$C_OFF"
  printf '  %sfrom /sys/class/hwmon, which not every board exposes.%s\n\n' "$C_DIM" "$C_OFF"
fi

[ "$UP" = "1" ] || exit 1
exit 0

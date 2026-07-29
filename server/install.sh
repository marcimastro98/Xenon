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
  # Only worth naming when the companion is absent: it reads the sensors
  # itself, so on a normal install macmon lights up nothing new.
  if [ ! -x "$SERVER_DIR/helper/xenon-helper" ]; then
    have macmon || miss "macmon  — CPU/GPU temperature and GPU load without the companion: brew install vladkens/tap/macmon"
  fi
  have SwitchAudioSource || miss "switchaudio-osx — switching the output device: brew install switchaudio-osx"
else
  # The tools linux-collectors.js shells out to; each one degrades to the "--"
  # the tile showed before Linux support existed.
  have nvidia-smi || miss "nvidia-smi — GPU load, temperature and VRAM on NVIDIA cards (AMD and Intel need nothing)"
  have wpctl || miss "wireplumber — the volume mixer and audio devices"
  have dbus-monitor || miss "dbus-monitor — mirroring your desktop notifications"
  # xprop is what the app switcher and game-mode detection read; wmctrl only
  # adds the ability to ACT on a window, so the two are named separately rather
  # than as one lump the user has to install whole.
  have xprop || miss "x11-utils — the open-applications widget and game-mode detection (X11 and Xwayland)"
  have wmctrl || miss "wmctrl — focusing and closing windows from the open-applications widget"
  have mangohud || miss "mangohud — in-game FPS (launch the game with it: mangohud %command%)"
  # playerctl is no longer required for now-playing: busctl reads the same bus.
  # Naming it only makes sense when the fallback is unavailable too, or as the
  # speed note below, so it never reads as a broken tile.
  have busctl || miss "systemd (busctl) — reading what is playing, over D-Bus"
  have playerctl || miss "playerctl — optional: makes the now-playing tile update instantly instead of once a second"
fi
if [ -n "$MISSING" ]; then
  printf '\n%s  Optional, not installed:%s\n' "$C_DIM" "$C_OFF"
  printf '%s' "$MISSING" | while IFS= read -r m; do
    [ -n "$m" ] && printf '%s    %s%s\n' "$C_DIM" "$m" "$C_OFF"
  done
  printf '\n'
fi

# ── 3b) macOS now-playing bridge ─────────────────────────────────────────────
# mediaremote-adapter (BSD-3-Clause) is what lets the media tile read the track
# on macOS: since 15.4 the private MediaRemote framework refuses to load into
# anything that is not Apple-signed, so the adapter loads it from inside
# /usr/bin/perl, which is. The release workflow builds it; we fetch it here.
#
# Optional in the strict sense — the server treats its absence as "nothing is
# playing" and never retries — so every failure below is a warning, never a
# fail. Fetched over HTTPS from our own release, with the same TLS-only trust a
# first install has everywhere else (see the first-install integrity note in
# docs/MACOS_PORTABILITY.md); nothing here weakens the SIGNED path the updater
# and the app bootstrap use.
install_media_adapter() {
  [ "$XENON_OS" = 'macos' ] || return 0
  local dir="$SERVER_DIR/mediaremote"
  if [ -d "$dir/MediaRemoteAdapter.framework" ] && [ -f "$dir/mediaremote-adapter.pl" ]; then
    return 0
  fi
  have curl || { warn 'curl is missing; skipping the now-playing bridge.'; return 0; }
  step 'Installing the macOS now-playing bridge…'
  local url='https://github.com/marcimastro98/Xenon/releases/latest/download/MediaRemoteAdapter-macos.tar.gz'
  local tmp
  tmp="$(mktemp -d)" || { warn 'could not create a temporary directory; skipping.'; return 0; }
  if ! curl -fsSL --retry 3 --max-time 120 -o "$tmp/adapter.tar.gz" "$url"; then
    warn 'the now-playing bridge could not be downloaded; the media tile will stay empty.'
    rm -rf "$tmp"
    return 0
  fi
  mkdir -p "$dir"
  if ! tar -xzf "$tmp/adapter.tar.gz" -C "$dir"; then
    warn 'the now-playing bridge archive could not be extracted; the media tile will stay empty.'
    rm -rf "$tmp" "$dir"
    return 0
  fi
  rm -rf "$tmp"
  # A downloaded framework carries com.apple.quarantine, and Gatekeeper refuses
  # to load a quarantined unsigned bundle — the adapter would be present and
  # silently never work. This clears the flag on the component the user just
  # asked this installer to fetch from our own release, and nothing else.
  if have xattr; then xattr -dr com.apple.quarantine "$dir" 2>/dev/null || true; fi
  printf '%s  ✓ now-playing bridge installed%s\n' "$C_OK" "$C_OFF"
}
install_media_adapter

# ── 3c) macOS helper ─────────────────────────────────────────────────────────
# The macOS half of the Xenon Helper: the app switcher without a per-app
# Automation grant, the game probe, the global search hotkey and the Trash. Same
# optional contract as everything else here — without it those features fall
# back to osascript or are simply not offered.
#
# MIN_MAC_HELPER is the twin of $minVersion in server/helper-update.ps1 and is
# gated the same way: an installed helper below it is REPLACED, not kept. This
# used to be a bare "is the file there" test, which meant an existing install
# stayed on whatever helper it first downloaded forever — a new mode would ship
# and the only machines that ever saw it were fresh installs. There is no in-app
# helper update off Windows yet (helper-update.js checks the hash of the exe),
# so re-running the installer is the whole update path and it has to be able to
# move the version. Bump this with helper-mac/…/Version.swift whenever a mode
# is added or its answers change.
MIN_MAC_HELPER='0.5.0'

# Compare dotted versions without sort -V, which BSD sort does not have.
mac_helper_outdated() {
  local have_v="$1" want="$2" i h w
  local -a hp wp
  IFS='.' read -r -a hp <<< "$have_v"
  IFS='.' read -r -a wp <<< "$want"
  for i in 0 1 2; do
    h="${hp[$i]:-0}"; w="${wp[$i]:-0}"
    case "$h" in ''|*[!0-9]*) h=0 ;; esac
    case "$w" in ''|*[!0-9]*) w=0 ;; esac
    [ "$h" -lt "$w" ] && return 0
    [ "$h" -gt "$w" ] && return 1
  done
  return 1
}

install_mac_helper() {
  [ "$XENON_OS" = 'macos' ] || return 0
  local dir="$SERVER_DIR/helper" cur='' updating=0
  if [ -x "$dir/xenon-helper" ]; then
    cur="$("$dir/xenon-helper" --version 2>/dev/null | tr -d '[:space:]')"
    mac_helper_outdated "${cur:-0.0.0}" "$MIN_MAC_HELPER" || return 0
    updating=1
  fi
  have curl || return 0
  if [ "$updating" = 1 ]; then
    step "Updating the Xenon Helper (${cur:-unknown} → $MIN_MAC_HELPER)…"
  else
    step 'Installing the Xenon Helper…'
  fi
  local url='https://github.com/marcimastro98/Xenon/releases/latest/download/xenon-helper-macos.tar.gz'
  local tmp
  tmp="$(mktemp -d)" || return 0
  if ! curl -fsSL --retry 3 --max-time 180 -o "$tmp/helper.tar.gz" "$url"; then
    warn 'the Xenon Helper could not be downloaded; the app switcher and the search hotkey will use the fallbacks.'
    rm -rf "$tmp"; return 0
  fi
  # Unpacked into a staging directory, never straight over the installed one: an
  # archive that turns out to be truncated must not be able to take a working
  # helper with it, and on an update there IS one to lose.
  mkdir -p "$tmp/stage" "$dir"
  if ! tar -xzf "$tmp/helper.tar.gz" -C "$tmp/stage" || [ ! -f "$tmp/stage/xenon-helper" ]; then
    warn 'the Xenon Helper archive could not be extracted.'
    rm -rf "$tmp"; return 0
  fi
  # Remove before moving rather than overwriting in place. A running helper is
  # still executing from its own inode, so unlinking the name leaves the live
  # index and game probe alone until they next restart; writing over the file
  # would change the code signature underneath them, and macOS answers that by
  # killing the process outright (SIGKILL, observed on this port).
  rm -f "$dir/xenon-helper"
  if ! mv "$tmp/stage/xenon-helper" "$dir/xenon-helper"; then
    warn 'the Xenon Helper could not be installed.'
    rm -rf "$tmp"; return 0
  fi
  rm -rf "$tmp"
  chmod +x "$dir/xenon-helper" 2>/dev/null || true
  # Downloaded binaries carry com.apple.quarantine, and Gatekeeper refuses to
  # run a quarantined unsigned one — it would be present and never work.
  if have xattr; then xattr -dr com.apple.quarantine "$dir/xenon-helper" 2>/dev/null || true; fi
  printf '%s  ✓ Xenon Helper installed%s
' "$C_OK" "$C_OFF"
}
install_mac_helper

# ── 4) Register the login service ────────────────────────────────────────────
# Where the backend lives, written for Xenon.app to read. The app starts the
# backend itself (see below) and cannot ask launchd where it is once the agent
# stops naming node, so the install location is recorded here instead. Plain
# JSON, one key, rewritten on every run — it is a pointer, never state.
record_backend_location() {
  local dir="$HOME/Library/Application Support/Xenon"
  mkdir -p "$dir" || return 0
  printf '{\n  "entry": "%s",\n  "root": "%s"\n}\n' "$SERVER_DIR/server.js" "$ROOT_DIR" > "$dir/backend.json"
}

# Is the native app installed? It is what owns the backend on macOS.
find_xenon_app() {
  local p
  for p in "/Applications/Xenon.app" "$HOME/Applications/Xenon.app"; do
    [ -d "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

# Undo a half-made macOS registration. The plist is written BEFORE launchctl is
# asked to load it, so a refusal used to leave it on disk while `fail` told the
# user nothing had been changed — untrue, and worse than untrue: that leftover is
# the "backend installed" marker, so the app's first-launch bootstrap would find
# it, believe the install had happened and refuse to try again.
drop_mac_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  rm -f "$PLIST"
}

# The login item that launches XENON.APP, which then starts the backend as its
# own child.
#
# This is not a lifecycle preference, it is the only way the backend can read
# the user's files. macOS attributes file-access permission to the RESPONSIBLE
# process, and a child's responsible process is its parent. Started by launchd
# the backend is responsible for itself, so Full Disk Access would have to be
# granted to `node` — an interpreter, which would carry that grant into every
# unrelated script the user ever runs. Started by the app it inherits Xenon's
# own grant: one entry the user recognises, and one they can revoke.
#
# Measured on a real Mac, same machine, same helper: the launchd-run backend saw
# 253,519 files / 90.5 GB of the home directory; run under the app's grant it
# saw 410,413 / 105.4 GB. The Trash and most of ~/Library/Caches were invisible,
# so the cleanup categories came back empty and the disk map under-reported.
register_macos_app_agent() {
  local app="$1"
  mkdir -p "$HOME/Library/LaunchAgents" "$MAC_LOG_DIR"
  # `open -a` and not the bundle executable: LaunchServices is what gives the
  # process its bundle identity, which is what the permission is attached to.
  # It also exits immediately, so there is deliberately no KeepAlive here —
  # macOS does not restart GUI apps, and a KeepAlive on a command that always
  # exits cleanly would spin.
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>$app</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$MAC_LOG_DIR/backend.log</string>
  <key>StandardErrorPath</key>
  <string>$MAC_LOG_DIR/backend.err.log</string>
</dict>
</plist>
PLIST_EOF
  local gui="gui/$(id -u)"
  launchctl bootout "$gui/$LABEL" >/dev/null 2>&1
  if ! launchctl bootstrap "$gui" "$PLIST" >/dev/null 2>&1 \
    && ! launchctl load -w "$PLIST" >/dev/null 2>&1; then
    drop_mac_agent
    fail "launchctl refused to load $PLIST."
  fi
  open -a "$app" >/dev/null 2>&1 || true
}

# Set by register_macos so the caller knows which chain it is waiting on: the
# app path has several more links and needs a longer window.
MAC_SERVICE_KIND='launchd'

register_macos() {
  record_backend_location
  local app
  if app="$(find_xenon_app)"; then
    register_macos_app_agent "$app"
    MAC_SERVICE_KIND='launchd-app'
    return 0
  fi
  # No app: fall back to running node under launchd, which is what this did
  # before the app existed. It works, and it is honest about what it costs —
  # the folders macOS protects stay invisible until the app is installed.
  warn 'Xenon.app is not installed: starting the backend directly.'
  warn 'The Trash and some caches will not be scanned until you install the app'
  warn 'from the .dmg and grant it Full Disk Access.'
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
  if ! launchctl bootstrap "$gui" "$PLIST" >/dev/null 2>&1 \
    && ! launchctl load -w "$PLIST" >/dev/null 2>&1; then
    drop_mac_agent
    fail "launchctl refused to load $PLIST."
  fi
  launchctl kickstart "$gui/$LABEL" >/dev/null 2>&1
}

# Undo a systemd registration completely. Falling through to the autostart
# fallback while leaving a disabled unit behind would give the next
# update-apply.sh two plausible ways to start the server and let it pick the one
# that was never enabled.
drop_linux_unit() {
  systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1
  systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1
  rm -f "$UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1
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
  #
  # ExecStart is QUOTED. It is a command line, so systemd splits it on
  # whitespace: an install under "/home/u/My Apps/xenon" became `node /home/u/My`
  # and the backend never started again after the first reboot. WorkingDirectory
  # takes the rest of the line as one path and needs no quotes.
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Xenon dashboard backend
Documentation=https://github.com/marcimastro98/Xenon
After=graphical-session.target network.target

[Service]
Type=simple
ExecStart="$NODE_BIN" "$SERVER_DIR/server.js"
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
  # Every failure below unwinds the registration completely — see drop_linux_unit.
  if ! systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 \
    || ! systemctl --user restart "$UNIT_NAME" >/dev/null 2>&1; then
    drop_linux_unit
    return 1
  fi

  # `restart` on a Type=simple unit returns 0 as soon as the process is forked,
  # so its exit code says nothing about whether the server survived being
  # started — which is why this function used to be incapable of returning 1 and
  # the XDG fallback below was unreachable. Give it a moment and ask systemd
  # what actually happened. `auto-restart` is the tell: at two seconds it means
  # the process has ALREADY exited once and RestartSec is counting, which a
  # healthy server never does.
  sleep 2
  case "$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null)" in
    failed|inactive) drop_linux_unit; return 1 ;;
  esac
  if [ "$(systemctl --user show -p SubState --value "$UNIT_NAME" 2>/dev/null)" = 'auto-restart' ]; then
    drop_linux_unit
    return 1
  fi
  return 0
}

register_linux_autostart() {
  # Fallback for a desktop without a systemd user manager (Devuan, Void, some
  # Alpine setups). An XDG autostart entry is the portable equivalent; it has no
  # crash-restart, which is stated rather than hidden.
  #
  # Exec is QUOTED for the same reason the unit's ExecStart is: it is a command
  # line the desktop splits on whitespace. This one was the worse of the two,
  # because the immediate `nohup` below IS quoted — so an install under a path
  # with a space came up fine and then silently never started again at the next
  # login. Path= takes the whole value and needs no quotes.
  mkdir -p "$AUTOSTART_DIR"
  cat > "$AUTOSTART" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=Xenon dashboard backend
Comment=Starts the local Xenon server on port $PORT
Exec="$NODE_BIN" "$SERVER_DIR/server.js"
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
  SERVICE_KIND="$MAC_SERVICE_KIND"
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
# The app path has more links in its chain than the direct one — launchd runs
# `open`, LaunchServices starts the app, the app polls the port before deciding
# nothing is there, and only then spawns node, which then boots. Forty seconds
# was tuned for `launchd → node` and reported a healthy install as a failure.
WAIT_SECS=40
[ "$SERVICE_KIND" = 'launchd-app' ] && WAIT_SECS=90
UP=0
for _ in $(seq 1 "$WAIT_SECS"); do
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
  # The app switcher only needs Automation on the fallback path. With the helper
  # in place it reads the window server directly and prompts for nothing, so
  # naming it here would train the user to expect a prompt that never comes.
  if [ ! -x "$SERVER_DIR/helper/xenon-helper" ]; then
    printf '  %s  Automation (System Events) — the app switcher widget%s\n' "$C_DIM" "$C_OFF"
  fi
  printf '  %s  Microphone                 — voice input%s\n' "$C_DIM" "$C_OFF"
  printf '  %s  Screen Recording           — the screenshot the AI can take%s\n\n' "$C_DIM" "$C_OFF"
  # Full Disk Access is the one macOS never PROMPTS for: it has to be granted by
  # hand, and until the app is signed it lapses at every update because the
  # permission is tied to a code signature that changes with each build. Saying
  # nothing here is what makes it invisible — a folder macOS refuses to list
  # reads as an empty one, so the Disk widget just quietly under-reports.
  if [ "$SERVICE_KIND" = 'launchd-app' ]; then
    printf '  %sOne permission macOS will NOT ask for — grant it by hand:%s\n' "$C_DIM" "$C_OFF"
    printf '  %s  System Settings > Privacy & Security > Full Disk Access%s\n' "$C_DIM" "$C_OFF"
    printf '  %s  Add Xenon, turn it on, then quit and reopen Xenon.%s\n' "$C_DIM" "$C_OFF"
    printf '  %s  Without it the Trash and most caches stay out of the Disk%s\n' "$C_DIM" "$C_OFF"
    printf '  %s  widget and out of search, with no error to tell you so.%s\n' "$C_DIM" "$C_OFF"
    printf '  %s  Redo it after every Xenon update until the app is signed:%s\n' "$C_DIM" "$C_OFF"
    printf '  %s  toggle it off and on, or remove it and add it again.%s\n\n' "$C_DIM" "$C_OFF"
  fi
else
  printf '  %sLinux support is experimental. Under a Wayland session the app%s\n' "$C_DIM" "$C_OFF"
  printf '  %sswitcher lists only apps running through Xwayland, and CPU%s\n' "$C_DIM" "$C_OFF"
  printf '  %stemperature comes from /sys/class/hwmon, which not every board%s\n' "$C_DIM" "$C_OFF"
  printf '  %sexposes. Run `npm run doctor` to see what your machine reads.%s\n\n' "$C_DIM" "$C_OFF"
fi

[ "$UP" = "1" ] || exit 1
exit 0

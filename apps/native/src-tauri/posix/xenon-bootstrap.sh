#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# xenon-bootstrap.sh — backend bootstrap for the Xenon app on macOS and Linux.
#
# The counterpart of windows/xenon-bootstrap.ps1. On Windows the NSIS
# post-install hook runs that script at install time; neither a .dmg nor an
# AppImage has an install hook, so this one is launched by the app itself (see
# spawn_backend_nudge in src/lib.rs) on the first launch that finds no backend
# at all. It turns the drag-to-Applications (or double-click-the-AppImage)
# install into a full one:
#
#   1. download the latest release source zip + its signed SHA256SUMS,
#   2. verify the zip (Ed25519, fail-closed, BEFORE extraction),
#   3. extract it into a canonical per-user install root,
#   4. run the normal backend installer (server/install.sh).
#
# Trust model is identical to the Windows bootstrap: the source zip is verified
# against the pinned Ed25519 public key below — the SAME key server/
# self-update.js and server/helper-update.js pin (rotating the signing key means
# updating ALL copies; see the rotation checklist in self-update.js). Node.js
# itself is fetched over TLS only, because on a first install there is nothing
# local to anchor more trust to. That gap is known and accepted until code
# signing lands.
#
# A .deb CAN run a post-install script, and this deliberately does not use one:
# a deb hook runs as root, and everything it would have to create — the login
# service, the install root, the data directory — belongs to ONE user's session.
# That is the same rule that keeps the Windows backend out of a session-0
# service. First launch is the only moment that knows whose Xenon this is.
#
# This terminal window IS the UI: every failure prints one clear line and waits.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

REPO='marcimastro98/Xenon'
PORT=3030
DASH_URL="http://127.0.0.1:$PORT/"
LABEL='com.marcimastro98.xenon.backend'

# Per-platform: where a fresh install goes, and what proves one already
# happened. Both roots are per-user, so self-updates can swap files without
# sudo, and both avoid cloud-synced folders (Desktop/Documents, ~/Dropbox).
# The markers are exactly what server/install.sh writes — the login service is
# the "backend installed" fact on every platform.
MARKER_AUTOSTART=''
case "$(uname -s)" in
  Darwin)
    XENON_OS='macos'
    OS_LABEL='Mac'
    INSTALL_ROOT="$HOME/Library/Application Support/Xenon"
    MARKER_SERVICE="$HOME/Library/LaunchAgents/$LABEL.plist"
    ;;
  Linux)
    XENON_OS='linux'
    OS_LABEL='computer'
    INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/Xenon"
    MARKER_SERVICE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/xenon-backend.service"
    # Either half of the Linux install story counts: the systemd --user unit, or
    # the XDG autostart entry install.sh falls back to where there is no user
    # manager. Missing one of them and reinstalling over it would leave two
    # backends fighting for port 3030.
    MARKER_AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/xenon-backend.desktop"
    ;;
  *)
    printf 'This installer supports macOS and Linux only.\n' >&2
    exit 1
    ;;
esac

C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[90m'; C_OFF=$'\033[0m'
step() { printf '%s==>%s %s\n' "$C_STEP" "$C_OFF" "$1"; }
fail() {
  printf '\n%s  %s%s\n' "$C_ERR" "$1" "$C_OFF"
  printf '%s  Nothing was changed on your %s beyond the Xenon app itself.%s\n' "$C_DIM" "$OS_LABEL" "$C_OFF"
  printf '%s  You can retry by reopening Xenon, or install manually:%s\n' "$C_DIM" "$C_OFF"
  printf '%s  https://github.com/%s#readme%s\n\n' "$C_DIM" "$REPO" "$C_OFF"
  read -r -p 'Press Enter to close this window ' _
  exit 1
}

printf '\n  %sXenon — completing your installation%s\n' "$C_STEP" "$C_OFF"
printf '  %sThe app you just installed is only the screen; this sets up the%s\n' "$C_DIM" "$C_OFF"
printf '  %sXenon dashboard itself (one time, a few minutes).%s\n\n' "$C_DIM" "$C_OFF"

# A GUI app's PATH is not a login shell's. Homebrew on macOS and the usual
# per-user bin dirs on Linux (nvm, ~/.local/bin) are where node actually is.
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && PATH="$p:$PATH" ;; esac
done
export PATH

# ── 0) Bail out when a backend already exists ────────────────────────────────
# Two independent signals, same shape as the Windows bootstrap: the login
# service is the "installed" marker, and anything answering on the port means a
# backend is live (a dev checkout, a manual start) that a second install would
# only fight for 3030.
if { [ -n "$MARKER_SERVICE" ] && [ -f "$MARKER_SERVICE" ]; } \
|| { [ -n "$MARKER_AUTOSTART" ] && [ -f "$MARKER_AUTOSTART" ]; }; then
  step 'The Xenon backend is already installed — nothing to do.'
  exit 0
fi
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/version" >/dev/null 2>&1; then
  step "A Xenon backend is already running on 127.0.0.1:$PORT — nothing to do."
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/xenon-bootstrap.XXXXXX")" || fail 'Could not create a temporary folder.'
cleanup() { rm -rf "$TMP" 2>/dev/null; }
trap cleanup EXIT

# ── 1) Locate the latest release ─────────────────────────────────────────────
step 'Looking up the latest Xenon release…'
RELEASE="$(curl -fsSL --max-time 25 -H 'User-Agent: XenonBootstrap' -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null)" \
  || fail 'Could not reach GitHub to find the latest release. Check your connection and retry.'
TAG="$(printf '%s' "$RELEASE" | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$TAG" ] || fail 'The latest release has no tag — please retry later.'
step "Latest release: $TAG"

# ── 2) Download the source zip + its signed checksums ────────────────────────
ZIP="$TMP/source.zip"
SUMS="$TMP/SHA256SUMS"
SIG="$TMP/SHA256SUMS.sig"

step 'Downloading Xenon…'
DOWNLOADED=0
for attempt in 1 2 3; do
  [ "$attempt" -gt 1 ] && { printf '%s  Retrying the download (attempt %s of 3)…%s\n' "$C_WARN" "$attempt" "$C_OFF"; sleep 5; }
  if curl -fsSL --max-time 300 -H 'User-Agent: XenonBootstrap' -o "$ZIP"  "https://github.com/$REPO/archive/refs/tags/$TAG.zip" \
  && curl -fsSL --max-time 60  -H 'User-Agent: XenonBootstrap' -o "$SUMS" "https://github.com/$REPO/releases/download/$TAG/SHA256SUMS" \
  && curl -fsSL --max-time 60  -H 'User-Agent: XenonBootstrap' -o "$SIG"  "https://github.com/$REPO/releases/download/$TAG/SHA256SUMS.sig"; then
    DOWNLOADED=1; break
  fi
done
[ "$DOWNLOADED" = "1" ] || fail 'The download failed.'

# ── 3) Ensure Node.js (needed to verify the download, and by Xenon itself) ───
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ "$XENON_OS" = 'macos' ] && command -v brew >/dev/null 2>&1; then
  step 'Installing Node.js with Homebrew (required by Xenon)…'
  brew install node || true
  NODE_BIN="$(command -v node || true)"
fi
# Deliberately NOT installing a package manager, or using one that needs sudo:
# on macOS installing Homebrew itself is a large, opinionated change to someone's
# machine, and on Linux apt/dnf/pacman would ask for a root password inside a
# window the user did not open for that. Point at the normal install instead.
if [ -z "$NODE_BIN" ]; then
  if [ "$XENON_OS" = 'macos' ]; then
    fail 'Node.js is required. Install it from https://nodejs.org (or run "brew install node"), then reopen Xenon.'
  else
    fail 'Node.js is required. Install it with your package manager (for example "sudo apt install nodejs npm") or from https://nodejs.org, then reopen Xenon.'
  fi
fi
step "Node.js: $NODE_BIN"

# ── 4) Verify the download (Ed25519 over SHA256SUMS, then hash the zip) ──────
# Runs in Node — the same primitive self-update.js uses, and the only Ed25519
# implementation guaranteed present once step 3 succeeded. Fail-closed: no valid
# signature, no install.
step 'Verifying the download signature…'
cat > "$TMP/verify.js" <<'VERIFY_EOF'
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const [zip, sums, sig] = process.argv.slice(2);
// Pinned Xenon release-signing public key (copy of UPDATE_PUBKEY_PEM in
// server/self-update.js — keep all copies in lockstep on rotation).
const PUB = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlH0Ju7LRPoy6sJlBwPHAhTCv1ck9RmPz9C2V1AzvOBk=
-----END PUBLIC KEY-----`;
let sumsBuf, sigB64;
try { sumsBuf = fs.readFileSync(sums); sigB64 = fs.readFileSync(sig, 'utf8').trim(); }
catch { console.error('integrity_missing'); process.exit(2); }
let ok = false;
try { ok = crypto.verify(null, sumsBuf, crypto.createPublicKey(PUB), Buffer.from(sigB64, 'base64')); }
catch { ok = false; }
if (!ok) { console.error('signature_invalid'); process.exit(3); }
let want = '';
for (const line of sumsBuf.toString('utf8').split(/\r?\n/)) {
  const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trim());
  if (m && m[2].trim() === 'source.zip') { want = m[1].toLowerCase(); break; }
}
if (!want) { console.error('integrity_missing'); process.exit(2); }
const got = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (got !== want) { console.error('integrity_mismatch'); process.exit(4); }
process.exit(0);
VERIFY_EOF

# The status must be captured from the call itself: inside `if ! cmd`, `$?` is
# the status of the negation (always 0), which would report every failure as
# "code 0" and hide which check refused.
"$NODE_BIN" "$TMP/verify.js" "$ZIP" "$SUMS" "$SIG"
VERIFY_RC=$?
if [ "$VERIFY_RC" -ne 0 ]; then
  fail "The downloaded files failed the integrity check (code $VERIFY_RC). This can happen right after a release is published — retry in a few minutes."
fi
step 'Signature verified.'

# ── 5) Extract into the install root (merge, never a mirror) ─────────────────
step "Installing to $INSTALL_ROOT…"
EXTRACT="$TMP/extract"
mkdir -p "$EXTRACT"
# unzip is standard on macOS and usual but not guaranteed on Linux; bsdtar
# (libarchive) reads zips too and ships on plenty of distros that skip unzip.
if command -v unzip >/dev/null 2>&1; then
  unzip -qq "$ZIP" -d "$EXTRACT" || fail 'The downloaded archive could not be extracted.'
elif command -v bsdtar >/dev/null 2>&1; then
  bsdtar -xf "$ZIP" -C "$EXTRACT" || fail 'The downloaded archive could not be extracted.'
else
  fail 'Unzipping needs "unzip" (or "bsdtar"). Install it with your package manager and reopen Xenon.'
fi
# GitHub wraps a tag archive in exactly one top-level directory.
SRC_ROOT=''
for d in "$EXTRACT"/*/; do
  [ -d "$d" ] || continue
  [ -n "$SRC_ROOT" ] && fail 'The downloaded archive has an unexpected layout.'
  SRC_ROOT="${d%/}"
done
[ -n "$SRC_ROOT" ] || fail 'The downloaded archive has an unexpected layout.'

mkdir -p "$INSTALL_ROOT"
# Merge, never --delete: an existing install's node_modules and any file the
# archive does not carry must survive. server/data is excluded defensively even
# though a source zip never contains it — which is also why `cp -a` is an
# acceptable stand-in where rsync is absent (a common minimal-Linux case): there
# is nothing in the source for the exclude to actually match.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude 'server/data/' "$SRC_ROOT"/ "$INSTALL_ROOT"/ \
    || fail "Copying Xenon into $INSTALL_ROOT failed."
else
  cp -a "$SRC_ROOT"/. "$INSTALL_ROOT"/ \
    || fail "Copying Xenon into $INSTALL_ROOT failed."
fi
mkdir -p "$INSTALL_ROOT/server/data"

# Seed the installed-file manifest so the FIRST self-update can already clean up
# files a newer version drops (see remove_stale_app_files in update-apply.sh).
"$NODE_BIN" -e '
  const fs = require("fs"), path = require("path");
  const [src, dataDir] = process.argv.slice(1);
  const files = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (r === "server/data" || r.startsWith("server/data/")) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  })(src, "");
  let version = "";
  try { version = String(JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version || ""); } catch {}
  const out = path.join(dataDir, "update-manifest.json");
  fs.writeFileSync(out + ".tmp", JSON.stringify({ version, at: new Date().toISOString(), files }));
  fs.renameSync(out + ".tmp", out);
' "$SRC_ROOT" "$INSTALL_ROOT/server/data" 2>/dev/null || true

# ── 6) Run the normal backend installer ──────────────────────────────────────
INSTALLER="$INSTALL_ROOT/server/install.sh"
[ -f "$INSTALLER" ] || fail 'install.sh is missing from the downloaded release.'
chmod +x "$INSTALLER" 2>/dev/null
step 'Running the Xenon installer…'
if ! bash "$INSTALLER"; then
  fail 'The Xenon installer did not complete. The output above says why.'
fi

printf '\n  %s---------------------------------------------------%s\n' "$C_DIM" "$C_OFF"
printf '  %sXenon is installed. The app window will come alive in a%s\n' "$C_OK" "$C_OFF"
printf '  %smoment; the dashboard is also at:%s\n' "$C_OK" "$C_OFF"
printf '    %s%s%s\n' "$C_OK" "$DASH_URL" "$C_OFF"
printf '  %s---------------------------------------------------%s\n\n' "$C_DIM" "$C_OFF"
read -r -p 'Press Enter to close this window ' _
exit 0

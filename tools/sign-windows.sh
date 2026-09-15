#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# sign-windows.sh — Authenticode-signs Windows binaries from Linux or macOS.
#
# The POSIX twin of tools/sign-windows.ps1. Same job, same certificate, same
# timestamp; a different tool underneath, because signtool is Windows-only.
# Here it is osslsigncode driving the SimplySign cloud key through PKCS#11:
# the private key stays in Certum's HSM and never reaches this machine, exactly
# as on Windows.
#
#   ./tools/sign-windows.sh dist/Xenon-Setup-x64.exe dist/xenon-helper.exe
#
# Configuration, all through the environment:
#
#   XENON_SIGN_PKCS11_MODULE   path to the SimplySign PKCS#11 library
#                              (required — see the search list below for where
#                              it usually lives)
#   XENON_SIGN_CERT_PEM        path to the certificate downloaded from Certum
#                              ("Download PEM" in the certificate view).
#                              Optional: without it the certificate is read
#                              from the token instead.
#   XENON_SIGN_PKCS11_CERT     PKCS#11 URI or label of the certificate on the
#                              token, when it holds more than one
#   XENON_SIGN_PKCS11_PIN      PIN, if the token asks for one
#   XENON_SIGN_TIMESTAMP_URL   RFC 3161 server (default: Certum's own)
#
# A SimplySign session must be OPEN before this runs: the virtual card only
# exists while SimplySign Desktop is logged in. Without it the module loads and
# reports no key, which is the most common failure here by a wide margin.
#
# Signing is done to a temporary file and the original is replaced only after
# the signature verifies, so a failed run never leaves a half-signed binary
# behind for a release to pick up.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

[ "$#" -gt 0 ] || die "usage: $0 <file> [file...]"

command -v osslsigncode >/dev/null 2>&1 || die \
  "osslsigncode is not installed.
  Debian/Ubuntu:  sudo apt install osslsigncode
  Fedora:         sudo dnf install osslsigncode
  Arch:           sudo pacman -S osslsigncode
  macOS:          brew install osslsigncode"

# The PKCS#11 library ships with SimplySign Desktop / proCertum CardManager and
# is never on a standard search path, so it is configured rather than guessed —
# but guessing first saves the common case.
MODULE="${XENON_SIGN_PKCS11_MODULE:-}"
if [ -z "$MODULE" ]; then
  for candidate in \
    /opt/proCertumSmartSign/libSimplySignPKCS11.so \
    /usr/lib/libcryptoki.so \
    /usr/lib64/libcryptoki.so \
    /usr/lib/x86_64-linux-gnu/libcryptoki.so \
    /usr/local/lib/libcryptoki.so \
    /opt/proCertumCardManager/libcryptoki.so \
    /Library/Frameworks/CryptoTokenKit.framework/libcryptoki.dylib
  do
    if [ -f "$candidate" ]; then MODULE="$candidate"; break; fi
  done
  # The CardManager bundle names it by version, e.g. sc30pkcs11-3.0.6.68-MS.so.
  if [ -z "$MODULE" ]; then
    MODULE=$(find /usr/lib /usr/local/lib /opt -maxdepth 3 \
      \( -name 'sc30pkcs11*' -o -name 'libSimplySignPKCS11*' \) 2>/dev/null | head -1 || true)
  fi
fi
[ -n "$MODULE" ] && [ -f "$MODULE" ] || die \
  "the SimplySign PKCS#11 library was not found.
  Install SimplySign Desktop, then point XENON_SIGN_PKCS11_MODULE at its
  PKCS#11 library, for example:
    export XENON_SIGN_PKCS11_MODULE=/usr/lib/libcryptoki.so
  Locate it with:  find / -iname '*pkcs11*' -o -iname '*cryptoki*' 2>/dev/null"

TIMESTAMP_URL="${XENON_SIGN_TIMESTAMP_URL:-http://time.certum.pl/}"

# Certificate: from a PEM when given (what Certum's "Download PEM" hands you),
# otherwise read off the token.
cert_args=()
if [ -n "${XENON_SIGN_CERT_PEM:-}" ]; then
  [ -f "$XENON_SIGN_CERT_PEM" ] || die "XENON_SIGN_CERT_PEM points at nothing: $XENON_SIGN_CERT_PEM"
  cert_args+=(-certs "$XENON_SIGN_CERT_PEM")
fi
if [ -n "${XENON_SIGN_PKCS11_CERT:-}" ]; then
  cert_args+=(-pkcs11cert "$XENON_SIGN_PKCS11_CERT")
fi
if [ -n "${XENON_SIGN_PKCS11_PIN:-}" ]; then
  cert_args+=(-pass "$XENON_SIGN_PKCS11_PIN")
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

for file in "$@"; do
  [ -f "$file" ] || die "nothing to sign at '$file'"
  out="$tmpdir/$(basename "$file")"

  # Three attempts: a timestamp server is a third party over plain HTTP and it
  # does go down, and losing a release to a five second outage is the worse
  # outcome. A signature without a timestamp is not an option — it would stop
  # validating the day the certificate expires, which since 27 February 2026 is
  # at most 459 days out.
  attempt=0
  until osslsigncode sign \
      -pkcs11module "$MODULE" \
      ${cert_args[@]+"${cert_args[@]}"} \
      -h sha256 \
      -ts "$TIMESTAMP_URL" \
      -in "$file" -out "$out"
  do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 3 ] || die "osslsigncode failed on '$file' after $attempt attempts"
    echo "  attempt $attempt failed, retrying in $((5 * attempt))s"
    sleep "$((5 * attempt))"
  done

  # Assert rather than trust, the same way the Windows script does: a build that
  # quietly lost its signature ships looking fine and spends the reputation of a
  # certificate it never used.
  osslsigncode verify -in "$out" >/dev/null || die "'$file' was signed but does not verify"

  mv "$out" "$file"
  echo "signed: $file"
done

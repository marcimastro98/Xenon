#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# sign-windows.sh — Authenticode-signs Windows binaries from Linux or macOS.
#
# The POSIX twin of tools/sign-windows.ps1. Same certificate, same timestamp, a
# different tool underneath, because signtool is Windows-only. Here it is
# osslsigncode driving the SimplySign cloud key through PKCS#11: the private
# key stays in Certum's HSM and never reaches this machine, exactly as on
# Windows.
#
#   ./tools/sign-windows.sh dist/Xenon-Setup-x64.exe dist/xenon-helper.exe
#
# THE PROVIDER, NOT THE ENGINE. OpenSSL offers two ways to reach a PKCS#11
# token and only one of them works here: the old libp11 *engine*
# (/usr/lib64/engines-3/pkcs11.so) segfaults against Certum's module while
# enumerating objects — with -login, with an explicit -pkcs11cert URI, with
# either of the two modules Certum installs, on osslsigncode 2.12. The OpenSSL
# 3 *provider* (pkcs11-provider) signs the same file first time. Anything here
# that looks redundant is load-bearing; changing it back to -engine brings the
# crash back.
#
# Requirements: osslsigncode, pkcs11-provider, and SimplySign Desktop with a
# session OPEN — the virtual card only exists while it is logged in.
#
# Configuration, all through the environment:
#
#   XENON_SIGN_PKCS11_MODULE   path to the SimplySign PKCS#11 library
#                              (auto-detected; see the search list below)
#   XENON_SIGN_CERT_PEM        the certificate CHAIN, leaf first, as a PEM.
#                              REQUIRED, and it must be the chain rather than
#                              the bare leaf that Certum's "Download PEM"
#                              hands you: with the leaf alone the signature
#                              carries no path to the issuer, and verification
#                              stops at "unable to get local issuer
#                              certificate". Build it once by concatenating
#                              the leaf and the CA certificates from the
#                              panel's "Subordinate certificates" section:
#                                cat leaf.pem code-signing-ca.pem > chain.pem
#                              Handing osslsigncode the certificate also means
#                              it never has to enumerate the token.
#   XENON_SIGN_KEY_URI         PKCS#11 URI of the private key. The default
#                              matches the only key on a code-signing token;
#                              override it from the `uri:` line that
#                              `pkcs11-tool --module <module> -O` prints for
#                              the Private Key Object.
#   XENON_SIGN_PKCS11_PIN      card PIN. Unset, the PIN is asked for at the
#                              terminal — which is right by hand and a hang in
#                              CI, so set it there.
#   XENON_SIGN_TIMESTAMP_URL   RFC 3161 server (default: Certum's own)
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
  Fedora:         sudo dnf install osslsigncode
  Debian/Ubuntu:  sudo apt install osslsigncode
  Arch:           sudo pacman -S osslsigncode
  macOS:          brew install osslsigncode"

# pkcs11-provider, not the libp11 engine. See the note at the top.
PROVIDER_FOUND=
for dir in /usr/lib64/ossl-modules /usr/lib/x86_64-linux-gnu/ossl-modules \
           /usr/lib/ossl-modules /opt/homebrew/lib/ossl-modules
do
  if [ -f "$dir/pkcs11.so" ] || [ -f "$dir/pkcs11.dylib" ]; then
    PROVIDER_FOUND=1
    break
  fi
done
[ -n "$PROVIDER_FOUND" ] || die \
  "the OpenSSL PKCS#11 provider is not installed.
  Fedora:         sudo dnf install pkcs11-provider
  Debian/Ubuntu:  sudo apt install pkcs11-provider
  macOS:          brew install pkcs11-provider
  (openssl-pkcs11, the older libp11 ENGINE, is not a substitute — it
  segfaults against this token.)"

# The PKCS#11 library ships with SimplySign Desktop and is never on a standard
# search path, so it is configured rather than guessed — but guessing first
# saves the common case.
MODULE="${XENON_SIGN_PKCS11_MODULE:-}"
if [ -z "$MODULE" ]; then
  for candidate in \
    /opt/SimplySignDesktop/SimplySignPKCS_64-MS-1.0.20.so \
    /opt/proCertumSmartSign/libSimplySignPKCS11.so \
    /usr/lib/libcryptoki.so \
    /usr/lib64/libcryptoki.so \
    /usr/local/lib/libcryptoki.so
  do
    if [ -f "$candidate" ]; then MODULE="$candidate"; break; fi
  done
  if [ -z "$MODULE" ]; then
    MODULE=$(find /opt /usr/lib /usr/local/lib -maxdepth 3 \
      \( -name 'SimplySignPKCS*' -o -name 'libSimplySignPKCS11*' -o -name 'sc30pkcs11*' \) \
      2>/dev/null | head -1 || true)
  fi
fi
[ -n "$MODULE" ] && [ -f "$MODULE" ] || die \
  "the SimplySign PKCS#11 library was not found.
  Install SimplySign Desktop, then point XENON_SIGN_PKCS11_MODULE at it:
    export XENON_SIGN_PKCS11_MODULE=/opt/SimplySignDesktop/SimplySignPKCS_64-MS-1.0.20.so
  Locate it with:  find / -iname '*pkcs11*' -o -iname '*cryptoki*' 2>/dev/null"

CERT_PEM="${XENON_SIGN_CERT_PEM:-}"
[ -n "$CERT_PEM" ] || die \
  "XENON_SIGN_CERT_PEM is not set.
  Build the certificate chain once — the leaf from the Certum panel's
  \"Download PEM\", then the CA certificates from its \"Subordinate
  certificates\" section — and point this at it:
    cat leaf.pem code-signing-ca.pem > ~/xenon-codesign-chain.pem
    export XENON_SIGN_CERT_PEM=~/xenon-codesign-chain.pem"
[ -f "$CERT_PEM" ] || die "XENON_SIGN_CERT_PEM points at nothing: $CERT_PEM"

KEY_URI="${XENON_SIGN_KEY_URI:-pkcs11:type=private}"
TIMESTAMP_URL="${XENON_SIGN_TIMESTAMP_URL:-http://time.certum.pl/}"

# A PIN on the command line lands in the shell history; asked for at the
# terminal it cannot, which is why that is the default.
pass_args=(-askpass)
if [ -n "${XENON_SIGN_PKCS11_PIN:-}" ]; then
  pass_args=(-pass "$XENON_SIGN_PKCS11_PIN")
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

export PKCS11_PROVIDER_MODULE="$MODULE"

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
      -provider pkcs11 \
      -certs "$CERT_PEM" \
      -key "$KEY_URI" \
      "${pass_args[@]}" \
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
  # This is also what catches an incomplete chain: signing succeeds with the
  # bare leaf, and only verification says "unable to get local issuer
  # certificate" — which is a signature Windows would have to go and complete
  # over the network, or reject.
  osslsigncode verify -in "$out" >/dev/null || die \
    "'$file' was signed but does not verify. If the reason is 'unable to get
  local issuer certificate', XENON_SIGN_CERT_PEM holds the bare leaf and needs
  to be the full chain — see the note at the top of this script."

  mv "$out" "$file"
  echo "signed: $file"
done

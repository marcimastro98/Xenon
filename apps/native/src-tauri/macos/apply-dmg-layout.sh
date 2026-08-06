#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# apply-dmg-layout.sh — give the built .dmg its Finder window layout.
#
# Tauri's DMG bundler runs create-dmg (bundle_dmg.sh) with --skip-jenkins, and
# that flag's own help text says what it costs: "This will result in a DMG
# without any custom background or icons positioning." So the shipped image had
# no .DS_Store at all, and Finder fell back to arranging the volume itself: the
# app ended up to the RIGHT of the Applications folder — the drag reads
# backwards — with no size or placement of our choosing, and any user who has
# hidden files visible also saw .VolumeIcon.icns sitting in the window.
#
# The obvious fix is to let create-dmg run its AppleScript, and that is the one
# thing not to depend on: it drives Finder, which needs a real GUI session and
# an Automation grant, and a CI runner has neither. When it fails, bundle_dmg.sh
# exits 64 and takes the whole release build with it.
#
# So the layout is decided ONCE, on a Mac, and committed as macos/dmg-DS_Store
# (stored under that name because .gitignore excludes .DS_Store, which is the
# point of the rule and not worth an exception). This script only copies that
# file into the image — no Finder, no AppleScript, no GUI session, same result
# on every machine. A .DS_Store addresses its items by NAME, so it keeps working
# as long as the volume holds "Xenon.app" and "Applications".
#
# To change the layout: mount a scratch HFS+ image named Xenon holding a
# Xenon.app and an Applications symlink, arrange the window in Finder, unmount,
# and copy the resulting .DS_Store over macos/dmg-DS_Store.
#
# Fail-closed on the ONLY thing that matters: the original .dmg is replaced at
# the very last step and only when every step before it succeeded. Any failure
# leaves the built image exactly as Tauri produced it, which is a shippable
# release with a plain window — never a corrupt one.
#
#   Usage: apply-dmg-layout.sh <path-to.dmg>
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

DMG="${1:-}"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  printf 'apply-dmg-layout: no such disk image: %s\n' "$DMG" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAYOUT="$HERE/dmg-DS_Store"
if [ ! -f "$LAYOUT" ]; then
  printf 'apply-dmg-layout: the committed layout is missing: %s\n' "$LAYOUT" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/xenon-dmg-layout.XXXXXX")" || {
  printf 'apply-dmg-layout: could not create a temporary folder\n' >&2
  exit 1
}
MNT="$TMP/mnt"

cleanup() {
  # Detach before deleting, or the temp directory takes a mounted image with it.
  hdiutil detach "$MNT" -force >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  printf 'apply-dmg-layout: %s — leaving the built image untouched\n' "$1" >&2
  exit 1
}

# A shipped .dmg is read-only and compressed; the layout has to be written into
# a read-write copy, which is then re-compressed.
hdiutil convert "$DMG" -format UDRW -o "$TMP/rw.dmg" >/dev/null 2>&1 ||
  fail 'could not convert the image to read-write'

# Mounted at a path of our own rather than under /Volumes: a volume called Xenon
# may already be mounted on the machine doing the build (an installer that is
# open, a previous run), and mounting a second one renames it to "Xenon 1".
mkdir -p "$MNT"
hdiutil attach "$TMP/rw.dmg" -nobrowse -noverify -noautoopen -mountpoint "$MNT" >/dev/null 2>&1 ||
  fail 'could not mount the read-write image'

[ -d "$MNT/Xenon.app" ] || fail 'the image does not contain Xenon.app'
[ -e "$MNT/Applications" ] || fail 'the image has no Applications link'

cp "$LAYOUT" "$MNT/.DS_Store" || fail 'could not write the layout into the image'

hdiutil detach "$MNT" >/dev/null 2>&1 || fail 'could not unmount the image'

hdiutil convert "$TMP/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$TMP/out.dmg" >/dev/null 2>&1 ||
  fail 'could not re-compress the image'

# Last step, and the only destructive one.
mv -f "$TMP/out.dmg" "$DMG" || fail 'could not replace the built image'

printf 'apply-dmg-layout: window layout applied to %s\n' "$(basename "$DMG")"

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Xenon — uninstall for macOS and Linux, the twin of UNINSTALL.bat.
#
# Removes Xenon: the app, the login service, the running server, your data and
# the install folder. It asks once before it touches anything, and it can be
# told to keep the parts you want to keep:
#
#   ./UNINSTALL.sh               remove everything (asks first)
#   ./UNINSTALL.sh --keep-data   keep server/data and the install folder
#   ./UNINSTALL.sh --keep-files  keep the install folder, remove the data
#   ./UNINSTALL.sh --dry-run     list what would go; change nothing
#   ./UNINSTALL.sh --yes         skip the confirmation (for scripts)
#
# On macOS you can double-click UNINSTALL.command instead, which runs this.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1

if [ ! -f server/uninstall.sh ]; then
  printf '\n  server/uninstall.sh is missing — run this from the Xenon folder.\n\n' >&2
  exit 1
fi

bash server/uninstall.sh "$@"
status=$?

if [ "$status" -ne 0 ] && [ -t 0 ]; then
  printf '\n  Uninstall did not finish. The message above says why.\n'
  printf '  Press Enter to close.\n'
  read -r _
fi

exit $status

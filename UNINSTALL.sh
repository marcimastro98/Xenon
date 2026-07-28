#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Xenon — uninstall for macOS and Linux, the twin of UNINSTALL.bat.
#
# Removes the login service and stops the backend. Your settings, layouts,
# notes and Deck profiles are KEPT unless you ask for them to go:
#
#   ./UNINSTALL.sh                only the service and the running server
#   ./UNINSTALL.sh --purge-data   also delete server/data (irreversible)
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

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Xenon — one-click install for macOS and Linux, the twin of INSTALL.bat.
#
# The real installer is server/install.sh and always has been. This exists
# because the repository root did not name an entry point for anything but
# Windows: someone who downloads the source sees INSTALL.bat, INSTALL.bat only,
# and has no reason to believe there is something here for them. A file you have
# to go looking for is, for most people, a file that is not there.
#
# On macOS you can also double-click INSTALL.command in Finder, which is this
# same script under an extension Finder is willing to execute.
#
# Arguments are passed straight through, so anything server/install.sh accepts
# works here too.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1

if [ ! -f server/install.sh ]; then
  printf '\n  server/install.sh is missing — run this from the Xenon folder.\n\n' >&2
  exit 1
fi

bash server/install.sh "$@"
status=$?

# Hold the window open on failure, the way INSTALL.bat pauses. A double-clicked
# Terminal window is no use to anyone if the error scrolls past and the shell
# exits; on success install.sh has already printed everything worth reading.
if [ "$status" -ne 0 ] && [ -t 0 ]; then
  printf '\n  Installation did not finish. The message above says why.\n'
  printf '  Press Enter to close.\n'
  read -r _
fi

exit $status

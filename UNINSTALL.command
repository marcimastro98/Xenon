#!/usr/bin/env bash
# The double-clickable face of UNINSTALL.sh — see INSTALL.command for why the
# extension has to exist. Pass --keep-data to keep your settings and notes.
#
# It also closes its own Terminal window when the uninstall succeeded. Terminal
# leaves a finished window on screen with "[Process completed]" in it, and after
# an uninstall that reads as if something is still running — the last thing left
# on the screen being a window belonging to the app you just removed. The window
# is identified by the tty this shell is attached to, so another Terminal window
# of the user's is never touched.
dir="$(dirname "$0")"
bash "$dir/UNINSTALL.sh" "$@"
status=$?
[ "$status" -eq 0 ] || exit "$status"

tty_path="$(tty 2>/dev/null)"
if [ "$(uname -s)" = 'Darwin' ] && [ "${TERM_PROGRAM:-}" = 'Apple_Terminal' ] &&
   [ -n "$tty_path" ] && [ -z "${XENON_NO_CLOSE:-}" ]; then
  osa="$(mktemp -t xenon-close.XXXXXX 2>/dev/null)"
  if [ -n "$osa" ]; then
    cat > "$osa" <<APPLESCRIPT
tell application "Terminal"
  repeat with w in windows
    try
      if tty of (selected tab of w) is "$tty_path" then close w
    end try
  end repeat
end tell
APPLESCRIPT
    printf '  Closing this window…\n\n'
    # Delayed and detached: closing a window whose shell is still running makes
    # Terminal stop to ask whether to terminate it, which is the exact prompt
    # this is meant to spare the user. By the time it fires this shell is gone.
    nohup bash -c "sleep 2; /usr/bin/osascript '$osa' >/dev/null 2>&1; rm -f '$osa'" \
      >/dev/null 2>&1 &
  fi
fi

exit 0

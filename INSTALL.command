#!/usr/bin/env bash
# Finder runs a .command on a double-click and refuses to run a .sh — it opens
# that in a text editor instead. So this is the extension and nothing else:
# INSTALL.sh is the script, and there is deliberately no second copy of it here
# to drift out of step.
exec bash "$(dirname "$0")/INSTALL.sh" "$@"

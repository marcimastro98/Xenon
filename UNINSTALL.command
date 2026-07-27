#!/usr/bin/env bash
# The double-clickable face of UNINSTALL.sh — see INSTALL.command for why the
# extension has to exist. Pass --purge-data to also delete your settings.
exec bash "$(dirname "$0")/UNINSTALL.sh" "$@"

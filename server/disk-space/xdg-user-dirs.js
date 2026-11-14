'use strict';
// Reads the folders a Linux desktop names in user-dirs.dirs, so that a Documents folder with a
// translated name is protected like the English one.

// Pure parser for ~/.config/user-dirs.dirs (xdg-user-dirs). Exported so the
// rule that protects a non-English user's real document folder is unit-tested
// on every platform, not only where the file exists.
// Returns { documents, pictures, desktop, ... } with absolute paths.
function parseXdgUserDirs(text, home) {
  const out = {};
  const sep = '/';
  const homeAbs = String(home || '').replace(/\/+$/, '');
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    // Shell assignments, one per line: XDG_DOCUMENTS_DIR="$HOME/Documenti"
    const m = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"(.*)"\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value === '$HOME' || value === '$HOME/') value = homeAbs;
    else if (value.startsWith('$HOME/')) value = homeAbs + sep + value.slice('$HOME/'.length);
    value = value.replace(/\/+$/, '');
    // Absolute only, and never the home directory itself: xdg-user-dirs writes
    // "$HOME" for a disabled entry, and protecting the whole home would leave
    // nothing cleanable at all.
    if (!value.startsWith(sep) || value === homeAbs) continue;
    out[m[1].toLowerCase()] = value;
  }
  return out;
}

module.exports = { parseXdgUserDirs };

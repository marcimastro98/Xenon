'use strict';
// Where the Tailscale program is looked for on each system.

// Where the CLI lives, per platform, in the order we prefer it. Everything below
// this list is platform-neutral: `tailscale status --json`, `up` and `cert` are
// the same commands with the same output on all three, so the path was the only
// thing tying this module to Windows.
//
// macOS has two shapes and both are real: the App Store / standalone app keeps
// its CLI inside the bundle, while Homebrew installs the open-source client into
// its own prefix (Apple Silicon and Intel differ). Linux packages land in
// /usr/bin; the official install script and manual installs use /usr/local/bin.
const EXE_CANDIDATES = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
};

function exeCandidates(platform) {
  return EXE_CANDIDATES[platform] || EXE_CANDIDATES.linux;
}

const EXE = EXE_CANDIDATES.win32[0];

module.exports = { EXE_CANDIDATES, exeCandidates, EXE };

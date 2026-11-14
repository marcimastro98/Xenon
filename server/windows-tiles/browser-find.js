'use strict';
// Finds a Chromium browser on this PC for the browser tile: the places Edge, Chrome and the
// others install to on each system.

const fs = require('node:fs');
const path = require('node:path');

// Where a Chromium that speaks CDP lives, per platform. The tile needs any
// Chromium — it drives it over the DevTools protocol and nothing here is
// Edge-specific — so the list is ordered by what is most likely to be present
// and best behaved, not by preference. Absolute paths only: resolving through
// PATH would accept whatever a shell profile happens to point at.
const BROWSER_CANDIDATES = {
  win32: () => [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ].filter(Boolean).map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),

  darwin: () => [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    // The same bundles installed for one user only.
    ...(process.env.HOME
      ? [
          `${process.env.HOME}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
          `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        ]
      : []),
  ],

  linux: () => [
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser',
    // Flatpak and snap ship their own launchers rather than a plain binary.
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    '/var/lib/flatpak/exports/bin/com.brave.Browser',
    '/var/lib/flatpak/exports/bin/com.microsoft.Edge',
    // …and the SAME apps installed for this user only, which the list missed:
    // `flatpak install --user` is the one route that needs no password at all,
    // so it is the likeliest way a browser got here, and it exports to $HOME
    // rather than /var/lib.
    ...(process.env.HOME
      ? [
          `${process.env.HOME}/.local/share/flatpak/exports/bin/org.chromium.Chromium`,
          `${process.env.HOME}/.local/share/flatpak/exports/bin/com.google.Chrome`,
          `${process.env.HOME}/.local/share/flatpak/exports/bin/com.brave.Browser`,
          `${process.env.HOME}/.local/share/flatpak/exports/bin/com.microsoft.Edge`,
        ]
      : []),
    '/snap/bin/chromium',
  ],
};

// Locate a Chromium to drive. Kept under the original name: every call site and
// every log line already says "edge", and renaming them would be a bigger diff
// than the feature.
function findEdge() {
  const list = BROWSER_CANDIDATES[process.platform];
  if (!list) return null;
  for (const exe of list()) {
    try { if (fs.existsSync(exe)) return exe; } catch (e) { /* unreadable path */ }
  }
  return null;
}

module.exports = { BROWSER_CANDIDATES, findEdge };

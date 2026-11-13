// Opens a file, a folder or a web address with the program the system uses for it, on Windows,
// macOS and Linux.

const { execFile } = require('node:child_process');
const { DECK_ACTIONS_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');

// Open a file, folder or URL with the system handler — the single place that
// answers "hand this to the desktop". On Windows it is deck-actions.ps1's `open`
// verb (Start-Process); macOS has `open` and Linux `xdg-open`, which do the same
// job natively. Every call is an argv array, never a shell string.
//
// Every caller that opens something on the user's behalf goes through here: the
// Deck registry, the Spotlight search results, Performance Mode and the
// Start-Menu app launcher. Reaching for runPowerShellScript directly is how one
// of them ends up working on Windows and failing everywhere else.
//
// `args` (openApp only, already an argv array from the registry) are launch
// arguments for the program. On Windows they travel as base64 JSON so no quote or
// space in them can re-cut the PowerShell command line; the script rebuilds one
// correctly quoted line. On macOS they follow `--args`, which an app that is
// already running ignores (only `open -n` would start a second copy, and that
// breaks single-instance apps).
function openExternalPath(p, args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (process.platform === 'win32') {
    const packed = argv.length ? Buffer.from(JSON.stringify(argv), 'utf8').toString('base64') : '';
    return runPowerShellScript(DECK_ACTIONS_SCRIPT, packed ? ['open', p, packed] : ['open', p], 8000);
  }
  if (process.platform === 'darwin' && argv.length) {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-a', String(p), '--args', ...argv], { timeout: 8000 }, (err) => {
        if (err) reject(err); else resolve({ ok: true });
      });
    });
  }
  // `--` ends option parsing on macOS, so a file whose name begins with a dash
  // cannot become a flag. xdg-open has no such separator — it rejects `--` as an
  // unknown option — so Linux passes the path alone. Everything that reaches
  // here has already been validated: a path the registry proved exists, or an
  // http(s) URL. A stored path is absolute in practice, and a leading-dash
  // relative one degrades to xdg-open's own syntax error rather than anything
  // being run.
  const posix = process.platform === 'darwin'
    ? ['/usr/bin/open', ['--', String(p)]]
    : ['xdg-open', [String(p)]];
  return new Promise((resolve, reject) => {
    execFile(posix[0], posix[1], { timeout: 8000 }, (err) => {
      if (err) reject(err); else resolve({ ok: true });
    });
  });
}

module.exports = { openExternalPath };

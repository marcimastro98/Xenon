'use strict';
// Picks the part that knows this system's sign-in, the same three answers on every one:
//   signIn()      → { id, ageMs } | null   the sign-in this start of the engine belongs to
//   appAtSignIn() → boolean                the Xenon app opens at sign-in and shows the dashboard
//   canOpen()     → boolean                a browser can be opened from where the engine runs
// and two more that only some systems have, asked only where they are there:
//   oldLauncher() → boolean                the task older versions opened the browser with is still registered (Windows)
//   display()     → object | null          the session's display, once the desktop has one (Linux)
// A question the system cannot answer rejects, and the engine opens no tab.
// Picked here once, never by the callers.

/**
 * @param {string} platform
 * @returns {{ signIn: Function, appAtSignIn: Function, canOpen: Function } | null} null on a
 *   system the engine does not know how to ask
 */
function pickBackend(platform) {
  if (platform === 'win32') return require('./sign-in-windows.js');
  if (platform === 'darwin') return require('./sign-in-darwin.js');
  if (platform === 'linux') return require('./sign-in-linux.js');
  return null;
}

module.exports = { pickBackend };

// Where the Xenon app keeps its own start at sign-in on macOS and Linux, so the engine can
// tell that the app opens there and shows the dashboard itself.

const path = require('node:path');

// The app registers itself under its product name (apps/native: the autostart plugin).
const APP_ENTRY_NAME = 'Xenon';

/**
 * @param {string} platform
 * @param {{ home: string, env?: Record<string, string | undefined> }} where the user's folder and environment
 * @returns {string} the file of the app's sign-in entry, '' on a system where it is not a file
 */
function appSignInEntry(platform, { home, env = {} }) {
  if (!home) return '';
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'LaunchAgents', APP_ENTRY_NAME + '.plist');
  if (platform === 'linux') {
    return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'autostart', APP_ENTRY_NAME + '.desktop');
  }
  return '';
}

module.exports = { appSignInEntry };

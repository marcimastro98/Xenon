// Where the media scripts for Windows and the now-playing bridge for macOS sit.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const MEDIA_SCRIPT = path.join(SERVER_DIR, 'media.ps1');
const MEDIA_KEY_SCRIPT = path.join(SERVER_DIR, 'media-key.ps1');

// mediaremote-adapter — the macOS equivalent of the helper's media-serve, and
// optional in the same way: downloaded by the installer, gitignored, absent on
// a source checkout. Without it the media tile stays empty, which is what it
// did before macOS had a media path at all.
const MEDIAREMOTE_DIR = path.join(SERVER_DIR, 'mediaremote');

module.exports = { MEDIA_SCRIPT, MEDIA_KEY_SCRIPT, MEDIAREMOTE_DIR };

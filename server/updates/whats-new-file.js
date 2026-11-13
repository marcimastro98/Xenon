// Where the file with the news of this version sits.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

// ── What's New (curated highlights for the RUNNING version) ─────────────────
// Distinct from the update-available modal (which nags users who are BEHIND with
// the remote release notes). This announces the headline features of the version
// the user is ALREADY on. Content is authored by hand in server/whatsnew.json and
// shipped with the build, so it always matches the running version and works
// offline. The client shows it until the user closes its `id`, and it only
// reappears when a later build ships a NEW `id`: patches and minors keep the `id`
// and tell their fixes through `releases` (js/release-notice.js). Text fields may be a plain string OR a { <lang>: string } map; the client picks the
// UI language with an English fallback. Media is GitHub-hosted only (same
// allowlist as the release-notes media).
const WHATSNEW_FILE = path.join(SERVER_DIR, 'whatsnew.json');

module.exports = { WHATSNEW_FILE };

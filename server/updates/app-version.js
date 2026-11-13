// The version of this build, read once from package.json when the engine starts, always without
// a leading v.

// App version — read once from package.json so the in-app indicator always
// matches the shipped build. Falls back gracefully if the file is unreadable.
let APP_VERSION = '';
// Normalize away a stray leading "v" so the reported version is always plain
// semver (e.g. "3.2.6"). A "v"-prefixed package.json version once shipped and
// broke self-update: the staged build's "v3.2.6" never equalled the normalized
// release tag "3.2.6", so prepare failed with version_mismatch (and the modal
// showed "from vv3.2.4"). Stripping here keeps /version and /update/check clean
// regardless of what package.json holds.
try { APP_VERSION = String(require('../../package.json').version || '').trim().replace(/^v/i, ''); } catch {}

module.exports = { APP_VERSION };

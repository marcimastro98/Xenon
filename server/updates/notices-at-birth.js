// A new install has nothing to catch up on: the What's New sheet and the release notes of
// the version it was installed with are marked read when its settings are first written
// (seedFreshInstall in server.js), so its first start shows neither, on the dashboard and in
// widgets only alike (both read these two settings), and the notes start with the next update.

const { APP_VERSION } = require('./app-version.js');
const { loadWhatsNew } = require('./whats-new-read.js');

async function noticesReadAtBirth(load = loadWhatsNew, version = APP_VERSION) {
  const wn = await load().catch(() => null);
  return {
    ...(wn?.id ? { whatsNewSeen: wn.id } : {}),
    ...(typeof version === 'string' && version ? { releaseNotesSeen: version.slice(0, 32) } : {}),
  };
}

module.exports = { noticesReadAtBirth };

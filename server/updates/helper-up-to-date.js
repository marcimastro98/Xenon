// Keeps the helper program in step with the engine: fetches it on a carried install's first
// start and replaces an old one after an update.

const startupLog = require('../startup-log.js');
const fs = require('node:fs');
const path = require('node:path');
const audioLevels = require('../audio-levels.js');
const {
  createHelperUpdate, HELPER_ASSET, HELPER_ASSET_MAC, MIN_MAC_HELPER,
} = require('../helper-update.js');
const { runHelperFirstInstall } = require('../helper-first-install.js');
const { APP_VERSION } = require('./app-version.js');
const { HELPER_REFRESH_MAX_TRIES, HELPER_REFRESH_RETRY_MS } = require('./check-values.js');
const { HELPER_EXE } = require('../engine/paths.js');
const { DATA_DIR } = require('../engine/paths.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { refreshAudioLevelsWatch } = require('../audio/levels-wanted.js');

const HELPER_CHECK_MARKER = path.join(DATA_DIR, 'helper-checked.txt');

// A helper that just arrived: this version counts as checked, and meters that gave up start fresh now.
function helperArrived() {
  writeFileAtomic(HELPER_CHECK_MARKER, APP_VERSION).catch(() => {});
  audioLevels.reset();
  refreshAudioLevelsWatch();
}
function ensureHelperUpToDate(attempt = 1) {
  const asset = { win32: HELPER_ASSET, darwin: HELPER_ASSET_MAC }[process.platform]; // Linux has no helper
  if (!asset || !APP_VERSION) return;
  try {
    if (!fs.existsSync(HELPER_EXE)) { // declined or never arrived: never surprise-download, except a carried install's first start
      if (attempt === 1) runHelperFirstInstall({ dataDir: DATA_DIR, install: () => createHelperUpdate({ helperExe: HELPER_EXE, appVersion: APP_VERSION, asset }).install(), log: (l) => startupLog.write(l), onInstalled: helperArrived }).catch(() => {});
      return;
    }
    let marked = '';
    try { marked = fs.readFileSync(HELPER_CHECK_MARKER, 'utf8').trim(); } catch { /* first run */ }
    if (marked && marked === APP_VERSION) return; // already ensured for this version
    createHelperUpdate({ helperExe: HELPER_EXE, appVersion: APP_VERSION, asset, minVersion: asset === HELPER_ASSET_MAC ? MIN_MAC_HELPER : '' }).refresh().then(status => {
      // Terminal for this app version → record it so we don't re-check until the next
      // update. 'skip-not-latest' = the app isn't on the latest release, so pulling
      // latest's helper could pair a newer helper with an older server; leave it.
      const done = status === 'up-to-date' || status === 'installed'
        || status === 'skip-not-latest' || status === 'no-helper';
      if (done) { writeFileAtomic(HELPER_CHECK_MARKER, APP_VERSION).catch(() => {}); return; }
      // Transient (assets not attached yet, network, hash mismatch): retry this session,
      // then at the next boot (the marker stays unwritten).
      if (attempt < HELPER_REFRESH_MAX_TRIES) {
        setTimeout(() => { try { ensureHelperUpToDate(attempt + 1); } catch { /* ignore */ } }, HELPER_REFRESH_RETRY_MS).unref();
      }
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

module.exports = { HELPER_CHECK_MARKER, helperArrived, ensureHelperUpToDate };

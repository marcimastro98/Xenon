// Puts the capture program of this system in place for this version, and asks it what it can
// do.

const fs = require('node:fs');
const { CAPTURE_EXE } = require('./capture-exe.js');
const { _captureHost } = require('./capture-engine-host.js');
const {
  createHelperUpdate, CAPTURE_ASSET, CAPTURE_ASSET_MAC, CAPTURE_ASSET_LINUX,
} = require('../updates/helper-update.js');
const { APP_VERSION } = require('../updates/app-version.js');
const { HELPER_REFRESH_MAX_TRIES, HELPER_REFRESH_RETRY_MS } = require('../updates/check-values.js');
const { writeFileAtomic } = require('../files/atomic-write.js');
const { CAPTURE_CHECK_MARKER } = require('../updates/capture-check-marker.js');

// Only where an engine can lag behind the server's list, or (Linux) where its
// answer is the only list (see capture-host.js).
function learnCaptureFeatures() {
  const asks = process.platform === 'darwin' || process.platform === 'linux';
  if (asks && _captureHost.available()) _captureHost.request('ping');
}
// The macOS and Linux engines are their own assets; once one is in place a ping
// tells the host what it can do (capture-host.js `has`). Linux: x86-64 only.
function ensureCaptureEngine(attempt = 1) {
  const linux = process.arch === 'x64' ? CAPTURE_ASSET_LINUX : null;
  const asset = { win32: CAPTURE_ASSET, darwin: CAPTURE_ASSET_MAC, linux }[process.platform];
  if (!asset || !APP_VERSION) return;
  try {
    let marked = '';
    try { marked = fs.readFileSync(CAPTURE_CHECK_MARKER, 'utf8').trim(); } catch { /* first run */ }
    const present = fs.existsSync(CAPTURE_EXE);
    if (present && marked === APP_VERSION) { learnCaptureFeatures(); return; }
    const up = createHelperUpdate({ helperExe: CAPTURE_EXE, appVersion: APP_VERSION, asset });
    (present ? up.refresh() : up.install()).then(status => {
      learnCaptureFeatures();
      const done = status === 'up-to-date' || status === 'installed' || status === 'skip-not-latest';
      if (done) { writeFileAtomic(CAPTURE_CHECK_MARKER, APP_VERSION).catch(() => {}); return; }
      if (attempt < HELPER_REFRESH_MAX_TRIES) {
        setTimeout(() => { try { ensureCaptureEngine(attempt + 1); } catch { /* ignore */ } }, HELPER_REFRESH_RETRY_MS).unref();
      }
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

module.exports = { learnCaptureFeatures, ensureCaptureEngine };

'use strict';

// The helper for an install the 5.1.0 setup made (apps/native/src-tauri/src/
// engine_install). That setup carries the engine and its Node and nothing that
// is downloaded, so the Xenon Helper, which the old installer fetched, is not
// there on the first start. It is fetched here ONCE, through the same verified
// path as the Settings button (helper-update.js: signed SHA256SUMS, pinned key,
// fail closed).
//
// Only for installs the shell made (install-mode.json says the engine was
// carried): a helper that was declined or removed on any other install is never
// downloaded behind the user's back, the rule ensureHelperUpToDate keeps.

const fs = require('fs');
const path = require('path');

const DONE_FILE = 'helper-first-install.txt';
const RETRY_MS = 3 * 60 * 1000; // the session's retries, like the boot refresh
const MAX_TRIES = 6;

function carriedInstall(dataDir, fsImpl) {
  try {
    const mode = JSON.parse(fsImpl.readFileSync(path.join(dataDir, 'install-mode.json'), 'utf8'));
    return !!mode && mode.engine === 'carried';
  } catch {
    return false;
  }
}

// opts: dataDir, install() -> Promise<status> (helper-update's install), log(line),
// onInstalled(); fsImpl and setTimeoutImpl for tests. Resolves the status, or
// 'skipped' when this is not a carried install or it already ran.
async function runHelperFirstInstall(opts, attempt = 1) {
  const fsImpl = opts.fsImpl || fs;
  const later = opts.setTimeoutImpl || setTimeout;
  const done = path.join(opts.dataDir, DONE_FILE);
  if (fsImpl.existsSync(done) || !carriedInstall(opts.dataDir, fsImpl)) return 'skipped';
  let status;
  try {
    status = await opts.install();
  } catch (e) {
    status = 'error';
  }
  opts.log(`helper first install (try ${attempt}): ${status}`);
  if (status === 'installed' || status === 'up-to-date') {
    fsImpl.writeFileSync(done, `${status}\n`);
    if (opts.onInstalled) opts.onInstalled();
  } else if (attempt < MAX_TRIES) {
    // Unwritten marker: a session that runs out of tries asks again at the next start.
    const timer = later(() => { runHelperFirstInstall(opts, attempt + 1).catch(() => {}); }, RETRY_MS);
    if (timer && timer.unref) timer.unref();
  }
  return status;
}

module.exports = { runHelperFirstInstall, DONE_FILE, MAX_TRIES };

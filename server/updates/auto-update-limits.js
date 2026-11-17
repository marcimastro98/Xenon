'use strict';
// The waits of the automatic updater, how many times a download is tried, and the download
// errors that trying again cannot fix.

const STARTUP_WINDOW_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const COUNTDOWN_MS = 60 * 1000;
const POSTPONE_MS = 60 * 60 * 1000;
const PREPARE_RETRY_MS = 60 * 60 * 1000;
const PREPARE_MAX_TRIES = 5;
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;

// A prepare failure that says the release itself is wrong. Retrying cannot fix
// it, so the version is treated like a failed install: manual only.
const PERMANENT_PREPARE_ERRORS = new Set([
  'signature_invalid', 'integrity_mismatch', 'version_mismatch', 'invalid_build', 'unexpected_archive',
]);


module.exports = {
  STARTUP_WINDOW_MS, FIRST_TICK_MS, TICK_MS, RECHECK_MS, COUNTDOWN_MS, POSTPONE_MS, PREPARE_RETRY_MS,
  PREPARE_MAX_TRIES, APPLY_TIMEOUT_MS, PERMANENT_PREPARE_ERRORS,
};

// Fixed values of the update check: where releases are, how often to look, and how often to
// retry updating the helper.

// ── Update check ──────────────────────────────────────────────────────────────
// Soft probe of the latest GitHub release so the dashboard can show a discreet
// "update available" hint in Settings. No token, never auto-downloads, and
// fail-silent: any network/API problem just means "no hint" until the next
// probe window. One probe serves every open dashboard.
const UPDATE_REPO = 'marcimastro98/Xenon';
const UPDATE_CHECK_TTL = 24 * 60 * 60 * 1000;   // reuse a successful probe for a day
const UPDATE_CHECK_RETRY = 60 * 60 * 1000;      // a failed probe retries after an hour
const UPDATE_NOTES_MAX = 8000;                  // cap the release-notes body we keep/serve

const AUTO_UPDATE_ASSUME_IDLE = process.env.XENON_AUTOUPDATE_ASSUME_IDLE === '1';

const HELPER_REFRESH_MAX_TRIES = 6;             // in-session retries before falling back to next boot
const HELPER_REFRESH_RETRY_MS = 3 * 60 * 1000;  // 3 min apart → ~15 min of coverage after the first try

module.exports = {
  UPDATE_REPO, UPDATE_CHECK_TTL, UPDATE_CHECK_RETRY, UPDATE_NOTES_MAX, AUTO_UPDATE_ASSUME_IDLE,
  HELPER_REFRESH_MAX_TRIES, HELPER_REFRESH_RETRY_MS,
};

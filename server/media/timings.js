// The waits of the music reader: how long an answer is reused, and how long to stay away from a
// reader that failed.

const MEDIA_HOST_RETRY_MS = 10000; // after a host death, poll one-shot for a while instead of respawn-storming
const MEDIA_HELPER_BAD_MS = 10 * 60 * 1000; // a helper exe that dies young (or is blind) is pinned out in favour of the PS host
const MEDIA_BLIND_STREAK = 3;          // consecutive empty helper polls before a PS cross-check
const MEDIA_CROSSCHECK_BASE_MS = 60000;   // first cross-checks: at most one PS spawn per minute
const MEDIA_CROSSCHECK_MAX_MS = 5 * 60000; // …backing off to no more than one every 5 min while idle

const MEDIA_CACHE_MS = 1200;
// A stuck media service answers only after its full timeout, and each try leaves another
// call open inside it: ask again in a while, not on every tick.
const MEDIA_READER_REST_MS = 30000;

// Each read of the sound rows is a process on Windows.
const SOUND_ROWS_REUSE_MS = 2500;

module.exports = {
  MEDIA_HOST_RETRY_MS, MEDIA_HELPER_BAD_MS, MEDIA_BLIND_STREAK, MEDIA_CROSSCHECK_BASE_MS,
  MEDIA_CROSSCHECK_MAX_MS, MEDIA_CACHE_MS, MEDIA_READER_REST_MS, SOUND_ROWS_REUSE_MS,
};

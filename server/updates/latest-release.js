// Asks GitHub which release is the newest and remembers the answer, for a day when it got one,
// so the screens can say when an update is out.

const {
  UPDATE_REPO, UPDATE_CHECK_TTL, UPDATE_CHECK_RETRY, UPDATE_NOTES_MAX,
} = require('./check-values.js');
const { resolveReleaseMedia } = require('./release-media.js');
const { releaseCache } = require('./release-cache.js');
const { parseSemver } = require('../semver.js');
const autoUpdateLib = require('../auto-update.js');

// Probe the latest GitHub release. `force` bypasses the cache (the manual
// "check now" button); otherwise a successful probe is reused for a day.
async function checkLatestRelease(force) {
  const now = Date.now();
  const ttl = releaseCache.found.ok ? UPDATE_CHECK_TTL : UPDATE_CHECK_RETRY;
  if (!force && releaseCache.found.at && now - releaseCache.found.at < ttl) return releaseCache.found;
  releaseCache.found = { at: now, ok: false, latest: '', tag: '', url: '', notes: '', name: '', publishedAt: '', noAuto: false, mediaTypes: {} };
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'XenonEdgeHub', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const rel = await res.json();
      const tag = String((rel && rel.tag_name) || '');
      if (parseSemver(tag)) {
        releaseCache.found = {
          at: now, ok: true, latest: tag.replace(/^v/i, ''), tag,
          url: String((rel && rel.html_url) || `https://github.com/${UPDATE_REPO}/releases/latest`),
          notes: String((rel && rel.body) || '').slice(0, UPDATE_NOTES_MAX),
          name: String((rel && rel.name) || tag),
          publishedAt: String((rel && rel.published_at) || ''),
          // Read from the WHOLE body, before the notes are capped: the marker
          // must work wherever in the notes it was written.
          noAuto: autoUpdateLib.hasNoAutoMarker(String((rel && rel.body) || '')),
          mediaTypes: {},
        };
        // Resolve embedded screenshots/videos (GitHub-hosted only). Best-effort —
        // a failed probe simply means those items render as links in the modal.
        try { releaseCache.found.mediaTypes = await resolveReleaseMedia(releaseCache.found.notes); } catch { /* keep {} */ }
      }
    }
  } catch { /* offline / rate-limited — retry next window */ }
  return releaseCache.found;
}

module.exports = { checkLatestRelease };

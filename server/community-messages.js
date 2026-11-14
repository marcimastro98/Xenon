'use strict';
// Hub messages — server-side fetch + validation for the announcement channel.
//
// A static JSON published with the project site (docs/community/messages.json),
// written by the hub's admin console through the same GitHub commit path as
// catalog.json. It carries release notes, "new in the Store" nudges, polls and
// the occasional note to supporters.
//
// The privacy shape is the point, so it is worth stating plainly: every message
// is delivered to EVERY install, and the `match` block is evaluated CLIENT-side
// (js/hub-messages.js) against what that dashboard already knows about itself.
// Nothing about the user is sent to get a targeted message, and the server
// cannot tell who saw what. That is why targeting exists at all — the correlation
// firewall around install-id.json (see version-ping.js) stays intact, and this
// module never touches an identifier. Do not "optimise" this into a per-install
// query; the feed being public is the feature.
//
// This module only VALIDATES shape and drops messages outside their date window.
// It deliberately does not interpret `match`.
//
// A message may also carry `media`: one picture or clip from the project's own
// asset host. It is validated here and it degrades rather than fails — a
// rejected media block leaves the message text-only, because artwork is never
// worth withholding an announcement over.
//
// Fetch shape mirrors community-catalog.js / ics-feeds.js (https-only conditional
// GET, bounded body, redirect cap, timeout, TTL cache + in-flight dedup) — the
// codebase convention for these fetchers is a documented mirror. If you harden
// one, harden all.
//
// Pure parts are exported for unit tests (server/test/community-messages.test.mjs).

require('./net-guard'); // nothing is taken from it here, but it runs code when it loads

const { MESSAGES_URL, fetchText } = require('./store-catalog/hub-message-fetch.js');

const MESSAGES_TTL_MS = 30 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const {
  MAX_MESSAGES, LEVELS, LINK_HOSTS, MEDIA_HOSTS, normalizeMatch, normalizeAction, normalizeMedia,
  normalizePoll, normalizeMessage, normalizeMessages,
} = require('./store-catalog/hub-message-clean.js');






const { filterVisibleMessages } = require('./store-catalog/hub-message-window.js');

function cacheIsFresh(cache, now, ttl = MESSAGES_TTL_MS) {
  return !!(cache && Array.isArray(cache.messages) && (now - cache.fetchedAt) < ttl);
}

// ── Cache (module-level, request-driven) ─────────────────────────────────────
// No periodic work: the feed is fetched only when a dashboard asks for it.
let _cache = null;      // { messages, fetchedAt, etag }
let _pending = null;    // in-flight dedup
let _lastForcedAt = 0;

async function fetchMessages(force) {
  const now = Date.now();
  if (_pending) return _pending;
  const doForce = force && (now - _lastForcedAt) >= REFRESH_MIN_INTERVAL_MS;
  if (doForce) _lastForcedAt = now;
  if (!doForce && cacheIsFresh(_cache, now)) {
    return { ok: true, messages: _cache.messages, cached: true };
  }
  _pending = (async () => {
    try {
      const resp = await fetchText(MESSAGES_URL, _cache && !doForce ? { etag: _cache.etag } : null);
      if (resp.notModified && _cache) {
        _cache.fetchedAt = Date.now();
        return { ok: true, messages: _cache.messages, cached: true };
      }
      let parsed;
      try { parsed = JSON.parse(resp.text || ''); } catch { throw new Error('bad messages JSON'); }
      const messages = normalizeMessages(parsed);
      _cache = { messages, fetchedAt: Date.now(), etag: resp.etag || '' };
      return { ok: true, messages, cached: false };
    } catch (e) {
      // Degrade to the last good copy when the network is down. An announcement
      // feed is never worth surfacing an error for.
      if (_cache) return { ok: true, messages: _cache.messages, cached: true, stale: true };
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), messages: [] };
    } finally {
      _pending = null;
    }
  })();
  return _pending;
}

// What the client should see: valid messages inside their date window.
async function fetchVisibleMessages(force) {
  const out = await fetchMessages(force);
  if (out && out.ok && Array.isArray(out.messages)) {
    return { ...out, messages: filterVisibleMessages(out.messages, Date.now()) };
  }
  return out;
}

module.exports = {
  fetchMessages,
  fetchVisibleMessages,
  // pure parts, for tests
  normalizeMessage,
  normalizeMessages,
  normalizeMatch,
  normalizeAction,
  normalizeMedia,
  normalizePoll,
  filterVisibleMessages,
  cacheIsFresh,
  MESSAGES_URL,
  MAX_MESSAGES,
  LEVELS,
  LINK_HOSTS,
  MEDIA_HOSTS,
};

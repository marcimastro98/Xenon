// What was already fetched about football (tables, searches, news, the clubs' crests and
// colours), how long each stays good, and where the clubs' details are kept.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

const _footballStandingsCache = new Map(); // bounded LRU: `${leagueId}|${season}` → { at, data }
const _footballSearchCache = new Map();    // bounded LRU: `query` → { at, results }
const _footballNewsCache = { at: 0, key: '', items: [], inflight: null };
const FOOTBALL_NEWS_TTL_MS = 15 * 60 * 1000;

// ── team identity (crest, colours, stadium) ──────────────────────────────────
// Identity barely changes, so it is fetched once per followed club and kept for
// a day — and persisted, because a restart that starts without crests is exactly
// the empty-looking widget this cache exists to prevent. `{ [teamId]: info }`
// plus a fetch stamp; the map rides along on /api/football and the SSE payload
// as an ADDED field (the teams[] shape is a public SDK stream, see WIDGET_SDK).
const FOOTBALL_INFO_FILE = path.join(DATA_DIR, 'football-info.json');
const FOOTBALL_INFO_TTL_MS = 24 * 60 * 60 * 1000;

module.exports = {
  _footballStandingsCache, _footballSearchCache, _footballNewsCache, FOOTBALL_NEWS_TTL_MS,
  FOOTBALL_INFO_FILE, FOOTBALL_INFO_TTL_MS,
};

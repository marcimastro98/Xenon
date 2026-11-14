'use strict';
// Reads what MPRIS players answer over D-Bus on Linux: their names, one player's track and
// state, and which player is the one to show.

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

// busctl wraps every reply in {type, data:[...]}, one entry per out-argument.
function unwrap(raw) {
  let j;
  try { j = JSON.parse(String(raw || '')); } catch { return null; }
  if (!j || !Array.isArray(j.data)) return null;
  return j.data[0];
}

function mprisNamesFrom(raw) {
  const names = unwrap(raw);
  if (!Array.isArray(names)) return [];
  // Unique: a player that owns both a well-known name and an instance-suffixed
  // one would otherwise be listed twice and poll twice.
  return [...new Set(names.filter((n) => typeof n === 'string' && n.startsWith(MPRIS_PREFIX)))];
}

// One {"type":..,"data":..} cell to a plain JS value. Variants nest, so a
// metadata dictionary arrives as cells of cells.
function cell(v) {
  if (v == null || typeof v !== 'object' || !('data' in v)) return v;
  const d = v.data;
  if (Array.isArray(d)) return d.map(cell);
  if (d && typeof d === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(d)) out[k] = cell(val);
    return out;
  }
  return d;
}

function propsFrom(raw) {
  const dict = unwrap(raw);
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return null;
  const out = {};
  for (const [k, v] of Object.entries(dict)) out[k] = cell(v);
  return out;
}

// The bus-name tail, which is the id playerctl reports and which js/media.js
// pattern-matches to recognise browsers. Keeping it identical is what lets the
// two sources feed the same downstream code.
function playerIdFrom(busName) {
  return String(busName || '').startsWith(MPRIS_PREFIX)
    ? String(busName).slice(MPRIS_PREFIX.length)
    : String(busName || '');
}

// xesam:artist is a LIST of strings in the spec, and every player follows it.
// Rendering the raw array would put "Primo,Secondo" (or worse, "[object
// Object]") under the track title.
function artistFrom(v) {
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.trim()).join(', ');
  return typeof v === 'string' ? v : '';
}

// Assemble the record shape linux-media.js's shapeNowPlaying already consumes.
// Values stay STRINGS of the raw microsecond numbers, exactly as playerctl
// prints them, so unitDivisor/seconds keep being the single place units are
// decided rather than two places that can drift apart.
function recordFrom(busName, player) {
  if (!player || typeof player !== 'object') return null;
  const meta = (player.Metadata && typeof player.Metadata === 'object') ? player.Metadata : {};
  const title = typeof meta['xesam:title'] === 'string' ? meta['xesam:title'] : '';
  const artist = artistFrom(meta['xesam:artist']);
  const album = typeof meta['xesam:album'] === 'string' ? meta['xesam:album'] : '';
  const status = typeof player.PlaybackStatus === 'string' ? player.PlaybackStatus : '';
  // A player that owns the bus name but has nothing loaded (a browser tab that
  // finished, a music app sitting at its library) is not a track. Reporting it
  // would pin the tile to a blank "now playing" that never clears.
  if (!title && !artist && !album && status !== 'Playing') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  return {
    player: playerIdFrom(busName),
    status,
    title,
    artist,
    album,
    length: num(meta['mpris:length']),
    position: num(player.Position),
    art: typeof meta['mpris:artUrl'] === 'string' ? meta['mpris:artUrl'] : '',
    // Kept internally for SetPosition. MPRIS requires the exact object path
    // of the track currently shown; substituting the player bus name is invalid
    // and can seek a newly-loaded track after a race.
    trackId: typeof meta['mpris:trackid'] === 'string' ? meta['mpris:trackid'] : '',
    canSeek: typeof player.CanSeek === 'boolean' ? player.CanSeek : null,
  };
}

// Which player the tile follows when several publish at once — a browser tab
// and a music app, typically. Playing beats paused beats stopped; ties keep the
// earlier one so the choice does not flip between polls on bus-name ordering.
const RANK = { Playing: 0, Paused: 1, Stopped: 2 };
function pickRecord(records) {
  const live = (records || []).filter(Boolean);
  if (!live.length) return null;
  let best = live[0];
  for (const r of live.slice(1)) {
    if ((RANK[r.status] ?? 3) < (RANK[best.status] ?? 3)) best = r;
  }
  return best;
}

// Two records differ in a way the dashboard should hear about. Position is
// excluded deliberately: it advances every poll, and treating that as a change
// would push an SSE event every two seconds for a track that is simply playing.
function recordChanged(a, b) {
  if (!a || !b) return a !== b;
  return a.player !== b.player || a.status !== b.status || a.title !== b.title ||
    a.artist !== b.artist || a.album !== b.album || a.art !== b.art;
}

module.exports = {
  MPRIS_PREFIX, unwrap, mprisNamesFrom, cell, propsFrom, playerIdFrom, artistFrom, recordFrom, RANK,
  pickRecord, recordChanged,
};

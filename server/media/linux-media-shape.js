'use strict';
// What playerctl prints on Linux turned into the now-playing shape the media tile reads, and a
// media command as playerctl's arguments.

const FIELDS = ['player', 'status', 'title', 'artist', 'album', 'length', 'position', 'art'];

// MPRIS PlaybackStatus is a closed enum in the spec. Mapping it explicitly
// rather than passing it through is what keeps liveMediaSnapshot's exact
// 'Playing' comparison working — and catches a player that invents a value.
const STATUS = { Playing: 'Playing', Paused: 'Paused', Stopped: 'Stopped' };

const COMMANDS = { playpause: 'play-pause', next: 'next', previous: 'previous' };

function commandArgs(action, position, player) {
  // Act on the player the tile is SHOWING, not on whichever playerctl's own
  // default resolution picks: hitting next on a paused browser tab while
  // Spotify plays is the bug this avoids (same guard linux-mpris.js carries).
  const selected = String(player || '').trim();
  const scope = selected ? ['--player', selected] : [];
  if (action === 'seek') {
    const seconds = Number(position);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const micros = Math.round(seconds * 1e6);
    if (!Number.isSafeInteger(micros)) return null;
    return [...scope, 'position', String(micros / 1e6)];
  }
  return Object.prototype.hasOwnProperty.call(COMMANDS, action)
    ? [...scope, COMMANDS[action]]
    : null;
}

// playerctl reports the bus name's tail: "spotify", "firefox", "chromium",
// "vlc". Only what would render badly is mapped; anything else is capitalised,
// which is right far more often than a lookup table would be.
const APP_NAMES = {
  spotify: 'Spotify',
  firefox: 'Firefox',
  chromium: 'Chromium',
  chrome: 'Chrome',
  brave: 'Brave',
  vlc: 'VLC',
  mpv: 'mpv',
  rhythmbox: 'Rhythmbox',
  elisa: 'Elisa',
  clementine: 'Clementine',
  audacious: 'Audacious',
  strawberry: 'Strawberry',
  amberol: 'Amberol',
  'io.bassi.Amberol': 'Amberol',
};

function appNameFor(player) {
  const raw = String(player || '').trim();
  if (!raw) return 'Media';
  // Chromium-family players append an instance number: "chromium.instance1234".
  const base = raw.split('.instance')[0];
  const key = base.toLowerCase();
  for (const [k, v] of Object.entries(APP_NAMES)) {
    if (key === k.toLowerCase()) return v;
  }
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// MPRIS says lengths and positions are MICROSECONDS, and playerctl passes the
// metadata through, so that is the default. Some builds have printed seconds
// for {{position}} instead, and guessing per value is not safe — 500000 is a
// plausible half-second in micros AND a plausible position in seconds. So the
// unit is decided ONCE per record from the track length, which is the field a
// real track always fills, and then applied to both: if reading it as
// microseconds yields a track under a second, it was seconds.
function unitDivisor(lengthRaw) {
  const n = Number(String(lengthRaw == null ? '' : lengthRaw).trim());
  if (!Number.isFinite(n) || n <= 0) return 1e6;
  return n / 1e6 >= 1 ? 1e6 : 1;
}

function seconds(raw, divisor) {
  const n = Number(String(raw == null ? '' : raw).trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return n / divisor;
}

// One `playerctl --follow` line into its fields. Returns null for anything that
// is not a full record, including playerctl's own "No players found" chatter.
function parseFollowLine(line) {
  const s = String(line == null ? '' : line).replace(/\r$/, '');
  if (!s.trim()) return null;
  const parts = s.split('\t');
  if (parts.length < FIELDS.length) return null;
  const out = {};
  FIELDS.forEach((name, i) => { out[name] = (parts[i] || '').trim(); });
  // A record with no player name is not a record; playerctl prints diagnostics
  // on stdout in some versions and they must never be read as a track.
  return out.player ? out : null;
}

// Artwork is a URL, and it is rendered as an <img src>. MPRIS players supply
// http(s) (browsers, Spotify) or file:// (local libraries); a file path cannot
// be served to the dashboard from here, so it is dropped rather than passed on
// as a link the page would silently fail to load. Anything else is refused
// outright — the scheme allowlist is the rule for every URL that becomes an
// attribute, not a formality.
function artUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

// Turn one record into the media object the rest of the app speaks. `sinceMs`
// is how long it has been held: --follow pushes on CHANGE, so a paused-then-
// resumed track would otherwise report the position it had minutes ago.
function shapeNowPlaying(rec, sinceMs) {
  if (!rec || typeof rec !== 'object' || !rec.player) {
    return {
      active: false, app: '', source: '', title: '', artist: '', album: '',
      playbackStatus: 'Closed', thumbnail: null, position: 0, duration: 0,
      sessions: [], selectionMode: 'auto',
    };
  }
  const status = STATUS[rec.status] || 'Unknown';
  const playing = status === 'Playing';
  const div = unitDivisor(rec.length);
  const duration = Math.round(seconds(rec.length, div));
  const elapsed = seconds(rec.position, div);
  const projected = playing ? elapsed + Math.max(0, sinceMs) / 1000 : elapsed;
  const exact = duration ? Math.min(duration, projected) : projected;
  const position = Math.round(exact);
  const app = appNameFor(rec.player);
  const info = {
    active: true,
    app,
    // The player's bus name is the stable id, the counterpart of Windows' AUMID
    // and macOS' bundle identifier. js/media.js pattern-matches it for browsers,
    // and "chromium"/"firefox"/"brave" satisfy that as they are.
    source: rec.player,
    title: rec.title || '',
    artist: rec.artist || '',
    album: rec.album || '',
    playbackStatus: status,
    thumbnail: artUrl(rec.art),
    position,
    positionMs: Math.round(exact * 1000),   // unrounded twin, for the lyrics clock
    duration,
    selectionMode: 'auto',
  };
  info.sessions = [{
    source: rec.player,
    app,
    title: info.title,
    artist: info.artist,
    album: info.album,
    playbackStatus: status,
    activePlayback: playing && !!(info.title || info.artist || app),
    position,
    duration,
    selected: true,
  }];
  return info;
}

module.exports = {
  FIELDS, STATUS, COMMANDS, commandArgs, APP_NAMES, appNameFor, unitDivisor, seconds,
  parseFollowLine, artUrl, shapeNowPlaying,
};

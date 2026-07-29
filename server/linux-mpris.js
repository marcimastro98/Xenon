'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// linux-mpris.js — now-playing straight off D-Bus, with nothing to install.
//
// linux-media.js reads MPRIS through playerctl, which is the right primary
// source: it pushes on change, so the media tile updates the instant a track
// does. But playerctl is a package almost nobody has by default, and without it
// the tile was simply empty — on a desktop where the data was sitting on the
// session bus the whole time.
//
// This is the same data, read directly. The transport is `busctl --json=short`
// for one reason worth stating: it is the only common D-Bus CLI that emits
// JSON. gdbus prints GVariant text, and hand-parsing that means writing a
// parser for a typed literal syntax where a track called "Don't, Stop" is
// quoting and commas inside a string. busctl hands over `{"type":"s","data":
// "Don't, Stop"}` and there is nothing left to get wrong.
//
// busctl ships with systemd, which Xenon's own autostart already requires — so
// on any machine where the dashboard starts at login, this works.
//
// It polls, where playerctl pushes. That is the honest trade for having no
// dependency, and it is why playerctl stays preferred when it is there.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const POLL_MS = 2000;          // how often the selected player is re-read
const NAMES_EVERY = 3;         // re-list the bus every third poll
const CALL_TIMEOUT_MS = 4000;

// ── pure parsing (exported for tests) ───────────────────────────────────────

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

const COMMAND_METHODS = { playpause: 'PlayPause', next: 'Next', previous: 'Previous' };

// ── runtime ─────────────────────────────────────────────────────────────────

function findBusctl(pathEnv) {
  const raw = pathEnv == null ? (process.env.PATH || '') : pathEnv;
  for (const dir of String(raw).split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'busctl');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

// The session bus lives behind XDG_RUNTIME_DIR, which systemd --user provides
// but a server started some other way may not have.
function busEnv() {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR) {
    try { env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`; } catch { /* no getuid */ }
  }
  return env;
}

function createLinuxMpris(o = {}) {
  const runner = typeof o.runner === 'function' ? o.runner : (bin, args) => new Promise((resolve) => {
    let p;
    try {
      p = execFile(bin, args, { timeout: CALL_TIMEOUT_MS, env: busEnv(), maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch { resolve(null); return; }
    p.on('error', () => resolve(null));
  });
  const locate = typeof o.findBusctl === 'function' ? o.findBusctl : findBusctl;
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
  const pollMs = Number(o.pollMs) > 0 ? Number(o.pollMs) : POLL_MS;

  let bin = null;
  let timer = null;
  let stopped = false;
  let busy = false;
  let ticks = 0;
  let names = [];
  let latest = { rec: null, at: 0 };

  function exe() {
    if (bin === null) bin = locate() || false;
    return bin || null;
  }

  function available() { return !!exe(); }

  const call = (dest, iface, method, ...args) =>
    runner(exe(), ['--user', '--json=short', 'call', dest, OBJECT_PATH, iface, method, ...args]);

  async function refreshNames() {
    const raw = await runner(exe(), ['--user', '--json=short', 'call',
      'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames']);
    names = mprisNamesFrom(raw);
  }

  async function readPlayer(name) {
    const player = propsFrom(await call(name, PROPS_IFACE, 'GetAll', 's', PLAYER_IFACE));
    return player ? recordFrom(name, player) : null;
  }

  async function tick() {
    if (busy || stopped || !exe()) return;
    busy = true;
    try {
      // The bus list changes only when a player starts or quits, so it is read
      // a third as often as the track itself.
      if (ticks % NAMES_EVERY === 0 || !names.length) await refreshNames();
      ticks++;
      const recs = names.length ? await Promise.all(names.map((n) => readPlayer(n).catch(() => null))) : [];
      const rec = pickRecord(recs);
      const changed = recordChanged(latest.rec, rec);
      latest = { rec, at: Date.now() };
      if (changed) { try { onChange(); } catch { /* never let a listener kill the poll */ } }
    } catch { /* a failed poll is "unchanged", not a crash */ } finally {
      busy = false;
    }
  }

  return {
    available,
    start() {
      if (timer || stopped || !exe()) return;
      tick();
      timer = setInterval(tick, pollMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
    latest: () => latest,
    async command(action, position) {
      if (action === 'seek') {
        const seconds = Number(position);
        if (!Number.isFinite(seconds) || seconds < 0) {
          return { ok: false, error: 'bad_position', seekProtocol: 1 };
        }
        if (!exe()) throw new Error('busctl is not available');
        const rec = latest.rec;
        if (!rec || !rec.trackId || !rec.trackId.startsWith('/') || rec.canSeek === false) {
          return { ok: false, error: 'not_seekable', seekProtocol: 1 };
        }
        const target = MPRIS_PREFIX + rec.player;
        const durationMicros = Number(rec.length);
        const requestedMicros = Math.round(seconds * 1e6);
        if (!Number.isSafeInteger(requestedMicros)) {
          return { ok: false, error: 'bad_position', seekProtocol: 1 };
        }
        const micros = Number.isFinite(durationMicros) && durationMicros > 0
          ? Math.min(requestedMicros, Math.round(durationMicros))
          : requestedMicros;
        const out = await call(
          target,
          PLAYER_IFACE,
          'SetPosition',
          'ox',
          rec.trackId,
          String(micros));
        if (out === null) {
          return { ok: false, error: 'not_seekable', seekProtocol: 1 };
        }
        latest = {
          rec: { ...rec, position: String(micros) },
          at: Date.now(),
        };
        try { onChange(); } catch { /* never let a listener kill the poll */ }
        return {
          ok: true,
          seekProtocol: 1,
          source: rec.player,
          app: '',
          position: micros / 1e6,
        };
      }

      const method = COMMAND_METHODS[action];
      if (!method) throw new Error(`unsupported media action "${action}"`);
      if (!exe()) throw new Error('busctl is not available');
      // Act on the player the tile is SHOWING, not on whichever answers first:
      // hitting next on a paused browser tab while Spotify plays is the bug
      // this avoids.
      const target = latest.rec ? MPRIS_PREFIX + latest.rec.player : names[0];
      if (!target) throw new Error('no MPRIS player is running');
      const out = await call(target, PLAYER_IFACE, method);
      if (out === null) throw new Error(`MPRIS ${method} failed`);
      // Re-read now so the caller's reply already reflects the new state
      // instead of the pre-command one.
      await tick();
      return true;
    },
  };
}

module.exports = {
  createLinuxMpris, mprisNamesFrom, propsFrom, recordFrom, pickRecord, recordChanged,
  playerIdFrom, artistFrom, findBusctl, cell, unwrap, MPRIS_PREFIX,
};

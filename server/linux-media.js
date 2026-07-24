'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// linux-media.js — now-playing and media transport on Linux.
//
// The fourth implementation of the contract server.js already had three times
// (xenon-helper's media-serve, media.ps1 -Serve, darwin-media.js): one
// long-lived child holding the OS's idea of what is playing, answering `info` /
// `playpause` / `next` / `previous`, and pushing when the track changes. Same
// keys, same units (seconds), same playbackStatus vocabulary — nothing above
// this file knows which platform produced it.
//
// Linux is the easy one of the three. Where macOS keeps now-playing behind a
// private framework that refuses to load into anything Apple did not sign, the
// Linux desktop publishes it on D-Bus as MPRIS: a public, versioned spec that
// Spotify, every browser, VLC, mpv and the GNOME/KDE players all implement.
// There is nothing to work around.
//
// playerctl is the shim, for the same reason wpctl and wmctrl are: it turns a
// D-Bus conversation into a line of text, which keeps this module a parser
// instead of a D-Bus client. It is optional like every other Linux tool here —
// without it the media tile stays empty, which is what it did before.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

// One field per line, tab-separated, in this order. Tabs are safe: the
// separator cannot appear inside a value because playerctl strips control
// characters from metadata, and a title containing one would only ever split
// into an extra field we drop.
const FORMAT = [
  '{{playerName}}',
  '{{status}}',
  '{{title}}',
  '{{artist}}',
  '{{album}}',
  '{{mpris:length}}',
  '{{position}}',
  '{{mpris:artUrl}}',
].join('\t'); // a REAL tab character, not the two-character escape: playerctl
              // passes format text through verbatim, so a backslash would
              // arrive as a backslash and every line would fail to split.

const FIELDS = ['player', 'status', 'title', 'artist', 'album', 'length', 'position', 'art'];

// MPRIS PlaybackStatus is a closed enum in the spec. Mapping it explicitly
// rather than passing it through is what keeps liveMediaSnapshot's exact
// 'Playing' comparison working — and catches a player that invents a value.
const STATUS = { Playing: 'Playing', Paused: 'Paused', Stopped: 'Stopped' };

const COMMANDS = { playpause: 'play-pause', next: 'next', previous: 'previous' };

function commandArgs(action) {
  return Object.prototype.hasOwnProperty.call(COMMANDS, action) ? [COMMANDS[action]] : null;
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
  const position = Math.round(duration ? Math.min(duration, projected) : projected);
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

const RESTART_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const YOUNG_MS = 15000;
const COMMAND_TIMEOUT_MS = 5000;
const MAX_BUFFER = 1 * 1024 * 1024; // art URLs only, never a payload

// Locate playerctl without spawning anything: a PATH walk is cheaper than a
// probe and cannot leave a child behind if the binary misbehaves.
function findPlayerctl() {
  const raw = process.env.PATH || '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'playerctl');
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable dir */ }
  }
  return null;
}

function createLinuxMedia(options) {
  const o = options || {};
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
  const exeOverride = o.exe || null;

  let proc = null;
  let buf = '';
  let stopped = false;
  let restartTimer = null;
  let failures = 0;
  let bornAt = 0;
  let latest = { rec: null, at: 0 };

  function exe() {
    return exeOverride || findPlayerctl();
  }

  function available() {
    return !!exe();
  }

  function handleLine(line) {
    const rec = parseFollowLine(line);
    if (!rec) return;
    latest = { rec, at: Date.now() };
    try { onChange(); } catch { /* never let a listener kill the host */ }
  }

  function retire() {
    const dead = proc;
    proc = null;
    buf = '';
    if (dead) { try { dead.kill(); } catch { /* already gone */ } }
    if (stopped) return;
    if (Date.now() - bornAt < YOUNG_MS) failures = Math.min(failures + 1, 8);
    else failures = 0;
    if (restartTimer) return;
    const delay = Math.min(RESTART_MS * (2 ** failures), MAX_BACKOFF_MS);
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
    restartTimer.unref();
  }

  function start() {
    if (stopped || proc) return;
    const bin = exe();
    if (!bin) return;
    let child;
    try {
      // --follow streams a line per change and exits when the last player goes
      // away, which the backoff above turns into a slow retry rather than a
      // spawn loop on a desktop with no media player running.
      child = spawn(bin, ['--follow', '--format', FORMAT, 'metadata'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { return; }
    proc = child;
    bornAt = Date.now();
    buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_BUFFER) { buf = ''; return; }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', () => {}); // "No players found" is normal
    child.on('error', () => { if (proc === child) retire(); });
    child.on('exit', () => { if (proc === child) retire(); });
    child.unref();
  }

  function stop() {
    stopped = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const dead = proc;
    proc = null;
    if (dead) { try { dead.kill(); } catch { /* already gone */ } }
  }

  function info() {
    if (!latest.rec) return shapeNowPlaying(null, 0);
    return shapeNowPlaying(latest.rec, Date.now() - latest.at);
  }

  // A control is a one-shot invocation: the --follow child holds the stream, it
  // takes no input. The answer is the pre-command snapshot; the stream pushes
  // the real change a moment later, and that push refreshes the widget.
  function command(action) {
    const args = commandArgs(action);
    if (!args) return Promise.reject(new Error(`unsupported media action "${action}"`));
    const bin = exe();
    if (!bin) return Promise.reject(new Error('playerctl is not installed'));
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: COMMAND_TIMEOUT_MS }, (err) => {
        if (err) reject(new Error(`playerctl ${args[0]} failed: ${err.message}`));
        else resolve(info());
      });
    });
  }

  return { available, start, stop, info, command };
}

module.exports = {
  createLinuxMedia,
  // exported for unit tests
  parseFollowLine, shapeNowPlaying, appNameFor, commandArgs, artUrl, unitDivisor, FORMAT, FIELDS,
};

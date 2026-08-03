'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// darwin-media.js — now-playing and media control on macOS.
//
// The third implementation of the same contract server.js already had twice
// (xenon-helper's media-serve and media.ps1 -Serve): one long-lived child that
// holds the OS's now-playing session and answers `info` / `playpause` / `next` /
// `previous` / `seek`, plus a push when the track changes. The shape it returns is the
// one media.ps1 defines and js/media.js consumes — same keys, same units
// (seconds), same playbackStatus vocabulary. Nothing above this file knows
// which platform produced it.
//
// WHY A CHILD PROCESS AT ALL. macOS keeps now-playing in the private
// MediaRemote framework, and since 15.4 loading it is denied to anything that
// is not an Apple-signed binary — so Node cannot read it, with or without an
// FFI. ungive/mediaremote-adapter (BSD-3-Clause, © 2025 Jonas van den Berg and
// contributors) is the standard way around that: a small framework loaded from
// inside /usr/bin/perl, which IS an Apple-signed system binary and therefore
// still entitled. We invoke its script; we do not link against anything.
//
// The adapter is NOT in this repository and is never built here. Like
// xenon-helper.exe it is downloaded into a gitignored directory
// (server/mediaremote/) by the installer, so a machine without it simply has no
// media tile — exactly what happened before this file existed. Absence is a
// supported state, never an error.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PERL = '/usr/bin/perl';
const SCRIPT_NAME = 'mediaremote-adapter.pl';
const FRAMEWORK_NAME = 'MediaRemoteAdapter.framework';

// MediaRemote command ids, from the adapter's own table. The three legacy
// transport actions use numeric `send` codes; seek uses the adapter's named
// verb below. An unknown action must never fall through to a number.
const COMMAND_CODES = { playpause: '2', next: '4', previous: '5' };

function commandCode(action) {
  return Object.prototype.hasOwnProperty.call(COMMAND_CODES, action)
    ? COMMAND_CODES[action]
    : null;
}

// The adapter's seek verb takes an absolute position in MICROSECONDS. Keep the
// conversion in one pure helper: it is unit-tested off macOS, and malformed
// values never reach an adapter command with surprising arguments.
function commandArgs(action, position) {
  if (action === 'seek') {
    const seconds = Number(position);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    // The adapter documents POSITION as a positive integer. Use one
    // microsecond for Xenon's logical zero so "back to start" remains valid;
    // the response still reports the requested/clamped logical position.
    const micros = Math.max(1, Math.round(seconds * 1e6));
    if (!Number.isSafeInteger(micros)) return null;
    return ['seek', String(micros)];
  }
  const code = commandCode(action);
  return code ? ['send', code] : null;
}

// The bundle identifier is macOS's answer to Windows' AUMID — a stable id we
// pass through as `source`, which js/media.js already pattern-matches for
// browsers (com.google.Chrome, org.mozilla.firefox and com.microsoft.edgemac
// all contain the substrings its BROWSER_SOURCE_RE looks for). This map only
// covers what the id alone would render badly.
const APP_NAMES = {
  'com.apple.Music': 'Music',
  'com.apple.TV': 'TV',
  'com.apple.podcasts': 'Podcasts',
  'com.apple.QuickTimePlayerX': 'QuickTime',
  'com.apple.Safari': 'Safari',
  'com.spotify.client': 'Spotify',
  'com.google.Chrome': 'Chrome',
  'com.microsoft.edgemac': 'Edge',
  'org.mozilla.firefox': 'Firefox',
  'com.brave.Browser': 'Brave',
  'com.operasoftware.Opera': 'Opera',
  'com.vivaldi.Vivaldi': 'Vivaldi',
  'com.colliderli.iina': 'IINA',
  'org.videolan.vlc': 'VLC',
  'tv.plex.desktop': 'Plex',
};

function appNameFor(bundleId) {
  const id = String(bundleId || '').trim();
  if (!id) return 'Media';
  if (APP_NAMES[id]) return APP_NAMES[id];
  // com.acme.SomePlayer → SomePlayer. Reverse-DNS ids put the human name last,
  // so the tail is the best guess when the map has nothing.
  const tail = id.split('.').filter(Boolean).pop() || id;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

// A stream line is `{"type":"data","diff":<bool>,"payload":{…}}`. Anything else
// on stdout (the adapter's own diagnostics) is ignored rather than guessed at.
function parseStreamLine(line) {
  const s = String(line || '').trim();
  if (!s || s[0] !== '{') return null;
  let env;
  try { env = JSON.parse(s); } catch { return null; }
  if (!env || env.type !== 'data' || typeof env !== 'object') return null;
  const payload = (env.payload && typeof env.payload === 'object') ? env.payload : {};
  return { diff: env.diff === true, payload };
}

// The adapter reports durations either as seconds or, under --micros, as
// <name>Micros. Both are read: which one arrives depends on a flag whose exact
// effect (replace the plain keys, or add to them) is not worth depending on.
function seconds(payload, name) {
  const micros = payload[`${name}Micros`];
  if (typeof micros === 'number' && isFinite(micros)) return Math.max(0, micros / 1e6);
  const plain = payload[name];
  if (typeof plain === 'number' && isFinite(plain)) return Math.max(0, plain);
  return 0;
}

// Artwork arrives as raw base64 plus its type, and becomes an <img src>. The
// mime type is validated to an image and the payload to the base64 alphabet
// before either is interpolated — a data: URI assembled from unchecked parts is
// a rendered-URL problem, not a formatting one. Oversized art is dropped rather
// than truncated: half a JPEG is a broken image, not a smaller one.
const MIME_RE = /^image\/[a-z0-9][a-z0-9.+-]{0,32}$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_ARTWORK_B64 = 6 * 1024 * 1024;

function artworkUri(payload) {
  const mime = String(payload.artworkMimeType || '').trim();
  const data = String(payload.artworkData || '').trim();
  if (!mime || !data) return null;
  if (!MIME_RE.test(mime)) return null;
  if (data.length > MAX_ARTWORK_B64) return null;
  if (!B64_RE.test(data)) return null;
  return `data:${mime};base64,${data}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Turn one adapter payload into the media object the rest of the app speaks.
// `sinceMs` is how long the payload has been held: MediaRemote pushes on change
// only, so a paused-then-resumed track would otherwise report the position it
// had minutes ago. The projection matches what media.ps1 does for the same
// reason, and only while playing.
function shapeNowPlaying(payload, sinceMs) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const bundleId = text(p.bundleIdentifier) || text(p.parentApplicationBundleIdentifier);
  const title = text(p.title);
  const artist = text(p.artist);
  const album = text(p.album);

  // Nothing is playing anywhere: the same "closed" answer media.ps1 gives, so
  // the widget shows its empty state instead of a stale track.
  if (!bundleId && !title && !artist && !album) {
    return {
      active: false, app: '', source: '', title: '', artist: '', album: '',
      playbackStatus: 'Closed', thumbnail: null, position: 0, duration: 0,
      sessions: [], selectionMode: 'auto',
    };
  }

  const playing = p.playing === true;
  const duration = seconds(p, 'duration');
  const elapsed = seconds(p, 'elapsedTime');
  const projected = playing ? elapsed + Math.max(0, sinceMs) / 1000 : elapsed;
  const position = duration ? Math.min(duration, projected) : projected;
  const app = appNameFor(bundleId);
  const status = playing ? 'Playing' : 'Paused';

  const info = {
    active: true,
    app,
    source: bundleId,
    title,
    artist,
    album,
    playbackStatus: status,
    thumbnail: artworkUri(p),
    position: Math.round(position),
    duration: Math.round(duration),
    selectionMode: 'auto',
  };
  // MediaRemote exposes exactly one now-playing client, so the session list the
  // picker renders has one entry. Reporting it keeps the widget's source picker
  // honest — it shows what is playing and offers no choice, rather than looking
  // broken because the list is empty.
  info.sessions = [{
    source: bundleId,
    app,
    title,
    artist,
    album,
    playbackStatus: status,
    activePlayback: playing && !!(title || artist || app),
    position: info.position,
    duration: info.duration,
    selected: true,
  }];
  return info;
}

const STREAM_RESTART_MS = 5000;      // a died-young child waits before respawning
const STREAM_MAX_BACKOFF_MS = 60000;
const STREAM_YOUNG_MS = 15000;       // died before this → count it as a failure
const COMMAND_TIMEOUT_MS = 5000;
const MAX_LINE_BYTES = 16 * 1024 * 1024; // artwork frames are large; a runaway is not

function createDarwinMedia(options) {
  const o = options || {};
  const dir = o.dir || '';
  const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
  const spawnChild = typeof o.spawn === 'function' ? o.spawn : spawn;
  const exists = typeof o.exists === 'function' ? o.exists : fs.existsSync;
  const perlPath = typeof o.perl === 'string' && o.perl ? o.perl : PERL;
  const scriptPath = path.join(dir, SCRIPT_NAME);
  const frameworkPath = path.join(dir, FRAMEWORK_NAME);

  let proc = null;
  let buf = '';
  let stopped = false;
  let restartTimer = null;
  let failures = 0;
  let bornAt = 0;
  let latest = { payload: null, at: 0 };

  function available() {
    try {
      return exists(perlPath) && exists(scriptPath) && exists(frameworkPath);
    } catch { return false; }
  }

  function handleLine(line) {
    const frame = parseStreamLine(line);
    if (!frame) return;
    // --no-diff is passed below, so every payload is complete and replaces the
    // previous one. A diff frame would have to be merged, and a merge that
    // drifts shows a track that never plays anywhere — so if one arrives
    // anyway, treat it as unusable rather than half-applying it.
    if (frame.diff) return;
    latest = { payload: frame.payload, at: Date.now() };
    try { onChange(); } catch { /* never let a listener kill the host */ }
  }

  function retire(reason) {
    const dead = proc;
    proc = null;
    buf = '';
    if (dead) {
      try { dead.kill(); } catch { /* already gone */ }
    }
    if (stopped) return;
    // Fast-fail counting with backoff, so an adapter that cannot run (missing
    // Xcode runtime, quarantined framework, revoked entitlement) costs one
    // spawn a minute instead of a spawn loop.
    if (Date.now() - bornAt < STREAM_YOUNG_MS) failures = Math.min(failures + 1, 8);
    else failures = 0;
    const delay = Math.min(STREAM_RESTART_MS * (2 ** failures), STREAM_MAX_BACKOFF_MS);
    if (restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
    restartTimer.unref();
    void reason;
  }

  function start() {
    if (stopped || proc || !available()) return;
    let child;
    try {
      // --no-diff: every frame is a complete payload (see handleLine).
      // --debounce: MediaRemote fires several events per track change; one
      // coalesced frame per change is all the widget can use.
      child = spawnChild(perlPath, [scriptPath, frameworkPath, 'stream', '--no-diff', '--micros', '--debounce=250'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { return; }
    proc = child;
    bornAt = Date.now();
    buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // 'exit' can fire before stdout drains, so a trailing chunk from a
      // retired child could interleave into the replacement's buffer.
      if (proc !== child) return;
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) { buf = ''; return; }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', () => {}); // the adapter reports its own problems
    child.on('error', () => { if (proc === child) retire('spawn error'); });
    child.on('exit', () => { if (proc === child) retire('exited'); });
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
    if (!latest.payload) {
      // Running but nothing has been reported yet, or not running at all —
      // either way the honest answer is the empty one.
      return shapeNowPlaying(null, 0);
    }
    return shapeNowPlaying(latest.payload, Date.now() - latest.at);
  }

  // A control is a one-shot `send <code>` or `seek <microseconds>`: the
  // streaming child holds the session and does not take input. The result is
  // the fresh info the caller expects back from a media action, which will
  // still be the pre-command snapshot — the stream pushes the real change a
  // moment later, and that push is what refreshes the widget.
  function command(action, position) {
    let target = position;
    if (action === 'seek') {
      const requested = Number(position);
      if (!Number.isFinite(requested) || requested < 0) {
        return Promise.reject(new Error('bad media position'));
      }
      // Clamp against the unrounded adapter duration when it is known. A live
      // stream legitimately has no duration and remains seekable at the value
      // its player accepts or rejects.
      const duration = latest.payload ? seconds(latest.payload, 'duration') : 0;
      target = duration > 0 ? Math.min(requested, duration) : requested;
    }
    const args = commandArgs(action, target);
    if (!args) {
      const reason = action === 'seek' ? 'bad media position' : `unsupported media action "${action}"`;
      return Promise.reject(new Error(reason));
    }
    if (!available()) return Promise.reject(new Error('media adapter unavailable'));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnChild(perlPath, [scriptPath, frameworkPath, ...args], { stdio: 'ignore' });
      } catch (e) { reject(e); return; }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        reject(new Error('media command timeout'));
      }, COMMAND_TIMEOUT_MS);
      timer.unref();
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code2) => {
        clearTimeout(timer);
        if (code2 === 0 && action === 'seek') {
          const snapshot = info();
          resolve({
            ok: true,
            seekProtocol: 1,
            source: snapshot.source || '',
            app: snapshot.app || '',
            position: target,
          });
        } else if (code2 === 0) resolve(info());
        // The adapter uses exit 1 for an unavailable/incompatible framework as
        // well as command failures, so it cannot honestly prove
        // `not_seekable`. Reject and let server.js expose `unavailable`.
        else reject(new Error(`media command failed (exit ${code2})`));
      });
    });
  }

  return { available, start, stop, info, command };
}

module.exports = {
  createDarwinMedia,
  // exported for unit tests
  parseStreamLine, shapeNowPlaying, appNameFor, commandCode, commandArgs, artworkUri,
};

'use strict';
// Instant Replay: the capture engine keeps the last N seconds of the screen
// in a ring of short segments on disk (apps/capture, replay_start), and a
// save (a Deck key, the voice, the phone) turns the newest of them into an
// MP4 in <Videos>/Xenon/<game or Desktop>/ in a moment, without re-encoding,
// indexed in captures.js like a recording. The path stays here; callers get
// the id and the file name.
//
// It runs when the user turned it on (off by default: it is a recording that
// never stops) and, with "while gaming", only while a game is in front; the
// engine then records the monitor the game is on. sync() brings the engine
// to what the settings and the game say; it is called when either changes and
// on the status tick, so a backup import or a missed event settles by itself.
// A replay that fails to start or dies is retried with a growing pause, and
// the reason is shown (status().error) instead of a switch that lies.
//
// The ring lives in the system's temp folder, deleted by the engine at start
// and stop; nothing of it is ever indexed or reachable.

const { pruneVideos } = require('./capture-prune');

// The engine waits up to 10 s for the encoder to open, plus its own start.
const START_TIMEOUT_MS = 20000;
// A save copies the clip and moves its index: generous for an hour at 4K.
const SAVE_TIMEOUT_MS = 60000;
const SAVE_MS_PER_SECOND = 100;
// Pauses between attempts after a failed start or a replay that died.
const RETRY_MS = Object.freeze([5000, 15000, 60000, 300000]);
// Engine failures the caller can act on keep their code; the rest are generic.
const START_CODES = new Set([
  'unavailable', 'unsupported', 'no_monitor', 'no_gpu', 'no_encoder', 'engine_failing', 'disk_full', 'write_failed',
]);
const SAVE_CODES = new Set(['too_short', 'disk_full', 'write_failed', 'saving', 'timeout']);
// The engine's bitrate (apps/capture video.rs): bits per pixel per frame.
const BITS_PER_PIXEL = Object.freeze({ small: 0.06, normal: 0.12, high: 0.2 });
const MIN_BITRATE = 4e6;
const MAX_BITRATE = 80e6;

// The bitrate the engine will use for a `width` x `height` screen with these
// options (the same formula as video.rs), for the disk estimate before the
// replay has run once.
function estimateBitrate({ width, height }, { fps = 60, height: cap = 0, quality = 'normal' } = {}) {
  let w = Number(width) || 0;
  let h = Number(height) || 0;
  if (!(w > 0 && h > 0)) return 0;
  if (cap > 0 && h > cap) {
    w = Math.round((w * cap) / h);
    h = cap;
  }
  const bits = w * h * fps * (BITS_PER_PIXEL[quality] || BITS_PER_PIXEL.normal);
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, bits)));
}

// Bytes per second the ring takes at `bitrate` (the video, plus the raw sound
// it keeps until a save): what the pane multiplies by the length it shows.
function ringByteRate(bitrate, { sound = true } = {}) {
  if (!(bitrate > 0)) return 0;
  const SOUND = 48000 * 2 * 2 * 8; // 48 kHz, 16-bit, stereo
  return Math.round((bitrate + (sound ? SOUND : 0)) / 8);
}

function createReplay({
  host, store, options = () => ({}), folder = async () => ({ dir: '' }),
  game = () => '', gaming = () => false, ringDir, mkdir,
  now = Date.now, timers = { setTimeout, clearTimeout }, onChange = () => {}, onSaved = () => {},
  markers = { between: () => [] },
}) {
  let run = null;        // { since, seconds, key, info }
  let error = '';        // why it is not running when it should
  let lastBitrate = 0;   // from the last run, for the estimate
  let retryTimer = null;
  let retries = 0;
  let saving = null;     // the save in progress (the engine takes one at a time)
  let stopped = false;
  let queue = Promise.resolve();
  const saves = new Map(); // token → { resolve, timer }

  const tell = (fn, value) => { try { fn(value); } catch { /* a listener never breaks the replay */ } };
  const opts = () => {
    try { return options() || {}; } catch { return {}; }
  };
  const look = (o) => ({
    fps: o.fps || 60, height: o.height || 0, quality: o.quality || 'normal',
    sound: o.replayAudio !== 'silent', mic: o.replayAudio === 'sound_mic',
  });
  const wanted = (o) => !stopped && o.replay === true && (o.replayWhen === 'always' || !!gaming());

  function status() {
    const o = opts();
    const s = { enabled: o.replay === true, when: o.replayWhen || 'gaming', seconds: o.replaySeconds || 30, on: !!run };
    if (run) Object.assign(s, { since: run.since, kept: run.seconds, ...run.info });
    // On, but waiting for a game: not an error, the pane says so.
    else if (s.enabled && !error && s.when === 'gaming' && !gaming()) s.waiting = true;
    if (error && !run) s.error = error;
    if (lastBitrate) s.lastBitrate = lastBitrate;
    if (saving) s.saving = true;
    return s;
  }
  const changed = () => tell(onChange, status());

  function settleSave(token, ev) {
    const p = saves.get(token);
    if (!p) return;
    saves.delete(token);
    timers.clearTimeout(p.timer);
    p.resolve(ev);
  }

  host.onEvent((ev) => {
    if (!ev || typeof ev.event !== 'string') return;
    if (ev.event === 'replay_saved') { settleSave(String(ev.token || ''), ev); return; }
    if (ev.event !== 'replay_ended' && ev.event !== 'engine_exited') return;
    if (ev.event === 'engine_exited') for (const token of [...saves.keys()]) settleSave(token, { ok: false, error: 'engine_exited' });
    if (!run) return;
    run = null;
    error = ev.event === 'engine_exited' ? 'engine_exited' : String(ev.reason || 'failed');
    changed();
    retryLater();
  });

  function retryLater() {
    if (retryTimer || stopped) return;
    const delay = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
    retries++;
    retryTimer = timers.setTimeout(() => { retryTimer = null; sync(); }, delay);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  function clearRetry() {
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    retries = 0;
  }

  async function startEngine(o) {
    try { await mkdir(ringDir); } catch { error = 'write_failed'; changed(); retryLater(); return; }
    const l = look(o);
    const reply = await host.request('replay_start', { dir: ringDir, seconds: o.replaySeconds, ...l }, { timeoutMs: START_TIMEOUT_MS });
    if (!reply || reply.ok !== true) {
      const code = reply && reply.error;
      error = START_CODES.has(code) ? code : 'failed';
      changed();
      retryLater();
      return;
    }
    retries = 0;
    error = '';
    const info = {
      width: reply.width, height: reply.height, fps: reply.fps, hdr: reply.hdr === true,
      bitrate: Number(reply.bitrate) || 0,
      sound: reply.sound === 'app' || reply.sound === 'system' ? reply.sound : null, mic: reply.mic === true,
    };
    if (info.bitrate) lastBitrate = info.bitrate;
    run = { since: now(), seconds: o.replaySeconds, key: JSON.stringify(l), info };
    // Asked for but refused (privacy setting, no microphone): the replay goes on without it.
    if (l.mic && !info.mic) run.info = { ...info, noMic: true };
    changed();
  }

  async function stopEngine() {
    if (saving) await saving.catch(() => {});
    if (!run) return;
    run = null;
    await host.request('replay_stop', {});
    changed();
  }

  async function step() {
    const o = opts();
    if (!wanted(o) || !host.available()) {
      clearRetry();
      const had = !!run || !!error;
      error = '';
      if (run) await stopEngine();
      else if (had) changed();
      return;
    }
    if (run && JSON.stringify(look(o)) !== run.key) await stopEngine();
    if (run) {
      if (o.replaySeconds !== run.seconds) {
        const r = await host.request('replay_keep', { seconds: o.replaySeconds });
        if (r && r.ok === true && run) { run.seconds = o.replaySeconds; changed(); }
      }
      return;
    }
    if (retryTimer) return; // waiting out the pause after a failure
    await startEngine(o);
  }

  // Brings the engine to what the settings and the game say. Calls queue up,
  // so two quick changes never start two replays.
  function sync() {
    queue = queue.then(step).catch(() => {});
    return queue;
  }

  // The engine writes the last `n` seconds to `file` and says when it is done:
  // { ok: true, seconds } or { ok: false, error }.
  async function engineSave(file, n, token) {
    const done = new Promise((resolve) => {
      const timer = timers.setTimeout(() => settleSave(token, { ok: false, error: 'timeout' }), SAVE_TIMEOUT_MS + n * SAVE_MS_PER_SECOND);
      saves.set(token, { resolve, timer });
    });
    const reply = await host.request('replay_save', { path: file, seconds: n, token });
    if (!reply || reply.ok !== true) {
      settleSave(token, null);
      const code = reply && reply.error;
      return { ok: false, error: code === 'not_running' ? 'not_running' : SAVE_CODES.has(code) ? code : 'save_failed' };
    }
    const ev = await done;
    if (!ev || ev.ok !== true) {
      const code = ev && ev.error;
      return { ok: false, error: SAVE_CODES.has(code) ? code : 'save_failed' };
    }
    return { ok: true, seconds: Number(ev.seconds) };
  }

  const lengthOf = (seconds, r) => (Number(seconds) > 0 ? Math.min(Math.round(Number(seconds)), r.seconds) : r.seconds);

  async function doSave(seconds, auto) {
    const r = run;
    // The clip ends where the user asked for it, whatever the engine takes to write it.
    const end = now();
    const g = String(game() || '');
    let where = { dir: '' };
    try { where = (await folder()) || where; } catch { /* the default folder */ }
    const plan = await store.plan({ kind: 'replay', game: g, root: where.dir || undefined });
    try { await mkdir(plan.dir); } catch { return { ok: false, error: 'write_failed' }; }
    const ev = await engineSave(plan.file, lengthOf(seconds, r), plan.id);
    if (!ev.ok) return ev;
    const entry = store.add({
      id: plan.id, kind: 'replay', file: plan.file, game: g,
      width: r.info.width, height: r.info.height, hdr: r.info.hdr, seconds: Number(ev.seconds),
      markers: markers.between(end - Number(ev.seconds) * 1000, end),
    });
    if (!entry) return { ok: false, error: 'save_failed' };
    const result = { ok: true, saved: true, id: entry.id, name: entry.name, game: entry.game, seconds: entry.seconds };
    if (where.missing === true) result.folderMissing = true;
    const pruned = await pruneVideos(store, opts().maxGB, entry.id);
    if (pruned) result.pruned = pruned;
    tell(onSaved, { ...result, kind: 'replay', ...(auto ? { auto } : {}) });
    return result;
  }

  // Saves the last `seconds` (all that is kept when absent or longer).
  // `auto` ('mark' | 'stutter') says a clip saved itself (capture-autoclips.js).
  function save({ seconds, auto } = {}) {
    if (!host.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (!run) {
      const o = opts();
      if (o.replay !== true) return Promise.resolve({ ok: false, error: 'off' });
      return Promise.resolve({ ok: false, error: error || (o.replayWhen !== 'always' && !gaming() ? 'no_game' : 'not_running') });
    }
    if (saving) return Promise.resolve({ ok: false, error: 'saving' });
    saving = doSave(seconds, auto === 'mark' || auto === 'stutter' ? auto : '').catch(() => ({ ok: false, error: 'save_failed' }));
    changed();
    return saving.finally(() => { saving = null; changed(); });
  }

  // The last seconds into a file of the caller's (the bug report package):
  // not indexed, no notice, nothing pruned. Never starts the replay: off or
  // waiting for a game answers with the reason and the caller goes on without.
  function saveTo(file, { seconds } = {}) {
    if (!host.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (!run) return Promise.resolve({ ok: false, error: opts().replay !== true ? 'off' : 'not_running' });
    if (saving) return Promise.resolve({ ok: false, error: 'saving' });
    const token = 'p' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
    saving = engineSave(file, lengthOf(seconds, run), token).catch(() => ({ ok: false, error: 'save_failed' }));
    changed();
    return saving.finally(() => { saving = null; changed(); });
  }

  // Shutdown: a save in progress finishes, then the ring goes.
  async function flush() {
    stopped = true;
    clearRetry();
    await queue.catch(() => {});
    await stopEngine();
  }

  return { sync, save, saveTo, status, flush };
}

module.exports = {
  createReplay, estimateBitrate, ringByteRate, RETRY_MS, START_TIMEOUT_MS, SAVE_TIMEOUT_MS,
};

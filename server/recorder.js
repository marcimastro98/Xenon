'use strict';
// Screen and window recording: one at a time, an MP4 in
// <Videos>/Xenon/<game or Desktop>/, written by the capture engine
// (apps/capture, record_start / record_stop) and indexed in captures.js once it
// is complete. The path stays here; callers get the id and the file name.
//
// A recording ends on stop, on shutdown (flush), or by itself: the window
// closed, the disk filled, the engine died. The engine says so with a
// `record_ended` event line, or the host reports `engine_exited`; either way
// what is on disk is kept (the MP4 is fragmented, so a crash leaves a file
// that plays). An empty recording leaves no file and no entry.
//
// The options (frame rate, size, quality, the pill, the space limit, the
// folder) are read at every start from hubSettings.capture (capture-settings.js).
//
// A timelapse is the same recording with `every` (seconds between pictures):
// silent, played back at the engine's 30 fps, " Timelapse" in its name.
//
// The webcam, when asked for, is a round bubble the engine draws into the
// video in the chosen corner; never in a timelapse. No camera = the video goes
// on without it and the answer says `noCamera`.

const { pruneVideos } = require('./capture-prune');
const { LAPSE_EVERY } = require('./captures');

// The engine waits up to 10 s for the encoder to open, plus its own start. On
// GNOME and KDE (Wayland) the first recording waits for the desktop's "share
// your screen" dialog, which the engine gives 120 s.
const START_TIMEOUT_MS = 150000;
const FPS = 60;
// Engine failures the caller can act on keep their code; the rest are "failed".
const PASS_THROUGH = new Set([
  'unavailable', 'unsupported', 'no_window', 'no_monitor', 'no_gpu', 'no_encoder',
  'engine_failing', 'disk_full',
]);
const TARGETS = Object.freeze(['screen', 'window']);
// "sound" is the app's sound for a window, the PC's for the screen; the
// microphone is an extra track, never on unless asked.
const AUDIO = Object.freeze(['sound', 'sound_mic', 'silent']);
// The corner of the webcam bubble; anything else = no webcam.
const WEBCAM = Object.freeze(['tl', 'tr', 'bl', 'br']);

function createRecorder({
  host, store, game = () => '', mkdir, exists = async () => true,
  options = () => ({}), folder = async () => ({ dir: '' }),
  now = Date.now, onChange = () => {}, onSaved = () => {},
  markers = { between: () => [] },
}) {
  let rec = null;       // { id, file, game, target, since, info, ending }
  let starting = null;  // the start in progress
  let early = null;     // an end the engine reported before its start reply arrived

  const tell = (fn, value) => { try { fn(value); } catch { /* a listener never breaks a recording */ } };

  host.onEvent((ev) => {
    if (!ev || (ev.event !== 'record_ended' && ev.event !== 'engine_exited')) return;
    if (rec) finish(ev);
    else if (starting) early = ev;
  });

  const opts = () => {
    try { return options() || {}; } catch { return {}; }
  };

  async function open(target, audio, every, webcam) {
    const g = String(game() || '');
    const o = opts();
    // The chosen folder, or Videos when it is gone (an unplugged drive): the
    // recording still happens and the user is told where it went.
    let where = { dir: '' };
    try { where = (await folder()) || where; } catch { /* the default folder */ }
    const plan = await store.plan({ kind: 'recording', game: g, root: where.dir || undefined, lapse: every });
    try { await mkdir(plan.dir); } catch { return { ok: false, error: 'write_failed' }; }
    const wanted = { sound: audio !== 'silent', mic: audio === 'sound_mic' };
    const look = { fps: o.fps || FPS, height: o.height || 0, quality: o.quality || 'normal', badge: o.badge !== false };
    const lapse = every ? { every } : {};
    const cam = webcam ? { webcam } : {};
    const reply = await host.request('record_start', { target, path: plan.file, ...look, ...wanted, ...lapse, ...cam }, { timeoutMs: START_TIMEOUT_MS });
    // The user closed the desktop's dialog: nothing to report, like a screenshot.
    if (reply && reply.error === 'cancelled') return { ok: true, cancelled: true };
    if (!reply || reply.ok !== true) {
      const code = reply && reply.error;
      return { ok: false, error: PASS_THROUGH.has(code) ? code : 'failed' };
    }
    const info = {
      width: reply.width, height: reply.height, fps: reply.fps, hdr: reply.hdr === true,
      sound: reply.sound === 'app' || reply.sound === 'system' ? reply.sound : null, mic: reply.mic === true,
      ...(webcam ? { camera: reply.camera === true } : {}),
    };
    rec = { id: plan.id, file: plan.file, game: g, target, since: now(), info, every, webcam, ending: null };
    // Asked for but refused (privacy setting, no microphone): the video goes on without it.
    const notes = {};
    if (wanted.mic && !info.mic) notes.noMic = true;
    // The macOS engine records no computer sound at all; a Windows one can lack a device.
    if (wanted.sound && !info.sound) notes.noSound = true;
    if (webcam && !info.camera) notes.noCamera = true;
    if (where.missing === true) notes.folderMissing = true;
    tell(onChange, { on: true, since: rec.since, target, ...lapse, ...notes });
    return { ok: true, recording: true, target, ...info, ...lapse, ...notes };
  }

  function start({ target, audio, every, webcam } = {}) {
    if (rec) return Promise.resolve({ ok: false, error: 'running' });
    if (starting) return Promise.resolve({ ok: false, error: 'starting' });
    if (!host.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    const t = TARGETS.includes(target) ? target : 'screen';
    const e = LAPSE_EVERY.includes(every) ? every : 0;
    // A timelapse has no sound: minutes squeezed into seconds would be noise.
    const a = e ? 'silent' : AUDIO.includes(audio) ? audio : 'sound';
    const w = !e && WEBCAM.includes(webcam) ? webcam : '';
    early = null;
    starting = open(t, a, e, w).catch(() => ({ ok: false, error: 'failed' })).then((result) => {
      starting = null;
      // The window closed in the first instant: the end came before the start reply.
      if (rec && early) finish(early);
      early = null;
      return result;
    });
    return starting;
  }

  // What the engine reported at the end: its summary, or the reason it is gone.
  async function index(r, summary) {
    const frames = Number(summary.frames);
    // The engine died: what it wrote so far is on disk, but nobody counted it.
    const unknown = !Number.isFinite(frames);
    if (unknown ? !(await exists(r.file)) : frames <= 0) return { ok: false, error: 'too_short' };
    const seconds = Number.isFinite(summary.seconds) ? summary.seconds : (now() - r.since) / 1000;
    const entry = store.add({
      id: r.id, kind: 'recording', file: r.file, game: r.game,
      width: r.info.width, height: r.info.height, hdr: r.info.hdr, seconds, lapse: r.every || undefined,
      // Where the bubble sits, so the gallery can offer a vertical copy with the face on top.
      webcam: r.info.camera ? r.webcam : undefined,
      // A timelapse squeezes time: a marker would land on the wrong picture.
      markers: r.every ? undefined : markers.between(r.since, r.since + seconds * 1000),
    });
    if (!entry) return { ok: false, error: 'failed' };
    const saved = { ok: true, saved: true, id: entry.id, name: entry.name, game: entry.game, seconds: entry.seconds };
    // A timelapse also says how long it watched (the engine's `span`, else the clock).
    if (r.every) {
      const span = Number.isFinite(summary.span) ? summary.span : (now() - r.since) / 1000;
      Object.assign(saved, { every: r.every, span: Math.max(0, Math.round(span)) });
    }
    return saved;
  }

  // Ends the recording once, whoever asks first (stop, an event, shutdown).
  function finish(summary) {
    if (!rec) return Promise.resolve({ ok: false, error: 'not_recording' });
    if (rec.ending) return rec.ending;
    const r = rec;
    r.ending = (async () => {
      const reason = summary.event === 'engine_exited' ? 'engine_exited' : String(summary.reason || 'stopped');
      let result;
      try { result = await index(r, summary); } catch { result = { ok: false, error: 'failed' }; }
      result.reason = reason;
      rec = null;
      tell(onChange, result.ok ? { on: false, reason } : { on: false, reason, error: result.error });
      if (result.saved) {
        const pruned = await pruneVideos(store, opts().maxGB, r.id);
        if (pruned) result.pruned = pruned;
        tell(onSaved, { ...result, kind: 'recording' });
      }
      return result;
    })();
    return r.ending;
  }


  async function stop() {
    if (starting) await starting;
    if (!rec) return { ok: false, error: 'not_recording' };
    if (rec.ending) return rec.ending;
    const r = rec;
    const reply = await host.request('record_stop', {});
    // Ended by itself meanwhile: its event already started the finish.
    if (r.ending) return r.ending;
    return finish(reply && reply.ok === true ? reply : { event: 'engine_exited' });
  }

  return {
    start,
    stop,
    // A second press while the engine is still opening is not a stop.
    toggle: (opts) => (starting ? Promise.resolve({ ok: true, starting: true }) : rec ? stop() : start(opts)),
    status: () => (rec ? { on: true, since: rec.since, target: rec.target, ...(rec.every ? { every: rec.every } : {}) } : { on: false }),
    // Shutdown: a recording in progress is finished and indexed, not lost.
    flush: () => (rec || starting ? stop() : Promise.resolve(null)),
  };
}

module.exports = { createRecorder, TARGETS, AUDIO, WEBCAM, LAPSE_EVERY, FPS, START_TIMEOUT_MS };

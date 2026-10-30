'use strict';
// Benchmark: every frame time of the running game, from a start to a stop, saved
// as a CSV the user can open in a spreadsheet or a frame-time tool. The game
// sessions log (game-sessions.js) keeps a summary of every match on its own; a
// benchmark is the deliberate run someone starts to measure one thing and keep
// the raw data.
//
// It reads fpsmon's ring by mark once a second (6000 frames, so nothing is
// missed below 6000 FPS) and keeps the frames in memory until the stop. The
// timer exists only while a run is going. A run ends on stop, when the game
// exits or changes, or after MAX_MS, and is written to
// <Documents>/Xenon/Benchmark/<game> <date time>.csv. The path stays on the
// server: callers get the file NAME, and "show the file" reveals it locally.

const path = require('path');
const { createFrameHistogram, MIN_FRAMES_LOW1 } = require('./frame-stats');
const { resolveUserFolder } = require('./user-folders');

const POLL_MS = 1000;
const MAX_MS = 30 * 60 * 1000;
const MAX_FRAMES = 2000000;
// A run that has drawn no frame by then never will (a launcher, a paused
// game the capture does not see): it ends instead of running for MAX_MS.
const FIRST_FRAMES_MS = 5000;

const round1 = v => (v == null ? null : Math.round(v * 10) / 10);
const pad = n => String(n).padStart(2, '0');

// Windows reserved characters and control characters out, so a process name
// can never name a path outside the folder.
function safeName(game) {
  const s = String(game || '').replace(/\.exe$/i, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 60);
  return s || 'game';
}

function fileNameFor(game, startMs) {
  const d = new Date(startMs);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${safeName(game)} ${stamp}.csv`;
}

// PresentMon's column names, so the file reads the same as a capture taken
// with it: the display side is what the person saw, the present side what the
// game handed over.
function toCsv({ game, side, frames }) {
  const col = side === 'display' ? 'MsBetweenDisplayChange' : 'MsBetweenPresents';
  // The process name as the game has it ("Tabletop Simulator.exe"); only what
  // would break a CSV field is taken out.
  const app = (String(game || '').replace(/\.exe$/i, '').replace(/[",\x00-\x1f]+/g, ' ').trim() || 'game') + '.exe';
  const lines = [`Application,TimeInSeconds,${col}`];
  let t = 0;
  for (const ms of frames) {
    t += ms;
    lines.push(`${app},${(t / 1000).toFixed(6)},${ms.toFixed(3)}`);
  }
  return lines.join('\n') + '\n';
}

// The user's Documents folder (user-folders.js: OneDrive-aware on Windows).
function resolveDocumentsDir(opts) {
  return resolveUserFolder('documents', opts);
}

// `folder` (optional): () → Promise<{ dir, missing }>, the folder the user
// chose ('' = Documents/Xenon/Benchmark), missing when the chosen one is gone.
function createBenchmark({
  fps, game, documentsDir, writeFile, mkdir, folder = null,
  now = Date.now, timers = { setInterval, clearInterval }, onStart = () => {}, onEnd = () => {},
}) {
  let run = null;
  let lastPath = '';

  const currentGame = () => {
    try { return String(game() || '').toLowerCase().replace(/\.exe$/, ''); } catch { return ''; }
  };

  function read() {
    try { return typeof fps.getFramesSince === 'function' ? fps.getFramesSince(run.mark, run.game) : null; } catch { return null; }
  }

  function poll() {
    if (!run) return;
    const g = currentGame();
    if (g !== run.game) { finish('game_ended'); return; }
    const r = read();
    if (!r) { finish('no_frames'); return; }
    if (r.mark && run.mark && r.mark.side !== run.mark.side && run.frames.length) {
      // The capture switched sides mid-run: frames of two kinds in one column
      // would be a wrong file. Keep what was measured.
      finish('side_changed');
      return;
    }
    run.mark = r.mark;
    if (r.mark) run.side = r.mark.side;
    for (const ms of r.frames) run.frames.push(ms);
    if (!run.frames.length && now() - run.start >= FIRST_FRAMES_MS) { finish('no_frames'); return; }
    if (run.frames.length >= MAX_FRAMES || now() - run.start >= MAX_MS) finish('limit');
  }

  function start() {
    if (run) return { ok: false, error: 'running', game: run.game };
    const g = currentGame();
    if (!g) return { ok: false, error: 'no_game' };
    run = { game: g, start: now(), mark: null, side: 'present', frames: [], timer: null, ending: null };
    const r = read();
    // No mark = the frame source does not see this game at all.
    if (!r || !r.mark) { run = null; return { ok: false, error: 'no_frames' }; }
    run.mark = r.mark;                       // the first read only primes the mark
    if (r.mark) run.side = r.mark.side;
    run.timer = timers.setInterval(poll, POLL_MS);
    if (run.timer && run.timer.unref) run.timer.unref();
    try { onStart({ game: g }); } catch { /* a listener never breaks the run */ }
    return { ok: true, running: true, game: g };
  }

  async function save(r) {
    let where = { dir: '' };
    if (typeof folder === 'function') {
      try { where = (await folder()) || where; } catch { /* the default folder still works */ }
    }
    const dir = where.dir && path.isAbsolute(where.dir) ? where.dir : path.join(await documentsDir(), 'Xenon', 'Benchmark');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, fileNameFor(r.game, r.start));
    await writeFile(file, toCsv(r));
    r.folderMissing = where.missing === true;
    return file;
  }

  // Ends the run once, however many callers ask (stop, the poll, shutdown).
  function finish(reason) {
    if (!run) return Promise.resolve({ ok: false, error: 'not_running' });
    if (run.ending) return run.ending;
    const r = run;
    timers.clearInterval(r.timer);
    r.ending = (async () => {
      const end = now();
      const hist = createFrameHistogram();
      hist.add(r.frames);
      const st = hist.stats();
      let result;
      if (!r.frames.length) {
        result = { ok: false, error: 'no_frames', game: r.game };
      } else if (!st || st.count < MIN_FRAMES_LOW1) {
        result = { ok: false, error: 'too_short', game: r.game };
      } else {
        try {
          const file = await save(r);
          lastPath = file;
          result = {
            ok: true, saved: true, reason, game: r.game,
            durationS: Math.round((end - r.start) / 1000), frames: st.count,
            avgFps: round1(st.avgFps), low1Fps: round1(st.low1Fps), low01Fps: round1(st.low01Fps),
            file: path.basename(file),
            ...(r.folderMissing ? { folderMissing: true } : {}),
          };
        } catch (e) {
          console.warn('[benchmark] save failed:', e && e.message);
          result = { ok: false, error: 'write_failed', game: r.game };
        }
      }
      run = null;
      try { onEnd(result); } catch { /* a listener never breaks the run */ }
      return result;
    })();
    return r.ending;
  }

  return {
    start,
    stop: () => finish('stopped'),
    toggle: () => (run ? finish('stopped') : Promise.resolve(start())),
    status: () => (run ? { running: true, game: run.game, elapsedS: Math.round((now() - run.start) / 1000) } : { running: false }),
    lastFile: () => lastPath,
    // Shutdown: a run in progress is saved, not lost.
    flush: () => (run ? finish('shutdown') : Promise.resolve(null)),
  };
}

module.exports = { createBenchmark, toCsv, fileNameFor, safeName, resolveDocumentsDir, POLL_MS, MAX_MS, MAX_FRAMES, FIRST_FRAMES_MS };

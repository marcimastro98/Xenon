'use strict';
// The `perf` SSE stream behind the Game performance tile: frame rate, lows and
// the newest frame times, four times a second. It runs only while a game is
// detected AND something shows it (the tile on the dashboard or on a layer),
// so an idle PC, or a game with no tile in sight, costs one boolean check per
// status tick and nothing else. Leaving the game sends one `{ active: false }`
// so a tile drops its numbers at once instead of freezing on the last frame.
// With a game-sessions store (deps.last), an idle reading also carries the last
// session played, which is what the tile shows between games. With a benchmark
// runner (deps.bench), a live reading says when a run is going and for how long.
// With deps.game, an idle reading names a game that runs but whose frames
// cannot be read, so the tile names it instead of saying "start a game"; `reader:
// false` adds that the frame reader is not installed, and with deps.access,
// `access: 'signin' | 'rights'` that Windows does not let it read yet
// (sensor-service/fps-access.js).

const INTERVAL_MS = 250;
const GRAPH_FRAMES = 120;

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// One reading. `fps` is the fps-monitor facade (fpsmon.js on Windows, MangoHud
// on Linux, a stub on macOS); every call is guarded so a backend that lacks one
// reports null for that part instead of failing the whole reading. `last`
// (optional) returns the latest game session for an idle reading.
function idle(last) {
  if (typeof last !== 'function') return { active: false };
  let s = null;
  try { s = last() || null; } catch { s = null; }
  return { active: false, last: s };
}

function unreadable(fps, game, access) {
  let g = '';
  try { g = typeof game === 'function' ? String(game() || '') : ''; } catch { g = ''; }
  if (!g) return null;
  let reader = true;
  try { reader = !(fps && typeof fps.isAvailable === 'function' && fps.isAvailable() === false); } catch { reader = true; }
  if (!reader) return { game: g, reader: false };
  let a = null;
  try { a = typeof access === 'function' ? access() : null; } catch { a = null; }
  return a === 'signin' || a === 'rights' ? { game: g, access: a } : { game: g };
}

// "Why does it stutter?" (stutter-why.js): { verdict, reason } once it held for
// two system ticks, or null; with `app` { name, cpu | ramMB } when a program other
// than the game weighs on the PC (perf-session/culprit.js).
function whyOf(why) {
  let w = null;
  try { w = typeof why === 'function' ? why() : null; } catch { w = null; }
  if (!w || typeof w.verdict !== 'string' || typeof w.reason !== 'string') return null;
  const app = appOf(w.app);
  return app ? { verdict: w.verdict, reason: w.reason, app } : { verdict: w.verdict, reason: w.reason };
}

function appOf(a) {
  if (!a || typeof a.name !== 'string' || !a.name) return null;
  if (Number.isFinite(a.cpu)) return { name: a.name, cpu: a.cpu };
  if (Number.isFinite(a.ramMB)) return { name: a.name, ramMB: a.ramMB };
  return null;
}

function snapshot(fps, last, bench, why, game, access) {
  const call = (name, ...args) => {
    try { return fps && typeof fps[name] === 'function' ? fps[name](...args) : null; } catch { return null; }
  };
  const detail = call('getFpsDetail') || {};
  if (detail.fps == null) {
    const u = unreadable(fps, game, access);
    return u ? { active: false, ...u } : idle(last);
  }
  const stats = call('getFrameStats') || {};
  const win = call('getFrameWindow', GRAPH_FRAMES);
  let b = null;
  try { b = typeof bench === 'function' ? bench() : null; } catch { b = null; }
  return {
    active: true,
    process: typeof stats.process === 'string' ? stats.process : '',
    fps: detail.fps,
    displayFps: detail.displayFps != null ? detail.displayFps : null,
    presentFps: detail.presentFps != null ? detail.presentFps : null,
    avgFps: stats.avgFps != null ? stats.avgFps : null,
    low1Fps: stats.low1Fps != null ? stats.low1Fps : null,
    low01Fps: stats.low01Fps != null ? stats.low01Fps : null,
    p99Ms: stats.p99Ms != null ? stats.p99Ms : null,
    frames: win && Array.isArray(win.frames) ? win.frames.map(round1) : [],
    bench: b && b.running ? { elapsedS: b.elapsedS } : null,
    why: whyOf(why),
    exclusive: stats.exclusive === true,
  };
}

// What a tile was last told: live readings ('active') go out every tick, an
// idle one only when it says something new.
const kindOf = (p) => (p.active ? 'active' : p.game ? 'game:' + p.game + (p.reader === false ? ':noreader' : '') + (p.access ? ':' + p.access : '') : '');

// deps: { fps, wanted(), hasClients(), broadcast(payload), last()?, bench()?, why()?, game()?, access()?, intervalMs? }
function createPerfStream(deps) {
  const intervalMs = deps.intervalMs || INTERVAL_MS;
  let timer = null;
  let sent = '';
  const read = () => snapshot(deps.fps, deps.last, deps.bench, deps.why, deps.game, deps.access);

  function tick() {
    if (!deps.hasClients() || !deps.wanted()) return;
    const payload = read();
    const kind = kindOf(payload);
    if (kind !== 'active' && kind === sent) return;
    sent = kind;
    deps.broadcast(payload);
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Called on every status tick and on every game-mode flip.
  function setGaming(on) {
    if (on && !timer) {
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
      tick();
    } else if (!on && timer) {
      stopTimer();
      if (sent) { sent = ''; deps.broadcast(idle(deps.last)); }
    }
  }

  // A game session just closed: an idle tile shows it at once. A live tile is
  // left alone (the next reading is a frame away).
  function sessionEnded() {
    if (timer && sent === 'active') return;
    if (deps.hasClients() && deps.wanted()) deps.broadcast(idle(deps.last));
  }

  return { setGaming, sessionEnded, stop: stopTimer, running: () => !!timer, snapshot: read };
}

module.exports = { createPerfStream, snapshot, INTERVAL_MS, GRAPH_FRAMES };

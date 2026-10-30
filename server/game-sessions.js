'use strict';
// Game sessions: one summary per game played (average FPS, 1% and 0.1% lows,
// CPU/GPU load, peak temperatures), so "how did the last match go?" and "did
// the driver update help?" have an answer without a benchmark tool.
//
// A session opens when game detection reports a running game and closes when it
// exits or another game takes its place. Every frame the game presented in
// between is counted once (fpsmon's ring, read by mark) into a histogram, so an
// hour of play costs the same few kilobytes as a minute. Short sessions (a
// launcher, a crash on start) and sessions with no frame rate at all are not
// kept: they would only push real ones out of the list.
//
// Stored newest first in DATA_DIR/game-sessions.json, at most MAX_SESSIONS,
// written atomically. Nothing leaves the PC.

const fs = require('fs');
const { createFrameHistogram } = require('./frame-stats');

const MAX_SESSIONS = 100;
const MIN_SESSION_MS = 2 * 60 * 1000;
const MAX_GAME_LEN = 80;

const round1 = v => Math.round(v * 10) / 10;
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const gameKey = g => String(g || '').toLowerCase().replace(/\.exe$/, '').slice(0, MAX_GAME_LEN);

// Persisted data is re-validated on load: a hand-edited or truncated file gives
// fewer sessions, never a crash or a NaN on the tile.
function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const game = gameKey(raw.game);
  const start = finite(raw.start);
  const end = finite(raw.end);
  const avgFps = finite(raw.avgFps);
  if (!game || start == null || end == null || end < start || avgFps == null || avgFps <= 0) return null;
  const num = k => { const v = finite(raw[k]); return v == null ? null : round1(v); };
  return {
    id: typeof raw.id === 'string' && /^gs_[a-z0-9]{1,16}$/.test(raw.id) ? raw.id : 'gs_' + Math.floor(start).toString(36),
    game,
    start, end,
    durationS: Math.max(0, Math.round((end - start) / 1000)),
    avgFps: round1(avgFps),
    low1Fps: num('low1Fps'),
    low01Fps: num('low01Fps'),
    frames: Math.max(0, Math.floor(finite(raw.frames) || 0)),
    cpuAvg: num('cpuAvg'),
    gpuAvg: num('gpuAvg'),
    cpuTempMax: num('cpuTempMax'),
    gpuTempMax: num('gpuTempMax'),
  };
}

// Latest session of `game` (any game when empty) against the one before it of
// the same game. Pure, so the comparison the tile and the AI both read is
// pinned by a test.
function compareSessions(sessions, game) {
  const want = gameKey(game);
  const latest = want ? sessions.find(s => s.game === want) : sessions[0];
  if (!latest) return null;
  const previous = sessions.find(s => s !== latest && s.game === latest.game && s.start < latest.start) || null;
  const delta = k => (previous && latest[k] != null && previous[k] != null ? round1(latest[k] - previous[k]) : null);
  return {
    latest, previous,
    deltaAvgFps: delta('avgFps'),
    deltaLow1Fps: delta('low1Fps'),
    deltaLow01Fps: delta('low01Fps'),
  };
}

// What a widget granted the `gameSessions` stream reads (GET /perf/sessions):
// the game being played, the latest sessions, and the newest one against the
// one before it of the same game. Off in Settings = an empty, honest answer.
function widgetSnapshot(store, { enabled = true, limit = 20 } = {}) {
  if (!enabled) return { ok: true, enabled: false, current: null, sessions: [], compare: null };
  const c = store.compare('');
  return {
    ok: true,
    enabled: true,
    current: store.current(),
    sessions: store.list({ limit }),
    compare: c ? {
      game: c.latest.game,
      latestId: c.latest.id,
      previousId: c.previous ? c.previous.id : null,
      deltaAvgFps: c.deltaAvgFps,
      deltaLow1Fps: c.deltaLow1Fps,
      deltaLow01Fps: c.deltaLow01Fps,
    } : null,
  };
}

function createGameSessions({ fps, file, writeFileAtomic, now = Date.now, enabled = () => true, onEnd = () => {} }) {
  let sessions = [];
  let open = null;
  let saving = Promise.resolve();

  async function load() {
    let raw;
    try { raw = await fs.promises.readFile(file, 'utf8'); } catch { return; }
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j && j.sessions) ? j.sessions : [];
      sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.start - a.start).slice(0, MAX_SESSIONS);
    } catch {
      // Set aside, not silently overwritten by the next save.
      try { await fs.promises.rename(file, file + '.corrupt-' + now()); } catch { /* gone */ }
      sessions = [];
    }
  }

  // Saves run one after another, so an older list never lands after a newer one.
  function save() {
    const body = JSON.stringify({ version: 1, sessions });
    saving = saving.then(() => writeFileAtomic(file, body)).catch((e) => {
      console.warn('[game-sessions] save failed:', e && e.message);
    });
    return saving;
  }

  function begin(game) {
    return {
      game, start: now(), hist: createFrameHistogram(), mark: null,
      rateSum: 0, rateN: 0,
      cpuSum: 0, cpuN: 0, gpuSum: 0, gpuN: 0, cpuTempMax: null, gpuTempMax: null,
    };
  }

  function collect() {
    let r = null;
    try { r = typeof fps.getFramesSince === 'function' ? fps.getFramesSince(open.mark, open.game) : null; } catch { r = null; }
    if (r) {
      open.mark = r.mark;
      open.hist.add(r.frames);
      return;
    }
    // A backend without single frames (MangoHud on Linux): the average of the
    // rate it reports, and no lows rather than wrong ones.
    let f = null;
    try { f = finite(fps.getCurrentFps && fps.getCurrentFps()); } catch { f = null; }
    if (f != null && f > 0) { open.rateSum += f; open.rateN++; }
  }

  function summarize(o, end) {
    if (end - o.start < MIN_SESSION_MS) return null;
    const st = o.hist.stats();
    const avg = st ? st.avgFps : (o.rateN ? o.rateSum / o.rateN : null);
    return normalizeSession({
      id: 'gs_' + o.start.toString(36),
      game: o.game, start: o.start, end,
      avgFps: avg,
      low1Fps: st ? st.low1Fps : null,
      low01Fps: st ? st.low01Fps : null,
      frames: st ? st.count : 0,
      cpuAvg: o.cpuN ? o.cpuSum / o.cpuN : null,
      gpuAvg: o.gpuN ? o.gpuSum / o.gpuN : null,
      cpuTempMax: o.cpuTempMax,
      gpuTempMax: o.gpuTempMax,
    });
  }

  function end() {
    const o = open;
    open = null;
    const s = o && summarize(o, now());
    if (!s) return null;
    sessions = [s, ...sessions.filter(x => x.id !== s.id)].slice(0, MAX_SESSIONS);
    save();
    try { onEnd(s); } catch { /* a listener never breaks the record */ }
    return s;
  }

  // Called on the status tick (every few seconds and on every game change).
  function tick({ running, game } = {}) {
    if (!enabled()) { open = null; return; }
    // A running game reported without a name for a tick is still the same game.
    const g = running ? (gameKey(game) || (open ? open.game : '')) : '';
    if (open && open.game !== g) end();
    if (g && !open) open = begin(g);
    if (open) collect();
  }

  function onSystem(sys) {
    if (!open || !sys || typeof sys !== 'object') return;
    const cpu = finite(sys.cpu);
    const gpu = finite(sys.gpu);
    const cpuT = finite(sys.cpuTemp);
    const gpuT = finite(sys.gpuTemp);
    if (cpu != null) { open.cpuSum += cpu; open.cpuN++; }
    if (gpu != null) { open.gpuSum += gpu; open.gpuN++; }
    if (cpuT != null) open.cpuTempMax = Math.max(open.cpuTempMax == null ? cpuT : open.cpuTempMax, cpuT);
    if (gpuT != null) open.gpuTempMax = Math.max(open.gpuTempMax == null ? gpuT : open.gpuTempMax, gpuT);
  }

  // What the tile shows with no game running: the latest session and how it
  // compares with the one before it of the same game.
  function last() {
    const c = compareSessions(sessions, '');
    return c ? { ...c.latest, deltaAvgFps: c.deltaAvgFps } : null;
  }

  return {
    load,
    tick,
    onSystem,
    isOpen: () => !!open,
    // The game being played and since when (the Game Companion's session time).
    current: () => (open ? { game: open.game, start: open.start } : null),
    list({ game = '', limit = 10 } = {}) {
      const want = gameKey(game);
      const n = Math.max(1, Math.min(MAX_SESSIONS, Math.floor(Number(limit)) || 10));
      return (want ? sessions.filter(s => s.game === want) : sessions).slice(0, n).map(s => ({ ...s }));
    },
    compare: (game) => compareSessions(sessions, game),
    last,
    async clear() {
      sessions = [];
      open = null;
      await save();
      return true;
    },
    // Shutdown: keep the session in progress if it is long enough.
    flush() { end(); return saving; },
    // Backup: the stored list, and a restore that validates like a load.
    exportData: () => sessions.map(s => ({ ...s })),
    async importData(list) {
      if (!Array.isArray(list)) return false;
      sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.start - a.start).slice(0, MAX_SESSIONS);
      await save();
      return true;
    },
  };
}

module.exports = { createGameSessions, normalizeSession, compareSessions, widgetSnapshot, MAX_SESSIONS, MIN_SESSION_MS };

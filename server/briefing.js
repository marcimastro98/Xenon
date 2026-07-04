'use strict';

// ── Briefing — proactive-moments opportunity engine ──────────────────────────
// Watches signals the server already collects and decides WHEN a glanceable
// moment is worth raising (SSE 'briefing' event → toast/voice on the client).
// Two moment types today:
//   'thermal' — a temperature has been over its threshold CONTINUOUSLY for
//               SUSTAINED_MS (distinct from Guardian's instant spike alerts);
//   'recap'   — a game session just ended: duration, average/max FPS, peak temps.
//
// The engine is deliberately PASSIVE: it owns no timers and spawns nothing.
// It is fed from the existing SSE broadcast ticks (status every 3s, system
// every 7s), which already gate on connected clients — so with no dashboard
// open the engine does zero work and there is nothing to stop on shutdown.
//
// Anti-nag discipline (every trigger is deterministic and bounded):
//   - each type is individually toggleable (Settings → Performance → Momenti
//     proattivi), checked at emit time so a mid-session change is honored;
//   - thermal: 60-min per-metric cooldown + 3°C hysteresis, and unobserved
//     time never counts as "sustained" (a sampling gap restarts the window);
//   - recap: at most one per session, and only for sessions ≥ 10 minutes;
//   - a global rolling-hour cap backstops everything above.

const SUSTAINED_MS = 15 * 60 * 1000;      // continuously hot this long → alert
const THERMAL_COOLDOWN_MS = 60 * 60 * 1000; // per-metric re-alert cooldown
const THERMAL_HYST_C = 3;                 // must drop this far below to reset
const SAMPLE_GAP_RESET_MS = 60 * 1000;    // a gap this long breaks "sustained"
const MIN_SESSION_MS = 10 * 60 * 1000;    // shorter game sessions stay silent
const MAX_MOMENTS_PER_HOUR = 6;           // global backstop, should never bind

// Same thresholds as Guardian's instant alerts — one notion of "too hot".
const THERMAL_METRICS = [
  { metric: 'cpu', key: 'cpuTemp', threshold: 90 },
  { metric: 'gpu', key: 'gpuTemp', threshold: 88 },
];

function createBriefingEngine({ emit, isTypeEnabled, getFps = () => null, now = Date.now }) {
  // Per-metric sustained-heat state (null = "never", so a clock that starts at
  // zero — the injected test clock — can't be mistaken for a past event).
  const heat = {};
  for (const t of THERMAL_METRICS) heat[t.metric] = { hotSince: null, lastSampleAt: null, lastEmitAt: null };

  // Current game session (null while no game is running).
  let session = null;

  const emitted = []; // timestamps of raised moments (rolling-hour backstop)

  function allow(type) {
    try { if (isTypeEnabled && isTypeEnabled(type) === false) return false; } catch { return false; }
    const t = now();
    while (emitted.length && t - emitted[0] > 60 * 60 * 1000) emitted.shift();
    if (emitted.length >= MAX_MOMENTS_PER_HOUR) return false;
    emitted.push(t);
    return true;
  }

  function raise(type, data) {
    if (!allow(type)) return;
    try { emit(type, data); } catch { /* a moment is best-effort, never fatal */ }
  }

  // Fed from the 'system' SSE tick with the sensor payload ALREADY read for
  // broadcast — the engine adds zero sensor reads of its own.
  function onSystemSample(sys) {
    if (!sys || typeof sys !== 'object') return;
    const t = now();
    for (const cfg of THERMAL_METRICS) {
      const st = heat[cfg.metric];
      const v = sys[cfg.key];
      const gap = st.lastSampleAt != null && (t - st.lastSampleAt) > SAMPLE_GAP_RESET_MS;
      st.lastSampleAt = t;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v >= cfg.threshold) {
        // Unobserved time can't count as sustained: after a sampling gap the
        // window restarts even though the metric may have stayed hot.
        if (st.hotSince == null || gap) st.hotSince = t;
        if (t - st.hotSince >= SUSTAINED_MS
            && (st.lastEmitAt == null || t - st.lastEmitAt >= THERMAL_COOLDOWN_MS)) {
          st.lastEmitAt = t;
          raise('thermal', {
            metric: cfg.metric,
            value: Math.round(v),
            minutes: Math.round((t - st.hotSince) / 60000),
          });
        }
      } else if (st.hotSince != null && v <= cfg.threshold - THERMAL_HYST_C) {
        st.hotSince = null; // genuinely cooled down (hysteresis avoids flapping)
      }
      // Track session temperature peaks for the recap.
      if (session && typeof v === 'number') {
        const cur = session.peaks[cfg.key];
        if (cur == null || v > cur) session.peaks[cfg.key] = v;
      }
    }
  }

  // Fed from the 'status' SSE tick (plus the instant game-flip push). The
  // session follows gameRunning — alive in foreground OR background — so
  // tapping the dashboard mid-game never splits one session into two.
  function onStatusTick(st) {
    if (!st || typeof st !== 'object') return;
    const t = now();
    if (st.gameRunning === true) {
      if (!session) {
        session = {
          game: '', startedAt: t, lastSeenAt: t,
          fps: { sum: 0, n: 0, max: null },
          peaks: { cpuTemp: null, gpuTemp: null },
        };
      }
      session.lastSeenAt = t;
      if (st.gameProcess) session.game = String(st.gameProcess);
      let fps = null;
      try { fps = getFps(); } catch { fps = null; }
      if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) {
        session.fps.sum += fps;
        session.fps.n += 1;
        if (session.fps.max == null || fps > session.fps.max) session.fps.max = fps;
      }
      return;
    }
    if (!session) return;
    // Session over. Duration ends at the last moment the game was SEEN running:
    // if every dashboard disconnected mid-game (ticks pause), the eventual
    // false-tick may arrive much later and must not inflate the session.
    const s = session;
    session = null;
    const minutes = Math.round((s.lastSeenAt - s.startedAt) / 60000);
    if ((s.lastSeenAt - s.startedAt) < MIN_SESSION_MS) return;
    raise('recap', {
      game: s.game,
      minutes,
      avgFps: s.fps.n > 0 ? Math.round(s.fps.sum / s.fps.n) : null,
      maxFps: s.fps.max != null ? Math.round(s.fps.max) : null,
      cpuTempMax: s.peaks.cpuTemp != null ? Math.round(s.peaks.cpuTemp) : null,
      gpuTempMax: s.peaks.gpuTemp != null ? Math.round(s.peaks.gpuTemp) : null,
    });
  }

  return { onSystemSample, onStatusTick };
}

module.exports = { createBriefingEngine };

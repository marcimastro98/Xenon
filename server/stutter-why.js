'use strict';
// "Why does it stutter?": local rules, no AI model, that turn the running game's
// frame times and the PC's own readings into ONE plain answer and a next step.
// Inputs are what Xenon already measures: fpsmon's last ~2000 frames (the same
// ones the 1% and 0.1% lows come from) and the `system` tick's readings while
// the game runs (GPU and CPU load, the busiest core, video and system memory,
// temperatures). Nothing is sent anywhere; Bit only words what comes out.
//
// Answer: { verdict, reason, also[], ...numbers }.
//   verdict  smooth | stutter | low
//   reason   the cause the numbers point to first (REASONS order), one of
//            smooth capped vram_full ram_full gpu_hot cpu_hot gpu_bound cpu_bound
//            mixed no_gpu_reading loading
// Thresholds are rules of thumb, kept conservative so the answer is never a
// guess dressed as a fact: "loading" (shaders, streaming) is what is left when
// every reading is normal, and it says so.

const MIN_FRAMES = 120;           // fewer and the lows mean nothing yet
const SAMPLES_KEPT = 12;          // ~1 min of system ticks at the default 5 s
const HITCH_FACTOR = 2.5;         // a frame this many times the median...
const HITCH_EXTRA_MS = 12;        // ...and at least this much longer is felt
const HITCH_MIN = 3;              // a single hitch in half a minute is not stutter
const HITCHES_PER_MIN = 4;
const LOW1_RATIO = 0.5;           // 1% low under half the average: uneven
const LOW_FPS = 50;
const STEADY_P99 = 1.25;          // p99 frame time within 25% of the mean
const CAP_TOLERANCE = 0.025;
const CAPS = Object.freeze([30, 40, 45, 48, 50, 60, 72, 75, 90, 100, 120, 144, 160, 165, 170, 175, 180, 200, 240, 280, 300, 360]);
const VRAM_FULL_PCT = 95;
const RAM_FULL_PCT = 92;
const GPU_HOT_C = 87;             // where most cards start to clock down
const CPU_HOT_C = 95;             // AMD's Tctl target; Intel throttles at 100
const GPU_BUSY_PCT = 85;
const GPU_WAITING_PCT = 80;
const CORE_BUSY_PCT = 90;

// English, for Bit's turn (it answers in the user's language) and the docs.
const SENTENCES = Object.freeze({
  smooth: 'Runs smoothly: no stutter and a steady frame rate.',
  capped: 'Held at {cap} FPS by V-Sync or a frame limit in the game or the driver. That is normal; raise the limit there if the screen can show more.',
  vram_full: 'The video memory is full, so the game swaps textures in and out. Lower texture quality or resolution.',
  ram_full: 'The system memory is almost full. Close browsers and other apps while playing.',
  gpu_hot: 'The graphics card is at {gpuTemp} °C and slows itself down. Check its fans and the case airflow.',
  cpu_hot: 'The processor is at {cpuTemp} °C and slows itself down. Check the CPU cooler and the case airflow.',
  gpu_bound: 'The graphics card is at full load ({gpu}%). Lower resolution or graphics settings, or turn on DLSS, FSR or XeSS if the game has it.',
  cpu_bound: 'The graphics card waits ({gpu}% load): the processor or the game itself is the limit. Close background apps; view distance, crowds and simulation settings load the processor.',
  mixed: 'Neither part is clearly the limit ({gpu}% graphics card load). Lower the graphics settings one step and close apps in the background.',
  no_gpu_reading: 'This PC does not report how busy the graphics card is, so Xenon cannot tell which part holds the game back.',
  loading: 'Short stutters with nothing at its limit: usually the game loading the world or compiling shaders in a new area. It often calms down after a few minutes.',
});
const REASONS = Object.freeze(Object.keys(SENTENCES));

const finite = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v) => (v == null ? null : Math.round(v));
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const peak = (list) => (list.length ? Math.max(...list) : null);

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Frames far longer than their neighbours' typical time: what a stutter IS.
function hitchesOf(frames) {
  const list = frames.filter((v) => Number.isFinite(v) && v > 0);
  if (!list.length) return { count: 0, seconds: 0 };
  const med = median(list.slice().sort((a, b) => a - b));
  const limit = Math.max(med * HITCH_FACTOR, med + HITCH_EXTRA_MS);
  return { count: list.filter((v) => v > limit).length, seconds: list.reduce((a, b) => a + b, 0) / 1000 };
}

// A frame rate pinned to a common limit with even frame times: V-Sync or a cap.
function capOf(avgFps, p99Ms) {
  if (!(avgFps > 0) || !(p99Ms > 0) || p99Ms > STEADY_P99 * (1000 / avgFps)) return null;
  return CAPS.find((c) => Math.abs(avgFps - c) <= c * CAP_TOLERANCE) || null;
}

// The readings of the last minute, reduced to what the rules look at.
function hardwareOf(samples) {
  const pick = (key) => samples.map((s) => finite(s[key])).filter((v) => v != null);
  const pct = (used, total) => samples
    .map((s) => (finite(s[used]) != null && finite(s[total]) > 0 ? (100 * Number(s[used])) / Number(s[total]) : null))
    .filter((v) => v != null);
  return {
    gpu: mean(pick('gpu')),
    cpu: mean(pick('cpu')),
    core: mean(pick('cpuMaxCore')),
    vramPct: peak(pct('vramUsed', 'vramTotal')),
    memPct: peak(samples.map((s) => finite(s.memory && s.memory.percent)).filter((v) => v != null)),
    gpuTemp: peak(pick('gpuTemp')),
    cpuTemp: peak(pick('cpuTemp')),
  };
}

// Every cause the numbers support, most decisive first.
function causesOf(verdict, hw) {
  const out = [];
  if (hw.vramPct != null && hw.vramPct >= VRAM_FULL_PCT) out.push('vram_full');
  if (hw.memPct != null && hw.memPct >= RAM_FULL_PCT) out.push('ram_full');
  if (hw.gpuTemp != null && hw.gpuTemp >= GPU_HOT_C) out.push('gpu_hot');
  if (hw.cpuTemp != null && hw.cpuTemp >= CPU_HOT_C) out.push('cpu_hot');
  if (verdict === 'low') {
    if (hw.gpu == null) out.push('no_gpu_reading');
    else if (hw.gpu >= GPU_BUSY_PCT) out.push('gpu_bound');
    else if (hw.gpu < GPU_WAITING_PCT) out.push('cpu_bound');
    else out.push('mixed');
  } else if (verdict === 'stutter' && hw.gpu != null && hw.gpu < GPU_WAITING_PCT && hw.core != null && hw.core >= CORE_BUSY_PCT) {
    out.push('cpu_bound');
  }
  if (verdict === 'stutter' && !out.length) out.push('loading');
  return out;
}

function sentenceOf(reason, n) {
  return SENTENCES[reason].replace(/\{(\w+)\}/g, (_, k) => (n[k] == null ? '?' : String(n[k])));
}

// stats: fpsmon getFrameStats(); frames: its newest frame times (ms); samples:
// system readings taken while the game ran.
function diagnose({ stats, frames, samples } = {}) {
  if (!stats || !(stats.avgFps > 0)) return { ok: false, error: 'no_frames' };
  const list = Array.isArray(frames) ? frames : [];
  if (list.length < MIN_FRAMES || (stats.count != null && stats.count < MIN_FRAMES)) return { ok: false, error: 'too_soon' };
  const hw = hardwareOf(Array.isArray(samples) ? samples.filter((s) => s && typeof s === 'object') : []);
  const hitch = hitchesOf(list);
  const perMin = hitch.seconds > 0 ? (hitch.count * 60) / hitch.seconds : 0;
  const uneven = stats.low1Fps != null && stats.low1Fps < LOW1_RATIO * stats.avgFps;
  // A card at full load is the limit itself, not a cap that happens to match.
  const cap = hw.gpu != null && hw.gpu >= GPU_BUSY_PCT ? null : capOf(stats.avgFps, stats.p99Ms);
  let verdict = 'smooth';
  if ((hitch.count >= HITCH_MIN && perMin >= HITCHES_PER_MIN) || uneven) verdict = 'stutter';
  else if (stats.avgFps < LOW_FPS && !cap) verdict = 'low';
  const causes = causesOf(verdict, hw);
  if (verdict === 'smooth') causes.unshift(cap ? 'capped' : 'smooth');
  const numbers = {
    fps: round(stats.avgFps), low1Fps: round(finite(stats.low1Fps)), low01Fps: round(finite(stats.low01Fps)),
    hitches: hitch.count, seconds: Math.round(hitch.seconds), cap,
    gpu: round(hw.gpu), cpu: round(hw.cpu), busiestCore: round(hw.core),
    vramPct: round(hw.vramPct), memPct: round(hw.memPct), gpuTemp: round(hw.gpuTemp), cpuTemp: round(hw.cpuTemp),
  };
  const reason = causes[0];
  return {
    ok: true, process: typeof stats.process === 'string' ? stats.process : '',
    verdict, reason, also: causes.slice(1, 3), ...numbers,
    summary: sentenceOf(reason, numbers),
  };
}

// deps: { fps (fps-monitor facade), readSystem()? → one fresh reading,
//         game()? → the game in front ('' = none) }
// fpsmon measures whatever app presents frames in front, a browser too: without
// a game (gamedetect's word, as the perf tile uses it) there is nothing to judge.
function createStutterWatch(deps) {
  const d = deps || {};
  let samples = [];
  let game = '';
  let candidate = null;   // the last evaluation, waiting for a second like it
  let shown = null;       // what the tile and the perf stream show

  function evaluate() {
    const fps = d.fps;
    let stats = null;
    let win = null;
    try { stats = fps && typeof fps.getFrameStats === 'function' ? fps.getFrameStats() : null; } catch { stats = null; }
    try { win = fps && typeof fps.getFrameWindow === 'function' ? fps.getFrameWindow(2000) : null; } catch { win = null; }
    return diagnose({ stats, frames: win && Array.isArray(win.frames) ? win.frames : [], samples });
  }

  function reset() { samples = []; candidate = null; shown = null; }

  // Every system tick. `running` is the game in front ('' = none): another game
  // starts over, so its readings are never mixed with the previous one's.
  function onSystem(sys, running) {
    const name = typeof running === 'string' ? running : '';
    if (!name) { if (game) { game = ''; reset(); } return; }
    if (name !== game) { game = name; reset(); }
    if (sys && typeof sys === 'object') samples = samples.concat([sys]).slice(-SAMPLES_KEPT);
    const r = evaluate();
    const key = r.ok ? r.verdict + ':' + r.reason : '';
    // Two ticks in a row before the line changes: one odd tick never flickers it.
    if (key && candidate === key) shown = { verdict: r.verdict, reason: r.reason };
    else if (!key) shown = null;
    candidate = key;
  }

  // For the perf stream: { verdict, reason } once it held for two ticks, or null.
  function current() { return shown; }

  // The full answer now (Deck key, Bit). Without a reading yet (no dashboard
  // open, so no system tick), one is taken.
  async function explain() {
    if (typeof d.game === 'function') {
      let now = '';
      try { now = String(d.game() || ''); } catch { now = ''; }
      if (!now) return { ok: false, error: 'no_frames' };
      if (now !== game) { game = now; reset(); }
    }
    if (!samples.length && typeof d.readSystem === 'function') {
      try { const sys = await d.readSystem(); if (sys && typeof sys === 'object') samples = [sys]; } catch { /* frames alone */ }
    }
    return evaluate();
  }

  return { onSystem, current, explain };
}

module.exports = {
  createStutterWatch, diagnose, hitchesOf, capOf, hardwareOf, REASONS, SENTENCES,
  MIN_FRAMES, SAMPLES_KEPT,
};

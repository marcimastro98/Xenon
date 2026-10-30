'use strict';
// Frame-time statistics: the numbers RTSS, CapFrameX and the NVIDIA overlay show
// next to the frame rate. Pure, so every definition here is pinned by a test
// without a game running.
//
// Definitions (the ones CapFrameX documents, so a value can be checked against it):
//   avgFps     frames / total time, NOT the mean of per-frame FPS (which a single
//              very fast frame would inflate)
//   low1Fps    the average frame rate of the slowest 1% of frames
//   low01Fps   the same for the slowest 0.1%
//   p99Ms      the 99th percentile frame time
//
// A low is only reported when the window holds enough frames for that tail to
// contain at least one whole frame: 0.1% of 240 frames is a quarter of a frame,
// and a number computed from it would only be the single worst frame wearing a
// more impressive name.

const MIN_FRAMES_LOW1 = 100;
const MIN_FRAMES_LOW01 = 1000;
const MAX_FRAME_MS = 1000;   // a longer "frame" is a pause or a loading screen

function cleanFrameTimes(ms) {
  if (!Array.isArray(ms)) return [];
  return ms.filter(v => Number.isFinite(v) && v > 0 && v <= MAX_FRAME_MS);
}

// Mean frame rate of the slowest `fraction` of frames, from frame times sorted
// slowest first.
function tailFps(slowestFirst, fraction) {
  const n = Math.max(1, Math.floor(slowestFirst.length * fraction));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += slowestFirst[i];
  return 1000 / (sum / n);
}

// `ms`: frame times in milliseconds, any order. Returns null when there is
// nothing to measure.
function frameStats(ms) {
  const frames = cleanFrameTimes(ms);
  if (!frames.length) return null;
  const slowestFirst = frames.slice().sort((a, b) => b - a);
  const total = frames.reduce((a, b) => a + b, 0);
  const round1 = v => Math.round(v * 10) / 10;
  return {
    count: frames.length,
    avgFps: round1(1000 * frames.length / total),
    low1Fps: frames.length >= MIN_FRAMES_LOW1 ? round1(tailFps(slowestFirst, 0.01)) : null,
    low01Fps: frames.length >= MIN_FRAMES_LOW01 ? round1(tailFps(slowestFirst, 0.001)) : null,
    p99Ms: round1(slowestFirst[Math.floor(frames.length * 0.01)]),
    maxMs: round1(slowestFirst[0]),
  };
}

// PresentMon v1 builds that carry an FPS column instead of a frame time hand us
// rates; everything above works in milliseconds.
function toFrameTimes(samples, usesFps) {
  if (!usesFps) return samples;
  return (samples || []).map(f => (Number.isFinite(f) && f > 0 ? 1000 / f : NaN));
}

// Fixed-size ring of the most recent values. PresentMon delivers every frame of
// every presenter, so Array#shift on a window this long would cost a copy per
// frame; a typed ring costs one store.
function createFrameRing(capacity) {
  const buf = new Float64Array(capacity);
  let next = 0;
  let size = 0;
  let total = 0;
  return {
    push(v) {
      buf[next] = v;
      next = (next + 1) % capacity;
      if (size < capacity) size++;
      total++;
    },
    size: () => size,
    // Values ever pushed: a reader that remembers this can take only what is
    // new since its last look, even after the ring has wrapped.
    total: () => total,
    // The newest `n` values, oldest first: a graph's window without copying
    // the whole ring.
    last(n) {
      const k = Math.max(0, Math.min(size, Math.floor(n) || 0));
      const out = new Array(k);
      const start = (next - k + capacity) % capacity;
      for (let i = 0; i < k; i++) out[i] = buf[(start + i) % capacity];
      return out;
    },
    toArray() {
      const out = new Array(size);
      const start = (next - size + capacity) % capacity;
      for (let i = 0; i < size; i++) out[i] = buf[(start + i) % capacity];
      return out;
    },
  };
}

// A whole game session's frame times in constant memory: an hour at 144 FPS is
// half a million frames, which a list would keep for nothing. Bins are 0.1 ms
// wide up to 100 ms (where the lows of any playable game sit) and 1 ms wide
// above; each keeps its count and the exact sum of its frames, so a low is
// exact except for the one bin it cuts through, read at that bin's mean.
const FINE_BIN_MS = 0.1;
const FINE_BINS = 1000;   // 0-100 ms
const COARSE_BINS = 900;  // 100-1000 ms, 1 ms each

function createFrameHistogram() {
  const bins = FINE_BINS + COARSE_BINS;
  const counts = new Uint32Array(bins);
  const sums = new Float64Array(bins);
  let count = 0;
  let totalMs = 0;

  function add(frames) {
    for (const v of cleanFrameTimes(frames)) {
      const i = v < FINE_BINS * FINE_BIN_MS
        ? Math.floor(v / FINE_BIN_MS)
        : FINE_BINS + Math.min(COARSE_BINS - 1, Math.floor(v - FINE_BINS * FINE_BIN_MS));
      counts[i]++;
      sums[i] += v;
      count++;
      totalMs += v;
    }
  }

  // Mean frame rate of the slowest `want` frames, walking the bins from the
  // slowest.
  function tail(want) {
    let left = want;
    let sum = 0;
    for (let i = bins - 1; i >= 0 && left > 0; i--) {
      if (!counts[i]) continue;
      const k = Math.min(counts[i], left);
      sum += k === counts[i] ? sums[i] : k * (sums[i] / counts[i]);
      left -= k;
    }
    return 1000 / (sum / want);
  }

  function stats() {
    if (!count) return null;
    const round1 = v => Math.round(v * 10) / 10;
    return {
      count,
      avgFps: round1(1000 * count / totalMs),
      low1Fps: count >= MIN_FRAMES_LOW1 ? round1(tail(Math.max(1, Math.floor(count * 0.01)))) : null,
      low01Fps: count >= MIN_FRAMES_LOW01 ? round1(tail(Math.max(1, Math.floor(count * 0.001)))) : null,
    };
  }

  return { add, stats, count: () => count };
}

module.exports = { frameStats, toFrameTimes, cleanFrameTimes, createFrameRing, createFrameHistogram, MIN_FRAMES_LOW1, MIN_FRAMES_LOW01 };

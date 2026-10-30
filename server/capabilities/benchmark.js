'use strict';
// Benchmark capability: start or stop a frame-time recording of the running
// game (server/benchmark.js), or show the last saved file in the file manager.
// The result names the file, never its path.
//
// deps (injected):
//   fps    the fps-monitor.js facade: a benchmark needs single frame times
//   bench  { store() → the benchmark runner, reveal(path) → opens the folder }

const MODES = Object.freeze(['toggle', 'start', 'stop', 'reveal']);

// Single frame times come from PresentMon only: MangoHud on Linux reports a
// rate, and macOS has no frame rate for another app at all.
function available(fps) {
  return !!(fps && fps.backend === 'presentmon' && typeof fps.getFramesSince === 'function'
    && typeof fps.isAvailable === 'function' && fps.isAvailable());
}

async function run(d, action) {
  const b = d && d.bench && typeof d.bench.store === 'function' ? d.bench.store() : null;
  if (!b) return { ok: false, error: 'unavailable' };
  const mode = MODES.includes(action.mode) ? action.mode : 'toggle';
  if (mode === 'reveal') {
    const file = b.lastFile();
    if (!file) return { ok: false, error: 'no_file' };
    d.bench.reveal(file);
    return { ok: true, shown: true };
  }
  if (mode === 'start') return b.start();
  if (mode === 'stop') return b.stop();
  return b.toggle();
}

module.exports = { MODES, available, run };

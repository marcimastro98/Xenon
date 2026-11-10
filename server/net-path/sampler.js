'use strict';
// Runs probe() every periodMs, one call at a time, and hands each answer to
// onSample. Only index.js starts one, while a granted widget reads net-path, and
// it stops them IDLE_MS after the last read: this is the widget's own cadence,
// never a server poll. The timer is unref'd so it never holds the process open.

function createSampler(probe, onSample, { periodMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  let timer = null;
  let stopped = false;

  const arm = (ms) => {
    timer = setTimer(tick, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  async function tick() {
    timer = null;
    const started = now();
    let value = null;
    try { value = await probe(); } catch { value = null; }
    if (stopped) return;
    onSample(value);
    arm(Math.max(0, periodMs - (now() - started)));
  }

  arm(0);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    dead: () => false,
  };
}

module.exports = { createSampler };

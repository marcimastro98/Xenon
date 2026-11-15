'use strict';
// The moment of a purchase, run only after the hub said yes: Sparks leave the price and
// reach Bit in crisp steps, the way Bit moves, while the balance counts down. Nothing
// moves with reduced motion or on a low-power GPU.
(function () {
  const FLIGHTS = 6;
  const FLIGHT_MS = 520;
  const FLIGHT_GAP_MS = 75;
  const FLIGHT_STEPS = 13;
  const FLIGHT_FAN = 22;   // how far apart the paths bow, in px
  const FLIGHT_LIFT = 26;  // how far above the straight line they arc
  const FLIGHT_RISE = 5;   // each spark arcs a little higher than the one before
  const SPARK_HALF = 15;
  const COUNT_MS = 800;

  const still = () => document.body.classList.contains('low-power-gpu')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function create(overlay) {
    const runs = [];
    let raf = 0;
    let release = null;

    function fly(from, to) {
      if (still()) return Promise.resolve();
      const base = overlay.getBoundingClientRect();
      const at = (node) => {
        const r = node.getBoundingClientRect();
        return [r.left - base.left + r.width / 2 - SPARK_HALF, r.top - base.top + r.height / 2 - SPARK_HALF];
      };
      const [sx, sy] = at(from);
      const [ex, ey] = at(to);
      const layer = makeEl('div', 'buy-flight');
      layer.setAttribute('aria-hidden', 'true');
      overlay.appendChild(layer);
      const landed = [];
      for (let i = 0; i < FLIGHTS; i += 1) {
        const mx = (sx + ex) / 2 + (i - (FLIGHTS - 1) / 2) * FLIGHT_FAN;
        const my = Math.min(sy, ey) + (sy - ey) / 4 - FLIGHT_LIFT - i * FLIGHT_RISE;
        const node = window.BuySheetParts.spark('buy-fly', { still: true });
        layer.appendChild(node);
        const run = node.animate(
          [{ transform: `translate(${sx}px,${sy}px)` }, { transform: `translate(${mx}px,${my}px)`, offset: 0.55 }, { transform: `translate(${ex}px,${ey}px)` }],
          { duration: FLIGHT_MS, delay: i * FLIGHT_GAP_MS, easing: `steps(${FLIGHT_STEPS}, end)`, fill: 'both' },
        );
        runs.push(run);
        landed.push(run.finished.catch(() => {}));
      }
      return Promise.all(landed).then(() => layer.remove());
    }

    function count(from, to, show) {
      if (still() || !Number.isInteger(from) || !Number.isInteger(to) || from <= to) return Promise.resolve();
      return new Promise((resolve) => {
        release = resolve;
        const start = performance.now();
        const step = (now) => {
          // The first frame's timestamp can predate start: never count upwards.
          const p = Math.min(1, Math.max(0, (now - start) / COUNT_MS));
          show(Math.round(from + (to - from) * p));
          if (p < 1) raf = requestAnimationFrame(step); else resolve();
        };
        raf = requestAnimationFrame(step);
      });
    }

    function stop() {
      for (const run of runs) run.cancel();
      cancelAnimationFrame(raf);
      if (release) release();
    }

    return { fly, count, stop };
  }

  window.BuySheetMotion = { create };
})();

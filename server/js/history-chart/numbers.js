// The numbers a history chart is drawn from, with no page in them: an axis of nice steps, the
// buckets that have a reading, one part as a series with its last and highest value, runs of
// readings, and where the ticks stand.
'use strict';

(() => {
  // Tick steps a person reads at a glance, times a power of ten (Apple's charts
  // guidance: "familiar sequences" such as 0, 5, 10 rather than 1, 6, 11).
  const NICE_STEPS = [1, 2, 2.5, 5, 10, 20, 25, 50];
  const MIN_SPAN = 4;          // a flat line still gets a readable axis

  // Two or three intervals of a nice step that cover min..max. Percentages are
  // always 0 to 100; `zero` starts the axis at 0 (watts).
  function niceScale(min, max, { pct = false, zero = false } = {}) {
    if (pct) return { lo: 0, hi: 100, ticks: [0, 50, 100] };
    let lo = zero ? 0 : min;
    let hi = Math.max(max, lo + MIN_SPAN);
    const mag = 10 ** Math.floor(Math.log10((hi - lo) / 3));
    for (const s of NICE_STEPS) {
      const step = s * mag;
      const a = Math.floor(lo / step) * step;
      const b = Math.ceil(hi / step) * step;
      if ((b - a) / step <= 3) {
        const ticks = [];
        for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
        return { lo: a, hi: b, ticks };
      }
    }
    return { lo, hi, ticks: [lo, hi] };
  }

  const reading = (p, key) => (p && p[key] && typeof p[key].avg === 'number' ? p[key] : null);

  // The buckets a chart draws: those where at least one of its parts has a
  // reading, side by side and in order. A bucket nobody reported in is dropped,
  // not kept as a hole (see pointsForRange in guardian-history.js).
  function axisBuckets(points, keys) {
    return (points || []).filter((p) => keys.some((k) => reading(p, k)));
  }

  // One part on the shared axis: its value per bucket (null where it said
  // nothing), the latest value and the highest reading of the range. `convert`
  // turns a stored reading into the unit shown (Celsius to Fahrenheit).
  function seriesOf(buckets, key, convert = (v) => v) {
    const values = buckets.map((p) => { const r = reading(p, key); return r ? convert(r.avg) : null; });
    let last = null;
    let peak = null;
    buckets.forEach((p) => {
      const r = reading(p, key);
      if (!r) return;
      last = convert(r.avg);
      const top = convert(typeof r.max === 'number' ? Math.max(r.max, r.avg) : r.avg);
      peak = peak == null ? top : Math.max(peak, top);
    });
    return { values, last, peak };
  }

  // Runs of consecutive readings: a part that was silent for a while is drawn as
  // separate pieces rather than a line through readings that do not exist.
  function segments(values) {
    const out = [];
    let run = [];
    values.forEach((v, i) => {
      if (v == null) { if (run.length) out.push(run); run = []; return; }
      run.push(i);
    });
    if (run.length) out.push(run);
    return out;
  }

  // Up to five tick positions; rank 0 are the ends, 1 the middle, 2 the
  // quarters, which a narrow chart leaves out (GuardianHistory.css).
  function tickIndexes(n) {
    if (n <= 1) return [{ i: 0, rank: 0 }];
    const at = (f) => Math.round(f * (n - 1));
    // The ends first, so a short axis keeps them as ends when the middle falls on one.
    const picks = [[0, 0], [n - 1, 0], [at(0.5), 1], [at(0.25), 2], [at(0.75), 2]];
    const seen = new Set();
    return picks
      .filter(([i]) => !seen.has(i) && seen.add(i))
      .map(([i, rank]) => ({ i, rank }))
      .sort((a, b) => a.i - b.i);
  }

  window.HistoryChartNumbers = { niceScale, axisBuckets, seriesOf, segments, tickIndexes };
})();

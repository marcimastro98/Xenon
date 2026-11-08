'use strict';

// One line chart of the sensor history. The System tile's History tab draws three
// (temperature, load, power), each with the parts that share its unit on one axis;
// the Power widget draws one per part. The lines stretch with the box (a viewBox
// drawn with preserveAspectRatio none and strokes that keep their width), while
// every word, the end dots and the crosshair are HTML placed in percent, so text
// never stretches with the lines and the chart needs no redraw when it resizes.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VB_W = 1000;
  const VB_H = 100;
  // Tick steps a person reads at a glance, times a power of ten (Apple's charts
  // guidance: "familiar sequences" such as 0, 5, 10 rather than 1, 6, 11).
  const NICE_STEPS = [1, 2, 2.5, 5, 10, 20, 25, 50];
  const MIN_SPAN = 4;          // a flat line still gets a readable axis
  const TOUCH_HOLD_MS = 4000;  // a value read with a tap stays this long
  const PART_NAMES = { cpu: 'CPU', gpu: 'GPU', ram: 'RAM' };

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

  function locale() {
    return (typeof i18n === 'object' && typeof lang === 'string' && i18n[lang] && i18n[lang].locale) || undefined;
  }

  // 'YYYY-MM-DDTHH' or 'YYYY-MM-DD' to a Date, in local time like the keys.
  function bucketDate(t) {
    const [day, hour] = String(t || '').split('T');
    const [y, m, d] = day.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, hour ? Number(hour) : 0);
  }

  // The hour in the user's clock (Settings → Time format, through utils.js
  // plainHourParts): bare on the axis ("17", "5 PM"), with its minutes where it
  // stands alone over the chart ("17:00", "5:00 PM").
  function hourText(date, minutes = false) {
    try {
      return date.toLocaleTimeString(locale(), plainHourParts({ minutes }));
    } catch {
      return minutes ? `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}` : String(date.getHours());
    }
  }

  function dayText(date, opts) {
    try { return date.toLocaleDateString(locale(), opts || { day: 'numeric', month: 'short' }); } catch { return `${date.getDate()}/${date.getMonth() + 1}`; }
  }

  // An axis label. Hourly buckets show the hour in the user's clock; when the
  // range crosses midnight the two ends also carry their day, so "9 PM" on the
  // left and "8 PM" on the right do not read as one hour going backwards.
  function tickText(t, withDay) {
    const date = bucketDate(t);
    if (!date) return String(t || '');
    if (!String(t).includes('T')) return dayText(date);
    return withDay ? `${dayText(date)}, ${hourText(date)}` : hourText(date);
  }

  // The moment a crosshair stands on, in full enough words to place it.
  function whenText(t) {
    const date = bucketDate(t);
    if (!date) return String(t || '');
    if (!String(t).includes('T')) return dayText(date, { weekday: 'short', day: 'numeric', month: 'short' });
    return `${dayText(date, { weekday: 'short' })} ${hourText(date, true)}`;
  }

  const fmt = (v, unit) => (v == null ? '--' : `${Math.round(v)}${unit}`);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
    return n;
  };

  // spec: { title, unit, pct, zero, convert?, parts: [{ key, part, name? }], solo }
  // `solo` is a chart of one part whose title already names it: its legend shows
  // the numbers alone. Returns null when no part has a reading in `points`.
  function build(spec, points, tr) {
    const keys = spec.parts.map((p) => p.key);
    const buckets = axisBuckets(points, keys);
    // A percentage axis is 0 to 100; a counter that overshoots must not draw above it.
    const shown = spec.convert || ((v) => v);
    const convert = spec.pct ? (v) => Math.min(100, Math.max(0, shown(v))) : shown;
    const parts = spec.parts
      .map((p) => ({ ...p, ...seriesOf(buckets, p.key, convert) }))
      .filter((p) => p.last != null);
    if (!parts.length) return null;

    const n = buckets.length;
    const all = parts.flatMap((p) => p.values.filter((v) => v != null));
    const scale = niceScale(Math.min(...all), Math.max(...all), spec);
    const xPct = (i) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
    const yPct = (v) => (1 - (v - scale.lo) / (scale.hi - scale.lo)) * 100;
    const word = (key, fallback) => (typeof tr === 'function' ? tr(key, fallback) : fallback);

    const card = el('div', 'guardian-chart');
    const head = el('div', 'guardian-chart-head');
    head.appendChild(el('span', 'guardian-chart-label', spec.title));
    const when = el('span', 'guardian-chart-when');
    when.hidden = true;
    head.appendChild(when);
    card.appendChild(head);

    const legend = el('div', 'guardian-legend');
    const valueEls = parts.map((p) => {
      const key = el('span', 'guardian-key');
      key.dataset.part = p.part;
      if (!spec.solo) {
        key.appendChild(el('i', 'guardian-swatch'));
        key.appendChild(el('span', 'guardian-key-name', p.name || PART_NAMES[p.part] || p.part));
      }
      const value = el('b', 'guardian-key-value', fmt(p.last, spec.unit));
      key.appendChild(value);
      key.appendChild(el('span', 'guardian-key-max', `${word('guardian_max', 'max')} ${fmt(p.peak, spec.unit)}`));
      legend.appendChild(key);
      return value;
    });
    card.appendChild(legend);

    const plot = el('div', 'guardian-plot');
    const area = el('div', 'guardian-area');
    const svg = svgEl('svg', { viewBox: `0 0 ${VB_W} ${VB_H}`, preserveAspectRatio: 'none', class: 'guardian-lines', 'aria-hidden': 'true' });
    scale.ticks.forEach((v) => {
      const y = (yPct(v) / 100) * VB_H;
      svg.appendChild(svgEl('line', { x1: 0, x2: VB_W, y1: y, y2: y, class: 'guardian-grid', 'vector-effect': 'non-scaling-stroke' }));
    });
    const toVb = (i, v) => [(xPct(i) / 100) * VB_W, (yPct(v) / 100) * VB_H];
    parts.forEach((p) => {
      segments(p.values).forEach((run) => {
        const pts = run.map((i) => toVb(i, p.values[i]));
        const d = pts.length > 1 && typeof SparkPath === 'object'
          ? SparkPath.smoothLineD(pts, 1)
          : `M${pts.map((q) => q.map((c) => c.toFixed(1)).join(',')).join(' L')}${pts.length === 1 ? ` L${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}` : ''}`;
        // One part alone gets a soft wash under its line; several would cover each other.
        if (parts.length === 1 && pts.length > 1) {
          const base = VB_H.toFixed(1);
          svg.appendChild(svgEl('path', { d: `${d} L${pts[pts.length - 1][0].toFixed(1)},${base} L${pts[0][0].toFixed(1)},${base} Z`, class: 'guardian-wash', 'data-part': p.part }));
        }
        svg.appendChild(svgEl('path', { d, class: 'guardian-line', 'data-part': p.part, 'vector-effect': 'non-scaling-stroke' }));
      });
    });
    area.appendChild(svg);

    // The latest reading of each part, at the end of its line.
    parts.forEach((p) => {
      const i = p.values.reduce((at, v, k) => (v == null ? at : k), -1);
      const dot = el('span', 'guardian-dot');
      dot.dataset.part = p.part;
      dot.style.left = `${xPct(i)}%`;
      dot.style.top = `${yPct(p.values[i])}%`;
      area.appendChild(dot);
    });
    const cross = el('span', 'guardian-cross');
    cross.hidden = true;
    area.appendChild(cross);
    plot.appendChild(area);

    // The ticks are evenly spaced from lo to hi, so the column spaces them itself
    // (GuardianHistory.css) and is as wide as its longest value.
    const yAxis = el('div', 'guardian-yaxis');
    yAxis.setAttribute('aria-hidden', 'true');
    scale.ticks.forEach((v) => yAxis.appendChild(el('span', 'guardian-ytick', fmt(v, spec.unit))));
    plot.appendChild(yAxis);

    const xAxis = el('div', 'guardian-xaxis');
    xAxis.setAttribute('aria-hidden', 'true');
    const dayOf = (t) => String(t || '').slice(0, 10);
    const crossesDay = n > 1 && String(buckets[0].t).includes('T') && dayOf(buckets[0].t) !== dayOf(buckets[n - 1].t);
    tickIndexes(n).forEach(({ i, rank }) => {
      const tick = el('span', 'guardian-xtick', tickText(buckets[i].t, crossesDay && rank === 0));
      tick.dataset.rank = String(rank);
      tick.dataset.edge = i === 0 ? 'start' : (i === n - 1 ? 'end' : '');
      tick.style.left = `${xPct(i)}%`;
      xAxis.appendChild(tick);
    });
    plot.appendChild(xAxis);
    card.appendChild(plot);

    // What a screen reader hears, and what the chart says with no pointer at all.
    const summary = parts.map((p) => `${p.name || PART_NAMES[p.part] || ''} ${fmt(p.last, spec.unit)}, ${word('guardian_max', 'max')} ${fmt(p.peak, spec.unit)}`.trim());
    area.setAttribute('role', 'img');
    area.setAttribute('aria-label', `${spec.title}: ${summary.join('; ')}`);
    area.tabIndex = 0;

    wireInspect({ card, area, cross, when, parts, buckets, valueEls, xPct, unit: spec.unit });
    return card;
  }

  // Pointing at the chart reads every part at that moment: the legend's numbers
  // become the values there and the head names the hour. A mouse reads while it
  // moves; a tap holds the reading a few seconds; the arrow keys walk the axis.
  // Nothing is lost without it: the legend always shows the latest and the peak.
  function wireInspect({ card, area, cross, when, parts, buckets, valueEls, xPct, unit }) {
    const n = buckets.length;
    let index = -1;
    let holdTimer = null;

    const show = (i) => {
      index = Math.max(0, Math.min(n - 1, i));
      card.classList.add('is-reading');
      cross.hidden = false;
      cross.style.left = `${xPct(index)}%`;
      when.hidden = false;
      when.textContent = whenText(buckets[index].t);
      parts.forEach((p, k) => { valueEls[k].textContent = fmt(p.values[index], unit); });
    };
    const reset = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      index = -1;
      card.classList.remove('is-reading');
      cross.hidden = true;
      when.hidden = true;
      parts.forEach((p, k) => { valueEls[k].textContent = fmt(p.last, unit); });
    };
    const indexAt = (clientX) => {
      const r = area.getBoundingClientRect();
      if (!r.width || n <= 1) return 0;
      return Math.round(((clientX - r.left) / r.width) * (n - 1));
    };

    area.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') show(indexAt(e.clientX)); });
    area.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') reset(); });
    area.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      show(indexAt(e.clientX));
      clearTimeout(holdTimer);
      holdTimer = setTimeout(reset, TOUCH_HOLD_MS);
    });
    area.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step) { e.preventDefault(); show(index < 0 ? n - 1 : index + step); }
      else if (e.key === 'Home') { e.preventDefault(); show(0); }
      else if (e.key === 'End') { e.preventDefault(); show(n - 1); }
      else if (e.key === 'Escape' && index >= 0) { e.preventDefault(); reset(); }
    });
    area.addEventListener('blur', reset);
  }

  window.HistoryChart = { build, niceScale, axisBuckets, seriesOf, segments, tickIndexes, tickText, whenText };
})();

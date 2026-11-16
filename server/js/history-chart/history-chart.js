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
  const { niceScale, axisBuckets, seriesOf, segments, tickIndexes } = window.HistoryChartNumbers;
  const TOUCH_HOLD_MS = 4000;  // a value read with a tap stays this long
  const PART_NAMES = { cpu: 'CPU', gpu: 'GPU', ram: 'RAM' };

  const { tickText, whenText, fmt } = window.HistoryChartWords;

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

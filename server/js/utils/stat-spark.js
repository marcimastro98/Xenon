// The small live graph under a reading.
'use strict';

// ── Live sparkline for stat cards ────────────────────────────────
// Replaces the static fill bar with a small animated history graph that
// rises/falls with the metric. The path morph is animated via `transition: d`
// (Chromium). History is kept per fill element id.
const _statSparkHist = {};
const STAT_SPARK_POINTS = 40;

function _statSparkColor(fillEl) {
  const c = ' ' + (fillEl.className || '') + ' ';
  if (c.includes(' cpu ')) return 'var(--green)';
  if (c.includes(' gpu ')) return 'var(--blue)';
  if (c.includes(' ram ')) return 'var(--amber)';
  if (c.includes(' disk ')) return '#c084fc';
  if (c.includes('net-ping')) return 'var(--green)';
  if (c.includes('net-fps')) return '#7c5cff';
  if (c.includes('net-latency')) return '#ff8a3d';
  if (c.includes('net-down')) return 'var(--cyan)';
  return 'var(--accent)';
}

// Drop a fill element's sparkline history so the next render starts a fresh
// series. Used when a card's underlying metric changes (e.g. GPU load ↔ VRAM),
// otherwise the two unrelated series would blend into one misleading graph.
function resetStatSparkFor(fillEl) {
  if (!fillEl) return;
  const track = fillEl.parentElement;
  const key = fillEl.id || (track && track.dataset ? track.dataset.sparkKey : null);
  if (key && _statSparkHist[key]) delete _statSparkHist[key];
}

function renderStatSpark(fillEl, value) {
  if (!fillEl) return;
  const track = fillEl.parentElement;
  if (!track || !track.classList || !track.classList.contains('stat-track')) return;
  const key = fillEl.id || (track.dataset.sparkKey || (track.dataset.sparkKey = 's' + Math.random().toString(36).slice(2)));

  let svg = track.querySelector('svg.stat-spark');
  if (!svg) {
    track.classList.add('has-spark');
    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'stat-spark');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    // Two stacked strokes, not one stroke plus a drop-shadow filter. The glow is
    // a wider, translucent copy of the same path drawn underneath: it reads like
    // a soft halo but costs one more ordinary stroke raster, whereas a
    // `filter: drop-shadow` on a path whose `d` is TRANSITIONING re-runs a
    // gaussian blur on every frame of every transition (see the sparkline note in
    // SystemPanel.css).
    const glow = document.createElementNS(NS, 'path');
    glow.setAttribute('class', 'stat-spark-glow');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'stat-spark-line');
    // The soft fill under the line, drawn only on looks that ask for it (hidden by default).
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('class', 'stat-spark-area');
    svg.append(area, glow, line);
    svg.style.color = _statSparkColor(fillEl);
    track.appendChild(svg);
  }

  const hist = _statSparkHist[key] || (_statSparkHist[key] = []);
  hist.push(value);
  if (hist.length > STAT_SPARK_POINTS) hist.shift();

  const n = hist.length;
  const stepX = n > 1 ? 100 / (n - 1) : 100;
  // Auto-scale the Y axis to the recent min/max so even small fluctuations
  // fill the chart with visible peaks/valleys (a flat value stays centred).
  let min = Infinity, max = -Infinity;
  for (const val of hist) { if (val < min) min = val; if (val > max) max = val; }
  const range = (max - min) || 1;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const norm = max === min ? 0.5 : (hist[i] - min) / range;
    pts.push([i * stepX, 3 + (1 - norm) * 24]);
  }
  // Monotone cubic, not a polyline: the series is spiky by nature (a ping that
  // flips between two values, a GPU that idles then jumps) and straight joins
  // read as a saw. SparkPath never overshoots, so a smoothed peak still sits on
  // the sample it came from — and it emits the same command COUNT the polyline
  // did, which is what `transition: d` needs to keep interpolating.
  const path = SparkPath.smoothLineD(pts, 2);
  svg.querySelectorAll('.stat-spark-line, .stat-spark-glow').forEach(p => p.setAttribute('d', path));
  svg.querySelector('.stat-spark-area').setAttribute('d', `${path} L100 30 L0 30 Z`);
}

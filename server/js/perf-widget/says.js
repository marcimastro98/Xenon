// What the FPS tile says and draws its numbers from: a stat box, the hints of the less known
// numbers, the path of the frame graph, durations, the sentence about the last game, and the three
// alerts it raises.
'use strict';

(() => {
  const el = makeEl;        // shared DOM factory (utils.js)

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const GRAPH_W = 120;
  const GRAPH_H = 40;

  // `hint` says what the number means, on hover and to screen readers: the
  // tile stays dense, and "1% low" is not a term everyone knows.
  const HINT_LOW1 = ['perf_low1_hint', 'The frame rate of the slowest 1% of frames: the lower it is against the FPS, the more the game stutters.'];
  const HINT_LOW01 = ['perf_low01_hint', 'The frame rate of the slowest 0.1% of frames: the rare, longest hitches.'];
  const HINT_FRAME = ['perf_frametime_hint', 'How long one frame takes on average, in milliseconds. Lower is smoother.'];

  function stat(cls, labelKey, fallback, hint) {
    const box = el('div', 'perfw-stat ' + cls);
    if (hint) box.title = t(hint[0], hint[1]);
    const value = el('b', 'perfw-stat-val', '--');
    const label = el('span', 'perfw-stat-label', t(labelKey, fallback));
    box.append(label, value);
    return { box, value, label };
  }

  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '--' : String(Math.round(Number(v))));

  // A polyline, not a smoothed curve: a stutter IS a spike, and smoothing it
  // would hide the one thing this graph is for.
  function graphPath(frames) {
    const list = Array.isArray(frames) ? frames.filter((v) => Number.isFinite(v) && v > 0) : [];
    if (list.length < 2) return '';
    const top = Math.max(16.7, ...list) * 1.1;
    const step = GRAPH_W / (list.length - 1);
    return list.map((v, i) => (i ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + (GRAPH_H - (v / top) * GRAPH_H).toFixed(1)).join(' ');
  }

  // "1 h 12 min" / "45 min": how long the last game lasted.
  function duration(sec) {
    const m = Math.max(1, Math.round((Number(sec) || 0) / 60));
    if (m < 60) return t('perf_dur_m', '{m} min').replace('{m}', String(m));
    return t('perf_dur_hm', '{h} h {m} min').replace('{h}', String(Math.floor(m / 60))).replace('{m}', String(m % 60));
  }

  // One plain sentence: which game the numbers are from, against the time before.
  function lastText(last) {
    const d = Number(last.deltaAvgFps);
    if (last.deltaAvgFps == null || !Number.isFinite(d)) return t('perf_last', 'Last game');
    const n = Math.round(Math.abs(d));
    if (n < 1) return t('perf_last_same', 'Last game, same as the time before');
    const key = d > 0 ? 'perf_last_more' : 'perf_last_less';
    const fb = d > 0 ? 'Last game, {n} FPS more than the time before' : 'Last game, {n} FPS less than the time before';
    return t(key, fb).replace('{n}', String(n));
  }

  // "Benchmark 1:05" in place of the game name: the person knows which game
  // they are in, and this is what tells them the run is recording.
  function benchText(b) {
    const s = Math.max(0, Math.floor(Number(b.elapsedS) || 0));
    return t('perf_bench', 'Benchmark {t}').replace('{t}', Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
  }

  function tempText(celsius) {
    const v = typeof toDisplayHwTemp === 'function' ? toDisplayHwTemp(celsius) : celsius;
    return num(v) + '°' + (typeof hwTempUnitSuffix === 'function' ? hwTempUnitSuffix() : 'C');
  }

  // "Why does it stutter?" answered (SSE 'stutter_why'): same rule as above.
  function onStutterWhy(d) {
    if (!window.XenonToast || !window.AlertToasts) return;
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    const toast = window.AlertToasts.stutterWhy(d, { t });
    if (toast) window.XenonToast.show(toast);
  }

  // Exclusive full screen with widgets over the game (SSE 'exclusive_hint').
  function onExclusiveHint(d) {
    if (!window.XenonToast || !window.AlertToasts) return;
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    const toast = window.AlertToasts.exclusiveHint(d, { t });
    if (toast) window.XenonToast.show(toast);
  }

  // FPS needs a Windows permission (SSE 'fps_access', once per version).
  function onFpsAccess(d) {
    if (!window.XenonToast || !window.AlertToasts) return;
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    const toast = window.AlertToasts.fpsAccess(d, { t });
    if (toast) window.XenonToast.show(toast);
  }

  window.PerfWidgetSays = {
    el, t, GRAPH_W, GRAPH_H, HINT_LOW1, HINT_LOW01, HINT_FRAME, stat, num, graphPath, duration,
    lastText, benchText, tempText, onStutterWhy, onExclusiveHint, onFpsAccess,
  };
})();

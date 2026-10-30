'use strict';
// Game performance tile: the running game's frame rate, its 1% and 0.1% lows,
// a graph of the newest frame times, and CPU/GPU load with the GPU temperature.
// Fed by SSE 'perf' (four times a second, only while a game runs and a tile
// shows it; seed: GET /perf) and by the 'system' tick for the hardware row.
// Between games it shows the last one played (server/game-sessions.js, carried
// by the idle reading as `last`) and how it compares with the time before.
// While a benchmark records (server/benchmark.js), the head says so, with the time.
// While the game stutters, one line under the graph says why (stutter-why.js).
// Built once per tile, then only text and one path change, because this tile is
// meant to sit over a game and every repaint there costs the game a little.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GRAPH_W = 120;
  const GRAPH_H = 40;
  const HUD_PARTS = ['low1', 'low01', 'frame', 'graph', 'hw'];

  let perf = { active: false };
  let sys = null;
  let seeded = false;
  const built = new WeakMap();   // tile → its element refs

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="perf"]'))
      .filter((n) => n.closest('.pager-page, .layer-slot'));
  }

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

  function build(mount) {
    const wrap = el('div', 'perfw-wrap');
    const head = el('div', 'perfw-head');
    const game = el('span', 'perfw-game');
    head.append(el('span', 'perfw-title', t('layout_widget_perf', 'Game performance')), game);

    const main = el('div', 'perfw-main');
    const fps = el('div', 'perfw-fps');
    const fpsVal = el('b', null, '--');
    fps.append(fpsVal, el('span', 'perfw-unit', 'FPS'));
    const lows = el('div', 'perfw-lows');
    const low1 = stat('is-low1', 'perf_low1', '1% low', HINT_LOW1);
    const low01 = stat('is-low01', 'perf_low01', '0.1% low', HINT_LOW01);
    const frame = stat('is-frame', 'perf_frametime', 'Frame time', HINT_FRAME);
    lows.append(low1.box, low01.box, frame.box);
    main.append(fps, lows);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'perfw-graph');
    svg.setAttribute('viewBox', '0 0 ' + GRAPH_W + ' ' + GRAPH_H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('perf_graph', 'Frame times of the latest frames'));
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);

    const state = el('div', 'perfw-state');

    const hw = el('div', 'perfw-hw');
    const cpu = stat('is-cpu', 'perf_cpu', 'CPU');
    const gpu = stat('is-gpu', 'perf_gpu', 'GPU');
    const temp = stat('is-temp', 'perf_gpu_temp', 'GPU temp');
    hw.append(cpu.box, gpu.box, temp.box);

    wrap.append(head, main, svg, state, hw);
    mount.replaceChildren(wrap);
    const refs = { lang: curLang(), wrap, game, fpsVal, low1, low01, frame, path, state, cpu, gpu, temp };
    built.set(mount, refs);
    return refs;
  }

  const curLang = () => (typeof lang === 'string' ? lang : '');
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

  function idleText() {
    const platform = sys && sys.platform;
    if (platform === 'darwin') return t('perf_mac', 'A Mac cannot measure the frame rate of other apps.');
    if (platform === 'linux') return t('perf_linux', 'Start the game with MangoHud to see its frame rate.');
    // A game runs but draws no readable frames: say so, not "start a game".
    if (runningGame()) {
      return perf.reader === false
        ? t('perf_no_reader', 'Install PresentMon in Settings to see its frame rate.')
        : t('perf_unreadable', 'Its frame rate cannot be read right now.');
    }
    return t('perf_idle', 'Start a game to see its frame rate.');
  }

  // The game that runs while the reading is idle (server/perf-stream.js `game`).
  function runningGame() {
    const g = perf.active !== true && typeof perf.game === 'string' ? perf.game.trim() : '';
    return g.slice(0, 120).replace(/\.exe$/i, '');
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

  function lastSession() {
    const l = perf.active !== true && !runningGame() && perf.last;
    return l && typeof l === 'object' && Number(l.avgFps) > 0 ? l : null;
  }

  // "Why does it stutter?" while it does (server/stutter-why.js, `why` in the
  // reading, held for two system ticks): the cause in a few words, worded like
  // the toast. A smooth or capped game needs no line.
  function whyText() {
    const w = perf.why;
    if (!w || (w.verdict !== 'stutter' && w.verdict !== 'low') || !window.AlertToasts) return '';
    return window.AlertToasts.stutterLabel(w.reason, perf, { t });
  }

  // What the user chose to show besides the FPS (Settings, Performance;
  // js/perf-hud.js). `hubSettings` is the page's own copy: the dashboard's, or
  // the read-only one of a layer page. A class per hidden part, set only when
  // the choice changed, so the 4 Hz repaint over a game stays text-only.
  function hudParts() {
    const raw = typeof hubSettings !== 'undefined' && hubSettings ? hubSettings.perfHud : null;
    return window.PerfHud ? window.PerfHud.normalizePerfHud(raw) : null;
  }

  function applyHud(r) {
    const parts = hudParts();
    const key = parts ? JSON.stringify(parts) : '';
    if (r.hud === key) return;
    r.hud = key;
    for (const k of HUD_PARTS) r.wrap.classList.toggle('hud-no-' + k, !!parts && parts[k] === false);
  }

  function paintPerf(r) {
    applyHud(r);
    const on = perf.active === true;
    const last = lastSession();
    const src = on ? perf : (last || {});
    r.wrap.classList.toggle('is-idle', !on && !last);
    r.wrap.classList.toggle('is-last', !!last);
    const bench = on && perf.bench && typeof perf.bench === 'object' ? perf.bench : null;
    r.wrap.classList.toggle('is-bench', !!bench);
    r.game.textContent = bench ? benchText(bench)
      : on ? String(perf.process || '').replace(/\.exe$/i, '') : (last ? String(last.game || '') : runningGame());
    r.fpsVal.textContent = on ? num(perf.fps) : (last ? num(last.avgFps) : '--');
    r.low1.value.textContent = num(src.low1Fps);
    r.low01.value.textContent = num(src.low01Fps);
    r.low1.box.hidden = (on || !!last) && src.low1Fps == null;
    r.low01.box.hidden = (on || !!last) && src.low01Fps == null;
    if (last) {
      r.frame.label.textContent = t('perf_duration', 'Duration');
      r.frame.box.title = '';
      r.frame.value.textContent = duration(last.durationS);
    } else {
      r.frame.label.textContent = t('perf_frametime', 'Frame time');
      r.frame.box.title = t(HINT_FRAME[0], HINT_FRAME[1]);
      const avgMs = on && Number(perf.avgFps) > 0 ? 1000 / Number(perf.avgFps) : (on && Number(perf.fps) > 0 ? 1000 / Number(perf.fps) : null);
      r.frame.value.textContent = avgMs == null ? '--' : avgMs.toFixed(1) + ' ms';
    }
    r.path.setAttribute('d', on ? graphPath(perf.frames) : '');
    // A stutter's cause first; otherwise say an exclusive full screen hides the overlay.
    const why = on ? (whyText() || (perf.exclusive === true ? t('excl_line', 'Exclusive full screen: no widgets over it') : '')) : '';
    r.wrap.classList.toggle('is-why', !!why);
    r.state.textContent = on ? why : (last ? lastText(last) : idleText());
  }

  function paintSystem(r) {
    const s = sys || {};
    r.cpu.value.textContent = s.cpu == null ? '--' : num(s.cpu) + '%';
    r.gpu.value.textContent = s.gpu == null ? '--' : num(s.gpu) + '%';
    const temp = s.gpuTemp == null ? null
      : (typeof toDisplayHwTemp === 'function' ? toDisplayHwTemp(s.gpuTemp) : Math.round(Number(s.gpuTemp)));
    const unit = typeof hwTempUnitSuffix === 'function' ? hwTempUnitSuffix() : 'C';
    r.temp.value.textContent = temp == null ? '--' : num(temp) + '°' + unit;
    r.temp.box.hidden = temp == null;
  }

  function refsFor(tile) {
    const mount = tile.querySelector('.perf-widget-mount');
    if (!mount) return null;
    const r = built.get(mount);
    // Rebuilt when the language changed, or when something replaced the mount's content.
    return r && r.lang === curLang() && mount.firstChild === r.wrap ? r : build(mount);
  }

  async function seed() {
    seeded = true;
    const d = await api('/perf');
    if (d && typeof d === 'object') onPerf(d);
  }

  function renderWidgets() {
    const list = tiles();
    if (!list.length) { seeded = false; return; }
    list.forEach((tile) => {
      const r = refsFor(tile);
      if (r) { paintPerf(r); paintSystem(r); }
    });
    if (!seeded) seed();
  }

  function onPerf(d) {
    if (!d || typeof d !== 'object') return;
    perf = d;
    tiles().forEach((tile) => { const r = refsFor(tile); if (r) paintPerf(r); });
  }

  function onSystem(d) {
    if (!d || typeof d !== 'object') return;
    sys = d;
    tiles().forEach((tile) => { const r = refsFor(tile); if (r) { paintSystem(r); if (!perf.active) paintPerf(r); } });
  }

  function revealBenchmark() {
    api('/actions/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'benchmark', mode: 'reveal' }),
    });
  }

  // A benchmark started or ended (SSE 'benchmark'). One toast each, from the
  // main dashboard only: a layer window shows the tile, not a second toast.
  function onBenchmark(d) {
    if (!window.XenonToast || !window.AlertToasts) return;
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    // Worded in alert-toasts.js, shared with the on-screen alerts window.
    const toast = window.AlertToasts.benchmark(d, { t }, revealBenchmark);
    if (toast) window.XenonToast.show(toast);
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

  window.PerfWidget = { renderWidgets, onPerf, onSystem, onBenchmark, onStutterWhy, onExclusiveHint, graphPath };
})();

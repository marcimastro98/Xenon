'use strict';
// Game performance tile: the running game's frame rate, its 1% and 0.1% lows,
// a graph of the newest frame times, and the system readings the person chose
// (js/performance/perf-hud.js). Fed by SSE 'perf' (four times a second, only while a game runs
// and a tile shows it; seed: GET /perf), the 'system' tick for the hardware and
// 'perf_net' for ping and packet loss. Over a game it is text and nothing else.
// Between games it shows the last one played (server/performance/game-sessions.js, carried
// by the idle reading as `last`) and how it compares with the time before.
// While a benchmark records (server/performance/benchmark.js), the head says so, with the time.
// While the game stutters, one line under the graph says why (stutter-why.js).
// Built once per tile, then only text and one path change, because this tile is
// meant to sit over a game and every repaint there costs the game a little.
(function () {
  const {
    el, t, GRAPH_W, GRAPH_H, HINT_LOW1, HINT_LOW01, HINT_FRAME, stat, num, graphPath, duration,
    lastText, benchText, tempText, onStutterWhy, onExclusiveHint, onFpsAccess,
  } = window.PerfWidgetSays;
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SILENCE_MS = 3000;  // readings come four times a second
  const { PERF_HUD_GROUPS, PERF_HUD_SYSTEM, PERF_HUD_LABELS, PERF_HUD_SHORT, normalizePerfHud, statText } = window.PerfHud;

  let perf = { active: false };
  let sys = null;
  let net = null;
  let seeded = false;
  let silenceTimer = null;
  const built = new WeakMap();   // tile → its element refs

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="perf"]'))
      .filter((n) => n.closest('.pager-page, .layer-slot'));
  }


  const overGame = () => document.documentElement?.dataset?.layer === 'overlay';

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
    const frame = stat('is-frame', 'perf_frame_short', 'Frame', HINT_FRAME);
    lows.append(low1.box, low01.box, frame.box);
    main.append(fps, lows);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'perfw-graph');
    svg.setAttribute('viewBox', '0 0 ' + GRAPH_W + ' ' + GRAPH_H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('perf_graph', 'Frame times of the latest frames'));
    const line = () => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      return svg.appendChild(p);
    };
    // The dark edge keeps the line readable over a bright game, without a filter
    // that would re-run on each of the four repaints a second.
    const edge = line();
    edge.setAttribute('class', 'perfw-graph-edge');
    const path = line();

    const state = el('div', 'perfw-state');

    const hw = el('div', 'perfw-hw');
    const system = {};
    for (const part of PERF_HUD_SYSTEM) {
      const short = PERF_HUD_SHORT[part];
      system[part] = stat('is-' + part, short, part, short === PERF_HUD_LABELS[part] ? null : [PERF_HUD_LABELS[part], part]);
      hw.appendChild(system[part].box);
    }

    wrap.append(head, main, svg, state, hw);
    mount.replaceChildren(wrap);
    // Over a game the window is cut to the words, and they have nothing to press, so
    // clicks go through them to whatever lies under (js/layers/layer-host.js).
    if (overGame()) {
      wrap.setAttribute('data-layer-fit', '');
      wrap.setAttribute('data-layer-through', '');
      window.LayerHost?.fitTo?.(wrap);
    }
    const refs = { lang: curLang(), wrap, game, fpsVal, low1, low01, frame, edge, path, state, system };
    built.set(mount, refs);
    return refs;
  }

  const curLang = () => (typeof lang === 'string' ? lang : '');

  function idleText() {
    const platform = sys && sys.platform;
    if (platform === 'darwin') return t('perf_mac', 'A Mac cannot measure the frame rate of other apps.');
    if (platform === 'linux') return t('perf_linux', 'Start the game with MangoHud to see its frame rate.');
    // A game runs but draws no readable frames. Only a missing reader or a
    // Windows permission has a fix to offer; otherwise the numbers come back by
    // themselves, so nothing is said.
    if (runningGame()) {
      if (perf.reader === false) return t('perf_no_reader', 'Install PresentMon in Settings to see its frame rate.');
      if (perf.access === 'signin') return t('perf_fps_signin', 'Sign out of Windows and back in to see its frame rate.');
      if (perf.access === 'rights') return t('perf_fps_rights', 'Allow FPS in Settings to see its frame rate.');
      return '';
    }
    return t('perf_idle', 'Start a game to see its frame rate.');
  }

  // The game that runs while the reading is idle (server/performance/perf-stream.js `game`).
  function runningGame() {
    const g = perf.active !== true && typeof perf.game === 'string' ? perf.game.trim() : '';
    return g.slice(0, 120).replace(/\.exe$/i, '');
  }

  function lastSession() {
    const l = !overGame() && perf.active !== true && !runningGame() && perf.last;
    return l && typeof l === 'object' && Number(l.avgFps) > 0 ? l : null;
  }

  // "Why does it stutter?" while it does (server/performance/stutter-why.js, `why` in the
  // reading, held for two system ticks): the cause in a few words, worded like
  // the toast. A smooth or capped game needs no line.
  function whyText() {
    const w = perf.why;
    if (!w || (w.verdict !== 'stutter' && w.verdict !== 'low') || !window.AlertToasts) return '';
    const label = window.AlertToasts.stutterLabel(w.reason, perf, { t });
    // The program that weighs on the PC, when there is one: "browser 3.3 GB".
    const app = label && window.AlertToasts.stutterAppShort ? window.AlertToasts.stutterAppShort(w, { t }) : '';
    return app ? label + ' · ' + app : label;
  }

  // What the user chose to show (Settings, Performance, or the Overlay section of
  // the menu; js/performance/perf-hud.js). `hubSettings` is the page's own copy: the dashboard's,
  // or the read-only one of a layer page. A class per hidden part, set only when
  // the choice changed, so the 4 Hz repaint over a game stays text-only.
  function hudParts() {
    return normalizePerfHud(typeof hubSettings !== 'undefined' && hubSettings ? hubSettings.perfHud : null);
  }

  function applyHud(r) {
    const parts = hudParts();
    const key = JSON.stringify(parts);
    if (r.hud === key) return;
    r.hud = key;
    for (const k of PERF_HUD_GROUPS.game) r.wrap.classList.toggle('hud-no-' + k, !parts[k]);
    for (const k of PERF_HUD_SYSTEM) r.system[k].box.classList.toggle('is-off', !parts[k]);
    r.wrap.classList.toggle('hud-no-hw', !PERF_HUD_SYSTEM.some((k) => parts[k]));
    r.wrap.classList.toggle('hud-row', parts.layout === 'row');
  }

  function paintPerf(r) {
    applyHud(r);
    const on = perf.active === true;
    const last = lastSession();
    const src = on ? perf : (last || {});
    r.wrap.classList.toggle('is-idle', !on && !last);
    r.wrap.classList.toggle('is-last', !!last);
    r.wrap.classList.toggle('is-nofps', sys?.platform === 'darwin');
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
      r.frame.label.textContent = t('perf_frame_short', 'Frame');
      r.frame.box.title = t(HINT_FRAME[0], HINT_FRAME[1]);
      const avgMs = on && Number(perf.avgFps) > 0 ? 1000 / Number(perf.avgFps) : (on && Number(perf.fps) > 0 ? 1000 / Number(perf.fps) : null);
      r.frame.value.textContent = avgMs == null ? '--' : avgMs.toFixed(1) + ' ms';
    }
    const d = on ? graphPath(perf.frames) : '';
    r.path.setAttribute('d', d);
    r.edge.setAttribute('d', d);
    // Over a game the widget is numbers only, never a sentence: the same facts stay on
    // the dashboard tile, in Bit's answers and in the "Why does it stutter?" toast.
    // Elsewhere a stutter's cause comes first, then that exclusive full screen hides the overlay.
    const why = on && !overGame() ? (whyText() || (perf.exclusive === true ? t('excl_line', 'Exclusive full screen: no widgets over it') : '')) : '';
    r.wrap.classList.toggle('is-why', !!why);
    r.state.textContent = overGame() ? '' : (on ? why : (last ? lastText(last) : idleText()));
  }

  function paintSystem(r) {
    for (const k of PERF_HUD_SYSTEM) r.system[k].value.textContent = statText(k, sys, net, tempText);
    // On by default, so a machine with no such sensor gets no dash it never asked for.
    r.system.gpuTemp.box.hidden = r.system.gpuTemp.value.textContent === '--';
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

  // The stream ends a game with one message: a page that missed it (server
  // restart, sleep) would show the last FPS for good, so silence means ask again.
  function watchForSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = perf.active && tiles().length ? setTimeout(seed, SILENCE_MS) : null;
  }

  function onPerf(d) {
    if (!d || typeof d !== 'object') return;
    perf = d;
    tiles().forEach((tile) => { const r = refsFor(tile); if (r) paintPerf(r); });
    watchForSilence();
  }

  function onSystem(d) {
    if (!d || typeof d !== 'object') return;
    sys = d;
    tiles().forEach((tile) => { const r = refsFor(tile); if (r) { paintSystem(r); if (!perf.active) paintPerf(r); } });
  }

  // Ping and packet loss, sent only while someone chose them (server/performance/perf-net.js).
  function onNet(d) {
    if (!d || typeof d !== 'object') return;
    net = d;
    tiles().forEach((tile) => { const r = refsFor(tile); if (r) paintSystem(r); });
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

  // An app in a window that draws like a game (SSE 'game_guess', asked once). Not
  // on a paired device: the lists are the PC's, and a phone may not change them.
  function onGameGuess(d) {
    if (!window.XenonToast || !window.AlertToasts || window.__xenonRemote) return;
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    const ctx = { t };
    const toast = window.AlertToasts.gameGuess(d, ctx, async (name, isGame) => {
      const out = await apiJson(SERVER + '/actions/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: isGame ? 'gameAlways' : 'gameIgnore', mode: 'add', name }),
      });
      window.XenonToast.show(window.AlertToasts.gameGuessDone(name, isGame, out, ctx));
    });
    // A question nobody asked for: it follows the master Notifiche switch.
    if (toast && typeof showAlertToast === 'function') showAlertToast(toast);
  }

  window.PerfWidget = { renderWidgets, onPerf, onSystem, onNet, onBenchmark, onStutterWhy, onExclusiveHint, onFpsAccess, onGameGuess, graphPath };
})();

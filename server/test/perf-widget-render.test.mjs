// js/perf-widget.js: the Game performance tile. Pinned here: idle says why in
// the words of THIS platform, live readings land in the right cells, the graph
// is a real path, game names are text (never markup), and a tile is built once
// and then only repainted, because it is meant to sit over a running game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { makeDom, settle } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'perf-widget.js'), 'utf8');
const LABELS = {
  perf_idle: 'Start a game', perf_unreadable: 'Cannot be read', perf_no_reader: 'Install PresentMon', perf_mac: 'Mac cannot', perf_linux: 'Use MangoHud', layout_widget_perf: 'Game performance',
  perf_last_more: 'Last game, {n} FPS more', perf_last_less: 'Last game, {n} FPS less',
  perf_last_same: 'Last game, same', perf_last: 'Last game', perf_duration: 'Duration',
  perf_dur_hm: '{h} h {m} min', perf_dur_m: '{m} min', perf_frametime: 'Frame time',
  perf_bench: 'Benchmark {t}', deck_act_benchmark: 'Benchmark', bench_running: 'Running', bench_saved: 'Saved',
  bench_saved_msg: '{avg} avg, low {low}', bench_show: 'Show', bench_too_short: 'Too short', bench_no_frames: 'No frames', bench_failed: 'Failed',
};

const LIVE = { active: true, process: 'Cyberpunk2077.exe', fps: 143.6, avgFps: 125, low1Fps: 88.2, low01Fps: null, frames: [7, 8, 30, 7] };

function mount({ seed = { active: false }, where = 'pager-page', layer = false } = {}) {
  const dom = makeDom();
  const { document, mkEl } = dom;
  const page = mkEl('div');
  page.className = where;
  document.body.appendChild(page);
  const tile = mkEl('section');
  tile.setAttribute('data-dashboard-widget', 'perf');
  page.appendChild(tile);
  const host = mkEl('div');
  host.className = 'perf-widget-mount';
  tile.appendChild(host);
  const calls = [];
  const posts = [];
  const toasts = [];
  const sandbox = {
    document,
    isLayerPage: () => layer,
    XenonToast: { show: (o) => toasts.push(o) },
    AlertToasts: createRequire(import.meta.url)('../js/alert-toasts.js'),
    makeEl: (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    apiJson: async (p, opts) => {
      if (opts && opts.method === 'POST') { posts.push({ p, body: JSON.parse(opts.body) }); return { ok: true }; }
      calls.push(p);
      return seed;
    },
    lang: 'en',
    toDisplayHwTemp: (c) => c * 9 / 5 + 32,
    hwTempUnitSuffix: () => 'F',
    t: (k) => LABELS[k] || k,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'perf-widget.js' });
  const q = (sel) => host.querySelector(sel);
  return { ...dom, sandbox, tile, host, calls, posts, toasts, q, W: sandbox.PerfWidget };
}

test('without a game it dims and says why, in this platform\'s words', async () => {
  const m = mount();
  m.W.renderWidgets();
  await settle();
  assert.deepEqual(m.calls, ['/perf'], 'seeded once');
  assert.ok(m.q('.perfw-wrap').classList.contains('is-idle'));
  assert.equal(m.q('.perfw-fps b').textContent, '--');
  assert.equal(m.q('.perfw-state').textContent, 'Start a game');
  m.W.onSystem({ platform: 'darwin', cpu: 12 });
  assert.equal(m.q('.perfw-state').textContent, 'Mac cannot');
  m.W.onSystem({ platform: 'linux' });
  assert.equal(m.q('.perfw-state').textContent, 'Use MangoHud');
  m.W.renderWidgets();
  assert.equal(m.calls.length, 1, 'not seeded again while the tile stays');
});

test('a live reading fills the cells and draws the frame times', async () => {
  const m = mount({ seed: LIVE });
  m.W.renderWidgets();
  await settle();
  assert.ok(!m.q('.perfw-wrap').classList.contains('is-idle'));
  assert.equal(m.q('.perfw-game').textContent, 'Cyberpunk2077');
  assert.equal(m.q('.perfw-fps b').textContent, '144');
  assert.equal(m.q('.is-low1 .perfw-stat-val').textContent, '88');
  assert.equal(m.q('.is-low01').hidden, true, 'too few frames for a 0.1% low: hidden, not a fake number');
  assert.equal(m.q('.is-frame .perfw-stat-val').textContent, '8.0 ms');
  assert.equal(m.q('.is-low1').title, 'perf_low1_hint', 'what a low means, on hover and to screen readers');
  assert.equal(m.q('.is-frame').title, 'perf_frametime_hint');
  assert.match(m.q('path').getAttribute('d'), /^M0\.0 [\d.]+( L[\d.]+ [\d.]+){3}$/);
  m.W.onPerf({ active: false });
  assert.equal(m.q('path').getAttribute('d'), '');
  assert.equal(m.q('.perfw-game').textContent, '');
  assert.equal(m.q('.is-low01').hidden, false);
});

test('the hardware row uses the user\'s temperature unit and hides a missing reading', () => {
  const m = mount();
  m.W.renderWidgets();
  m.W.onSystem({ cpu: 41.4, gpu: 97.6, gpuTemp: 70 });
  assert.equal(m.q('.is-cpu .perfw-stat-val').textContent, '41%');
  assert.equal(m.q('.is-gpu .perfw-stat-val').textContent, '98%');
  assert.equal(m.q('.is-temp .perfw-stat-val').textContent, '158°F');
  m.W.onSystem({ cpu: null, gpu: null, gpuTemp: null });
  assert.equal(m.q('.is-cpu .perfw-stat-val').textContent, '--');
  assert.equal(m.q('.is-temp').hidden, true);
});

test('a game name is text, never markup', () => {
  const m = mount();
  m.W.renderWidgets();
  m.W.onPerf({ ...LIVE, process: '<img src=x onerror=alert(1)>.exe' });
  const game = m.q('.perfw-game');
  assert.equal(game.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(game.children.length, 0);
  assert.doesNotMatch(SRC, /innerHTML/);
});

test('built once, repainted after; rebuilt for a new language', () => {
  const m = mount();
  m.W.renderWidgets();
  const wrap = m.q('.perfw-wrap');
  for (let i = 0; i < 20; i++) m.W.onPerf({ ...LIVE, fps: 60 + i });
  assert.equal(m.q('.perfw-wrap'), wrap, 'four readings a second must not rebuild the tile');
  assert.equal(m.q('.perfw-fps b').textContent, '79');
  m.sandbox.lang = 'it';
  m.W.renderWidgets();
  assert.notEqual(m.q('.perfw-wrap'), wrap);
  assert.equal(m.q('.perfw-fps b').textContent, '79', 'the last reading survives the rebuild');
});

test('only tiles on a page or a layer slot are painted', () => {
  const m = mount({ where: 'palette-preview' });
  m.W.renderWidgets();
  m.W.onPerf(LIVE);
  assert.equal(m.host.children.length, 0);
  assert.deepEqual(m.calls, []);
});

test('the graph keeps a stutter as a spike and refuses junk', () => {
  const { graphPath } = mount().W;
  assert.equal(graphPath([]), '');
  assert.equal(graphPath([8]), '');
  assert.equal(graphPath(null), '');
  assert.equal(graphPath([8, NaN, -1, 8]), 'M0.0 22.6 L120.0 22.6');
  // The 50 ms frame touches the top band; the 8 ms frames sit low.
  const ys = graphPath([8, 50, 8]).split(/[ML]/).filter(Boolean).map((p) => Number(p.trim().split(' ')[1]));
  assert.ok(ys[1] < 5 && ys[0] > 30 && ys[2] > 30, ys.join(','));
});

test('between games it shows the last one and how it compares', async () => {
  const last = { game: 'cyberpunk2077', avgFps: 112.4, low1Fps: 71, low01Fps: null, durationS: 4320, deltaAvgFps: 12.3 };
  const m = mount({ seed: { active: false, last } });
  m.W.renderWidgets();
  await settle();
  const wrap = m.q('.perfw-wrap');
  assert.ok(wrap.classList.contains('is-last'));
  assert.ok(!wrap.classList.contains('is-idle'));
  assert.equal(m.q('.perfw-game').textContent, 'cyberpunk2077');
  assert.equal(m.q('.perfw-fps b').textContent, '112');
  assert.equal(m.q('.is-low1 .perfw-stat-val').textContent, '71');
  assert.equal(m.q('.is-low01').hidden, true, 'a low the PC could not measure is left out, not dashed');
  assert.equal(m.q('.is-frame .perfw-stat-label').textContent, 'Duration');
  assert.equal(m.q('.is-frame .perfw-stat-val').textContent, '1 h 12 min');
  assert.equal(m.q('.is-frame').title, '', 'a duration needs no frame time hint');
  assert.equal(m.q('.perfw-state').textContent, 'Last game, 12 FPS more');

  m.W.onPerf({ active: false, last: { ...last, deltaAvgFps: -0.4, durationS: 600 } });
  assert.equal(m.q('.perfw-state').textContent, 'Last game, same');
  assert.equal(m.q('.is-frame .perfw-stat-val').textContent, '10 min');
  m.W.onPerf({ active: false, last: { ...last, deltaAvgFps: -7.6 } });
  assert.equal(m.q('.perfw-state').textContent, 'Last game, 8 FPS less');
  m.W.onPerf({ active: false, last: { ...last, deltaAvgFps: null } });
  assert.equal(m.q('.perfw-state').textContent, 'Last game', 'a first session has nothing to compare');

  m.W.onPerf(LIVE);
  assert.ok(!wrap.classList.contains('is-last'), 'a running game wins over the last one');
  assert.equal(m.q('.is-frame .perfw-stat-label').textContent, 'Frame time');
  m.W.onPerf({ active: false, last: { game: 'x', avgFps: 0 } });
  assert.ok(wrap.classList.contains('is-idle'), 'junk is no last game');
});

test('a running benchmark takes the head with its time, and leaves with it', () => {
  const m = mount();
  m.W.renderWidgets();
  m.W.onPerf({ ...LIVE, bench: { elapsedS: 65 } });
  assert.ok(m.q('.perfw-wrap').classList.contains('is-bench'));
  assert.equal(m.q('.perfw-game').textContent, 'Benchmark 1:05');
  m.W.onPerf({ ...LIVE, bench: { elapsedS: 3725 } });
  assert.equal(m.q('.perfw-game').textContent, 'Benchmark 62:05');
  m.W.onPerf({ ...LIVE, bench: null });
  assert.ok(!m.q('.perfw-wrap').classList.contains('is-bench'));
  assert.equal(m.q('.perfw-game').textContent, 'Cyberpunk2077');
  m.W.onPerf({ active: false, bench: { elapsedS: 5 } });
  assert.ok(!m.q('.perfw-wrap').classList.contains('is-bench'), 'no game, no benchmark line');
});

test('a benchmark says when it starts and what it saved, once, on the dashboard only', async () => {
  const m = mount();
  m.W.onBenchmark({ running: true, game: 'cyberpunk2077' });
  m.W.onBenchmark({ running: false, result: { ok: true, game: 'cyberpunk2077', avgFps: 112.4, low1Fps: 71.2, file: 'x.csv' } });
  m.W.onBenchmark({ running: false, result: { ok: false, error: 'too_short' } });
  m.W.onBenchmark({ running: false, result: { ok: false, error: 'no_frames' } });
  m.W.onBenchmark({ running: false, result: { ok: false, error: 'write_failed' } });
  m.W.onBenchmark(null);
  assert.deepEqual(m.toasts.map((o) => [o.type, o.kicker, o.title, o.message || '']), [
    ['info', 'cyberpunk2077', 'Running', ''],
    ['success', 'cyberpunk2077', 'Saved', '112 avg, low 71'],
    ['error', 'Benchmark', 'Too short', ''],
    ['error', 'Benchmark', 'No frames', ''],
    ['error', 'Benchmark', 'Failed', ''],
  ]);
  assert.equal(m.toasts[1].important, true, 'the answer to what the user started is never held back');
  m.toasts[1].actions[0].onClick();
  await settle();
  assert.deepEqual(m.posts, [{ p: '/actions/run', body: { type: 'benchmark', mode: 'reveal' } }]);

  const gone = mount();
  gone.W.onBenchmark({ running: false, result: { ok: true, game: 'g', avgFps: 60, low1Fps: 50, file: 'x.csv', folderMissing: true } });
  assert.match(gone.toasts[0].message, /^60 avg, low 50 · \S/, 'the chosen folder is gone: said after the numbers');

  const layer = mount({ layer: true });
  layer.W.onBenchmark({ running: true, game: 'g' });
  assert.equal(layer.toasts.length, 0, 'a layer window shows the tile, not a second toast');
});

test('while the game stutters one line says why; smooth, capped or no game says nothing', () => {
  const m = mount();
  m.W.renderWidgets();
  const wrap = () => m.q('.perfw-wrap');
  const line = () => m.q('.perfw-state').textContent;
  m.W.onPerf({ ...LIVE, why: { verdict: 'stutter', reason: 'vram_full' } });
  assert.ok(wrap().classList.contains('is-why'));
  assert.equal(line(), 'Video memory full');
  m.W.onPerf({ ...LIVE, why: { verdict: 'low', reason: 'gpu_bound' } });
  assert.equal(line(), 'Graphics card at full load');
  for (const why of [{ verdict: 'smooth', reason: 'capped' }, { verdict: 'stutter', reason: '<b>x</b>' }, null]) {
    m.W.onPerf({ ...LIVE, why });
    assert.ok(!wrap().classList.contains('is-why'));
    assert.equal(line(), '');
  }
  m.W.onPerf({ active: false, why: { verdict: 'stutter', reason: 'loading' } });
  assert.ok(!wrap().classList.contains('is-why'), 'no game, no line');
});

test('the answer to "why does it stutter?" is one toast, on the dashboard only', () => {
  const m = mount();
  m.W.onStutterWhy({ ok: true, process: 'Cyberpunk2077.exe', verdict: 'smooth', reason: 'capped', cap: 60, fps: 60 });
  m.W.onStutterWhy({ ok: true, process: 'game.exe', verdict: 'stutter', reason: 'loading' });
  m.W.onStutterWhy({ ok: false, error: 'no_frames' });
  m.W.onStutterWhy({ ok: true, reason: 'made_up' });
  m.W.onStutterWhy(null);
  assert.deepEqual(m.toasts.map((o) => [o.type, o.kicker, o.title]), [
    ['success', 'Cyberpunk2077', 'Capped at 60 FPS'],
    ['info', 'game', 'Loading stutter'],
  ]);
  const layer = mount({ layer: true });
  layer.W.onStutterWhy({ ok: true, process: 'g', verdict: 'smooth', reason: 'smooth', fps: 90 });
  assert.equal(layer.toasts.length, 0);
});

// Measured in headless Edge at 120-260 px tall and 200-420 px wide: these are
// the rules that keep the why line (and the stacked lows) inside the tile.
test('on short or narrow tiles the why line takes the graph\'s place, then leaves', () => {
  const css = readFileSync(join(HERE, '..', 'components', 'PerfWidget', 'PerfWidget.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (query) => {
    const at = css.indexOf('@container ' + query + ' {');
    assert.ok(at >= 0, 'missing @container ' + query);
    return css.slice(at, css.indexOf('\n}', at));
  };
  assert.match(block('(max-height: 160px)'), /\.perfw-wrap\.is-why \.perfw-graph \{ display: none; \}/);
  assert.match(block('(max-width: 300px) and (max-height: 220px)'), /\.perfw-wrap\.is-why \.perfw-graph,\s*\.perfw-wrap\.is-why \.perfw-hw \{ display: none; \}/);
  const short = block('(max-width: 300px) and (max-height: 140px)');
  assert.match(short, /\.perfw-wrap\.is-why \.perfw-state \{ display: none; \}/);
  assert.match(short, /\.perfw-lows \{ display: none; \}/);
  assert.match(block('(max-height: 100px)'), /\.perfw-wrap\.is-why \.perfw-state \{ display: none; \}/);
  // Two lines, not an ellipsis: "Exclusive full screen: no widgets over it" lost its end in Italian at 300 px.
  const line = css.match(/\.perfw-wrap\.is-why \.perfw-state \{[^}]*\}/)[0];
  assert.match(line, /line-clamp: 2/);
  assert.doesNotMatch(line, /nowrap/);
  // "Производительность в игре" ran out of a 200 px tile: the title gives way too, after the game name.
  assert.match(css, /\.perfw-title \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
});

test('a game that runs but cannot be read is named, never "start a game"', () => {
  const m = mount();
  m.W.renderWidgets();
  m.W.onPerf({ active: false, game: 'Tabletop Simulator.exe' });
  const wrap = m.q('.perfw-wrap');
  assert.ok(wrap.classList.contains('is-idle'));
  assert.equal(m.q('.perfw-game').textContent, 'Tabletop Simulator');
  assert.equal(m.q('.perfw-state').textContent, 'Cannot be read');
  assert.equal(m.q('.perfw-fps b').textContent, '--');
  m.W.onPerf({ active: false, game: 'Tabletop Simulator.exe', reader: false });
  assert.equal(m.q('.perfw-state').textContent, 'Install PresentMon');
  // The last game waits for this one to end: its numbers are not this game's.
  m.W.onPerf({ active: false, game: 'Tabletop Simulator.exe', last: { game: 'old', avgFps: 90 } });
  assert.ok(!wrap.classList.contains('is-last'));
  assert.equal(m.q('.perfw-game').textContent, 'Tabletop Simulator');
  // A Mac keeps its own sentence; junk in `game` is no game.
  m.W.onSystem({ platform: 'darwin' });
  assert.equal(m.q('.perfw-state').textContent, 'Mac cannot');
  m.W.onSystem({ platform: 'win32' });
  m.W.onPerf({ active: false, game: { x: 1 } });
  assert.equal(m.q('.perfw-state').textContent, 'Start a game');
  assert.equal(m.q('.perfw-game').textContent, '');
  m.W.onPerf({ active: false });
  assert.equal(m.q('.perfw-state').textContent, 'Start a game');
});

test('exclusive full screen says why widgets cannot show over it, unless a stutter cause needs the line', () => {
  const m = mount();
  m.W.renderWidgets();
  m.W.onPerf({ ...LIVE, exclusive: true });
  assert.equal(m.q('.perfw-state').textContent, 'excl_line');
  assert.ok(m.q('.perfw-wrap').classList.contains('is-why'));
  m.W.onPerf({ ...LIVE, exclusive: true, why: { verdict: 'stutter', reason: 'vram_full' } });
  assert.notEqual(m.q('.perfw-state').textContent, 'excl_line');
  m.W.onPerf({ ...LIVE, exclusive: false });
  assert.equal(m.q('.perfw-state').textContent, '');
});

test('the exclusive full screen hint is one toast, on the dashboard only', () => {
  const m = mount();
  m.W.onExclusiveHint({ process: 'Game.exe' });
  assert.equal(m.toasts.length, 1);
  assert.equal(m.toasts[0].kicker, 'Game');
  const layer = mount({ layer: true });
  layer.W.onExclusiveHint({ process: 'Game.exe' });
  assert.equal(layer.toasts.length, 0);
  m.W.onExclusiveHint(null);
  assert.equal(m.toasts.length, 1);
});

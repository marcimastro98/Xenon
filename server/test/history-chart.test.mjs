// The History tab of the System tile and the Power widget's consumption history:
// one chart per unit with the parts that share it on one axis (history-chart.js),
// the screen time beside them (guardian-history.js), and the range in the tab bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partsOf, readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CHART_SRC = read('../js/history-chart.js');
const HISTORY_SRC = read('../js/guardian-history.js');
const CSS = read('../components/GuardianHistory/GuardianHistory.css');
const INDEX = read('../index.html');
// The real Settings → Time format helpers, so the axis hours go through them.
const UTILS = read('../js/utils.js');
const CLOCK_SRC = UTILS.slice(UTILS.indexOf('function clockUses12h()'), UTILS.indexOf('function toDateInputValue'));

function rig({ data = null, fahrenheit = false, clockFormat = 'auto', locale = null } = {}) {
  const dom = makeDom();
  const { document } = dom;
  const timers = [];
  const window = {};
  const ctx = {
    window,
    document,
    console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    fetch: async () => ({ json: async () => data }),
    t: (key) => key,
    aiFeatureEnabled: () => false,
    hubSettings: { sensorHistory: { enabled: true }, clockFormat },
    hwTempIsF: () => fahrenheit,
    ...(locale ? { i18n: { xx: { locale } }, lang: 'xx' } : {}),
  };
  vm.createContext(ctx);
  vm.runInContext(CLOCK_SRC, ctx);
  vm.runInContext(CHART_SRC, ctx);
  vm.runInContext(HISTORY_SRC, ctx);
  const body = document.createElement('div');
  body.id = 'sys-history-body';
  document.body.append(body);
  return { dom, document, window, body, timers, HC: window.HistoryChart };
}

const m = (avg, max = avg) => ({ avg, max });
const hour = (h, day = 7) => `2026-11-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}`;
function bucket(t, { watts = true } = {}) {
  const b = { t, cpuTemp: m(50, 61), gpuTemp: m(44, 52), cpu: m(20, 48), gpu: m(12, 30), mem: m(41, 44) };
  if (watts) Object.assign(b, { cpuWatts: m(40, 72), gpuWatts: m(90, 260) });
  return b;
}
const usage = {
  total: 36000,
  gameTotal: 11520,
  apps: [
    { name: 'FC27.exe', seconds: 11520, game: true },
    { name: 'chrome', seconds: 9600 },
    { name: 'Code', seconds: 6900 },
    { name: 'discord', seconds: 4200 },
    { name: 'spotify', seconds: 2880 },
    { name: 'explorer', seconds: 720 },
    { name: 'notepad', seconds: 300 },
  ],
};
const history = (hours, extra = {}) => ({ enabled: true, hours, days: [], usage: { ranges: { '24h': usage } }, ...extra });
const descendants = (dom, node) => dom.descendants(node);
// Values made inside the vm context carry its prototypes; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const fallback = (_key, text) => text;
const byClass = (dom, node, cls) => descendants(dom, node).filter((n) => n.classList.contains(cls));

// ── Scales and series (pure) ──

test('percentages always run 0 to 100 in halves', () => {
  const { HC } = rig();
  assert.deepEqual(plain(HC.niceScale(3, 41, { pct: true })), { lo: 0, hi: 100, ticks: [0, 50, 100] });
});

test('a scale covers its readings with at most three intervals of a familiar step', () => {
  const { HC } = rig();
  for (const [min, max, opts] of [[38, 74, {}], [30, 330, { zero: true }], [50, 50, {}], [0.4, 2.2, {}], [612, 640, {}]]) {
    const s = HC.niceScale(min, max, opts);
    assert.ok(s.lo <= min && s.hi >= max, `${min}..${max} inside ${s.lo}..${s.hi}`);
    assert.ok(s.ticks.length >= 2 && s.ticks.length <= 4, `ticks ${s.ticks}`);
    assert.equal(s.ticks[0], s.lo);
    assert.equal(s.ticks[s.ticks.length - 1], s.hi);
    const step = s.ticks[1] - s.ticks[0];
    s.ticks.forEach((v, i) => i && assert.ok(Math.abs(v - s.ticks[i - 1] - step) < 1e-9, 'evenly spaced'));
    if (opts.zero) assert.equal(s.lo, 0, 'watts start at zero');
  }
  // A flat line still gets an axis a person can read.
  assert.ok(HC.niceScale(50, 50).hi - HC.niceScale(50, 50).lo >= 4);
});

test('the axis keeps the buckets where a part spoke, and a silent stretch splits the line', () => {
  const { HC } = rig();
  const points = [{ t: 'a', cpu: m(1) }, { t: 'b' }, { t: 'c', gpu: m(2) }, { t: 'd', cpu: m(3, 9) }];
  const buckets = HC.axisBuckets(points, ['cpu', 'gpu']);
  assert.deepEqual(buckets.map((b) => b.t), ['a', 'c', 'd']);
  const s = HC.seriesOf(buckets, 'cpu');
  assert.deepEqual([...s.values], [1, null, 3]);
  assert.equal(s.last, 3);
  assert.equal(s.peak, 9, 'the peak is the highest reading, not the highest average');
  assert.deepEqual(plain(HC.segments(s.values)), [[0], [2]]);
  assert.equal(HC.seriesOf(buckets, 'cpu', (c) => c * 9 / 5 + 32).last, 3 * 9 / 5 + 32);
});

test('time labels: the ends first, then the middle, then the quarters', () => {
  const { HC } = rig();
  const pairs = (list) => plain(list).map(({ i, rank }) => [i, rank]);
  assert.deepEqual(pairs(HC.tickIndexes(1)), [[0, 0]]);
  assert.deepEqual(pairs(HC.tickIndexes(2)), [[0, 0], [1, 0]]);
  assert.deepEqual(pairs(HC.tickIndexes(3)), [[0, 0], [1, 1], [2, 0]]);
  assert.deepEqual(pairs(HC.tickIndexes(24)), [[0, 0], [6, 2], [12, 1], [17, 2], [23, 0]]);
});

// ── One chart ──

test('a chart with no reading for any of its parts is not drawn', () => {
  const { HC } = rig();
  assert.equal(HC.build({ title: 'Power', unit: ' W', parts: [{ key: 'cpuWatts', part: 'cpu' }] }, [{ t: hour(1), cpu: m(3) }], fallback), null);
});

test('parts that share a unit share one axis, each named in the legend with its latest value and peak', () => {
  const { dom, HC } = rig();
  const points = [bucket(hour(18)), bucket(hour(19)), { ...bucket(hour(20)), cpuTemp: m(66, 79) }];
  const card = HC.build({ title: 'Temperature', unit: '°', parts: [{ key: 'cpuTemp', part: 'cpu' }, { key: 'gpuTemp', part: 'gpu' }] }, points, fallback);
  const keys = byClass(dom, card, 'guardian-key');
  assert.deepEqual(keys.map((k) => k.dataset.part), ['cpu', 'gpu']);
  assert.equal(keys[0].textContent, 'CPU66°max 79°');
  assert.equal(byClass(dom, card, 'guardian-swatch').length, 2);
  // One line per part, no wash when two lines would cover each other.
  assert.equal(byClass(dom, card, 'guardian-line').length, 2);
  assert.equal(byClass(dom, card, 'guardian-wash').length, 0);
  const ticks = byClass(dom, card, 'guardian-ytick').map((n) => n.textContent);
  assert.equal(byClass(dom, card, 'guardian-grid').length, ticks.length, 'a grid line per value');
  assert.ok(ticks.every((v) => /^\d+°$/.test(v)), ticks.join(' '));
  // The end dots sit on the latest reading, at the right edge.
  assert.deepEqual(byClass(dom, card, 'guardian-dot').map((d) => d.style.left), ['100%', '100%']);
});

test('a chart of one part says the numbers alone and keeps a soft wash under its line', () => {
  const { dom, HC } = rig();
  const card = HC.build({ title: 'CPU', unit: ' W', zero: true, solo: true, parts: [{ key: 'cpuWatts', part: 'cpu' }] }, [bucket(hour(1)), bucket(hour(2))], fallback);
  assert.equal(byClass(dom, card, 'guardian-key-name').length, 0);
  assert.equal(byClass(dom, card, 'guardian-swatch').length, 0);
  assert.equal(byClass(dom, card, 'guardian-wash').length, 1);
  assert.equal(byClass(dom, card, 'guardian-ytick')[0].textContent, '0 W', 'watts start at zero');
});

test('the ends of an hourly axis carry the day only when the range crosses midnight', () => {
  const { dom, HC } = rig();
  const spec = { title: 'Load', unit: '%', pct: true, parts: [{ key: 'cpu', part: 'cpu' }] };
  const ends = (card) => byClass(dom, card, 'guardian-xtick').filter((n) => n.dataset.rank === '0');
  const sameDay = HC.build(spec, [bucket(hour(9)), bucket(hour(12)), bucket(hour(15))], fallback);
  assert.ok(ends(sameDay).every((n) => !n.textContent.includes(',')));
  const overnight = HC.build(spec, [bucket(hour(22, 6)), bucket(hour(23, 6)), bucket(hour(8, 7))], fallback);
  assert.deepEqual(ends(overnight).map((n) => n.dataset.edge), ['start', 'end']);
  assert.ok(ends(overnight).every((n) => n.textContent.includes(',')), ends(overnight).map((n) => n.textContent).join(' | '));
});

test('the hours on the axis follow Settings → Time format', () => {
  const spec = { title: 'Load', unit: '%', pct: true, parts: [{ key: 'cpu', part: 'cpu' }] };
  const points = [bucket(hour(9)), bucket(hour(13)), bucket(hour(17))];
  const ticks = (clockFormat) => {
    const { dom, HC } = rig({ clockFormat, locale: 'en-US' });
    return byClass(dom, HC.build(spec, points, fallback), 'guardian-xtick').map((n) => n.textContent);
  };
  // en-US writes the 24-hour clock padded ("09"); the point is no AM/PM.
  const day = ticks('24');
  assert.match(day[0], /^0?9$/);
  assert.deepEqual(day.slice(1), ['13', '17']);
  const twelve = ticks('12');
  assert.match(twelve[0], /^9\sAM$/);
  assert.match(twelve[2], /^5\sPM$/);
});

test('pointing reads every part at that moment; a tap holds it, Escape and leaving let go', () => {
  const { dom, HC, timers } = rig();
  const points = [bucket(hour(1)), { ...bucket(hour(2)), cpu: m(70) }, bucket(hour(3))];
  const card = HC.build({ title: 'Load', unit: '%', pct: true, parts: [{ key: 'cpu', part: 'cpu' }, { key: 'gpu', part: 'gpu' }] }, points, fallback);
  const [area] = byClass(dom, card, 'guardian-area');
  const [when] = byClass(dom, card, 'guardian-chart-when');
  const values = () => byClass(dom, card, 'guardian-key-value').map((v) => v.textContent);
  const fire = (type, e) => (area._handlers[type] || []).forEach((fn) => fn({ preventDefault() {}, ...e }));
  assert.equal(area.getAttribute('role'), 'img');
  assert.match(area.getAttribute('aria-label'), /^Load: CPU 20%, max 70%; GPU 12%, max 30%$/);

  // The first arrow lands on the latest reading, the next ones walk back.
  fire('keydown', { key: 'ArrowLeft' });
  assert.ok(card.classList.contains('is-reading'));
  assert.deepEqual(values(), ['20%', '12%']);
  fire('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(values(), ['70%', '12%']);
  assert.equal(when.hidden, false);
  fire('keydown', { key: 'Escape' });
  assert.deepEqual(values(), ['20%', '12%'], 'back to the latest');
  assert.equal(when.hidden, true);

  area._rect = { width: 200, height: 80 };
  fire('pointerdown', { pointerType: 'touch', clientX: 100 });
  assert.deepEqual(values(), ['70%', '12%']);
  const hold = timers[timers.length - 1];
  assert.equal(hold.ms, 4000);
  hold.fn();
  assert.equal(card.classList.contains('is-reading'), false);

  fire('pointermove', { pointerType: 'mouse', clientX: 0 });
  assert.deepEqual(values(), ['20%', '12%']);
  fire('pointerleave', { pointerType: 'mouse' });
  assert.equal(card.classList.contains('is-reading'), false);
});

// ── The History tab ──

async function mount(data, opts) {
  const r = rig({ data, ...opts });
  r.window.mountSystemHistory();
  await settle();
  return r;
}

test('the tab draws temperature, load and power by unit beside the screen time', async () => {
  const { dom, body } = await mount(history(Array.from({ length: 24 }, (_, h) => bucket(hour(h)))));
  const [panels] = byClass(dom, body, 'guardian-panels');
  assert.equal(panels.dataset.count, '4');
  assert.deepEqual(byClass(dom, panels, 'guardian-chart-label').map((n) => n.textContent), ['Temperature', 'Load', 'Power']);
  assert.equal(byClass(dom, panels, 'screentime').length, 1);
  assert.equal(byClass(dom, body, 'guardian-foot').length, 0, 'a full range says nothing about its length');
});

test('with no power readings the chart is left out instead of drawn empty', async () => {
  const { dom, body } = await mount(history([bucket(hour(1), { watts: false }), bucket(hour(2), { watts: false })]));
  const [panels] = byClass(dom, body, 'guardian-panels');
  assert.equal(panels.dataset.count, '3');
  assert.deepEqual(byClass(dom, panels, 'guardian-chart-label').map((n) => n.textContent), ['Temperature', 'Load']);
  // Two buckets of 24 asked: the note says how much there is, so the chart reads as expected.
  assert.equal(byClass(dom, body, 'guardian-foot')[0].textContent, 'So far {n} hours recorded'.replace('{n}', '2'));
});

test('temperatures follow the unit chosen for hardware', async () => {
  const { dom, body } = await mount(history([bucket(hour(1)), bucket(hour(2))]), { fahrenheit: true });
  const temp = byClass(dom, body, 'guardian-chart')[0];
  assert.equal(byClass(dom, temp, 'guardian-key-value')[0].textContent, '122°');
});

test('screen time: the total, the time in games, up to six apps by their plain names', async () => {
  const { dom, body } = await mount(history([bucket(hour(1))]));
  const [card] = byClass(dom, body, 'screentime');
  assert.equal(byClass(dom, card, 'screentime-total')[0].textContent, '10h');
  assert.equal(byClass(dom, card, 'screentime-games')[0].textContent, '3h 12m playing');
  const rows = byClass(dom, card, 'screentime-row');
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => byClass(dom, r, 'screentime-name')[0].textContent), ['FC27', 'Chrome', 'Code', 'Discord', 'Spotify', 'Explorer']);
  const icon = byClass(dom, rows[0], 'screentime-game')[0];
  assert.equal(icon.tag, 'svg');
  assert.equal(icon.getAttribute('aria-label'), 'Game');
  assert.equal(byClass(dom, rows[1], 'screentime-game').length, 0);
  assert.equal(byClass(dom, rows[0], 'screentime-fill')[0].style.width, '100%');
});

test('the range buttons say which one is on', () => {
  const { document, window } = rig();
  const group = document.createElement('div');
  ['24h', '7d', '30d'].forEach((r, i) => {
    const b = document.createElement('button');
    b.className = `guardian-range-btn${i ? '' : ' active'}`;
    b.setAttribute('data-range', r);
    group.append(b);
  });
  document.body.append(group);
  window.setGuardianRange('7d');
  const btns = group.children;
  assert.deepEqual(btns.map((b) => b.classList.contains('active')), [false, true, false]);
  assert.deepEqual(btns.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
});

test('the Power widget gets one chart per part, or an empty card with its title', () => {
  const { dom, window } = rig();
  const metric = { key: 'gpuWatts', labelKey: 'power_gpu', fallback: 'GPU', unit: 'W', pct: false, cls: 'gpu' };
  const card = window.GuardianCharts.chartFor(metric, [bucket(hour(1)), bucket(hour(2))]);
  assert.equal(byClass(dom, card, 'guardian-key-value')[0].textContent, '90 W');
  assert.equal(byClass(dom, card, 'guardian-line')[0].getAttribute('data-part'), 'gpu');
  const empty = window.GuardianCharts.chartFor(metric, [{ t: hour(1) }]);
  assert.equal(byClass(dom, empty, 'guardian-chart-label')[0].textContent, 'GPU');
  assert.equal(byClass(dom, empty, 'guardian-chart-empty').length, 1);
});

// ── Markup, loading, styles, words ──

test('the range sits in the tab bar, hidden until History opens, and the old row is gone', () => {
  const right = /<div class="system-tabs-right">([\s\S]*?)<span class="sys-uptime"/.exec(INDEX);
  assert.ok(right, 'tab bar right side');
  assert.match(right[1], /<div class="guardian-range" id="sys-history-range" role="group" data-i18n-aria-label="guardian_range_label" aria-label="[^"]+" hidden>/);
  assert.doesNotMatch(INDEX, /sys-history-head/);
  assert.match(read('../js/network.js'), /rangeCtl\.hidden = \(name !== 'history'\)/);
  // Both keys in that corner are `display: inline-flex`, which outranks the UA [hidden] rule.
  assert.match(CSS, /^\.guardian-range\[hidden\] \{ display: none; \}/m);
  assert.match(read('../components/PerformancePanel/PerformancePanel.css'), /^\.sys-optimize-btn\[hidden\] \{ display: none; \}/m);
  // A copy of the tile has no History tab: its pane and range go with it.
  assert.match(read('../js/dashboard-layout.js'), /clone\.querySelectorAll\('\.system-history-pane, \.guardian-range'\)\.forEach\(el => el\.remove\(\)\)/);
});

test('the chart engine loads before the History module on the page and in desktop widgets', () => {
  const at = (s) => INDEX.indexOf(`<script src="js/${s}"></script>`);
  assert.ok(at('spark-path.js') > 0 && at('spark-path.js') < at('history-chart.js') && at('history-chart.js') < at('guardian-history.js'));
  const tiles = read('../js/layer-tiles.js');
  const history = partsOf('server/js/guardian-history.js').map((file) => `'${file.slice('server/'.length)}'`).join(', '); // the scripts the History module is made of today
  for (const list of [`'js/picker.js', 'js/history-chart.js', ${history}]`, `power: tile('power', 'PowerWidget', ['js/spark-path.js', 'js/history-chart.js', ${history}`]) assert.ok(tiles.includes(list), list);
  assert.match(tiles, /null, \['components\/GuardianHistory\/GuardianHistory\.css'\]\)/);
});

test('each part has one colour on both appearances, and text never wears it', () => {
  const block = (sel) => new RegExp(`^${sel.replace(/[[\]()]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(CSS)[1];
  for (const sel of [':root', ':root[data-appearance="light"]']) {
    for (const part of ['cpu', 'gpu', 'ram']) assert.match(block(sel), new RegExp(`--hist-${part}: #[0-9a-f]{6};`));
  }
  for (const part of ['cpu', 'gpu', 'ram']) assert.match(CSS, new RegExp(`^\\[data-part="${part}"\\] \\{ --part-color: var\\(--hist-${part}\\); \\}`, 'm'));
  // Values and names keep the text colours; the colour is on the stroke beside them.
  assert.doesNotMatch(block('.guardian-key-value'), /part-color/);
  // The old chart colours and their light-theme override are gone.
  assert.doesNotMatch(read('../styles/themes-light.css'), /guardian-svg/);
});

test('a size container only where the tile has a height of its own', () => {
  assert.match(CSS, /^body:not\(\[data-panel\]\) \.sys-history-body \{ container: histpane \/ size; \}/m);
  assert.match(CSS, /^:root\.is-stacked body:not\(\[data-panel\]\) \.sys-history-body,\r?\nbody:not\(\[data-panel\]\) \.layer-slot \.sys-history-body \{ container: none; \}/m);
});

test('the words of the tab exist in all eleven languages, and the old ones are gone', () => {
  const ctx = {};
  vm.createContext(ctx);
  const src = appStringsSource();
  vm.runInContext(`${src.slice(0, src.search(/^function /m))};globalThis.__i18n = i18n;`, ctx);
  const langs = Object.keys(ctx.__i18n);
  assert.equal(langs.length, 11);
  const keys = ['guardian_g_temp', 'guardian_g_load', 'guardian_g_power', 'guardian_max', 'guardian_playing',
    'guardian_range_label', 'guardian_have_hours', 'guardian_have_days', 'guardian_game', 'guardian_screentime_title'];
  for (const lang of langs) {
    for (const key of keys) assert.ok(typeof ctx.__i18n[lang][key] === 'string' && ctx.__i18n[lang][key].trim(), `${lang}.${key}`);
    assert.match(ctx.__i18n[lang].guardian_playing, /\{t\}/, `${lang} playing`);
    assert.match(ctx.__i18n[lang].guardian_have_hours, /\{n\}/, `${lang} hours`);
    for (const old of ['guardian_peak', 'guardian_collected', 'guardian_days_short', 'guardian_m_cpu_temp']) {
      assert.equal(ctx.__i18n[lang][old], undefined, `${lang}.${old}`);
    }
  }
});

test('no emoji, no "A · B" strings, and untrusted names go in as text', () => {
  for (const src of [CHART_SRC, HISTORY_SRC]) {
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|·/);
    assert.doesNotMatch(src, /\p{Extended_Pictographic}/u);
  }
});

// ── The 6h range: single samples at the interval chosen in Settings ──

test('single samples carry their minutes on the axis', () => {
  const spec = { title: 'Load', unit: '%', pct: true, parts: [{ key: 'cpu', part: 'cpu' }] };
  const { dom, HC } = rig({ clockFormat: '24', locale: 'en-US' });
  const points = ['2026-11-07T13:05', '2026-11-07T13:06', '2026-11-07T13:07'].map((t) => bucket(t));
  const ticks = byClass(dom, HC.build(spec, points, fallback), 'guardian-xtick').map((n) => n.textContent);
  assert.deepEqual(ticks, ['13:05', '13:06', '13:07']);
  assert.match(HC.whenText('2026-11-07T13:06'), /13:06/);
  // Hourly buckets stay bare hours.
  assert.match(HC.tickText(hour(13)), /^13$/);
});

test('the 6h range draws the recent samples, and its screen time is today\'s', async () => {
  const recent = ['2026-11-07T13:05', '2026-11-07T13:06'].map((t) => ({ ...bucket(t), cpu: m(77) }));
  const { dom, window, body } = rig({ data: history([bucket(hour(1)), bucket(hour(2))], { recent }) });
  window.mountSystemHistory();
  await settle();
  window.setGuardianRange('6h');
  const values = byClass(dom, body, 'guardian-key-value').map((n) => n.textContent);
  assert.ok(values.includes('77%'), values.join(' | '));
  assert.ok(byClass(dom, body, 'guardian-app-row').length > 0 || body.textContent.includes('FC27'), 'today\'s apps beside the 6h charts');
  assert.match(INDEX, /id="sys-history-range"[\s\S]*?data-range="6h"[\s\S]*?data-range="24h"/);
  assert.doesNotMatch(INDEX, /onclick="setGuardianRange/, 'the buttons are wired in guardian-history.js');
  assert.match(HISTORY_SRC, /group\.addEventListener\('click'/);
});

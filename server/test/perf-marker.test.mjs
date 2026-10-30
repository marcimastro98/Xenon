import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Performance Mode in the top bar. Many people took a running session for a
// broken Xenon: animations, the Media wave and heavy tiles paused with nothing
// on screen saying why, and the only place that showed it was the System tile.
// Now a button sits with the clock while a session runs, one tap ends it, and
// a Settings switch keeps it there to start one at any time.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Just enough DOM for js/perf-marker.js: elements that hold children, classes,
// attributes and click handlers.
function fakeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, hidden: false, disabled: false, title: '', textContent: '',
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { return Promise.all((this.listeners.click || []).map((fn) => fn())); },
  };
  return el;
}

function load(perf, perfMode = {}) {
  const host = fakeElement('span');
  host.hidden = true;
  const calls = [];
  const winListeners = {};
  const ctx = {
    console,
    hubSettings: { performance: perf },
    normalizePerformance: (v) => ({ active: false, barAlways: false, ...v }),
    t: (k) => k,
    document: {
      readyState: 'complete',
      getElementById: (id) => (id === 'clock-perf' ? host : null),
      createElement: fakeElement,
      createElementNS: (_ns, tag) => fakeElement(tag),
      addEventListener() {},
    },
  };
  ctx.window = ctx;
  ctx.addEventListener = (type, fn) => { (winListeners[type] ||= []).push(fn); };
  ctx.PerfMode = {
    restore: async (meta) => { calls.push(['restore', meta]); ctx.hubSettings.performance = { ...ctx.hubSettings.performance, active: false }; },
    optimize: async (meta) => { calls.push(['optimize', meta]); },
    ...perfMode,
  };
  vm.createContext(ctx);
  vm.runInContext(read('../js/perf-marker.js'), ctx);
  const fire = () => (winListeners['xenon:perf-change'] || []).forEach((fn) => fn());
  return { ctx, host, calls, fire };
}

const button = (host) => host.children[0];
const label = (host) => button(host).children.find((c) => c.className === 'perf-tb-label');

test('nothing in the bar while no session runs, by default', () => {
  const { host } = load({ active: false });
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

test('a running session is on screen, says so in words, and one tap ends it', async () => {
  const { host, calls, ctx, fire } = load({ active: true });
  assert.equal(host.hidden, false);
  const btn = button(host);
  assert.equal(btn.tagName, 'BUTTON', 'a real button: keyboard and screen readers get it for free');
  assert.ok(btn.classList.contains('is-on'));
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(label(host).textContent, 'perf_bar_on');
  assert.equal(btn.title, 'perf_bar_on_title');
  await btn.click();
  assert.deepEqual(calls.map((c) => c[0]), ['restore']);
  // Restore runs applyState, which tells the bar.
  assert.equal(ctx.hubSettings.performance.active, false);
  fire();
  assert.equal(host.hidden, true, 'gone once the session ended');
});

test('"always in the bar" keeps it there to start a session at any time', async () => {
  const { host, calls } = load({ active: false, barAlways: true });
  assert.equal(host.hidden, false);
  const btn = button(host);
  assert.equal(btn.classList.contains('is-on'), false);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(label(host).textContent, 'perf_bar_off');
  await btn.click();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['optimize', { by: 'manual' }]], 'the same start as the System tile, so the confirmation sheet still asks');
});

test('a second tap while the first is still working does nothing', async () => {
  let release;
  const { host, calls } = load({ active: true }, { restore: (meta) => { calls.push(['restore', meta]); return new Promise((r) => { release = r; }); } });
  const first = button(host).click();
  assert.equal(button(host).disabled, true, 'shown as busy');
  await button(host).click();
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.equal(button(host).disabled, false);
});

test('a failed start or stop is logged and the button comes back', async () => {
  const warn = console.warn;
  const seen = [];
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    const { host } = load({ active: true }, { restore: async () => { throw new Error('power plan refused'); } });
    await button(host).click();
    assert.match(seen.join('\n'), /restore failed: power plan refused/);
    assert.equal(button(host).disabled, false);
  } finally {
    console.warn = warn;
  }
});

test('the setting is kept by the shared normalizer, off by default', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(read('../js/perf-settings.js') + ';globalThis.__n = normalizePerformance;', ctx);
  assert.equal(ctx.__n({}).barAlways, false);
  assert.equal(ctx.__n({ barAlways: true }).barAlways, true);
  assert.equal(ctx.__n({ barAlways: 'yes' }).barAlways, false, 'only a real true turns it on');
  const html = read('../index.html');
  assert.match(html, /id="settings-perf-baralways" type="checkbox" onchange="updatePerformanceBarAlways\(this\.checked\)"/);
  assert.match(read('../js/settings.js'), /setChecked\('settings-perf-baralways', p\.barAlways\);/);
});

test('the marker sits with the clock, so both chromes show it, and can be hidden like the others', () => {
  const html = read('../index.html');
  assert.match(html, /id="clock-codex" hidden><\/span>\n(?:\s*<!--[\s\S]*?-->\n)?\s*<span class="clock-perf" id="clock-perf" hidden><\/span>/);
  assert.ok(html.indexOf('<script src="js/perf-marker.js">') > html.indexOf('<script src="js/performance.js">'), 'loaded after Performance Mode');
  assert.match(html, /components\/PerfMarker\/PerfMarker\.css/);
  // One island id list, three copies: the dashboard's, the server's, the minimal bar's.
  const ids = (src, re) => JSON.parse(re.exec(src)[1].replace(/'/g, '"'));
  const client = ids(read('../js/settings.js'), /const canonical = (\[[^\]]*\]);/);
  const server = ids(read('../server.js'), /const TOPBAR_ISLAND_IDS = (\[[^\]]*\]);/);
  const minimal = ids(read('../js/topbar-minimal.js'), /const ISLAND_SEG_IDS = (\[[^\]]*\]);/);
  assert.ok(client.includes('perf'));
  assert.deepEqual(server, client);
  assert.deepEqual(minimal, client);
  assert.match(read('../js/topbar-minimal.js'), /case 'perf': return els\.clockPerf;/);
  assert.match(read('../js/settings.js'), /perf: 'topbar_el_perf'/);
});

test('Performance Mode tells the bar only when something it shows changed', () => {
  const src = read('../js/performance.js');
  const fn = src.slice(src.indexOf('  function applyState() {'), src.indexOf('\n  }\n', src.indexOf('  function applyState() {')));
  assert.match(fn, /if \(sig === _stateSig\) return;/);
  assert.match(fn, /window\.dispatchEvent\(new CustomEvent\('xenon:perf-change'/);
  assert.match(fn, /p\.barAlways/);
});

test('the Media wave names what holds it, and Settings listens', () => {
  const viz = read('../js/media-viz.js');
  const at = viz.indexOf('  const SILENT_TICKS');
  const fn = viz.slice(at, viz.indexOf('\n  }\n', viz.indexOf('  function holdReason() {')) + 4);
  const body = new Set();
  let lyrics = false;
  let tokens = [];
  const st = { playing: false, sawLevels: false, samples: [], capacity: 40 };
  const make = () => new Function('document', 'panel', 'window', 'playing', 'sawLevels', 'samples', 'capacity', fn + '\nreturn holdReason;')(
    { body: { classList: { contains: (c) => body.has(c) } } },
    () => ({ classList: { contains: (c) => c === 'lyrics-open' && lyrics } }),
    { ambientFreeze: { tokens: () => tokens } },
    st.playing, st.sawLevels, st.samples, st.capacity,
  );
  assert.equal(make()(), '');
  tokens = ['settings'];
  assert.equal(make()(), '', 'Settings freezes the overlay itself: not a reason to name');
  st.playing = true; st.sawLevels = true; st.samples = new Array(40).fill(0);
  assert.equal(make()(), 'silent', 'a whole strip of nothing from the app the tile shows');
  st.samples[39] = 0.4;
  assert.equal(make()(), '', 'one real level and it is drawing');
  st.samples = new Array(10).fill(0);
  assert.equal(make()(), '', 'too early to call it silent');
  lyrics = true;
  assert.equal(make()(), 'lyrics');
  tokens = ['settings', 'hub-message:3'];
  assert.equal(make()(), 'overlay', 'a freeze left behind by something else');
  body.add('game-mode');
  assert.equal(make()(), 'game');
  body.add('perf-mode');
  assert.equal(make()(), 'perf');
  assert.match(viz, /onLevels, holdReason,/);
  assert.ok(read('../js/ambient-freeze.js').includes('window.ambientFreeze.tokens = () => [...frozen];'));
  assert.ok(read('../js/settings.js').includes("window.addEventListener('xenon:perf-change', () => {"));
});

test('every language has the new words, translated', () => {
  const SRC = read('../js/i18n.js');
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(0, SRC.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
  const keys = ['perf_bar_off', 'perf_bar_on', 'perf_bar_off_title', 'perf_bar_on_title', 'topbar_el_perf', 'settings_perf_baralways', 'settings_perf_baralways_hint'];
  const langs = Object.keys(ctx.__i18n);
  assert.equal(langs.length, 11);
  for (const l of langs) {
    for (const k of keys) {
      assert.ok(ctx.__i18n[l][k], `${l}.${k}`);
      if (l !== 'en' && k !== 'perf_bar_off') assert.notEqual(ctx.__i18n[l][k], ctx.__i18n.en[k], `${l}.${k} is still English`);
      assert.doesNotMatch(ctx.__i18n[l][k], /—/, `${l}.${k}: no em dash`);
    }
  }
});

// The greeting splash (js/greeting.js, greeting-scene.js, greeting-facts.js,
// components/GreetingSplash): a pixel landscape for the hour, Bit doing what it
// would do then, the greeting, one true line about the day, the date, the
// weather.
//  - the scene fills any screen on a whole-pixel grid, landscape or portrait;
//  - the line under the greeting comes from the calendar, never a pleasantry,
//    and is simply missing when there is nothing to say;
//  - the overlay builds its words with textContent, mounts Bit for the hour,
//    follows a resize, and lets everything go on close;
//  - every language has the new lines and none keeps the old ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const PARTS = ['morning', 'afternoon', 'evening', 'night'];
const FACT_KEYS = ['greet_fact_today_one', 'greet_fact_today_many', 'greet_fact_next', 'greet_fact_tomorrow_one', 'greet_fact_tomorrow_many'];

function load(file, ctx) {
  vm.runInContext(read(`../js/${file}`), ctx);
  return ctx;
}

const sceneCtx = () => load('greeting-scene.js', vm.createContext({ window: {}, Math }));
const factsCtx = () => load('greeting-facts.js', vm.createContext({ window: {}, Date, Array, Number }));

// ── scene ────────────────────────────────────────────────────────────────────

test('the grid is a whole number of pixels and the stage is centred', () => {
  const { GreetingScene } = sceneCtx().window;
  const full = GreetingScene.layoutFor(1920, 1080);
  assert.deepEqual([full.mode, full.unit, full.off], ['land', 20, 0]);
  const edge = GreetingScene.layoutFor(2560, 720); // 32:9: the height decides
  assert.deepEqual([edge.mode, edge.unit], ['land', 13]);
  assert.equal(edge.off, Math.floor((2560 / 13 - 96) / 2));
  const phone = GreetingScene.layoutFor(390, 844);
  assert.deepEqual([phone.mode, phone.unit, phone.off], ['port', 7, 0]);
  assert.ok(GreetingScene.layoutFor(100, 60).unit >= 3, 'never smaller than 3px');
});

test('each hour draws bands, hills and ground across the whole width, in its own colours', () => {
  const { GreetingScene } = sceneCtx().window;
  for (const [vw, vh] of [[1920, 1080], [2560, 720], [390, 844], [1024, 768]]) {
    const L = GreetingScene.layoutFor(vw, vh);
    for (const part of PARTS) {
      const svg = GreetingScene.svg(part, L);
      assert.doesNotMatch(svg, /NaN|undefined|Infinity/, `${part} ${vw}x${vh}`);
      assert.match(svg, /^<svg class="greet-scene" viewBox="[^"]+" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true">/);
      assert.deepEqual([...new Set(svg.match(/<\/?[a-z]+/g))].sort(), ['</svg', '<rect', '<svg'], 'only rects inside the svg');
      const pal = GreetingScene.PALETTES[part];
      for (const c of [...pal.bands, pal.farFill, pal.nearFill, pal.ground]) assert.ok(svg.includes(`fill="${c}"`), `${part} uses ${c}`);
      const xs = [...svg.matchAll(/<rect x="(-?[\d.]+)" y="[^"]+" width="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[1]) + Number(m[2])]);
      assert.ok(Math.min(...xs.map((r) => r[0])) <= -L.off, 'reaches the left edge');
      assert.ok(Math.max(...xs.map((r) => r[1])) >= vw / L.unit - L.off - 1e-9, 'reaches the right edge');
    }
  }
});

test('the sun is by day, the moon and stars by night, and the moon is a crescent', () => {
  const { GreetingScene } = sceneCtx().window;
  const L = GreetingScene.layoutFor(1920, 1080);
  const pal = GreetingScene.PALETTES;
  assert.ok(GreetingScene.svg('morning', L).includes(`fill="${pal.morning.sun}"`));
  assert.ok(GreetingScene.svg('afternoon', L).includes(`fill="${pal.afternoon.cloud}"`), 'clouds in the afternoon');
  const night = GreetingScene.svg('night', L);
  assert.ok(night.includes(`fill="${pal.night.moon}"`) && !night.includes('fill="#F25C3B"'));
  // The cut that makes the crescent is painted with the sky bands, not with a new colour.
  const colours = new Set([...night.matchAll(/fill="(#[0-9A-F]{6})"/g)].map((m) => m[1]));
  const allowed = new Set([...pal.night.bands, pal.night.farFill, pal.night.nearFill, pal.night.ground, pal.night.moon, pal.night.star]);
  assert.deepEqual([...colours].filter((c) => !allowed.has(c)), []);
});

test('the text colour keeps its contrast on the sky behind the words', () => {
  const { GreetingScene } = sceneCtx().window;
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const part of PARTS) {
    const pal = GreetingScene.PALETTES[part];
    // The words sit over the upper bands (the sky), never over the hills.
    for (const band of pal.bands.slice(0, 4)) assert.ok(ratio(pal.ink, band) >= 4.5, `${part}: ${pal.ink} on ${band}`);
  }
});

// ── facts ────────────────────────────────────────────────────────────────────

const fmt = { format: (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` };
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).toISOString();
const ev = (startsAt) => ({ startsAt, title: 'Riunione' });
const NOW = new Date(2026, 9, 27, 7, 42);

test('morning: how many events are left today and when the first is', () => {
  const { GreetingFacts } = factsCtx().window;
  assert.deepEqual(JSON.parse(JSON.stringify(GreetingFacts.pick('morning', [ev(at(27, 9, 30)), ev(at(27, 13)), ev(at(27, 18, 30))], NOW, fmt))),
    { key: 'greet_fact_today_many', vars: { n: 3, time: '9:30' } });
  assert.equal(GreetingFacts.pick('morning', [ev(at(27, 9, 30))], NOW, fmt).key, 'greet_fact_today_one');
  assert.equal(GreetingFacts.pick('morning', [ev(at(27, 6)), ev(at(28, 9))], NOW, fmt), null, 'past and other days do not count');
});

test('afternoon names the next event; evening and night look at tomorrow', () => {
  const { GreetingFacts } = factsCtx().window;
  const events = [ev(at(27, 9)), ev(at(27, 18, 30)), ev(at(28, 9)), ev(at(28, 12))];
  const three = new Date(2026, 9, 27, 15, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(GreetingFacts.pick('afternoon', events, three, fmt))), { key: 'greet_fact_next', vars: { n: 1, time: '18:30' } });
  const eve = GreetingFacts.pick('evening', events, new Date(2026, 9, 27, 19, 5), fmt);
  assert.deepEqual([eve.key, eve.vars.n, eve.vars.time], ['greet_fact_tomorrow_many', 2, '9:00']);
  assert.equal(GreetingFacts.pick('night', [ev(at(28, 9))], new Date(2026, 9, 27, 23, 20), fmt).key, 'greet_fact_tomorrow_one');
});

test('after midnight "night" still means today, and nothing to say means no line', () => {
  const { GreetingFacts } = factsCtx().window;
  const small = new Date(2026, 9, 28, 1, 10);
  assert.equal(GreetingFacts.pick('night', [ev(at(28, 9))], small, fmt).key, 'greet_fact_today_one');
  for (const part of PARTS) assert.equal(GreetingFacts.pick(part, [], NOW, fmt), null);
  assert.equal(GreetingFacts.pick('morning', undefined, NOW, fmt), null);
  assert.equal(GreetingFacts.pick('morning', [{ startsAt: 'not a date', title: 'x' }, { startsAt: at(27, 9), title: '' }, null], NOW, fmt), null, 'bad rows are skipped');
});

// ── the overlay ──────────────────────────────────────────────────────────────

function node(tag) {
  const n = {
    tag, className: '', textContent: '', innerHTML: '', children: [], attrs: {}, props: {}, listeners: {}, removed: false,
    classList: {
      on: new Set(),
      add(c) { this.on.add(c); },
      toggle(c, v) { if (v) this.on.add(c); else this.on.delete(c); },
      contains(c) { return this.on.has(c) || n.className.split(' ').includes(c); },
    },
    style: { setProperty(k, v) { n.props[k] = v; } },
    setAttribute(k, v) { n.attrs[k] = v; },
    appendChild(c) { n.children.push(c); return c; },
    addEventListener(type, fn) { n.listeners[type] = fn; },
    remove() { n.removed = true; },
  };
  return n;
}

function boot({ weather = { ok: true, tempC: 11, condition: 'sereno', location: 'Milano' }, bit = true } = {}) {
  const timers = [];
  const winListeners = {};
  const mounts = [];
  const plays = [];
  let swept = 0;
  const body = node('body');
  // In a page `window` is the global object, so bare names (GreetingScene, BitApp) resolve to it.
  const win = {
    innerWidth: 1920, innerHeight: 1080,
    addEventListener: (type, fn) => { winListeners[type] = fn; },
    removeEventListener: (type) => { delete winListeners[type]; },
  };
  if (bit) {
    win.BitApp = {
      TILE_HOLD: ['overlay-frozen', 'ambient-idle', 'game-mode', 'low-power-gpu', 'perf-mode'],
      mount: (host, opts) => { mounts.push({ host, opts, onPage: body.children.includes(overlay()) }); return { play: (id) => { plays.push(id); return Promise.resolve(); } }; },
      sweep: () => { swept += 1; },
    };
  }
  const ctx = vm.createContext(Object.assign(win, {
    window: win, console, Math, Number, String, Intl, Date, Promise, Array,
    document: { createElement: node, body: { appendChild: (c) => body.children.push(c) } },
    t: (k) => ({ locale: 'it-IT', greet_morning: 'Buongiorno', greet_night: 'Buonanotte', greet_fact_today_many: '{n} eventi oggi, il primo alle {time}' }[k] || k),
    toDisplayTemp: (c) => Math.round(c),
    weatherData: weather,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  }));
  load('greeting-scene.js', ctx);
  load('greeting.js', ctx);
  const overlay = () => body.children[0];
  const find = (root, cls, out = []) => { if (root.className.split(' ').includes(cls)) out.push(root); root.children.forEach((c) => find(c, cls, out)); return out; };
  const run = (pred) => { for (const t of timers.splice(0)) if (t.live && pred(t)) t.fn(); };
  return { ctx, win, winListeners, body, overlay, find, mounts, plays, timers, run, swept: () => swept };
}

test('it builds the words from the day, with textContent, and nothing for what is missing', () => {
  const b = boot();
  b.win.GreetingSplash.show('morning', {
    agenda: [{ time: '9:30', title: '<img src=x onerror=alert(1)>' }, { time: '13:00', title: 'Pranzo' }],
    fact: { key: 'greet_fact_today_many', vars: { n: 3, time: '9:30' } },
  });
  const o = b.overlay();
  assert.equal(o.className, 'greeting-splash greet-morning');
  assert.equal(o.attrs.role, 'status');
  assert.equal(b.find(o, 'greet-title')[0].textContent, 'Buongiorno');
  assert.equal(b.find(o, 'greet-fact')[0].textContent, '3 eventi oggi, il primo alle 9:30');
  const meta = b.find(o, 'greet-meta')[0];
  assert.match(meta.children[0].textContent, /martedì 27 ottobre|\d/, 'the date line');
  assert.equal(meta.children[1].textContent, '11° sereno, Milano');
  const rows = b.find(o, 'greet-agenda')[0].children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[1].textContent, '<img src=x onerror=alert(1)>', 'event titles are text, not markup');
  assert.equal(rows[0].children[1].innerHTML, '', 'nothing went through innerHTML');
});

test('no fact, no weather, no agenda: just the greeting and the date', () => {
  const b = boot({ weather: { ok: false } });
  b.win.GreetingSplash.show('night', {});
  const o = b.overlay();
  assert.equal(b.find(o, 'greet-fact').length, 0);
  assert.equal(b.find(o, 'greet-agenda').length, 0);
  assert.equal(b.find(o, 'greet-meta')[0].children.length, 1, 'only the date');
});

test('Bit does the hour\'s thing, without the holds that do not apply on an overlay', () => {
  const b = boot();
  b.win.GreetingSplash.show('morning');
  assert.equal(b.mounts.length, 1);
  const { opts, host } = b.mounts[0];
  assert.equal(host.className, 'greet-bit');
  assert.ok(b.mounts[0].onPage, 'mounted once the overlay is on the page (BitApp drops a host that is not)');
  assert.equal(opts.fidgets, false);
  assert.equal(opts.label, 'Bit');
  assert.deepEqual([...opts.hold], ['game-mode', 'low-power-gpu', 'perf-mode']);
  b.run((t) => t.ms === 400);
  assert.deepEqual(b.plays, ['coffee']);
  const n = boot();
  n.win.GreetingSplash.show('night');
  assert.equal(n.mounts[0].opts.mood, 'sleep', 'asleep at night');
  assert.equal(n.timers.filter((t) => t.ms === 400).length, 0, 'no clip to replay while asleep');
});

test('the sky follows the screen: land or port, a new grid on resize', () => {
  const b = boot();
  b.win.GreetingSplash.show('afternoon');
  const o = b.overlay();
  assert.ok(o.classList.contains('greet-land') && !o.classList.contains('greet-port'));
  assert.equal(o.props['--u'], '20px');
  assert.equal(o.props['--ink'], b.win.GreetingScene.PALETTES.afternoon.ink);
  const sky = b.find(o, 'greet-sky')[0];
  assert.match(sky.innerHTML, /^<svg class="greet-scene"/);
  b.win.innerWidth = 390; b.win.innerHeight = 844;
  b.winListeners.resize();
  assert.ok(o.classList.contains('greet-port') && !o.classList.contains('greet-land'));
  assert.equal(o.props['--u'], '7px');
});

test('tap closes it, auto-close closes it, and everything is let go', () => {
  const b = boot();
  b.win.GreetingSplash.show('evening');
  const o = b.overlay();
  b.win.GreetingSplash.show('evening'); // one at a time
  assert.equal(b.body.children.length, 1);
  assert.ok(b.timers.some((t) => t.ms === 8000), 'closes by itself after 8 seconds');
  o.listeners.pointerdown();
  assert.ok(o.classList.contains('closing'));
  assert.equal(b.winListeners.resize, undefined, 'the resize listener is gone');
  b.run((t) => t.ms === 700);
  assert.ok(o.removed);
  assert.equal(b.swept(), 1, 'Bit is swept');
  // The 8-second timer was cleared by the tap, and the clip loop stops.
  b.run(() => true);
  assert.equal(b.plays.length, 0);
});

test('it works without the Bit engine', () => {
  const b = boot({ bit: false });
  assert.doesNotThrow(() => b.win.GreetingSplash.show('morning'));
  assert.equal(b.find(b.overlay(), 'greet-title').length, 1);
});

// ── wiring, styles, languages ────────────────────────────────────────────────

test('the page loads the scene and facts before the splash, and ambient asks for the fact', () => {
  const html = read('../index.html');
  const order = ['js/greeting-scene.js', 'js/greeting-facts.js', 'js/greeting.js'].map((s) => html.indexOf(`<script src="${s}"></script>`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'scene, facts, then splash');
  const ambient = read('../js/ambient.js');
  assert.match(ambient, /GreetingSplash\.show\(part, \{ agenda, fact: greetingFact\(part, now\) \}\)/);
  assert.match(ambient, /GreetingFacts\.pick\(part, calendarEvents, now,/);
});

test('the splash is sized in the pixel unit and colours come from the scene, not the theme', () => {
  const css = read('../components/GreetingSplash/GreetingSplash.css');
  assert.doesNotMatch(css, /backdrop-filter|blur\(|radial-gradient|linear-gradient|box-shadow|text-shadow/, 'no glass, glow or gradient');
  assert.match(css, /\.greeting-splash \{[^}]*color: var\(--ink\)/s);
  assert.match(css, /\.greeting-splash\.greet-port \{[^}]*--sw: 54; --sh: 96; --ground: 88;/s);
  assert.match(css, /\.greet-bit \{[^}]*top: calc\(\(var\(--ground\) - 16\) \* var\(--u\)\)/s, 'Bit stands on the ground line');
  assert.match(read('../styles/fonts.css'), /font-family: "Pixelify Sans";[^}]*pixelify-sans-latin\.woff2/s, 'the pixel face is self-hosted');
});

test('every language has the new lines and none keeps the old ones', () => {
  const src = read('../js/i18n.js');
  assert.doesNotMatch(src, /greet_sub_|greet_agenda_title/);
  for (const key of FACT_KEYS) assert.equal((src.match(new RegExp(`["']?${key}["']?:`, 'g')) || []).length, LANGS.length, key);
  // Each line keeps its placeholders: {n} only where a count is said, {time} always.
  for (const m of src.matchAll(/["']?(greet_fact_[a-z_]+)["']?:\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]*)")/g)) {
    const text = m[2] ?? m[3];
    assert.ok(text.includes('{time}'), `${m[1]} keeps {time}`);
    assert.equal(text.includes('{n}'), m[1].endsWith('_many'), `${m[1]} says a count only when it is many`);
  }
});

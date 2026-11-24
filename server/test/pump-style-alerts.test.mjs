// A pump screen style that takes the pump's alerts its own way (manifest pumpAlerts): it is told
// only the kind (the pumpAlert message, pump-widget-host.js), never a word, and only when nothing
// it learns can leave its frame; Xenon writes the words in the band it leaves free below, in its
// colours, as dots (face-alert-dots.js) or plain type (face-alerts.js), and follows the face when
// it changes while an alert shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Faces = require('../js/pump/pump-faces.js');
const Model = require('../js/pump/pump-model.js');
const { normalizeManifest } = require('../widget-sdk/manifest-normalize.js');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

test('pumpAlerts is kept only for a style that keeps to itself, in one of its two looks', () => {
  const base = { id: 'bit-face', name: 'Bit', version: '1.0.0', api: 1, entry: 'index.html', pump: ['round'], pumpStyle: true };
  const look = (extra) => normalizeManifest({ ...base, ...extra }, 'bit-face').manifest.pumpAlerts;
  assert.equal(look({ pumpAlerts: 'dots' }), 'dots');
  assert.equal(look({ pumpAlerts: 'plain' }), 'plain');
  for (const bad of ['neon', true, 1, '', null]) assert.equal(look({ pumpAlerts: bad }), null, String(bad));
  assert.equal(look({ pumpAlerts: 'dots', pumpStyle: false }), null, 'only a style takes the pump\'s alerts');
  // When a message or a call came is news of its own: any way out of the frame turns the key off.
  const ways = {
    actions: { actions: ['media'] }, hosts: { hosts: ['api.example.com'] },
    userHosts: { userHosts: [{ id: 'my-api', label: 'My API' }] }, hooks: { hooks: ['on-tap'] },
    ai: { ai: true }, storage: { storage: true }, storageGroup: { storageGroup: 'bit-pack' },
    secrets: { secrets: true }, clipboard: { clipboard: true },
  };
  for (const [name, grant] of Object.entries(ways)) assert.equal(look({ pumpAlerts: 'dots', ...grant }), null, name);
});

test('the kinds a style is told are the pump\'s alerts, and the band leaves Bit most of the screen', () => {
  assert.deepEqual([...Faces.STYLE_ALERTS].sort(), [...Model.ALERTS].sort());
  assert.ok(Faces.ALERT_BAND > 0.25 && Faces.ALERT_BAND < 0.5);
});

// The widget's page, run whole: the settings and the package as the engine gives them.
async function hostPage(search, pkg) {
  const { document } = makeDom();
  const host = document.createElement('div');
  host.id = 'pump-widget-host';
  document.body.append(host);
  const window = {
    PumpFaces: Faces, parent: {}, matchMedia: () => ({ matches: true }), addEventListener() {},
    CustomWidget: {
      getPackages: async () => ({ packages: [pkg] }), packageGranted: () => true, assetBase: (id) => `/sdk/${id}/`,
      registerCanvasFrame() {}, unregisterCanvasFrames() {}, refreshTheme() {}, refreshLang() {}, onData() {},
    },
  };
  const settings = { sdkWidgets: { enabled: true, grants: { [pkg.id]: {} } }, language: 'en' };
  vm.runInNewContext(read('../js/pump/pump-widget-host.js'), {
    window, document, location: { search, reload() {} }, URLSearchParams, SERVER: '', lang: 'en', i18n: { en: {} },
    normalizeLangCode: (x) => x, ThemeTokens: { derivePalette: () => ({}) },
    WidgetFeed: { listen() {}, weatherQuery: () => '', weatherDelay: () => 1e9 },
    fetch: async () => ({ ok: true, json: async () => ({ settings }) }), fetchWithDeadline: async () => ({ ok: false }),
    EventSource: class { addEventListener() {} }, setTimeout, clearTimeout,
  });
  await settle(20);
  const posted = [];
  const frame = host.querySelector('iframe');
  if (frame) frame.contentWindow = { postMessage: (m, to) => posted.push([plain(m), to]) };
  return { window, posted };
}

test('the style is told the kind and how long, never a word, and nothing when it did not ask', async () => {
  const pkg = { id: 'bit-face', entry: 'index.html', version: '1.1.0', pumpAlerts: 'dots' };
  const { window, posted } = await hostPage('?id=bit-face&line=clock&moment=base', pkg);
  assert.equal(window.pumpAlertsLook(), 'dots');
  window.pumpAlertTell({ kind: 'call', seconds: 7.6, caller: 'Someone', title: 'Words', body: 'More words', app: 'Phone' });
  assert.deepEqual(posted.at(-1), [{ xenonSdk: 1, type: 'pumpAlert', kind: 'call', band: Faces.ALERT_BAND, seconds: 8 }, '*']);
  window.pumpAlertTell(null);
  assert.deepEqual(posted.at(-1)[0], { xenonSdk: 1, type: 'pumpAlert', kind: null, band: 0, seconds: 0 }, 'over: kind null');
  window.pumpAlertTell({ kind: 'mail', seconds: 5 });
  assert.equal(posted.at(-1)[0].kind, null, 'a kind it does not know is no alert');
  // A widget of its own on the pump (no line), or a style that did not ask: never told.
  for (const [search, p] of [['?id=bit-face', pkg], ['?id=bit-face&line=clock', { ...pkg, pumpAlerts: undefined }], ['?id=bit-face&line=clock', { ...pkg, pumpAlerts: 'neon' }]]) {
    const page = await hostPage(search, p);
    assert.equal(page.window.pumpAlertsLook(), null, search);
    page.window.pumpAlertTell({ kind: 'notify', seconds: 6 });
    assert.equal(page.posted.length, 0, search);
  }
});

test('the widget face says how its style takes alerts only while the style itself shows', () => {
  const { document } = makeDom();
  /** @type {any} */
  const window = { PumpFaces: Faces };
  vm.runInNewContext(read('../js/pump/face-kit.js') + read('../js/pump/face-widget.js'), { window, document, Intl, Number, Math, Object, String, Array, JSON, Date, URLSearchParams });
  const Kit = window.PumpFaceKit;
  Kit.setWords({ locale: 'en-US' }, { lang: 'en', tempUnit: 'c' });
  Kit.add('face', 'clock', () => ({ update() {}, stop() {} }));
  const layer = document.createElement('div');
  const face = Kit.get('face', 'widget')(layer, { face: 'widget', id: 'bit-face', colors: 'xenon', line: { face: 'clock', moment: 'base' } });
  const [frame] = layer.children;
  const told = [];
  const state = { state: 'on' };
  frame.contentDocument = { documentElement: { dataset: state } };
  frame.contentWindow = { pumpAlertsLook: () => 'dots', pumpAlertTell: (a) => told.push(plain(a)) };
  face.tick();
  const look = plain(face.alertsLook());
  assert.equal(look.mode, 'dots');
  assert.deepEqual(look.colors, plain(Faces.colorsOf('xenon')), 'the line\'s own colours');
  assert.ok(/^#[0-9a-f]{6}$/i.test(look.warn) && /^#[0-9a-f]{6}$/i.test(look.background));
  face.alert({ kind: 'timer', seconds: 5 });
  assert.deepEqual(told, [{ kind: 'timer', seconds: 5 }]);
  state.state = 'ungranted';
  face.tick();
  assert.equal(face.alertsLook(), null, 'the clock stands in: Xenon\'s own card');
  state.state = 'on';
  face.tick();
  Object.defineProperty(frame, 'contentWindow', { get() { throw new Error('gone'); } });
  assert.equal(face.alertsLook(), null, 'a page going away is no look');
  face.alert({ kind: 'timer', seconds: 5 });
});

// A clock the test moves by hand.
function clock() {
  let now = 1_000_000;
  let seq = 0;
  const jobs = new Map();
  const add = (fn, ms, every) => { seq += 1; jobs.set(seq, { fn, at: now + ms, every }); return seq; };
  class FakeDate extends Date { static now() { return now; } }
  return {
    globals: { Date: FakeDate, setTimeout: (fn, ms) => add(fn, ms, 0), setInterval: (fn, ms) => add(fn, ms, ms), clearTimeout: (id) => jobs.delete(id), clearInterval: (id) => jobs.delete(id) },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, job] = due;
        now = job.at;
        if (job.every) job.at += job.every; else jobs.delete(id);
        job.fn();
      }
      now = end;
    },
    pending: () => jobs.size,
  };
}

// The face page's alerts part over a face the test controls, with the dots part when asked.
function alertsPart({ dots = false } = {}) {
  const { document } = makeDom();
  const t = clock();
  const createNS = document.createElementNS;
  document.createElementNS = (ns, tag) => Object.assign(createNS(ns, tag), { animate: () => ({}) });
  /** @type {any} */
  const window = { PumpFaces: Faces, innerWidth: 480, innerHeight: 480, devicePixelRatio: 1 };
  const ctx = vm.createContext({ window, document, Intl, Number, Math, Object, String, Array, JSON, Uint8ClampedArray, ...t.globals, getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', getPropertyValue: () => '' }) });
  vm.runInContext(read('../js/pump/face-kit.js'), ctx);
  window.PumpFaceKit.setWords({ locale: 'en-US' }, { lang: 'en', tempUnit: 'c' });
  if (dots) vm.runInContext(read('../js/pump/face-alert-dots.js'), ctx);
  vm.runInContext(read('../js/pump/face-alerts.js'), ctx);
  const root = document.createElement('div');
  let face = null;
  const part = window.PumpFaceKit.get('part', 'alerts')(root, { style: () => face });
  return { root, part, t, setFace: (f) => { face = f; } };
}

// A style's face: whether it takes alerts now, and what it was told.
function styleFace(mode = 'plain') {
  const told = [];
  const impl = {
    mode,
    alertsLook() { return this.mode ? { mode: this.mode, colors: ['#111111', '#222222', '#333333', '#444444'], warn: '#ff0000', background: '#000000' } : null; },
    alert(a) { told.push(a === null ? null : plain(a)); },
  };
  return { impl, told };
}

const cards = (root) => root.children.filter((c) => c.classList.contains('pf-alert'));
const texts = (card) => card.children.map((c) => [c.className, c.textContent]);

test('over a style that takes alerts: no card, the words in its band and colours, the kind told', () => {
  const { root, part, t, setFace } = alertsPart();
  const { impl, told } = styleFace('plain');
  setFace(impl);
  part.show({ kind: 'notify', app: 'Mail', title: 'Lunch?', body: 'At one' }, { open: true, seconds: 6 });
  const [card] = cards(root);
  assert.ok(card.classList.contains('pf-alert-band'));
  assert.deepEqual(texts(card), [['pf-alert-kicker', 'Mail'], ['pf-alert-title', 'Lunch?'], ['pf-alert-body', 'At one']], 'no ring and no icon');
  assert.deepEqual(['--pf-c1', '--pf-c2', '--pf-hot', '--pf-band'].map((k) => card.style.getPropertyValue(k)), ['#111111', '#222222', '#ff0000', `${Faces.ALERT_BAND * 100}%`]);
  assert.equal(card.attrs['aria-label'], 'Mail. Lunch?. At one');
  assert.deepEqual(told, [{ kind: 'notify', seconds: 6 }], 'the kind and the seconds, never the words');
  t.advance(6000);
  assert.ok(card.classList.contains('pf-alert-out'));
  assert.deepEqual(told.at(-1), null, 'told when it ends');
  t.advance(1000);
  assert.equal(t.pending(), 0, 'nothing keeps running once it is gone');
});

test('the words of a message stay off the screen when it may not show them, in the band too', () => {
  const { root, part, setFace } = alertsPart();
  setFace(styleFace('plain').impl);
  part.show({ kind: 'discord', title: 'Secret', body: 'Words' }, { open: false, seconds: 6 });
  assert.deepEqual(texts(cards(root)[0]).map(([, s]) => s), ['Discord', 'New notification']);
});

test('the alert follows the face: a style page that comes up, then Xenon again', () => {
  const { root, part, t, setFace } = alertsPart();
  const { impl, told } = styleFace(null);
  setFace(impl);
  part.show({ kind: 'timer', label: 'Tea' }, { open: true, seconds: 10 });
  assert.ok(!cards(root)[0].classList.contains('pf-alert-band'), 'not taken yet: Xenon\'s card');
  t.advance(2000);
  assert.equal(told.length, 0);
  impl.mode = 'plain';
  t.advance(1000);
  const band = cards(root)[0];
  assert.equal(cards(root).length, 1, 'one card at a time');
  assert.ok(band.classList.contains('pf-alert-band') && band.classList.contains('pf-alert-still'), 'redrawn without coming in again');
  assert.deepEqual(told, [{ kind: 'timer', seconds: 7 }], 'told the seconds it has left');
  setFace(null);
  t.advance(1000);
  assert.deepEqual(told.at(-1), null, 'the style that leaves is told it is over');
  assert.ok(!cards(root)[0].classList.contains('pf-alert-band'));
  t.advance(6500);
  assert.equal(t.pending(), 0);
});

test('a call stays while it rings and is told so, and stop leaves nothing running', () => {
  const { part, t, setFace } = alertsPart();
  const { impl, told } = styleFace('dots');
  setFace(impl);
  part.show({ kind: 'call', caller: 'Someone' }, { open: true, seconds: 8 });
  assert.deepEqual(told, [{ kind: 'call', seconds: 0 }]);
  t.advance(60000);
  assert.equal(part.busy(), true, 'still ringing');
  part.calls(false);
  assert.deepEqual(told.at(-1), null);
  part.show({ kind: 'notify', title: 'x' }, { open: true, seconds: 6 });
  part.stop();
  assert.deepEqual(told.at(-1), null);
  t.advance(1000);
  assert.equal(t.pending(), 0);
});

// The dots part on a canvas that says what it was asked: each character 6 px wide, and every third
// pixel of a written line ink.
function dotsRig(width = 320) {
  const { document } = makeDom();
  const written = [];
  const lit = [];
  const create = document.createElement;
  document.createElement = (tag) => {
    const n = create(tag);
    if (tag === 'canvas') {
      n.getContext = () => ({
        measureText: (s) => ({ width: [...s].length * 6 }),
        fillText: (s) => written.push(s), clearRect() {}, scale() {},
        getImageData: (_x, _y, w, h) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 !== 3 ? 0 : ((i - 3) / 4) % 3 === 0 ? 255 : 100)) }),
        fillRect(...at) { lit.push([this.fillStyle, ...at]); },
      });
    }
    return n;
  };
  /** @type {any} */
  const window = { innerWidth: 900, innerHeight: 900, devicePixelRatio: 1 };
  const getComputedStyle = (el) => ({ paddingLeft: '10px', paddingRight: '10px', getPropertyValue: (k) => el.style.getPropertyValue(k) });
  vm.runInNewContext(read('../js/pump/face-kit.js') + read('../js/pump/face-alert-dots.js'), { window, document, Intl, Number, Math, Object, String, Array, JSON, Date, getComputedStyle });
  // The screen the alerts cover: 480 px, whatever the window.
  const screen = Object.assign(document.createElement('div'), { clientWidth: 480, clientHeight: 480 });
  const card = document.createElement('div');
  screen.append(card);
  card.clientWidth = width;
  card.className = 'pf-alert pf-alert-band pf-alert-notify';
  for (const [k, v] of [['--pf-c1', '#111111'], ['--pf-c2', '#222222'], ['--pf-hot', '#ff0000']]) card.style.setProperty(k, v);
  return { draw: window.PumpFaceKit.get('part', 'alertDots'), card, written, lit };
}

test('dots: the title wrapped to two lines, one dot per inked pixel, in the line\'s colour', () => {
  const { draw, card, written, lit } = dotsRig();
  assert.equal(draw(card, 'Your build finished and the tests passed too'), true);
  // 300 px inside the padding, a dot every 3 px on a 480 px screen: 100 dots, 16 characters a line.
  assert.deepEqual(written, ['Your build', 'finished and…'], 'the last line ends on a whole word');
  const [out] = card.children;
  assert.equal(out.className, 'pf-alert-dots');
  assert.equal(out.attrs['aria-hidden'], 'true');
  assert.deepEqual([out.style.width, out.style.height], ['300px', `${(12 + 2 + 12) * 3}px`]);
  assert.equal(lit.length, 400 * 2, 'every inked pixel, none of the faint ones');
  assert.ok(lit.every(([c]) => c === '#111111'), 'the line\'s first colour');
  assert.deepEqual(lit[400].slice(1), [0, 14 * 3, 2, 2], 'dots a pitch apart, a pixel between them');
});

test('dots: a hot PC in the warning colour, a language with no spaces, and no room at all', () => {
  const hot = dotsRig();
  hot.card.classList.add('pf-alert-hot');
  hot.draw(hot.card, 'Hot');
  assert.deepEqual(hot.written, ['Hot']);
  assert.ok(hot.lit.every(([c]) => c === '#ff0000'));
  const cjk = dotsRig();
  cjk.draw(cjk.card, 'あ'.repeat(40));
  assert.deepEqual(cjk.written, ['あ'.repeat(16), `${'あ'.repeat(15)}…`]);
  const none = dotsRig(20);
  assert.equal(none.draw(none.card, 'Hello'), false, 'plain type then');
  assert.equal(none.card.children.length, 0);
});

test('in dots the app\'s name stays plain type over the title, which falls back to type with no room', () => {
  const { root, part, setFace } = alertsPart({ dots: true });
  setFace(styleFace('dots').impl);
  part.show({ kind: 'notify', app: 'Mail', title: 'Lunch?', body: 'At one' }, { open: true, seconds: 6 });
  assert.deepEqual(texts(cards(root)[0]), [['pf-alert-kicker', 'Mail'], ['pf-alert-title', 'Lunch?'], ['pf-alert-body', 'At one']], 'not laid out: plain type');
});

test('the page loads the dots before the alerts, and the face page hands the alerts its face', () => {
  const page = read('../pump-face.html');
  assert.ok(page.indexOf('js/pump/face-alert-dots.js') > page.indexOf('js/pump/face-kit.js'));
  assert.ok(page.indexOf('js/pump/face-alert-dots.js') < page.indexOf('js/pump/face-alerts.js'));
  assert.match(read('../js/pump/pump-face.js'), /Kit\.get\('part', 'alerts'\)\(document\.getElementById\('pf-alerts'\), \{ style: \(\) => face\?\.impl \}\)/);
  const css = read('../components/PumpFace/PumpFace.css');
  assert.match(css, /\.pf-alert-band \{[^}]*height: var\(--pf-band, 38%\);[^}]*background: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}\.pf-face, \.pf-alert \{ animation: none; \}/, 'the band comes in still too');
});

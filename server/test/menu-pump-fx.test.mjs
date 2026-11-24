// The cards of how a pump's ring of lights moves: the rows (menu/menu-pump-fx.js) put every
// effect in its group with the ones this line and this PC can take; the menu loads the painter
// the first time such a card shows (js/menu/xenon-menu-pumps.js), and the painter
// (js/menu/xenon-menu-pump-fx.js) moves each card's ring with the pump's own maths, stops when
// none is on screen or the menu is hidden, and shows one still moment with less motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const Fx = require('../js/pump/ring-effects.js');
const { fxRows } = require('../menu/menu-pump-fx.js');
const Pumps = require('../js/menu/xenon-menu-pumps.js');

const act = (value) => ({ run: value });

test('the rows: one per group, the lead card first, only the effects allowed, the one in use idle', () => {
  const rows = fxRows({ id: 'k', label: 'Lights', sub: 'Sub', lead: 'auto', on: 'comet', allow: () => true, act });
  assert.deepEqual(rows.map((r) => r.id), ['k', 'k-moving', 'k-music', 'k-pc']);
  assert.ok(rows.every((r) => r.kind === 'pumpcards' && r.fx === true && r.value === 'comet'));
  assert.deepEqual([rows[0].label, rows[0].sub, rows[1].sub], ['Lights', 'Sub', undefined]);
  assert.deepEqual(rows.flatMap((r) => r.cards.map((c) => c.value)), ['auto', ...Fx.EFFECTS]);
  assert.ok(rows.flatMap((r) => r.cards).every((c) => c.art === 'fx-' + c.value));
  const comet = rows[1].cards.find((c) => c.value === 'comet');
  assert.deepEqual([comet.on, comet.act], [true, null]);
  assert.deepEqual(rows[1].cards.find((c) => c.value === 'orbit').act, { run: 'orbit' });
  const deaf = fxRows({ id: 'k', lead: 'style', on: 'style', allow: (e) => e.needs !== 'sound', act });
  assert.ok(!deaf.flatMap((r) => r.cards).some((c) => c.value === 'beat' || c.value === 'meter'));
  const calmOnly = fxRows({ id: 'k', lead: 'style', on: 'style', allow: (e) => e.group === 'calm', act });
  assert.deepEqual(calmOnly.map((r) => r.id), ['k'], 'a group with nothing allowed is left out');
});

// A page for the painter: rings with their classes, canvases that record what they draw, frames
// that run when the test says, and the reduced-motion and hidden switches.
function page({ reduced = false, extra = [], fx = Fx } = {}) {
  const frames = [];
  const listeners = {};
  const document = {
    hidden: false,
    createElement: () => {
      const calls = [];
      return {
        calls, width: 0, height: 0, parent: null, attrs: {},
        get isConnected() { return !!this.parent?.isConnected; },
        setAttribute(k, v) { this.attrs[k] = v; },
        getContext: () => ({ clearRect: () => calls.push('clear'), scale: () => {}, beginPath: () => {}, arc: () => calls.push('dot'), fill: () => {}, set fillStyle(v) { calls.push(v); } }),
      };
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const ring = (cls) => {
    const node = { classList: ['xm-pumpring', cls], isConnected: true, kids: [], querySelector: () => node.kids[0] || null, appendChild(k) { k.parent = node; node.kids.push(k); } };
    return node;
  };
  const nodes = [ring('xm-pumpring--fx-comet'), ring('xm-pumpring--fx-heat'), ring('xm-pumpring--fx-auto'), ring('xm-pumpring--fx-confetti'), ...extra];
  const root = { querySelectorAll: () => nodes };
  const window = {
    LightFx: fx, devicePixelRatio: 2,
    matchMedia: () => ({ matches: reduced }),
  };
  const ctx = vm.createContext({
    window, document, Date, Math, Object, Set,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
  });
  for (const file of ['../js/light-fx/light-fx-preview.js', '../js/menu/xenon-menu-pump-fx.js']) vm.runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), ctx);
  const next = (at) => { const fn = frames.shift(); fn?.(at); return !!fn; };
  return { window, document, nodes, root, frames, next, listeners };
}

const dots = (canvas) => canvas.calls.filter((c) => c === 'dot').length;

test('the painter rings every card with an effect once, and moves them at the lights\' pace', () => {
  const p = page();
  p.window.XenonMenuPumpFx.scan(p.root);
  const [comet, heat, auto, unknown] = p.nodes;
  assert.equal(comet.kids.length, 1);
  assert.equal(heat.kids.length, 1);
  assert.deepEqual([auto.kids.length, unknown.kids.length], [0, 0], 'as Look says and an unknown one keep their still picture');
  const [canvas] = comet.kids;
  assert.deepEqual([canvas.width, canvas.height, canvas.attrs['aria-hidden']], [104, 104, 'true'], 'sharp on a dense screen, hidden from readers');
  assert.equal(dots(canvas), 24, 'drawn at once, one dot per LED');
  p.window.XenonMenuPumpFx.scan(p.root);
  assert.equal(comet.kids.length, 1, 'a ring with its canvas is not ringed again');
  assert.equal(p.frames.length, 1, 'one loop for all of them');
  p.next(100);
  assert.equal(dots(canvas), 48);
  p.next(130);
  assert.equal(dots(canvas), 48, 'not again before 66 ms');
  p.next(170);
  assert.equal(dots(canvas), 72);
  assert.equal(p.frames.length, 1, 'still going');
});

test('the painter stops with no ring on screen or the menu hidden, and starts again when it shows', () => {
  const p = page();
  p.window.XenonMenuPumpFx.scan(p.root);
  p.document.hidden = true;
  p.next(100);
  assert.equal(p.frames.length, 0, 'hidden: no more frames');
  p.document.hidden = false;
  p.listeners.visibilitychange();
  assert.equal(p.frames.length, 1, 'shown again: moving again');
  for (const n of p.nodes) n.isConnected = false;
  p.next(200);
  assert.equal(p.frames.length, 0, 'the menu drew over them: the loop ends');
  p.listeners.visibilitychange();
  assert.equal(p.frames.length, 0, 'and nothing to start again for');
});

test('a pump\'s own card: its ring moves as the ring does now, in its effect, colours, pace, way round and size', () => {
  const card = (dataset) => {
    const node = { classList: ['xm-scrpump-ring'], dataset, isConnected: true, kids: [], querySelector: () => node.kids[0] || null, appendChild(k) { k.parent = node; node.kids.push(k); } };
    return node;
  };
  const own = card({ ringFx: 'comet', ringColours: '#ff0000,#00FF00,bad', ringSpeed: 'fast', ringSize: '58', ringReverse: '1' });
  const plain = card({ ringFx: 'still' });
  const unknown = card({ ringFx: 'nope', ringSize: '58' });
  const asked = new Map();
  const plainOf = (v) => JSON.parse(JSON.stringify(v));   // made in the page's own realm
  const spy = { ...Fx, frame: (effect, opts) => { asked.set(effect, opts); return Fx.frame(effect, opts); } };
  const p = page({ extra: [own, plain, unknown], fx: spy });
  p.window.XenonMenuPumpFx.scan(p.root);
  assert.deepEqual([own.kids[0].width, own.kids[0].height], [116, 116], 'its own size, sharp');
  assert.deepEqual([plain.kids[0].width, unknown.kids.length], [104, 0], 'no size said: the cards\' own; an unknown effect: no ring');
  const comet = asked.get('comet');
  assert.deepEqual([comet.speed, comet.reverse, comet.count], ['fast', true, 24]);
  assert.deepEqual(plainOf(comet.colours), [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }], 'its colours, a bad one left out');
  assert.deepEqual(plainOf(asked.get('still').colours[0]), { r: 110, g: 231, b: 135 }, 'none said: Xenon\'s');
  assert.equal(asked.get('still').reverse, false);
});

test('an effect card is drawn as the ring is set; a pump card says its amount and dark part too', () => {
  const node = (dataset) => {
    const n = { classList: ['xm-pumpring'], dataset, isConnected: true, kids: [], querySelector: () => n.kids[0] || null, appendChild(k) { k.parent = n; n.kids.push(k); } };
    return n;
  };
  const card = node({ ringLook: JSON.stringify({ effect: 'spin', colours: ['#0000ff', 'bad'], speed: 72, size: 0.8, glow: 0.2, reverse: true }) });
  const broken = node({ ringLook: '{not json' });
  const pump = node({ ringFx: 'orbit', ringSpeed: '40', ringAmount: '0.7', ringGlow: '0' });
  const asked = new Map();
  const spy = { ...Fx, frame: (effect, opts) => { asked.set(effect, JSON.parse(JSON.stringify(opts))); return Fx.frame(effect, opts); } };
  const p = page({ extra: [card, broken, pump], fx: spy });
  p.window.XenonMenuPumpFx.scan(p.root);
  const spin = asked.get('spin');
  assert.deepEqual([spin.speed, spin.size, spin.glow, spin.reverse, spin.colours], [72, 0.8, 0.2, true, [{ r: 0, g: 0, b: 255 }]]);
  assert.equal(broken.kids.length, 0, 'a look it cannot read: no ring');
  const orbit = asked.get('orbit');
  assert.deepEqual([orbit.speed, orbit.size, orbit.glow], [40, 0.7, 0], 'numbers said as text read as numbers');
  assert.deepEqual(Object.keys(spin.inputs).sort(), ['fans', 'level', 'load', 'sky', 'sound', 'timer', 'weather'], 'what the PC effects follow, played for the card');
  // The sky plays a whole day in 24 s: its sunrise and sunset are set round the clock so that the
  // sky reads the played hour, sunrise at 6:30 and sunset at 19:00 of it.
  const { now, inputs: { sky } } = spin;
  const d = new Date(now);
  const clock = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const playedHour = (clock - sky.rise + 390 + 2880) % 1440;
  const off = Math.abs(playedHour - ((now % 24_000) / 24_000) * 1440);
  assert.ok(Math.min(off, 1440 - off) <= 1, 'the sky reads the played hour');
  assert.equal((sky.set - sky.rise + 1440) % 1440, 750, 'a day of 12 and a half hours');
});

test('with less motion each ring shows one still moment', () => {
  const p = page({ reduced: true });
  p.window.XenonMenuPumpFx.scan(p.root);
  assert.equal(dots(p.nodes[0].kids[0]), 24, 'drawn once');
  assert.equal(p.frames.length, 0, 'never moving');
});

test('a page colours LEDs of its own on the same loop: at once, at the lights\' pace, until no tick or off the page', () => {
  const p = page();
  const node = { isConnected: true };
  const seen = [];
  p.window.LightFxPreview.run(node, (_now, inputs) => seen.push(inputs));
  assert.equal(seen.length, 1, 'at once');
  assert.ok(seen[0].sky && seen[0].sound > 0, 'with the readings the cards play');
  p.next(100);
  p.next(120);
  assert.equal(seen.length, 2, 'once a frame of the lights, not each screen frame');
  assert.ok(seen[1].sky && seen[1].sound > 0, 'the loop plays them too');
  p.window.LightFxPreview.run(node, null);
  p.next(300);
  assert.equal(seen.length, 2, 'no tick: stopped');
  assert.equal(p.frames.length, 0, 'and the loop ends');
  p.window.LightFxPreview.run(node, () => seen.push('again'));
  node.isConnected = false;
  p.next(500);
  assert.deepEqual(seen.slice(2), ['again'], 'off the page: dropped');
  const still = page({ reduced: true });
  const once = [];
  still.window.LightFxPreview.run({ isConnected: true }, () => once.push(1));
  assert.deepEqual([once.length, still.frames.length], [1, 0], 'less motion: one moment');
});

// The menu's document: the cards on show or not, scripts that load when the test says.
function menuDoc({ cards = true } = {}) {
  const scripts = [];
  const win = {};
  const doc = {
    defaultView: win,
    querySelector: (sel) => (cards && sel.split(', ').includes('.xm-pumpcards.is-fx') ? {} : null),
    createElement: () => ({ removed: false, remove() { this.removed = true; } }),
    head: { appendChild: (s) => scripts.push(s) },
    body: { appendChild: () => {} },
  };
  return { doc, win, scripts };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the menu loads the painter once, in order, the first time a card shows, and again after a failure', async () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const none = menuDoc({ cards: false });
    Pumps.create({ el: () => ({}), doc: none.doc }).settle();
    assert.equal(none.scripts.length, 0, 'no card of the kind: nothing loaded');

    const m = menuDoc();
    const view = Pumps.create({ el: () => ({ setAttribute() {}, remove() {} }), doc: m.doc });
    const settle = () => { try { view.settle(); } catch { /* the preview frame needs a real page */ } };
    settle();
    settle();
    await tick();
    const order = [
      'js/light-fx/light-fx-colour.js', 'js/light-fx/light-fx-calm.js', 'js/light-fx/light-fx-moving.js', 'js/light-fx/light-fx-pc.js',
      'js/light-fx/light-fx.js', 'js/light-fx/light-fx-preview.js', 'js/menu/xenon-menu-pump-fx.js',
    ];
    assert.deepEqual(m.scripts.map((s) => s.src), [order[0]], 'one at a time, once');
    m.scripts[0].onerror();
    await tick();
    assert.equal(m.scripts[0].removed, true);
    assert.match(warned.join('\n'), /did not load: js\/light-fx\/light-fx-colour\.js/, 'the failure is said, not swallowed');
    settle();
    await tick();
    assert.equal(m.scripts.length, 2, 'tried again on the next look');
    for (let i = 1; i < order.length; i++) {
      m.scripts[i].onload();
      await tick();
    }
    assert.deepEqual(m.scripts.slice(1).map((s) => s.src), order, 'the maths in order, the painter last');
    const scanned = [];
    m.win.XenonMenuPumpFx = { scan: (d) => scanned.push(d) };
    m.scripts[order.length].onload();
    await tick();
    assert.deepEqual(scanned, [m.doc], 'loaded: the cards on show get their rings');
    settle();
    assert.equal(scanned.length, 2, 'from then on each look rings the new cards');
    assert.equal(m.scripts.length, order.length + 1, 'never loaded twice');
  } finally {
    console.warn = warn;
  }
});

// js/bit-companion/desk.js: Bit on the desktop. The page renders the person's own Bit into cells
// and sends the shell one message per change (and again every 20 s), in the shape bit_desk.rs
// takes; it plays moves once, strolls along the bar and back, and a drop is kept in its prefs or
// undone. Only in the shell that can draw it, on the main window, for a hatched Bit not turned off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const SOURCE = readFileSync(new URL('../js/bit-companion/desk.js', import.meta.url), 'utf8');
const FRAMES = readFileSync(new URL('../js/bit-companion/desk-frames.js', import.meta.url), 'utf8');
const SCREENS = readFileSync(new URL('../js/bit-companion/desk-screens.js', import.meta.url), 'utf8');
const bit = require('../../packages/core/src/bit.js');
require('../../packages/core/src/bit-clips-life.js');
require('../../packages/core/src/bit-clips-move.js');
const bitCells = require('../../packages/core/src/bit-cells.js');
const bitCellsWarp = require('../../packages/core/src/bit-cells-warp.js');
const bitDirector = require('../../packages/core/src/bit-director.js');
const genome = require('../../packages/core/src/bit-genome.js');
const bitLook = require('../../packages/core/src/bit-look.js');

const SEED = '0123456789abcdef';
const LOOK = bitLook.lookOf(genome.decode(SEED), { background: '#0d1117' });
const MAX_PAYLOAD = 64 * 1024;
const born = (prefs = {}) => ({ ok: true, hatched: true, seed: SEED, prefs: { roam: 'mix', desk: 'main', deskX: null, ...prefs } });

function rig({ native = true, caps = { bitDesk: true }, bit: state = born(), reduced = false, pace = 'live', save = { ok: true }, warp = false, displays = [], active = '' } = {}) {
  let now = 0;
  let id = 0;
  const timers = new Map(); // id -> { at, fn, every }
  const signals = [];
  const posts = [];
  const handlers = {};
  const ctx = {
    console: { ...console, warn() {} }, Math, Object, Number, JSON, Map, WeakMap, Promise,
    Date: { now: () => now },
    __XENON_NATIVE__: native,
    __XENON_NATIVE_CAPS__: caps,
    __xenonSignal: (url) => url,
    location: { set href(v) { signals.push(v); } },
    XenonNative: { afterLoad: (fn) => fn(), displayState: () => ({ displays, active }) },
    Xenon: { bit, bitCells, bitDirector, ...(warp ? { bitCellsWarp } : {}) },
    BitApp: {
      state: () => state, personal: () => LOOK, director: () => null, context: () => ({ hour: 12 }),
      heard: (next) => { state = next; (handlers['xenon-bit'] || []).forEach((fn) => fn()); },
    },
    BitMoments: { pace: () => pace },
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    setTimeout: (fn, ms = 0) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: (t) => timers.delete(t),
    setInterval: (fn, ms) => { timers.set(++id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: (t) => timers.delete(t),
    SERVER: '',
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      const out = typeof save === 'function' ? save() : save;
      if (out.ok) out.bit = { ...state, prefs: { ...state.prefs, ...JSON.parse(init.body) } };
      return { status: out.ok ? 200 : 500, json: async () => out };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(FRAMES, ctx);
  vm.runInContext(SCREENS, ctx);
  vm.runInContext(SOURCE, ctx);
  /** Runs every timer due in the next `ms`, in order. */
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [tid, t] = next;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(tid);
      t.fn();
    }
    now = end;
  }
  const messages = () => signals.map((s) => {
    assert.match(s, /^xenon-app:bit-desk\?d=/);
    return JSON.parse(decodeURIComponent(s.slice('xenon-app:bit-desk?d='.length)));
  });
  const last = () => messages().at(-1);
  return { ctx, desk: ctx.BitDesk, advance, signals, messages, last, posts };
}

// The rule bit_desk.rs parse() enforces, so a message the page sends is never dropped.
function assertShellTakes(msg, json) {
  assert.ok(json.length <= MAX_PAYLOAD, `${json.length} bytes`);
  assert.ok(msg.pal.length >= 1 && msg.pal.length <= 16);
  assert.ok(msg.pal.every((c) => /^[0-9a-f]{6}$/.test(c)));
  const all = [...msg.loop, ...(msg.once?.frames || [])];
  assert.ok(msg.loop.length >= 1 && msg.loop.length <= 24);
  const h = all[0].rows.length;
  const w = all[0].rows[0].length;
  assert.ok(h <= 24 && w <= 24 && msg.body <= h);
  for (const f of all) {
    assert.equal(f.rows.length, h);
    assert.ok(f.ms >= 40);
    for (const row of f.rows) {
      assert.equal(row.length, w);
      assert.ok([...row].every((c) => c === '.' || c.charCodeAt(0) - 65 < msg.pal.length), row);
    }
  }
}

test('not out of the shell, without the caps, for an egg or with the desktop turned off', () => {
  for (const r of [rig({ native: false }), rig({ caps: {} }), rig({ bit: { ...born(), hatched: false } }), rig({ bit: born({ desk: 'off' }) })]) {
    r.advance(100);
    assert.equal(r.signals.length, 0);
    assert.equal(r.desk.on(), false);
  }
});

test('a hatched Bit goes on the main screen in a message the shell takes, and is sent again while out', () => {
  const r = rig({ pace: 'game' }); // no fidget or stroll in between
  r.advance(100);
  const msg = r.last();
  assert.equal(r.desk.on(), true);
  assert.deepEqual([msg.on, msg.monitor, msg.cell, msg.home], [true, '', 3, 0.7]);
  assert.equal(msg.loop.length, bit.clip('idle').frames.length);
  assertShellTakes(msg, JSON.stringify(msg));
  const sent = r.signals.length;
  r.advance(20000);
  assert.equal(r.signals.length, sent + 1, 'the keepalive');
  assert.deepEqual(r.last(), msg);
});

test('asleep it sleeps; reduced motion keeps one still frame', () => {
  const r = rig({ pace: 'asleep' });
  r.advance(100);
  assert.equal(r.last().loop.length, bit.clip('sleep').frames.length);
  const still = rig({ reduced: true });
  still.advance(100);
  assert.equal(still.last().loop.length, 1);
});

test('a move plays once with a new number; one too long for the shell is left out', () => {
  const r = rig({ pace: 'game' }); // its own fidgets wait
  r.advance(100);
  assert.equal(r.desk.play('wave'), true);
  r.advance(100);
  const first = r.last().once;
  assert.equal(first.frames.length, bit.clip('wave').frames.length);
  assertShellTakes(r.last(), JSON.stringify(r.last()));
  r.desk.play('wave');
  r.advance(100);
  assert.ok(r.last().once.seq > first.seq, 'the same move again is a new number');
  assert.equal(r.desk.play('hatch'), false, '31 frames');
  r.advance(60000);
  assert.equal(r.last().once, undefined, 'gone from the message once played');
  r.desk.tapped();
  r.advance(100);
  const poke = r.last().once;
  assert.ok(poke && bit.POKES.some((id) => bit.clip(id).frames.length === poke.frames.length), 'a tap pokes it');
});

test('a stroll: out along the bar on foot, a sit, then back to its place', () => {
  const r = rig({ pace: 'slow' }); // fewer fidgets on the way
  for (let s = 0; s < 301 && !r.last()?.walk; s += 1) r.advance(1000);
  const out = r.last();
  assert.ok(out.walk, 'it walks within five minutes');
  const far = Math.abs(out.walk.to - 0.7);
  assert.ok(far >= 0.039 && far <= 0.121, String(far));
  assert.equal(out.walk.pxs, 26);
  assert.equal(out.loop.length, bit.clip('walk').frames.length);
  assert.equal(r.desk.play('wave'), false, 'no move while it walks');
  r.desk.arrived();
  r.advance(100);
  assert.equal(r.last().walk, undefined);
  assert.equal(r.last().loop.length, bit.clip('sit').frames.length);
  r.advance(15000);
  const back = r.last().walk;
  assert.deepEqual([back.to, back.seq > out.walk.seq], [0.7, true]);
  r.desk.arrived();
  r.advance(100);
  assert.equal(r.last().walk, undefined);
  assert.equal(r.last().loop.length, bit.clip('idle').frames.length);
});

test('no stroll with roam stay, in reduced motion or asleep', () => {
  for (const r of [rig({ bit: born({ roam: 'stay' }) }), rig({ reduced: true }), rig({ pace: 'asleep' })]) {
    r.advance(600000);
    assert.ok(r.messages().every((m) => !m.walk));
  }
});

test('a drop is its place: kept in its prefs, or undone when the save fails', async () => {
  const r = rig();
  r.advance(100);
  await r.desk.dropped(0.4213);
  r.advance(100);
  assert.deepEqual(r.posts, [{ url: '/api/bit/prefs', body: { deskX: 0.421 } }]);
  assert.equal(r.last().home, 0.421);
  const failing = rig({ save: { ok: false, error: 'offline' } });
  failing.advance(100);
  const drop = failing.desk.dropped(0.2);
  failing.advance(100);
  assert.equal(failing.last().home, 0.2, 'it stays where dropped while it saves');
  await drop;
  failing.advance(100);
  assert.equal(failing.last().home, 0.7, 'and goes back when not kept');
  await r.desk.dropped('left');
  assert.equal(r.posts.length, 1, 'not a number: nothing');
});

test('the first time out, one line in Bit\'s messages says how to move it or take it away, once per egg', async () => {
  const store = new Map();
  const filed = [];
  const egg = '2026-11-26T08:00:00.000Z';
  const out = (eggAt, prefs) => {
    const r = rig({ bit: { ...born(prefs), eggAt }, pace: 'game' });
    r.ctx.t = (key) => key;
    r.ctx.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
    r.ctx.BitMessages = { file: (m) => { filed.push(m); return Promise.resolve(true); }, firstLine: (s) => s };
    r.advance(100);
    return r;
  };
  const r = out(egg);
  await Promise.resolve(); // the inbox answers on the next tick
  assert.equal(filed.length, 1);
  const [msg] = filed[0];
  assert.deepEqual([msg.id, msg.kind, msg.surface, msg.title, msg.body, msg.action.type], ['bit:desk', 'bit', 'dashboard', 'mybit_desk_told_title', 'mybit_desk_told_text', 'bit']);
  assert.equal(store.get('xenon.bit.deskTold'), egg, 'kept once the inbox has it');
  r.ctx.BitApp.heard({ ...born({ desk: 'off' }), eggAt: egg });
  r.advance(100);
  r.ctx.BitApp.heard({ ...born(), eggAt: egg });
  r.advance(100);
  out(egg);
  out(egg, { desk: 'off' });
  assert.equal(filed.length, 1, 'off and on again, or the next start, says nothing new');
  out('2026-12-01T08:00:00.000Z');
  assert.equal(filed.length, 2, 'a new egg (a reinstall) is told again');
});

const empty = (msg) => msg.loop.length === 1 && msg.loop[0].rows.every((row) => /^\.+$/.test(row));
const crumbleMs = bitCellsWarp.KINDS.crumble.n * bitCellsWarp.KINDS.crumble.ms;

test('it comes in a beam of light, and crumbles away when turned off, then goes', () => {
  const r = rig({ warp: true, pace: 'game' });
  r.advance(100);
  const first = r.last();
  assert.equal(first.once.frames.length, bitCellsWarp.KINDS.beam.n);
  assertShellTakes(first, JSON.stringify(first));
  r.ctx.BitApp.heard(born({ desk: 'off' }));
  r.advance(100);
  const going = r.last();
  assert.equal(going.once.frames.length, bitCellsWarp.KINDS.crumble.n);
  assert.ok(empty(going), 'nothing left once its bits have flown');
  assertShellTakes(going, JSON.stringify(going));
  r.advance(crumbleMs + 100);
  assert.deepEqual(r.last(), { on: false });
  r.ctx.BitApp.heard(born());
  r.advance(100);
  assert.equal(r.last().once.frames.length, bitCellsWarp.KINDS.beam.n, 'back on: the beam again');
  assert.equal(empty(r.last()), false);
});

test('on every screen: it crumbles here and comes together on the next one, left to right', () => {
  const displays = [{ id: 'right', x: 3840, y: 0, primary: false }, { id: 'left', x: 0, y: 0, primary: true }];
  const r = rig({ warp: true, displays, bit: born({ desk: 'all', roam: 'stay' }) });
  r.advance(31 * 60000);
  const all = r.messages();
  const at = all.findIndex((m) => m.monitor === 'right');
  assert.ok(at > 0, 'it went to the other screen within 30 minutes');
  const before = all.slice(0, at).filter((m) => m.once).at(-1);
  assert.ok(empty(before) && before.monitor === '' && before.once.frames.length === bitCellsWarp.KINDS.crumble.n, 'crumbled on the main one');
  assert.equal(all[at].once.frames.length, bitCellsWarp.KINDS.assemble.n);
  assert.equal(empty(all[at]), false);
  for (const m of all) assertShellTakes(m, JSON.stringify(m));
  const one = rig({ warp: true, displays: displays.slice(1), bit: born({ desk: 'all', roam: 'stay' }) });
  one.advance(31 * 60000);
  assert.ok(one.messages().every((m) => m.monitor === '' && !empty(m)), 'one screen: it stays');
  assert.equal(one.desk.hop(), false, 'and a hop asked by hand does nothing');
  const three = [...displays, { id: 'edge', x: 1000, y: 2160, primary: false }];
  const dash = rig({ warp: true, displays: three, active: 'edge', bit: born({ desk: 'all', roam: 'stay' }) });
  assert.deepEqual([...dash.desk.screens()], ['left', 'right'], "never the dashboard's own screen");
  dash.advance(3 * 31 * 60000);
  assert.ok(dash.messages().some((m) => m.monitor === 'right') && dash.messages().every((m) => m.monitor !== 'edge'));
  const two = rig({ warp: true, displays, active: 'right', bit: born({ desk: 'all', roam: 'stay' }) });
  assert.equal(two.desk.hop(), false, "the other screen is the dashboard's: nowhere to go");
  const wide = [{ id: 'left', x: 0, y: 0, width: 3840, scale: 1.5, primary: true }, { id: 'side', x: 3840, y: 0, width: 1080, scale: 1, primary: false }];
  const away = rig({ warp: true, displays: wide, bit: born({ desk: 'all', roam: 'stay', deskX: 0.3 }) });
  away.advance(100);
  assert.equal(away.last().home, 0.3, 'the main screen: the place it was given');
  away.desk.hop();
  away.advance(2000);
  assert.equal(away.last().monitor, 'side');
  assert.equal(away.last().home, (1080 - 110 - 60) / (1080 - 60), 'another screen: just left of its clock');
  away.desk.dropped(0.5);
  away.advance(100);
  assert.equal(away.last().home, 0.5, 'dropped there: it stays for this visit');
  assert.deepEqual(away.posts, [], 'and the main screen\'s place is not touched');
  away.desk.hop();
  away.advance(2000);
  assert.equal(away.last().monitor, 'left');
  assert.equal(away.last().home, 0.3);
  const main = rig({ warp: true, displays, bit: born({ roam: 'stay' }) });
  main.advance(31 * 60000);
  assert.ok(main.messages().every((m) => m.monitor === ''), 'main screen only: it stays');
  assert.equal(main.desk.hop(), false);
});

test('turned off from its room: one message switches it off, then nothing', () => {
  const r = rig();
  r.advance(100);
  r.ctx.BitApp.heard(born({ desk: 'off' }));
  r.advance(100);
  assert.deepEqual(r.last(), { on: false });
  const sent = r.signals.length;
  r.advance(60000);
  assert.equal(r.signals.length, sent, 'no keepalive when off');
});

test('its own fidgets come at the pace of the Bit in the dashboard, none asleep', () => {
  const r = rig();
  r.advance(119000);
  assert.ok(r.messages().some((m) => m.once), 'a fidget within two minutes');
  const asleep = rig({ pace: 'asleep' });
  asleep.advance(600000);
  assert.ok(asleep.messages().every((m) => !m.once));
});

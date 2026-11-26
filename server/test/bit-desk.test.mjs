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
const bit = require('../../packages/core/src/bit.js');
require('../../packages/core/src/bit-clips-life.js');
require('../../packages/core/src/bit-clips-move.js');
const bitCells = require('../../packages/core/src/bit-cells.js');
const bitDirector = require('../../packages/core/src/bit-director.js');
const genome = require('../../packages/core/src/bit-genome.js');
const bitLook = require('../../packages/core/src/bit-look.js');

const SEED = '0123456789abcdef';
const LOOK = bitLook.lookOf(genome.decode(SEED), { background: '#0d1117' });
const MAX_PAYLOAD = 64 * 1024;
const born = (prefs = {}) => ({ ok: true, hatched: true, seed: SEED, prefs: { roam: 'mix', desk: 'main', deskX: null, ...prefs } });

function rig({ native = true, caps = { bitDesk: true }, bit: state = born(), reduced = false, pace = 'live', save = { ok: true } } = {}) {
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
    XenonNative: { afterLoad: (fn) => fn() },
    Xenon: { bit, bitCells, bitDirector },
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

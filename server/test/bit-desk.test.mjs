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
const SPOT = readFileSync(new URL('../js/bit-companion/desk-spot.js', import.meta.url), 'utf8');
const SIGNS = readFileSync(new URL('../js/bit-companion/signs.js', import.meta.url), 'utf8');
const TRY = readFileSync(new URL('../js/bit-companion/desk-try.js', import.meta.url), 'utf8');
const wardrobe = require('../../packages/core/src/bit-wardrobe.js');
const bit = require('../../packages/core/src/bit.js');
require('../../packages/core/src/bit-clips-life.js');
require('../../packages/core/src/bit-clips-move.js');
const bitCells = require('../../packages/core/src/bit-cells.js');
const bitCellsWarp = require('../../packages/core/src/bit-cells-warp.js');
const bitSigns = require('../../packages/core/src/bit-signs.js');
const bitDirector = require('../../packages/core/src/bit-director.js');
const genome = require('../../packages/core/src/bit-genome.js');
const bitLook = require('../../packages/core/src/bit-look.js');

const SEED = '0123456789abcdef';
const LOOK = bitLook.lookOf(genome.decode(SEED), { background: '#0d1117' });
const MAX_PAYLOAD = 64 * 1024;
const born = (prefs = {}) => ({ ok: true, hatched: true, seed: SEED, prefs: { roam: 'mix', desk: 'main', deskX: null, ...prefs } });

function rig({ native = true, caps = { bitDesk: true }, bit: state = born(), reduced = false, pace = 'live', save = { ok: true }, warp = false, displays = [], active = '', sign = '', menu = 'screen' } = {}) {
  let now = 0;
  let id = 0;
  const timers = new Map(); // id -> { at, fn, every }
  const signals = [];
  const posts = [];
  const handlers = {};
  const taps = []; // the dashboard's pocket, asked for when the menu's window can't show it
  const counted = []; // what was seen of the Bit (BitApp.seen, server/bit/seen.js)
  const ctx = {
    console: { ...console, warn() {} }, Math, Object, Number, JSON, Map, WeakMap, Promise,
    Date: { now: () => now },
    __XENON_NATIVE__: native,
    __XENON_NATIVE_CAPS__: caps,
    __xenonSignal: (url) => url,
    location: { set href(v) { signals.push(v); } },
    XenonNative: { afterLoad: (fn) => fn(), displayState: () => ({ displays, active }) },
    Xenon: { bit, bitCells, bitDirector, bitSigns, ...(warp ? { bitCellsWarp } : {}) },
    BitApp: {
      state: () => state, personal: () => LOOK, director: () => null, context: () => ({ hour: 12 }), seen: (what) => counted.push(what),
      dressed: (worn) => bitLook.lookOf(genome.decode(SEED), { background: '#0d1117', worn: wardrobe.outfit(worn) }),
      heard: (next) => { state = next; (handlers['xenon-bit'] || []).forEach((fn) => fn()); },
    },
    BitMoments: { pace: () => pace },
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    dispatchEvent: (e) => (handlers[e.type] || []).forEach((fn) => fn(e)),
    CustomEvent: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms = 0) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: (t) => timers.delete(t),
    setInterval: (fn, ms) => { timers.set(++id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: (t) => timers.delete(t),
    requestAnimationFrame: (fn) => ctx.setTimeout(fn, 16),
    SERVER: '',
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      if (url === '/screen-menu') return { status: 200, json: async () => ({ ok: true, where: menu }) };
      const out = typeof save === 'function' ? save() : save;
      if (out.ok) out.bit = { ...state, prefs: { ...state.prefs, ...JSON.parse(init.body) } };
      return { status: out.ok ? 200 : 500, json: async () => out };
    },
  };
  ctx.window = ctx;
  ctx.BitCompanion = { tap: (anchor) => taps.push(anchor) };
  ctx.BitSignals = { top: () => (sign ? { kind: sign, vars: {} } : null) };
  vm.createContext(ctx);
  vm.runInContext(SIGNS, ctx);
  vm.runInContext(FRAMES, ctx);
  vm.runInContext(SCREENS, ctx);
  vm.runInContext(SPOT, ctx);
  vm.runInContext(TRY, ctx);
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
  return { ctx, desk: ctx.BitDesk, tryOn: ctx.BitDeskTry, advance, signals, messages, last, posts, taps, counted };
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

test('on a ride it glides along faster, as in the dashboard', () => {
  const BOARD = { id: 'testBoard', slot: 'ride', source: 'shop', price: 120, names: { en: 'Test board' }, layers: [{ fill: '#d9603b', cells: [[1, 9, 10]] }] };
  wardrobe.addItems([BOARD]);
  const r = rig({ pace: 'slow' });
  r.ctx.BitApp.personal = () => bitLook.lookOf(genome.decode(SEED), { background: '#0d1117', worn: wardrobe.outfit(['testBoard']) });
  for (let s = 0; s < 301 && !r.last()?.walk; s += 1) r.advance(1000);
  assert.equal(r.last().walk.pxs, 57);
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
  assert.deepEqual(r.posts, [{ url: '/api/bit/prefs', body: { deskX: 0.421, deskY: null, deskScreen: '' } }]);
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

test("dropped away from the bar it stays put there, on any screen but the dashboard's; near the bar it walks again", async () => {
  const displays = [{ id: 'main', x: 0, y: 0, width: 3840, primary: true }, { id: 'side', x: -1080, y: 128, width: 1080, primary: false }, { id: 'edge', x: 573, y: 2160, width: 2560, primary: false }];
  const r = rig({ displays, active: 'edge' });
  r.advance(100);
  await r.desk.dropped(0.25, 0.4, 0, 0);
  r.advance(100);
  assert.deepEqual(r.posts.at(-1).body, { deskX: 0.25, deskY: 0.4, deskScreen: '' });
  assert.deepEqual([r.last().monitor, r.last().home, r.last().rise], ['', 0.25, 0.4], 'still where it was left');
  r.advance(20 * 60000);
  assert.ok(r.messages().slice(-20).every((m) => !m.walk), 'no stroll while it stays put');
  await r.desk.dropped(0.6, 0.1, -1080, 128);
  r.advance(100);
  assert.deepEqual(r.posts.at(-1).body, { deskX: 0.6, deskY: 0.1, deskScreen: 'side' }, 'another screen is its own now');
  assert.deepEqual([r.last().monitor, r.last().rise], ['side', 0.1]);
  const before = r.posts.length;
  await r.desk.dropped(0.5, 0.5, 573, 2160);
  r.advance(100);
  assert.equal(r.posts.length, before, "the dashboard's screen has its own Bit: not kept");
  assert.deepEqual([r.last().monitor, r.last().home, r.last().rise], ['side', 0.6, 0.1], 'and the shell is told its place again');
  await r.desk.dropped(0.3, 0.2, 9999, 9999);
  assert.equal(r.posts.length, before, 'a screen not known: not kept');
  await r.desk.dropped(0.8, -1, 0, 0);
  r.advance(100);
  assert.deepEqual(r.posts.at(-1).body, { deskX: 0.8, deskY: null, deskScreen: '' }, 'near the bar: back on it, on the main screen');
  assert.equal('rise' in r.last(), false);
  r.advance(6 * 60000);
  assert.ok(r.messages().some((m) => m.walk), 'and it strolls again');
});

test('a drop the shell shows is told back even when nothing changed, so the shell puts it where it belongs', async () => {
  const r = rig({ save: { ok: false, error: 'offline' } });
  r.advance(100);
  const n = r.signals.length;
  await r.desk.dropped(0.7, -1, Number.NaN, Number.NaN);
  r.advance(100);
  assert.ok(r.signals.length > n, 'sent again');
  assert.equal(r.last().home, 0.7);
});

test('going out files no message: the guided setup says how to move it (room-setup.js)', () => {
  const filed = [];
  const r = rig({ pace: 'game' });
  r.ctx.BitMessages = { file: (m) => { filed.push(m); return Promise.resolve(true); }, firstLine: (x) => x };
  r.advance(100);
  assert.equal(r.last().on, true);
  assert.equal(filed.length, 0);
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

test("tapped: the pocket, the chat or its room alone in the menu's window, as the person chose", async () => {
  for (const [tap, open] of [[undefined, 'pocket'], ['pocket', 'pocket'], ['chat', 'chat'], ['room', 'bitroom']]) {
    const r = rig({ pace: 'game', bit: born(tap ? { tap } : {}) });
    r.advance(100);
    await r.desk.tapped();
    const asked = r.posts.filter((p) => p.url === '/screen-menu');
    assert.deepEqual(asked.map((p) => p.body), [{ sheet: { open } }]);
    assert.deepEqual(r.taps, [], 'the window shows it: nothing on the dashboard');
  }
});

test('tapped where the shell has the pocket window: the pocket opens over Bit, the chat and room as before', async () => {
  const r = rig({ pace: 'game', caps: { bitDesk: true, bitPocket: true } });
  r.advance(100);
  await r.desk.tapped();
  assert.equal(r.signals.at(-1), 'xenon-app:bit-pocket');
  assert.deepEqual(r.posts.filter((p) => p.url === '/screen-menu'), [], "not in the menu's big window");
  const chat = rig({ pace: 'game', caps: { bitDesk: true, bitPocket: true }, bit: born({ tap: 'chat' }) });
  chat.advance(100);
  await chat.desk.tapped();
  assert.deepEqual(chat.posts.filter((p) => p.url === '/screen-menu').map((p) => p.body), [{ sheet: { open: 'chat' } }]);
  assert.ok(!chat.signals.includes('xenon-app:bit-pocket'));
});

test('tapped with no window to show it: the dashboard opens what was chosen', async () => {
  const r = rig({ pace: 'game', menu: 'closed' });
  r.advance(100);
  await r.desk.tapped();
  assert.deepEqual(r.taps, [null]);
});

test('a sign over its head on every frame of Bit, in colours the shell takes; none while it is gone', () => {
  const r = rig({ pace: 'game', sign: 'done' });
  r.advance(100);
  const msg = r.last();
  assertShellTakes(msg, JSON.stringify(msg));
  const ink = (hex) => String.fromCharCode(65 + msg.pal.indexOf(hex));
  assert.ok(msg.pal.includes('3fd16b') && msg.pal.includes('d9dde3'));
  for (const f of msg.loop) assert.equal(f.rows[0].slice(15, 19), ink('d9dde3') + ink('3fd16b').repeat(3), 'the flag, top right');
  const plain = rig({ pace: 'game' });
  plain.advance(100);
  assert.ok(!plain.last().pal.includes('3fd16b'), 'no sign, no flag');
});

test('every sign is five by five and fits the palette beside any Bit', () => {
  const r = rig();
  const S = r.ctx.BitSigns;
  assert.deepEqual([...S.KINDS].sort(), ['ask', 'bell', 'disk', 'done', 'soon']);
  for (const kind of S.KINDS) {
    const cells = S.cells(kind);
    assert.ok(cells.length > 0 && cells.every((c) => c.x >= 0 && c.x < 5 && c.y >= 0 && c.y < 5 && /^[0-9a-f]{6}$/.test(c.hex)), kind);
    assert.ok(new Set(cells.map((c) => c.hex)).size <= 4, kind + ': few colours, so the Bit keeps its own');
  }
  assert.equal(S.at('nope', 0, 0), null);
  assert.equal(S.cells('nope').length, 0);
});

// ── desk-try.js ──────────────────────────────────────────────────────────

const cellsOfMsg = (msg) => msg.loop[0].rows.join('');

test('tried on in the room: the desktop Bit wears it ten minutes, then takes it off; the next room tries it on again', () => {
  const r = rig({ pace: 'game', bit: { ...born(), worn: [] } });
  r.advance(100);
  const plain = cellsOfMsg(r.last());
  r.tryOn.start(['topHat']);
  r.advance(1000);
  assert.notEqual(cellsOfMsg(r.last()), plain, 'the hat is on the desktop Bit');
  assert.ok(r.tryOn.tried('topHat') && !r.tryOn.tried('beanie'));
  assert.deepEqual(r.counted, ['tryon']);
  assertShellTakes(r.last(), JSON.stringify(r.last()));
  assert.deepEqual([...r.tryOn.take()], [], 'nothing for the room while it lasts');
  r.advance(10 * 60 * 1000);
  assert.equal(cellsOfMsg(r.last()), plain, 'ten minutes later it is taken off');
  assert.deepEqual([...r.tryOn.take()], ['topHat'], 'the next room tries it on again');
  assert.deepEqual([...r.tryOn.take()], [], 'once');
});

test("the keep bar's button: only while the desktop Bit is out, and it says what it is doing", () => {
  const made = [];
  const el = () => {
    const b = { disabled: false, textContent: '', on: null, addEventListener: (_t, fn) => { b.on = fn; } };
    made.push(b);
    return b;
  };
  const ctx = { say: (k) => k, signal: null };
  const off = rig({ native: true, bit: born({ desk: 'off' }) });
  off.ctx.makeEl = (_tag, _cls, text) => Object.assign(el(), { textContent: text });
  off.advance(100);
  assert.equal(off.tryOn.button([{ id: 'topHat' }], ctx), null, 'no desktop Bit, no button');
  const r = rig({ pace: 'game' });
  r.ctx.makeEl = (_tag, _cls, text) => Object.assign(el(), { textContent: text });
  r.advance(100);
  const b = r.tryOn.button([{ id: 'topHat' }], ctx);
  assert.equal(b.textContent, 'mybit_try_desk');
  b.on();
  assert.deepEqual([b.textContent, b.disabled], ['mybit_try_desk_on', true]);
  assert.equal(r.tryOn.button([{ id: 'topHat' }], ctx).disabled, true, 'a new room says it is still on');
});

test('the room starts from what the desktop wore, and its support link says it came from there', () => {
  const W = readFileSync(new URL('../js/bit-companion/wardrobe.js', import.meta.url), 'utf8');
  const K = readFileSync(new URL('../js/bit-companion/wardrobe-keep.js', import.meta.url), 'utf8');
  assert.ok(W.includes('if (!tried.length) tried = window.BitDeskTry?.take() || [];'));
  assert.ok(K.includes("joinLink(ctx, window.BitDeskTry?.tried(it.id) ? 'bit-tryon' : SOURCE)"));
  assert.ok(K.includes('window.BitDeskTry?.button(items, ctx)'));
});

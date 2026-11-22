// "I took the widget off in iCUE and the pump is still in Xenon, its lights still set":
// a pump screen shows Xenon only while its page speaks (pump-screen/presence.js). An away
// screen keeps its settings, but the menu stops drawing it, its moments stop asking for
// readings, and its ring of lights is given back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createPumpPresence, AWAY_MS, GONE_MS } = require('../pump-screen/presence.js');
const { createPumpStore } = require('../pump-screen/store.js');
const { createPumpLive } = require('../pump-screen/live.js');
const { createPumpRing } = require('../pump-screen/ring.js');
const { createPumpActions } = require('../pump-screen/actions.js');
const { createChange } = require('../pump-screen/change.js');
const { createRoutes } = require('../pump-screen/handlers.js');
const { pumpViews } = require('../menu/menu-pump.js');

// A clock and timers the test moves by hand.
function time() {
  let now = 1_000_000;
  const timers = new Set();
  return {
    clock: () => now,
    later: (fn, ms) => { const t = { fn, at: now + ms }; timers.add(t); return t; },
    cancel: (t) => timers.delete(t),
    pass(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.delete(t); t.fn(); }
    },
    pending: () => timers.size,
  };
}

test('a screen is here while its page speaks, away after a silence, and only coming or going is told', () => {
  const t = time();
  let told = 0;
  const p = createPumpPresence({ ...t, changed: () => { told++; } });
  assert.equal(p.here('pump'), false, 'never heard');
  p.note('pump');
  assert.deepEqual([p.here('pump'), told], [true, 1]);
  t.pass(30_000);
  p.note('pump');
  assert.equal(told, 1, 'a beat of a screen already here changes nothing');
  t.pass(AWAY_MS - 1000);
  assert.equal(p.here('pump'), true);
  t.pass(2000);
  assert.deepEqual([p.here('pump'), told], [false, 2], 'silent past AWAY_MS: away, and told');
  assert.equal(t.pending(), 0, 'nothing left ticking once every screen is away');
  p.note('pump');
  assert.deepEqual([p.here('pump'), told], [true, 3], 'back');
  p.stop();
  assert.equal(t.pending(), 0);
});

test('a held connection that closes makes the screen away in seconds, unless one opens again', () => {
  const t = time();
  let told = 0;
  const p = createPumpPresence({ ...t, changed: () => { told++; } });
  const letGo = p.hold('pump');
  assert.deepEqual([p.here('pump'), told], [true, 1], 'opening it is the page speaking');
  letGo();
  t.pass(GONE_MS - 100);
  assert.equal(p.here('pump'), true, 'a page reloading has a moment to come back');
  t.pass(200);
  assert.deepEqual([p.here('pump'), told], [false, 2], 'closed and not back: away long before the silence would say so');
  assert.ok(GONE_MS * 10 < AWAY_MS);
  letGo();
  t.pass(GONE_MS * 2);
  assert.equal(told, 2, 'letting go twice is once');

  const reload = p.hold('pump');
  reload();
  t.pass(GONE_MS / 2);
  const again = p.hold('pump');
  t.pass(GONE_MS * 2);
  assert.deepEqual([p.here('pump'), told], [true, 3], 'the page reloading stays here');

  const second = p.hold('pump');
  again();
  t.pass(GONE_MS * 2);
  assert.equal(p.here('pump'), true, 'another page of the same screen still holds it');
  second();
  p.stop();
  assert.equal(t.pending(), 0, 'stop leaves nothing ticking');
});

test('the face page beats well inside the silence that makes it away', () => {
  const src = readFileSync(new URL('../js/pump/pump-face.js', import.meta.url), 'utf8');
  const beat = Number(/const BEAT_MS = (\d+);/.exec(src)?.[1]);
  assert.ok(beat > 0 && beat * 2 < AWAY_MS, `BEAT_MS ${beat} vs AWAY_MS ${AWAY_MS}`);
  assert.match(src, /helloTimer = setTimeout\(\(\) => hello\(true\), BEAT_MS\);/);
  // It holds its connection once its hello named the screen, and never as the menu's picture.
  assert.match(src, /id = d\.screen;\n\s+holdOn\(\);/);
  assert.match(src, /new EventSource\('\/pump\/here\?screen=' \+ encodeURIComponent\(id\)\)/);
  assert.match(src, /if \(preview \|\| !id \|\|/);
});

function rig(tt) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-presence-'));
  tt.after(() => rmSync(dir, { recursive: true, force: true }));
  const t = time();
  const store = createPumpStore({ dataDir: dir });
  const rings = [];
  const presence = createPumpPresence({ ...t, changed: () => live.push(true) });
  const here = (id) => presence.here(id);
  const ring = createPumpRing({ store, here, setRing: (s) => rings.push(s), clock: t.clock, later: t.later, cancel: t.cancel });
  const live = createPumpLive({ store, here, broadcast: () => {}, changed: () => ring.refresh() });
  const actions = createPumpActions({ store, live, change: createChange({ store, live }), here });
  const routes = createRoutes({ store, live, ring, presence });
  rig.last = routes;
  const call = async (key, body) => {
    let answer;
    await routes[key]({}, {}, { json: (v) => { answer = v; }, readBody: async () => JSON.stringify(body), sendPage: async () => {} });
    return answer;
  };
  const hello = () => call('POST /pump/hello', { screen: 'pump', shape: 'round', w: 480, h: 480, via: 'icue' });
  return { t, store, live, rings, actions, call, hello };
}

test('a pump whose widget was taken off: kept, not drawn, the first step offered again, its lights given back', async (tt) => {
  const { t, live, rings, actions, call, hello } = rig(tt);
  assert.equal((await hello()).ok, true);
  await actions.run({ type: 'pumpSetup', screen: 'pump', setup: 'game' });
  await call('POST /pump', { screen: 'pump', patch: { leds: { follow: 'theme' } } });
  assert.equal(rings.at(-1)?.follow, 'theme', 'the ring is painted while the pump shows Xenon');
  const menu = async () => pumpViews({ pump: { icue: true, url: 'u', detected: [{ brand: 'corsair', route: 'icue' }], screens: (await actions.run({ type: 'pumpGet' })).screens } });
  assert.equal((await menu())[0].key, 'pump:pump');
  assert.ok(live.source.rules().length > 0, 'its moments ask for readings');

  t.pass(AWAY_MS + 100);
  const got = await actions.run({ type: 'pumpGet' });
  assert.deepEqual([got.screens.length, got.screens[0].here], [1, false], 'kept, and Bit is told it is away');
  assert.equal(got.screens[0].moments.length > 0, true, 'its settings stay for when it comes back');
  assert.equal(rings.at(-1), null, 'the ring goes back');
  const away = await menu();
  assert.deepEqual([away.length, away[0].key, away[0].add], [1, 'pump-add', true], 'the card is the first step again');
  assert.deepEqual(live.source.rules(), [], 'no readings asked for a pump showing nothing');
  assert.equal((await call('GET /pump')).screens.pump.here, false);

  await hello();
  assert.equal(rings.at(-1)?.follow, 'theme', 'back: painted again');
  assert.equal((await menu())[0].key, 'pump:pump');
});

// A request and an answer, enough for the held connection.
function stream() {
  const closers = [];
  const res = { status: 0, head: null, body: '', writeHead(code, head) { this.status = code; this.head = head; }, write(x) { this.body += x; }, end(x = '') { this.body += x; } };
  const req = { on: (ev, fn) => { if (ev === 'close') closers.push(fn); } };
  return { req, res, close: () => closers.forEach((fn) => fn()) };
}

test('GET /pump/here: held by a known screen, closed it makes the pump away in seconds', async (tt) => {
  const { t, rings, call, hello } = rig(tt);
  const routes = rig.last;
  const open = async (screen) => {
    const s = stream();
    await routes['GET /pump/here'](s.req, s.res, { urlObj: new URL('http://127.0.0.1/pump/here?screen=' + screen) });
    return s;
  };
  assert.equal((await open('pump')).res.status, 404, 'a screen that never said hello');
  await hello();
  await call('POST /pump', { screen: 'pump', patch: { leds: { follow: 'theme' } } });
  const held = await open('pump');
  assert.equal(held.res.status, 200);
  assert.match(held.res.head['Content-Type'], /^text\/event-stream/);
  assert.match(held.res.body, /^retry: 1000\n/, 'the page comes back fast after a drop');
  assert.equal((await open('../x')).res.status, 404);
  held.close();
  t.pass(GONE_MS + 100);
  assert.equal((await call('GET /pump')).screens.pump.here, false, 'iCUE closed the page: away');
  assert.equal(rings.at(-1), null, 'and its ring given back');
});

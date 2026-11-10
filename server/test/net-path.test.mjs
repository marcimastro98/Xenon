import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createNetPath, pickProvider, trafficBetween,
  INTERNET_TARGETS, IDLE_MS, ROUTE_CHECK_MS, ROUTE_RETRY_MS, SILENT_AFTER, STALE_MS, REVIVE_MS,
} = require('../net-path/net-path.js');

// Invented addresses only: RFC 5737 documentation ranges and generic private examples.
const GW = '192.168.1.1';
const HOP = '10.20.0.1';        // a provider that numbers its first hop privately
const NEXT = '198.51.100.1';
const NET = INTERNET_TARGETS[0];

const turn = () => new Promise((resolve) => setImmediate(resolve));
const key = (t) => `${t.ip}@${t.ttl || 0}`;

function fakeBackend({ route, available = true } = {}) {
  const b = {
    routeValue: route === undefined ? { iface: 7, gateway: GW, link: 'wired' } : route,
    hops: [{ ttl: 1, ip: GW, ms: 0.4 }, { ttl: 2, ip: HOP, ms: 3.1 }, { ttl: 3, ip: NEXT, ms: 5 }],
    ifaceValue: { linkMbps: 1000, dbm: null, rx: 1000, tx: 500 },
    watchers: [],
    calls: { route: 0, trace: 0, iface: 0, close: 0 },
    available: () => available,
    route: async () => { b.calls.route += 1; return b.routeValue; },
    trace: async () => { b.calls.trace += 1; return b.hops; },
    iface: async () => { b.calls.iface += 1; return b.ifaceValue && { ...b.ifaceValue }; },
    watch(target, onSample) {
      const w = { target, onSample, stopped: false, isDead: false };
      b.watchers.push(w);
      return { stop() { w.stopped = true; }, dead: () => w.isDead };
    },
    close: () => { b.calls.close += 1; },
  };
  return b;
}

function clock() {
  let t = 1000000;
  const timers = new Set();
  return {
    now: () => t,
    tick(ms) {
      t += ms;
      for (const h of [...timers]) if (h.at <= t) { timers.delete(h); h.fn(); }
    },
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, unref() {} }; timers.add(h); return h; },
    clearTimer: (h) => timers.delete(h),
  };
}

const live = (b) => b.watchers.filter((w) => !w.stopped);
const liveKeys = (b) => live(b).map((w) => key(w.target)).sort();
function watcherFor(b, ip, ttl = 0) {
  const w = live(b).find((x) => key(x.target) === `${ip}@${ttl}`);
  assert.ok(w, `no live watcher for ${ip}@${ttl}`);
  return w;
}
const feed = (b, ip, values, ttl = 0) => { const w = watcherFor(b, ip, ttl); for (const v of values) w.onSample(v); };
const times = (n, v) => Array(n).fill(v);

async function started(opts) {
  const b = fakeBackend(opts);
  const c = clock();
  const np = createNetPath(b, c);
  const first = await np.read();
  await turn();
  return { b, c, np, first };
}

test('nothing runs before the first read; it finds the route and measures each stretch', async () => {
  const b = fakeBackend();
  const np = createNetPath(b, clock());
  assert.equal(b.watchers.length, 0);
  const r = await np.read();
  await turn();
  assert.equal(r.ok, true);
  assert.equal(r.link, 'wired');
  assert.equal(r.linkMbps, 1000);
  assert.equal(r.router, null);   // no echo back yet: nothing to say
  assert.deepEqual(liveKeys(b), [`${HOP}@2`, `${NET}@0`, `${GW}@0`].sort());
});

test('the reading carries numbers, never an address', async () => {
  const { b, np } = await started();
  feed(b, GW, [0.4, 0.5, 0.6]);
  feed(b, HOP, [3, 3.2, 3.1], 2);
  feed(b, NET, [12, 11, 13]);
  const r = await np.read();
  assert.deepEqual(Object.keys(r).sort(), ['dbm', 'internet', 'link', 'linkMbps', 'ok', 'provider', 'router', 'signal', 'traffic']);
  assert.equal(r.router.now, 0.5);
  assert.equal(r.provider.now, 3.1);
  assert.equal(r.internet.now, 12);
  assert.doesNotMatch(JSON.stringify(r), /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
});

test('reads at the same time share one route and one interface reading', async () => {
  const b = fakeBackend();
  const np = createNetPath(b, clock());
  const [x, y] = await Promise.all([np.read(), np.read()]);
  assert.equal(b.calls.route, 1);
  assert.equal(b.calls.iface, 1);
  assert.deepEqual(x, y);
});

test('a read never waits for the trace, nor for a slow interface reading after the first', async () => {
  const b = fakeBackend();
  const c = clock();
  b.trace = () => new Promise(() => {});
  const np = createNetPath(b, c);
  assert.equal((await np.read()).ok, true);
  b.iface = () => new Promise(() => {});
  c.tick(2000);
  assert.equal((await np.read()).linkMbps, 1000);
});

test('traffic is the byte rate between two interface readings', async () => {
  const { b, c, np, first } = await started();
  assert.equal(first.traffic, null);
  c.tick(2000);
  b.ifaceValue = { linkMbps: 1000, dbm: null, rx: 5000, tx: 1500 };
  await np.read();
  await turn();
  assert.deepEqual((await np.read()).traffic, { downBps: 2000, upBps: 500 });
});

test('the Wi-Fi level shows only on a Wi-Fi link', async () => {
  const b = fakeBackend({ route: { iface: 3, gateway: GW, link: 'wifi' } });
  b.ifaceValue = { linkMbps: 866, dbm: -60, rx: 1, tx: 1 };
  const r = await createNetPath(b, clock()).read();
  assert.equal(r.signal, 80);
  assert.equal(r.dbm, -60);
  const w = fakeBackend();
  w.ifaceValue = { linkMbps: 1000, dbm: -60, rx: 1, tx: 1 };
  const r2 = await createNetPath(w, clock()).read();
  assert.equal(r2.signal, null);
  assert.equal(r2.dbm, null);
});

test('IDLE_MS after the last read every watcher stops, and the next read starts again', async () => {
  const { b, c, np } = await started();
  assert.equal(live(b).length, 3);
  c.tick(IDLE_MS - 1);
  await np.read();
  c.tick(IDLE_MS - 1);
  assert.equal(np.running(), true);
  c.tick(1);
  assert.equal(np.running(), false);
  assert.equal(live(b).length, 0);
  await np.read();
  await turn();
  assert.equal(live(b).length, 3);
  assert.equal(b.calls.route, 2);
});

test('stop ends everything, closes the backend and refuses later reads', async () => {
  const { b, np } = await started();
  np.stop();
  assert.equal(live(b).length, 0);
  assert.equal(b.calls.close, 1);
  assert.deepEqual(await np.read(), { ok: false, error: 'unavailable' });
  assert.equal(live(b).length, 0);
});

test('no backend, or one that is not available here, reads as unavailable', async () => {
  assert.deepEqual(await createNetPath(null, clock()).read(), { ok: false, error: 'unavailable' });
  const b = fakeBackend({ available: false });
  assert.deepEqual(await createNetPath(b, clock()).read(), { ok: false, error: 'unavailable' });
  assert.equal(b.watchers.length, 0);
});

test('behind a VPN only the far end is measured', async () => {
  const { b, first } = await started({ route: { iface: 9, gateway: '10.8.0.1', link: 'vpn' } });
  assert.equal(first.link, 'vpn');
  assert.deepEqual(liveKeys(b), [`${NET}@0`]);
  assert.equal(b.calls.trace, 0);
});

test('without a route only the internet is tried, and the route is asked again soon', async () => {
  const { b, c, np, first } = await started({ route: null });
  assert.equal(first.link, null);
  assert.deepEqual(liveKeys(b), [`${NET}@0`]);
  c.tick(ROUTE_RETRY_MS - 1);
  await np.read();
  assert.equal(b.calls.route, 1);
  b.routeValue = { iface: 7, gateway: GW, link: 'wired' };
  c.tick(1);
  const r = await np.read();
  await turn();
  assert.equal(b.calls.route, 2);
  assert.equal(r.link, 'wired');
  assert.ok(watcherFor(b, GW));
});

test('a new route forgets the old path and finds the new one', async () => {
  const { b, c, np } = await started();
  b.routeValue = { iface: 8, gateway: '192.168.0.254', link: 'wifi' };
  for (let i = 0; i < 4; i += 1) { c.tick(ROUTE_CHECK_MS / 4); await np.read(); }
  await turn();
  assert.equal(b.calls.route, 2);
  assert.ok(watcherFor(b, '192.168.0.254'));
  assert.equal(live(b).some((w) => w.target.ip === GW), false);
  assert.equal(b.calls.trace, 2);
});

test('a router that never answers echoes is timed at TTL 1, then left out', async () => {
  const { b, c, np } = await started();
  feed(b, NET, times(SILENT_AFTER, 12));
  feed(b, GW, times(SILENT_AFTER, null));
  await np.read();
  assert.ok(watcherFor(b, GW, 1));
  assert.equal(live(b).some((w) => key(w.target) === `${GW}@0`), false);
  feed(b, GW, times(SILENT_AFTER, null), 1);
  assert.equal((await np.read()).router, null);
  assert.equal(live(b).some((w) => w.target.ip === GW), false);
  for (let i = 0; i < 4; i += 1) { c.tick(ROUTE_CHECK_MS / 4); await np.read(); }
  assert.equal(b.calls.route, 2);
  assert.equal(live(b).some((w) => w.target.ip === GW), false);
});

test("a provider's hop that stops answering gives way to the next hop", async () => {
  const { b, np } = await started();
  assert.ok(watcherFor(b, HOP, 2));
  feed(b, NET, times(SILENT_AFTER, 12));
  feed(b, HOP, times(SILENT_AFTER, null), 2);
  await np.read();
  await turn();
  assert.equal(b.calls.trace, 2);
  assert.ok(watcherFor(b, NEXT, 3));
});

test('silent hops are left alone while the internet does not answer either', async () => {
  const { b, np } = await started();
  feed(b, NET, [12, ...times(SILENT_AFTER, null)]);
  feed(b, GW, times(SILENT_AFTER, null));
  await np.read();
  assert.ok(watcherFor(b, GW));
  assert.ok(watcherFor(b, NET));
});

test('the internet moves to the next target only while the first has never answered', async () => {
  const { b, np } = await started();
  const old = watcherFor(b, NET);
  feed(b, NET, times(SILENT_AFTER, null));
  await np.read();
  const next = INTERNET_TARGETS[1];
  assert.ok(watcherFor(b, next));
  assert.equal(old.stopped, true);
  old.onSample(5);   // a late answer for the replaced target is not counted
  assert.equal((await np.read()).internet, null);
  feed(b, next, [15, ...times(SILENT_AFTER, null)]);
  const r = await np.read();
  assert.ok(watcherFor(b, next));
  assert.equal(r.internet.loss, 90.9);
});

test('a ping child that exited comes back with its numbers, at most every REVIVE_MS', async () => {
  const { b, c, np } = await started();
  feed(b, NET, [10, 11, 12]);
  const first = watcherFor(b, NET);
  first.isDead = true;
  await np.read();
  assert.equal(first.stopped, false);
  c.tick(REVIVE_MS);
  const r = await np.read();
  assert.equal(first.stopped, true);
  assert.notEqual(watcherFor(b, NET), first);
  assert.equal(r.internet.n, 3);
});

test('a stretch with no echo for STALE_MS reads null', async () => {
  const { b, c, np } = await started();
  feed(b, NET, [10]);
  c.tick(STALE_MS / 2);
  assert.equal((await np.read()).internet.n, 1);
  c.tick(STALE_MS / 2 + 1);
  assert.equal((await np.read()).internet, null);
});

test("the provider's hop: past the gateway and past a second router at home", () => {
  const at = (ttl, ip, ms) => ({ ttl, ip, ms });
  // double NAT: the second router adds well under HOME_HOP_MS
  assert.deepEqual(pickProvider([at(1, GW, 0.4), at(2, '192.168.0.1', 0.9), at(3, NEXT, 6)], GW), { ip: NEXT, ttl: 3 });
  // a provider numbering its first hop privately is told by its delay
  assert.deepEqual(pickProvider([at(1, GW, 0.4), at(2, HOP, 3.1)], GW), { ip: HOP, ttl: 2 });
  // shared address space (CGNAT) is the provider's however close
  assert.deepEqual(pickProvider([at(1, GW, 0.4), at(2, '100.64.0.1', 0.8)], GW), { ip: '100.64.0.1', ttl: 2 });
  // silent, loopback and link-local hops are skipped; so is a hop asked to be
  assert.deepEqual(pickProvider([at(1, GW, 0.4), at(2, null, null), at(3, '169.254.0.1', 2), at(4, '203.0.113.1', 7)], GW), { ip: '203.0.113.1', ttl: 4 });
  assert.deepEqual(pickProvider([at(1, GW, 0.4), at(2, HOP, 3.1), at(3, NEXT, 5)], GW, new Set([HOP])), { ip: NEXT, ttl: 3 });
  // reaching the internet target first, or nothing past home, finds no provider
  assert.equal(pickProvider([at(1, GW, 0.4), at(2, NET, 9)], GW), null);
  assert.equal(pickProvider([at(1, null, null), at(2, '192.168.0.1', 1.2)], GW), null);
  assert.equal(pickProvider([], GW), null);
});

test('traffic between two counter readings', () => {
  const a = { iface: 7, rx: 1000, tx: 500, at: 0 };
  assert.deepEqual(trafficBetween(a, { iface: 7, rx: 3000, tx: 900, at: 2000 }, 7), { downBps: 1000, upBps: 200 });
  assert.equal(trafficBetween(null, a, 7), null);
  assert.equal(trafficBetween(a, { iface: 8, rx: 3000, tx: 900, at: 2000 }, 8), null);
  assert.equal(trafficBetween(a, { iface: 7, rx: 10, tx: 900, at: 2000 }, 7), null);   // the counter wrapped
  assert.equal(trafficBetween(a, { iface: 7, rx: 3000, tx: 900, at: 0 }, 7), null);
  assert.equal(trafficBetween(a, { iface: 7, rx: null, tx: 900, at: 2000 }, 7), null);
});

test('MIB_IF_ROW2 is laid out as Windows lays it out (x64)', { skip: process.platform !== 'win32' }, () => {
  const win = require('../net-path/windows.js');
  assert.equal(win.available(), true);
  const koffi = require('koffi');
  assert.equal(koffi.sizeof('NP_IF_ROW2'), 1352);
  assert.equal(koffi.offsetof('NP_IF_ROW2', 'InterfaceIndex'), 8);
  assert.equal(koffi.offsetof('NP_IF_ROW2', 'Type'), 1128);
  assert.equal(koffi.offsetof('NP_IF_ROW2', 'TransmitLinkSpeed'), 1192);
  assert.equal(koffi.offsetof('NP_IF_ROW2', 'InOctets'), 1208);
  assert.equal(koffi.offsetof('NP_IF_ROW2', 'OutOctets'), 1280);
});

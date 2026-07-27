import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wn = require('../winnotif.js');

// Drive the module through its line handler — the exact code path the child
// reader (helper exe / notifications.ps1) feeds — with fake init() deps.
let items = [];
let feedEvents = 0;
let excludedIds = [];

function line(obj) { wn._handleLine(JSON.stringify(obj)); }

beforeEach(() => {
  items = [];
  feedEvents = 0;
  excludedIds = [];
  wn.init({
    isExcluded: (it) => excludedIds.includes(it.aumid || it.app),
    onItem: (it) => items.push(it),
    onFeed: () => { feedEvents++; },
  });
  // Reset internal state between tests: an empty seed replaces the feed.
  line({ event: 'seed', items: [] });
  line({ event: 'status', status: 'allowed' });
  feedEvents = 0;
});

test('status line updates state and announces only on change', () => {
  line({ event: 'status', status: 'denied' });
  assert.equal(wn.getState(), 'denied');
  assert.equal(feedEvents, 1);
  line({ event: 'status', status: 'denied' });   // no change → no announce
  assert.equal(feedEvents, 1);
  line({ event: 'status', status: 'allowed' });
  assert.equal(wn.getState(), 'allowed');
  assert.equal(feedEvents, 2);
});

test('unknown status collapses to unavailable', () => {
  line({ event: 'status', status: 'weird' });
  assert.equal(wn.getState(), 'unavailable');
});

test('seed replaces the feed wholesale and announces once', () => {
  line({ event: 'seed', items: [{ id: 1, app: 'Mail', title: 'Hi', body: 'B', at: 123, icon: null }] });
  assert.equal(feedEvents, 1);
  assert.equal(wn.getFeed().length, 1);
  line({ event: 'seed', items: [{ app: 'Teams', title: 'T' }, { app: 'Mail', title: 'M' }] });
  assert.equal(wn.getFeed().length, 2);
  assert.equal(wn.getFeed()[0].app, 'Teams');
});

test('projection caps lengths, keeps known keys only, assigns server ids', () => {
  line({ event: 'seed', items: [{ id: 999, app: 'A'.repeat(500), aumid: 'X', title: 'T'.repeat(500), body: 'B'.repeat(900), at: 42, icon: null, evil: 'nope' }] });
  const it = wn.getFeed()[0];
  assert.equal(it.app.length, 200);
  assert.equal(it.title.length, 200);
  assert.equal(it.body.length, 400);
  assert.equal(it.at, 42);
  assert.equal(it.evil, undefined);
  assert.notEqual(it.id, 999);                       // server-assigned, not the child's
  line({ event: 'notification', item: { app: 'B' } });
  assert.ok(items[0].id > it.id);                    // monotonic
});

test('icon survives only as a bounded data:image/ URI', () => {
  line({ event: 'seed', items: [
    { app: 'ok', icon: 'data:image/png;base64,AAAA' },
    { app: 'remote', icon: 'https://evil.example/x.png' },
    { app: 'script', icon: 'javascript:alert(1)' },
    { app: 'huge', icon: 'data:image/png;base64,' + 'A'.repeat(200 * 1024) },
  ] });
  const byApp = Object.fromEntries(wn.getFeed().map(i => [i.app, i.icon]));
  assert.equal(byApp.ok, 'data:image/png;base64,AAAA');
  assert.equal(byApp.remote, null);
  assert.equal(byApp.script, null);
  assert.equal(byApp.huge, null);
});

test('notification prepends, fires onItem, caps at 30', () => {
  for (let i = 0; i < 35; i++) line({ event: 'notification', item: { app: 'App' + i, title: 't' } });
  assert.equal(items.length, 35);
  assert.equal(wn.getFeed().length, 30);
  assert.equal(wn.getFeed()[0].app, 'App34');        // newest first
});

test('excluded apps are dropped from both seed and live pushes', () => {
  excludedIds = ['com.spam.app'];
  line({ event: 'seed', items: [{ app: 'Spam', aumid: 'com.spam.app' }, { app: 'Mail', aumid: 'com.mail' }] });
  assert.equal(wn.getFeed().length, 1);
  assert.equal(wn.getFeed()[0].app, 'Mail');
  line({ event: 'notification', item: { app: 'Spam', aumid: 'com.spam.app' } });
  assert.equal(items.length, 0);
  assert.equal(wn.getFeed().length, 1);
});

test('exclusion falls back to the app name when there is no AUMID', () => {
  excludedIds = ['NoAumidApp'];
  line({ event: 'notification', item: { app: 'NoAumidApp' } });
  assert.equal(items.length, 0);
});

test('applyExclusions prunes the stored feed and announces only when it changed', () => {
  line({ event: 'seed', items: [{ app: 'Keep', aumid: 'k' }, { app: 'Drop', aumid: 'd' }] });
  feedEvents = 0;
  wn.applyExclusions();                              // nothing excluded yet
  assert.equal(feedEvents, 0);
  excludedIds = ['d'];
  wn.applyExclusions();
  assert.equal(feedEvents, 1);
  assert.deepEqual(wn.getFeed().map(i => i.app), ['Keep']);
});

test('malformed lines and unknown events are ignored', () => {
  wn._handleLine('not json at all');
  line({ event: 'mystery', item: { app: 'x' } });
  line({ event: 'notification' });                   // no item
  assert.equal(items.length, 0);
  assert.equal(wn.getFeed().length, 0);
});

test('sync(false) drops the buffered feed (privacy) and resets state', () => {
  line({ event: 'notification', item: { app: 'Mail', title: 'secret' } });
  assert.equal(wn.getFeed().length, 1);
  wn.sync(false);
  assert.equal(wn.getFeed().length, 0);
  assert.equal(wn.getState(), 'off');
});

// ── the Linux dbus idle-flush ───────────────────────────────────────────────
// dbus-monitor blocks are only "complete" when the NEXT message's header
// arrives, but the match rule narrows the stream to Notify calls, so on a quiet
// desktop the next one can be minutes away. The last block must therefore be
// flushed on idle, or the most recent notification stays invisible.

function notifyBlock(title) {
  return 'method call time=1.1 interface=org.freedesktop.Notifications; member=Notify\n'
    + '   string "App"\n   uint32 0\n   string "icon"\n'
    + `   string "${title}"\n   string "body"\n`;
}

test('Linux: a lone notification is delivered by the idle flush, not held forever', () => {
  wn.init({ isExcluded: () => false, onItem: (it) => items.push(it), onFeed: () => { feedEvents++; } });
  line({ event: 'seed', items: [] });
  wn._setProcForTest({});                 // a live child, so the flush proceeds
  items = [];

  wn._onDbusData(notifyBlock('first'));
  assert.equal(items.length, 0, 'held: no following header has proven it complete yet');

  wn._flushLinuxTail();                    // what the 250ms idle timer calls
  assert.equal(items.length, 1, 'delivered without waiting for another notification');
  assert.equal(items[0].title, 'first');

  // A second, much later, is delivered once — the first is not repeated.
  wn._onDbusData(notifyBlock('second'));
  wn._flushLinuxTail();
  assert.deepEqual(items.map((i) => i.title), ['first', 'second']);
  wn._setProcForTest(null);
});

test('Linux: fast back-to-back — the header split delivers all but the last at once', () => {
  wn.init({ isExcluded: () => false, onItem: (it) => items.push(it), onFeed: () => { feedEvents++; } });
  line({ event: 'seed', items: [] });
  wn._setProcForTest({});
  items = [];

  wn._onDbusData(notifyBlock('a') + notifyBlock('b'));
  assert.deepEqual(items.map((i) => i.title), ['a'], 'a completed by b\'s header; b still held');
  wn._flushLinuxTail();
  assert.deepEqual(items.map((i) => i.title), ['a', 'b'], 'b flushed, a not repeated');
  wn._setProcForTest(null);
});

test('Linux: a mid-write block is never emitted, then is emitted once when complete', () => {
  wn.init({ isExcluded: () => false, onItem: (it) => items.push(it), onFeed: () => { feedEvents++; } });
  line({ event: 'seed', items: [] });
  wn._setProcForTest({});
  items = [];

  wn._onDbusData('method call member=Notify\n   string "App"\n   string "ic');  // cut mid-block
  wn._flushLinuxTail();
  assert.equal(items.length, 0, 'a partial block does not parse, so nothing is emitted');

  wn._onDbusData('on"\n   string "third"\n   string "body"\n');                 // completes it
  wn._flushLinuxTail();
  assert.deepEqual(items.map((i) => i.title), ['third'], 'emitted once, whole');
  wn._setProcForTest(null);
});

// ── which platforms have a reader, and what the dashboard is told ───────────
// sync() used to gate on win32 alone, which made _wanted permanently false on
// Linux, so _start() was never called and the whole dbus path was unreachable
// code. Nothing caught it because every Linux test above drives the parser and
// the test hooks directly, never sync(). These do.

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
function withPlatform(value, fn) {
  Object.defineProperty(process, 'platform', { ...PLATFORM, value });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', PLATFORM); }
}

test('isSupported covers the platforms that actually have a reader', () => {
  assert.equal(withPlatform('win32', () => wn.isSupported()), true);
  assert.equal(withPlatform('linux', () => wn.isSupported()), true);
  assert.equal(withPlatform('darwin', () => wn.isSupported()), false);
  assert.equal(withPlatform('freebsd', () => wn.isSupported()), false);
});

test('sync(true) on Linux reaches the reader instead of no-opping', () => {
  // The regression: state must leave 'off'. Where dbus-monitor is absent that
  // is 'unavailable'; where it is present the monitor starts and reports
  // 'allowed'. Either proves _start() ran — the old gate produced neither.
  const state = withPlatform('linux', () => {
    wn.sync(true);
    const s = wn.getState();
    wn.sync(false);          // stop any child this started before leaving
    return s;
  });
  assert.notEqual(state, 'off');
  assert.ok(['starting', 'allowed', 'unavailable'].includes(state), `unexpected state ${state}`);
});

test('where there is no reader the tile is told a terminal state, never "off"', () => {
  withPlatform('darwin', () => {
    wn.sync(true);
    // The raw child state stays what it is — the reader's own logic and the
    // tests above depend on that — but 'off' is what the tile renders as a
    // permanent "Connecting…", so that is not what it is told.
    assert.equal(wn.getState(), 'off');
    assert.equal(wn.reportedState(), 'unavailable');
  });
});

test('where there is a reader, reportedState is the raw state', () => {
  withPlatform('win32', () => {
    line({ event: 'status', status: 'denied' });
    assert.equal(wn.reportedState(), 'denied');
    assert.equal(wn.reportedState(), wn.getState());
  });
});

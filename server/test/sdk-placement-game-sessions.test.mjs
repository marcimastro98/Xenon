// Two reads the single-screen work gave widgets (v4.12.0).
//
// `placement`: where a widget is drawn (dashboard, desktop, over a game, beside
// a window) and whether a dashboard is in use, so the same widget can lay
// itself out for each place. No grant: it says nothing about the user.
//
// `gameSessions`: the games played and how they ran, a pulled stream behind
// its own grant (it is history).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');
const BRIDGE = readFileSync(new URL('../js/custom-widget.js', import.meta.url));
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url));
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url));
const DOC = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url));
const SERVER = readFileSync(new URL('../server.js', import.meta.url));
const { SDK_STREAMS } = require('../sdk-widgets.js');
const { widgetSnapshot, normalizeSession, compareSessions } = require('../game-sessions.js');
const { remotePathAllowed } = require('../remote-access.js');

// The placement code, run as written: from its constant to the end of postPlacement.
function placementKit(search, hubSettings, scene) {
  const at = BRIDGE.indexOf('  const LAYER_SURFACES');
  const fnAt = BRIDGE.indexOf('function postPlacement(', at);
  assert.ok(at > 0 && fnAt > at, 'js/custom-widget.js must still define the placement code');
  const end = BRIDGE.indexOf('\n  }', fnAt) + 4;
  const posted = [];
  const window = { location: { search } };
  const document = { documentElement: { dataset: scene ? { scene } : {} } };
  const post = (_entry, msg) => posted.push(msg);
  // eslint-disable-next-line no-new-func
  const kit = new Function('window', 'document', 'hubSettings', 'post',
    `${BRIDGE.slice(at, end)}; return { placementOf, postPlacement, placementKey };`)(window, document, hubSettings, post);
  return { ...kit, posted };
}

test('placement names the surface from the layer key, and the frame kind wins', () => {
  const where = (search, entry = {}) => placementKit(search, {}).placementOf(entry).where;
  assert.equal(where(''), 'dashboard');
  assert.equal(where('?layer=desktop%3A%5C%5C.%5CDISPLAY1'), 'desktop');
  assert.equal(where('?layer=overlay:x'), 'overlay');
  assert.equal(where('?a=1&layer=anchor:lw_abcd1234'), 'anchor');
  assert.equal(where('?layer=other:x'), 'dashboard', 'an unknown kind is not invented');
  assert.equal(where('?layer=%E0%A4%A'), 'dashboard', 'a broken escape never throws');
  assert.equal(where('?layer=overlay:x', { service: true }), 'background');
  assert.equal(where('', { ambient: true }), 'ambient');
});

test('an Ambient scene on the desktop scene page says wallpaper or screensaver', () => {
  const where = (scene, entry = { ambient: true }) => placementKit('', {}, scene).placementOf(entry).where;
  assert.equal(where('wallpaper'), 'wallpaper');
  assert.equal(where('saver'), 'screensaver');
  assert.equal(where('constructor'), 'ambient', 'a name off the table is not looked up on the prototype');
  assert.equal(where('wallpaper', {}), 'dashboard', 'only the Ambient frame takes the scene name');
});

test('dashboard is false only when the user runs widgets only', () => {
  const dash = (hs) => placementKit('', hs).placementOf({}).dashboard;
  assert.equal(dash({ usageMode: 'widgets' }), false);
  for (const hs of [{}, null, { usageMode: '' }, { usageMode: 'dashboard' }, { usageMode: 'both' }, { usageMode: 'junk' }]) {
    assert.equal(dash(hs), true, JSON.stringify(hs));
  }
});

test('a change is pushed once, an unchanged pass sends nothing', () => {
  const hs = { usageMode: 'dashboard' };
  const k = placementKit('?layer=overlay:m', hs);
  const entry = { ready: true };
  entry.placementKey = k.placementKey(k.placementOf(entry));   // what init said
  k.postPlacement(entry);
  assert.equal(k.posted.length, 0);
  hs.usageMode = 'widgets';
  k.postPlacement(entry);
  k.postPlacement(entry);
  assert.deepEqual(JSON.parse(JSON.stringify(k.posted)), [{ type: 'placement', placement: { where: 'overlay', dashboard: false } }]);
  k.postPlacement({ ready: false });
  assert.equal(k.posted.length, 1, 'a frame that has not said hello is not told');
});

test('init carries placement and every settings pass checks it', () => {
  assert.match(BRIDGE, /const placement = placementOf\(entry\);\n      entry\.placementKey = placementKey\(placement\);/);
  assert.match(BRIDGE, /\n        placement,\n      \}\);/);
  const rt = BRIDGE.slice(BRIDGE.indexOf('function refreshTheme()'));
  assert.match(rt.slice(0, rt.indexOf('\n  }')), /postPlacement\(entry\)/);
});

test('gameSessions is a stream in every list that has to agree', () => {
  assert.ok(SDK_STREAMS.includes('gameSessions'));
  assert.match(SETTINGS, /const SDK_WIDGET_STREAMS = Object\.freeze\(\[[^\]]*'gameSessions'/);
  assert.match(BRIDGE, /gameSessions: \['cw_stream_gameSessions', /);
  assert.match(BRIDGE, /gameSessions: Object\.freeze\(\{ ttl: \d+, load: async \(\) => \{\n\s+const d = await api\('\/perf\/sessions\?limit=20'\);/);
  const count = (I18N.match(/\n\s+cw_stream_gameSessions: "/g) || []).length;
  assert.equal(count, 11, 'the permission label in all 11 languages');
  assert.match(DOC, /### 3c-quater\. The games you played — `gameSessions`/);
  assert.match(DOC, /### 4c-quater\. Where your widget is — `placement`/);
  assert.match(DOC, /placement: \{ where: 'dashboard', dashboard: true \},/);
});

test('the route is read-only, local data, and readable from a paired phone like /perf', () => {
  assert.match(SERVER, /reqPath === '\/perf\/sessions' && req\.method === 'GET'/);
  assert.equal(remotePathAllowed('/perf/sessions', 'GET'), true);
  assert.equal(remotePathAllowed('/perf/sessions', 'POST'), true, 'no POST route exists; the gate answers by path');
});

const store = (sessions, current = null) => ({
  list: ({ limit }) => sessions.slice(0, limit).map((s) => ({ ...s })),
  compare: (g) => compareSessions(sessions, g),
  current: () => current,
});
const S = (start, game, avgFps) => normalizeSession({ game, start, end: start + 600000, avgFps, low1Fps: avgFps / 2 });

test('widgetSnapshot: the list, the game running, and newest against the one before', () => {
  const sessions = [S(3e6, 'b', 90), S(2e6, 'a', 60), S(1e6, 'b', 80)];
  const snap = widgetSnapshot(store(sessions, { game: 'b', start: 4e6 }), { enabled: true, limit: 2 });
  assert.equal(snap.ok, true);
  assert.equal(snap.enabled, true);
  assert.deepEqual(snap.current, { game: 'b', start: 4e6 });
  assert.deepEqual(snap.sessions.map((s) => s.game), ['b', 'a']);
  assert.equal(snap.compare.game, 'b');
  assert.equal(snap.compare.latestId, sessions[0].id);
  assert.equal(snap.compare.previousId, sessions[2].id);
  assert.equal(snap.compare.deltaAvgFps, 10);
  assert.equal(snap.compare.deltaLow1Fps, 5);
});

test('widgetSnapshot: first time a game is played, and off in Settings', () => {
  const one = widgetSnapshot(store([S(1e6, 'a', 60)]), {});
  assert.equal(one.compare.previousId, null);
  assert.equal(one.compare.deltaAvgFps, null);
  assert.equal(widgetSnapshot(store([]), {}).compare, null);
  const off = widgetSnapshot(store([S(1e6, 'a', 60)], { game: 'a', start: 1 }), { enabled: false });
  assert.deepEqual(off, { ok: true, enabled: false, current: null, sessions: [], compare: null });
});

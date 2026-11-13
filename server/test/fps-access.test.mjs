// server/sensor-service/fps-access.js: whether Windows lets the engine read
// frame rates, and if not, whether signing out and back in fixes it ('signin')
// or the permission is missing ('rights'). Since 5.1.0 the engine never runs
// elevated, and a group joined after sign-in reaches only the next sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { createFpsAccess, parseToken, stateOf } = require('../sensor-service/fps-access.js');

// Invented SIDs, in the shapes whoami prints.
const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const row = (name, sid) => `"${name}","${sid}"`;
const groupRow = (sid) => `"Group","Alias","${sid}","Enabled"`;
const whoami = (...groups) => [row('pc\\someone', USER), '', ...groups.map(groupRow)].join('\r\n');
const MEDIUM = 'S-1-16-8192';

test('the token is read by SID, never by the names that change with the language', () => {
  assert.deepEqual(parseToken(whoami(MEDIUM, 'S-1-5-32-545')), { user: USER, canTrace: false });
  assert.deepEqual(parseToken(whoami(MEDIUM, 'S-1-5-32-559')), { user: USER, canTrace: true }, 'Performance Log Users');
  assert.equal(parseToken(whoami('S-1-16-12288')).canTrace, true, 'an elevated engine traces without the group');
  // An administrator's filtered token lists Administrators as deny-only: not enough.
  assert.equal(parseToken(whoami(MEDIUM, 'S-1-5-32-544')).canTrace, false);
  // A domain group (also S-1-5-21-…) after the user row is never taken for the user.
  assert.equal(parseToken(whoami('S-1-5-21-1111111111-2222222222-3333333333-513')).user, USER);
  assert.deepEqual(parseToken(''), { user: null, canTrace: false });
});

test('the state: nothing to say, sign out and back in, or the permission is missing', () => {
  const token = { user: USER, canTrace: false };
  assert.equal(stateOf({ user: USER, canTrace: true }, null), null);
  assert.equal(stateOf(null, null), null, 'whoami failed: say nothing rather than guess');
  assert.equal(stateOf(token, { v: 1, sid: USER, member: true }), 'signin');
  assert.equal(stateOf(token, { v: 1, sid: USER, member: false }), 'rights', 'the group refused this user');
  assert.equal(stateOf(token, null), 'rights', 'the sensors were never set up');
  assert.equal(stateOf(token, { v: 1, sid: OTHER, member: true }), 'rights', 'another user\'s record');
  assert.equal(stateOf(token, { v: 2, sid: USER, member: true }), 'rights', 'an unknown record');
  assert.equal(stateOf(token, { v: 1, sid: USER, member: 'true' }), 'rights', 'checked, never trusted');
});

function rig({ groups = [MEDIUM], record = null, platform = 'win32', fail = false } = {}) {
  const calls = { whoami: 0, read: [] };
  const run = (file, args, opts, cb) => {
    calls.whoami++;
    calls.args = args;
    calls.file = file;
    calls.opts = opts;
    if (fail) cb(new Error('no whoami'));
    else cb(null, whoami(...groups));
  };
  const fsp = {
    stat: async (file) => {
      calls.read.push(file);
      if (!record) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, size: JSON.stringify(record).length };
    },
    readFile: async () => JSON.stringify(record),
  };
  const clock = { t: 1000 };
  const env = { ProgramData: 'C:\\ProgramData', SystemRoot: 'C:\\Windows' };
  const access = createFpsAccess({ env, platform, run, fsp, now: () => clock.t });
  return { access, calls, clock, setRecord: (r) => { record = r; } };
}

test('whoami runs once per engine, without a shell; the record is read again on each refresh', async () => {
  const r = rig({ record: { v: 1, sid: USER, member: false } });
  assert.equal(await r.access.refresh(), 'rights');
  assert.equal(r.calls.file, 'C:\\Windows\\System32\\whoami.exe');
  assert.deepEqual(r.calls.args, ['/user', '/groups', '/fo', 'csv', '/nh']);
  assert.equal(r.calls.opts.shell, undefined);
  assert.equal(r.calls.opts.windowsHide, true);
  // The setup ran again without restarting the engine: now in the group.
  r.setRecord({ v: 1, sid: USER, member: true });
  assert.equal(await r.access.refresh(), 'signin');
  assert.equal(r.calls.whoami, 1, 'the token never changes in a running process');
  assert.match(r.calls.read.at(-1), /Xenon Sensors[\\/]fps-access-S-1-5-21-1111111111-2222222222-3333333333-1001\.json$/);
});

test('a token that can trace reads no record; elsewhere than Windows, nothing runs', async () => {
  const ok = rig({ groups: [MEDIUM, 'S-1-5-32-559'], record: { v: 1, sid: USER, member: true } });
  assert.equal(await ok.access.refresh(), null);
  assert.equal(ok.calls.read.length, 0);
  const mac = rig({ platform: 'darwin' });
  assert.equal(await mac.access.refresh(), null);
  assert.equal(mac.access.current(), null);
  assert.equal(mac.calls.whoami, 0);
  const broken = rig({ fail: true });
  assert.equal(await broken.access.refresh(), null, 'whoami failed: nothing to say');
});

test('current() never waits: it answers the last state and asks again at most once a minute', async () => {
  const r = rig({ record: { v: 1, sid: USER, member: true } });
  assert.equal(r.access.current(), null, 'not known yet');
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  assert.equal(r.access.current(), 'signin');
  const reads = r.calls.read.length;
  r.access.current();
  assert.equal(r.calls.read.length, reads, 'not again within the minute');
  r.clock.t += 60000;
  r.access.current();
  await new Promise((done) => setImmediate(done));
  assert.equal(r.calls.read.length, reads + 1);
});

test('the record is bounded and must be a file', async () => {
  const r = rig();
  const big = createFpsAccess({
    env: { ProgramData: 'C:\\ProgramData', SystemRoot: 'C:\\Windows' }, platform: 'win32',
    run: (f, a, o, cb) => cb(null, whoami(MEDIUM)),
    fsp: { stat: async () => ({ isFile: () => true, size: 1 << 20 }), readFile: async () => JSON.stringify({ v: 1, sid: USER, member: true }) },
  });
  assert.equal(await big.refresh(), 'rights', 'an oversized record is not read');
  assert.equal(await r.access.refresh(), 'rights');
});

test('Settings and the Game performance tile say it, in every language', () => {
  const settings = readFileSync(new URL('../js/sensor-access.js', import.meta.url), 'utf8');
  assert.match(settings, /function fpsAccessCard\(r\)/);
  assert.match(settings, /outdatedServiceCard\(r\) \|\| fpsAccessCard\(r\)/);
  const tile = readFileSync(new URL('../js/perf-widget.js', import.meta.url), 'utf8');
  assert.match(tile, /perf\.access === 'signin'/);
  assert.match(tile, /perf\.access === 'rights'/);
  const route = readFileSync(new URL('../sensor-service/routes.js', import.meta.url), 'utf8');
  assert.match(route, /fpsMonitor\.backend === 'presentmon' && fpsMonitor\.isAvailable\(\)/, 'only where PresentMon is installed');
  // One value per language, each its own translation (a title may match by chance).
  const src = appStringsSource();
  for (const k of ['perf_fps_signin', 'perf_fps_rights', 'fps_access_title', 'fps_access_signin_desc', 'fps_access_rights_desc', 'fps_access_btn']) {
    const values = [...src.matchAll(new RegExp(`^\\s+${k}: '((?:[^'\\\\]|\\\\.)+)',$`, 'gm'))].map((m) => m[1]);
    assert.equal(values.length, 11, `${k} in all 11 languages`);
    assert.ok(new Set(values).size >= (k === 'fps_access_title' || k === 'fps_access_btn' ? 9 : 11), `${k} translated`);
  }
});

test('a pop-up only when the setup ran: sign out and back in, or the group said no', async () => {
  const signin = rig({ record: { v: 1, sid: USER, member: true } });
  await signin.access.refresh();
  assert.equal(signin.access.worthTelling(), 'signin');
  const refused = rig({ record: { v: 1, sid: USER, member: false } });
  await refused.access.refresh();
  assert.equal(refused.access.worthTelling(), 'refused');
  const never = rig();
  assert.equal(await never.access.refresh(), 'rights');
  assert.equal(never.access.worthTelling(), null, 'never set up: the tile and Settings say it, no pop-up');
  const ok = rig({ groups: [MEDIUM, 'S-1-5-32-559'] });
  await ok.access.refresh();
  assert.equal(ok.access.worthTelling(), null);
});

test('the pop-up is said in a game, once per version and per case, and remembered', async () => {
  const { mkdtempSync, rmSync, readFileSync: read } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createFpsNotice, MARKER } = require('../sensor-service/fps-notice.js');
  const dir = mkdtempSync(join(tmpdir(), 'fps-notice-'));
  try {
    const sent = [];
    let kind = 'signin';
    let ready = true;
    const access = { current: () => 'signin', worthTelling: () => kind };
    const make = (version) => createFpsNotice({ access, dataDir: dir, version, readerReady: () => ready, broadcast: (p) => sent.push(p) });
    const n = make('5.1.1');
    assert.equal(await n.onTick(''), null, 'no game: nothing');
    ready = false;
    assert.equal(await n.onTick('Game.exe'), null, 'no frame reader here: the tile says that instead');
    ready = true;
    assert.deepEqual(await n.onTick('Game.exe'), { game: 'Game.exe', access: 'signin' });
    assert.equal(await n.onTick('Other.exe'), null, 'once, not at every game');
    kind = 'refused';
    assert.deepEqual(await n.onTick('Game.exe'), { game: 'Game.exe', access: 'rights' });
    assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(read(join(dir, MARKER), 'utf8')), { version: '5.1.1', kinds: ['signin', 'refused'] });
    // A restart remembers it; the next version says it again if it still holds.
    kind = 'signin';
    assert.equal(await make('5.1.1').onTick('Game.exe'), null);
    assert.deepEqual(await make('5.1.2').onTick('Game.exe'), { game: 'Game.exe', access: 'signin' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the pop-up reads the same on the dashboard and in "widgets only"', () => {
  const AlertToasts = require('../js/alert-toasts.js');
  const ctx = { t: (k, f) => f };
  const s = AlertToasts.fpsAccess({ game: 'Game.exe', access: 'signin' }, ctx);
  assert.equal(s.type, 'warning', 'an info card is silenced in a game');
  assert.equal(s.kicker, 'Game');
  assert.match(s.message, /Sign out of Windows/);
  assert.match(AlertToasts.fpsAccess({ game: 'Game.exe', access: 'rights' }, ctx).message, /Allow FPS/);
  assert.equal(AlertToasts.fpsAccess({ game: 'Game.exe', access: 'nope' }, ctx), null);
  assert.equal(AlertToasts.fpsAccess(null, ctx), null);
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /addEventListener\('fps_access'/);
  const screen = readFileSync(new URL('../js/screen-alerts.js', import.meta.url), 'utf8');
  assert.match(screen, /fps_access: \(d\) => \{ if \(onScreen\(\)\) show\(AlertToasts\.fpsAccess/);
  const server = engineSource();
  assert.match(server, /_fpsNotice\.onTick\(game\)/);
  assert.match(server, /broadcastSSE\('fps_access', payload\)/);
});

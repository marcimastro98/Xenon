// The last step of the tab at sign-in: the program that opens the browser, and the display
// it opens on.
//
// On Windows the address goes to explorer.exe and no longer through PowerShell, whose first
// start after a sign-in can outlast its time limit. On Linux the engine's unit starts before
// the desktop has a display, so the start waits for one, for a bounded time, with the sign-in
// already written down. Nothing here starts a program, asks systemd or opens a browser: what
// would be run is recorded and read. The one program that is started is node itself, to see
// that a wait in progress does not keep the engine from ending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const P = require('../install/sign-in-parse.js');
const linux = require('../install/sign-in-linux.js');
const signInOpen = require('../install/sign-in-open.js');
const { openOwnAddress } = require('../install/sign-in-browser.js');
const featureRoutes = require('../feature-routes.js');

const { openDashboardAtSignIn, signInOpenSupported } = signInOpen;
const ADDRESS = 'http://127.0.0.1:3030/';
const INSTALLED = { port: 3030 };

/** What starts a program, recording instead of starting; `error` is what the program ends with. */
function recorder(error = null) {
  const ran = [];
  return { ran, run: (file, args, options, done) => { ran.push({ file, args, options }); done(error); } };
}

// ── Windows: explorer.exe ────────────────────────────────────────────────────

test('Windows: the address goes to explorer.exe of this Windows as its one argument, and no PowerShell starts', async () => {
  const started = recorder(Object.assign(new Error('Command failed'), { code: 1 }));
  assert.deepEqual(await openOwnAddress(ADDRESS, undefined, { platform: 'win32', run: started.run, env: { SystemRoot: 'C:\\Windows' } }), { ok: true });
  assert.deepEqual(started.ran, [{ file: 'C:\\Windows\\explorer.exe', args: [ADDRESS], options: { timeout: 15000 } }]);
  assert.equal('shell' in started.ran[0].options, false);
  // Windows installed elsewhere; and an environment that names no usable folder.
  const moved = recorder();
  await openOwnAddress(ADDRESS, undefined, { platform: 'win32', run: moved.run, env: { SystemRoot: 'D:\\WINNT' } });
  assert.equal(moved.ran[0].file, 'D:\\WINNT\\explorer.exe');
  for (const env of [{}, { SystemRoot: '' }, { SystemRoot: 'Windows' }, { SystemRoot: '..\\tools' }]) {
    const fallback = recorder();
    await openOwnAddress(ADDRESS, undefined, { platform: 'win32', run: fallback.run, env });
    assert.equal(fallback.ran[0].file, 'C:\\Windows\\explorer.exe', JSON.stringify(env));
  }
});

test('Windows: explorer.exe that does not start, or does not end in time, is a tab that did not open', async () => {
  const missing = recorder(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(openOwnAddress(ADDRESS, undefined, { platform: 'win32', run: missing.run, env: {} }), /ENOENT/);
  const slow = recorder(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null }));
  await assert.rejects(openOwnAddress(ADDRESS, undefined, { platform: 'win32', run: slow.run, env: {} }), /timed out/);
  // Ending with a number is how explorer.exe ends after handing the address on.
  for (const code of [0, 1]) {
    const done = recorder(code ? Object.assign(new Error('Command failed'), { code }) : null);
    assert.deepEqual(await openOwnAddress(ADDRESS, undefined, { platform: 'win32', run: done.run, env: {} }), { ok: true });
  }
});

test('nothing but the engine own address is handed to the program, on any system', async () => {
  const others = [
    'C:\\Windows\\System32\\calc.exe', '\\\\server\\share\\tool.exe', 'shell:AppsFolder\\x', 'file:///C:/x.exe',
    'https://127.0.0.1:3030/', 'http://127.0.0.1:3030', 'http://127.0.0.1:3030/x', 'http://127.0.0.1:3030/?a=1',
    'http://localhost:3030/', 'http://127.0.0.1.example.com:3030/', 'http://127.0.0.1:3030/ --flag', ' http://127.0.0.1:3030/',
    'http://127.0.0.1:303030/', '', null, undefined, 3030, ['http://127.0.0.1:3030/'],
  ];
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const url of others) {
      const started = recorder();
      await assert.rejects(openOwnAddress(url, undefined, { platform, run: started.run, env: {} }), /not the engine address/, platform + ' ' + String(url));
      assert.deepEqual(started.ran, []);
    }
  }
});

test('macOS and Linux keep their own program, with the engine environment unless a session is given', async () => {
  const mac = recorder();
  await openOwnAddress(ADDRESS, undefined, { platform: 'darwin', run: mac.run, env: { HOME: '/Users/someone' } });
  assert.deepEqual(mac.ran, [{ file: '/usr/bin/open', args: ['--', ADDRESS], options: { timeout: 8000 } }]);
  const plain = recorder();
  await openOwnAddress(ADDRESS, {}, { platform: 'linux', run: plain.run, env: { HOME: '/home/someone' } });
  assert.deepEqual(plain.ran, [{ file: 'xdg-open', args: [ADDRESS], options: { timeout: 8000 } }], 'an engine that has a display adds nothing');
  const waited = recorder();
  const session = { DISPLAY: ':1', XDG_RUNTIME_DIR: '/run/user/1000' };
  await openOwnAddress(ADDRESS, session, { platform: 'linux', run: waited.run, env: { HOME: '/home/someone', DISPLAY: '' } });
  assert.deepEqual(waited.ran, [{
    file: 'xdg-open', args: [ADDRESS],
    options: { timeout: 8000, env: { HOME: '/home/someone', DISPLAY: ':1', XDG_RUNTIME_DIR: '/run/user/1000' } },
  }], 'the session is added to the environment, never run or parsed by a shell');
});

// ── Linux: what systemd says about the session ───────────────────────────────

const SHOWN = [
  'HOME=/home/someone',
  'LANG=en_US.UTF-8',
  'PATH=/usr/local/bin:/usr/bin',
  'DISPLAY=:0',
  'WAYLAND_DISPLAY=wayland-0',
  'XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.AB12CD',
  'XDG_RUNTIME_DIR=/run/user/1000',
  'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
  'XDG_CURRENT_DESKTOP=ubuntu:GNOME',
  'LD_PRELOAD=/tmp/x.so',
  '',
].join('\n');

test('only the variables of the display are read from systemd, each in its plain shape', () => {
  assert.deepEqual(P.sessionEnv(SHOWN), {
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.AB12CD',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
  });
  assert.deepEqual(P.sessionEnv('DISPLAY=localhost:10.0\nDISPLAY2=:5\n=:6\nDISPLAY\n'), { DISPLAY: 'localhost:10.0' });
  const refused = [
    "DISPLAY=$':0\\nLD_PRELOAD=/tmp/x.so'",          // a value systemd had to escape
    'DISPLAY=:0; rm -rf ~', 'DISPLAY=:0 --flag', 'DISPLAY=', 'DISPLAY=0', 'DISPLAY=:zero',
    'WAYLAND_DISPLAY=wayland 0', 'WAYLAND_DISPLAY=$(id)', 'WAYLAND_DISPLAY=',
    'XDG_RUNTIME_DIR=run/user/1000', "XDG_RUNTIME_DIR=/run/user/'1000'", 'XDG_RUNTIME_DIR=/run/$USER', 'XDG_RUNTIME_DIR=/run\\user',
    'XAUTHORITY=/tmp/a\tb', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus guid', 'XDG_CURRENT_DESKTOP=GNOME;x',
    'XDG_RUNTIME_DIR=/' + 'x'.repeat(2000),
  ];
  for (const line of refused) assert.deepEqual(P.sessionEnv(line + '\n'), {}, line.slice(0, 60));
  assert.deepEqual(P.sessionEnv(''), {});
  assert.deepEqual(P.sessionEnv(undefined), {});
  assert.equal(P.hasDisplay({ DISPLAY: ':0' }), true);
  assert.equal(P.hasDisplay({ WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(P.hasDisplay({ XDG_RUNTIME_DIR: '/run/user/1000' }), false);
  assert.equal(P.hasDisplay(null), false);
});

test('Linux: an engine with a display asks nobody; one without asks systemd, and gets it or nothing', async () => {
  let asked = 0;
  const show = (text) => async () => { asked += 1; return text; };
  assert.deepEqual(await linux.display({ env: { DISPLAY: ':0' }, show: show(SHOWN) }), {});
  assert.deepEqual(await linux.display({ env: { WAYLAND_DISPLAY: 'wayland-0' }, show: show(SHOWN) }), {});
  assert.equal(asked, 0);
  assert.deepEqual(await linux.display({ env: {}, show: show(SHOWN) }), P.sessionEnv(SHOWN));
  assert.equal(asked, 1);
  // Before the desktop told systemd: the folder of the session is known, the display is not.
  assert.equal(await linux.display({ env: {}, show: show('XDG_RUNTIME_DIR=/run/user/1000\nPATH=/usr/bin\n') }), null);
  assert.equal(await linux.display({ env: {}, show: show("DISPLAY=$':0\\n'\n") }), null, 'a display in a shape that is not handed on');
  assert.equal(await linux.display({ env: {}, show: async () => { throw new Error('Failed to connect to bus'); } }), null);
});

// ── The wait ─────────────────────────────────────────────────────────────────

/** A Linux PC at sign-in whose desktop gets a display after `after` questions (never, when null). */
function desktop({ after = null, deps = {}, backend = {} } = {}) {
  const did = [];
  const state = { seen: '', asked: 0 };
  const session = { DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000' };
  const parts = {
    startedAtMs: 1_800_000_000_000,
    backend: {
      signIn: async () => ({ id: 'boot:4242', ageMs: 3000 }),
      appAtSignIn: async () => { did.push('appAtSignIn'); return false; },
      canOpen: () => false,
      display: async () => { state.asked += 1; did.push('display'); return after !== null && state.asked > after ? session : null; },
      ...backend,
    },
    readSettings: async () => ({ autoOpenArmed: true, autoOpenBrowser: true }),
    readSeen: async () => state.seen,
    writeSeen: async (id) => { did.push('writeSeen'); state.seen = id; },
    open: async (url, env) => { did.push('open'); state.opened = { url, env }; },
    pause: async (ms) => { did.push('pause ' + ms); return true; },
    log: (line) => did.push('log ' + line.replace(/^.*at sign-in: /, '')),
    ...deps,
  };
  return { parts, did, state, session };
}

test('Linux: the display comes a little after the engine: one tab, on that display, the sign-in written down first', async () => {
  const pc = desktop({ after: 2 });
  assert.deepEqual(await openDashboardAtSignIn(INSTALLED, pc.parts), { open: true, why: 'sign_in', remember: true });
  assert.deepEqual(pc.did, ['writeSeen', 'appAtSignIn', 'display', 'pause 5000', 'display', 'pause 5000', 'display', 'open', 'log opened']);
  assert.deepEqual(pc.state.opened, { url: ADDRESS, env: pc.session });
  // The engine restarts while the browser is open: the sign-in is used up.
  assert.equal((await openDashboardAtSignIn(INSTALLED, pc.parts)).why, 'sign_in_seen');
  assert.equal(pc.did.filter((step) => step === 'open').length, 1);
});

test('Linux: a display that is there at once is asked for once and never waited for', async () => {
  const pc = desktop({ after: 0 });
  assert.equal((await openDashboardAtSignIn(INSTALLED, pc.parts)).open, true);
  assert.deepEqual(pc.did.filter((step) => step.startsWith('pause')), []);
  assert.equal(pc.state.asked, 1);
});

test('Linux: no display within two minutes means no tab, said once, and no later start tries again', async () => {
  const pc = desktop();
  assert.deepEqual(await openDashboardAtSignIn(INSTALLED, pc.parts), { open: false, why: 'no_display', remember: true });
  const pauses = pc.did.filter((step) => step.startsWith('pause'));
  assert.equal(pauses.length, 24, 'every 5 seconds for 2 minutes');
  assert.ok(pauses.every((step) => step === 'pause 5000'));
  assert.equal(pc.state.asked, 25);
  assert.equal(pc.did.at(-1), 'log not opened (no_display)');
  assert.equal(pc.did.includes('open'), false);
  assert.equal(pc.state.seen, 'boot:4242');
  // A crash and a restart later in the session, now with a display: still nothing.
  const later = desktop({ after: 0, deps: { readSeen: async () => pc.state.seen } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, later.parts)).why, 'sign_in_seen');
  assert.equal(later.state.asked, 0);
});

test('Linux: nobody waits for a display for a start that gets no tab anyway', async () => {
  const notAsked = desktop({ after: 0, deps: { readSettings: async () => ({ autoOpenBrowser: true }) } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, notAsked.parts)).why, 'never_asked');
  const app = desktop({ after: 0, backend: { appAtSignIn: async () => true } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, app.parts)).why, 'app_shows_it');
  const late = desktop({ after: 0, backend: { signIn: async () => ({ id: 'boot:4242', ageMs: 3 * 3600_000 }) } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, late.parts)).why, 'not_a_sign_in', 'a unit installed hours into the session');
  for (const pc of [notAsked, app, late]) {
    assert.equal(pc.state.asked, 0);
    assert.equal(pc.did.includes('open'), false);
  }
});

test('Linux: the engine stops while it waits: the wait ends at once and nothing opens', async () => {
  // The real wait, 10 seconds a step: only stop() can end this inside the test.
  const pc = desktop({ deps: { pause: undefined, displayPollMs: 10_000, displayWaitMs: 120_000 } });
  delete pc.parts.pause;
  const running = openDashboardAtSignIn(INSTALLED, pc.parts);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pc.state.asked, 1, 'waiting after the first question');
  const before = Date.now();
  featureRoutes.stop();   // what the engine calls at shutdown
  assert.deepEqual(await running, { open: false, why: 'stopped', remember: true });
  assert.ok(Date.now() - before < 2000);
  assert.equal(pc.did.includes('open'), false);
  assert.doesNotThrow(() => signInOpen.stop(), 'stopping with nothing waiting');
});

test('a wait for a display does not keep the engine from ending', () => {
  const module = fileURLToPath(new URL('../install/sign-in-open.js', import.meta.url));
  const script = `
    const { openDashboardAtSignIn } = require(${JSON.stringify(module)});
    openDashboardAtSignIn({ port: 3030 }, {
      startedAtMs: 0,
      backend: { signIn: async () => ({ id: 'a', ageMs: 0 }), appAtSignIn: async () => false, canOpen: () => false, display: async () => null },
      readSettings: async () => ({ autoOpenArmed: true }), readSeen: async () => '', writeSeen: async () => {},
      open: async () => { console.log('OPENED'); }, log: () => {},
    });
    setTimeout(() => console.log('waiting'), 50);`;
  const ended = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(ended.error, undefined, 'the process ended by itself, long before the two minutes of the wait');
  assert.equal(ended.status, 0);
  assert.equal(ended.stdout.trim(), 'waiting');
});

test('Linux: the switch is offered when a display is known to systemd, though the engine has none', async () => {
  const backend = (display) => ({ signIn: async () => ({ id: 'a', ageMs: 0 }), appAtSignIn: async () => false, canOpen: () => false, display });
  assert.equal(await signInOpenSupported(INSTALLED, { backend: backend(async () => ({ DISPLAY: ':0' })) }), true);
  assert.equal(await signInOpenSupported(INSTALLED, { backend: backend(async () => null) }), false, 'no session, as with lingering');
  assert.equal(await signInOpenSupported(INSTALLED, { backend: backend(async () => { throw new Error('broken'); }) }), false);
  const { display: _none, ...without } = backend(null);
  assert.equal(await signInOpenSupported(INSTALLED, { backend: without }), false, 'a system that cannot open and has nothing to wait for');
});

// ── From sign-in to the program ──────────────────────────────────────────────

test('from sign-in to the program that opens the tab, with what the engine itself uses on each system', async () => {
  const cases = [
    ['win32', 'C:\\Windows\\explorer.exe', [ADDRESS], undefined],
    ['darwin', '/usr/bin/open', ['--', ADDRESS], undefined],
    ['linux', 'xdg-open', [ADDRESS], { DISPLAY: ':0', XDG_RUNTIME_DIR: '/run/user/1000' }],
  ];
  for (const [platform, program, args, session] of cases) {
    const started = recorder();
    const pc = desktop({
      after: 0,
      backend: platform === 'linux' ? {} : { canOpen: () => true, display: undefined },
      deps: { open: (url, env) => openOwnAddress(url, env, { platform, run: started.run, env: { SystemRoot: 'C:\\Windows' } }) },
    });
    assert.equal((await openDashboardAtSignIn(INSTALLED, pc.parts)).open, true, platform);
    assert.equal(started.ran.length, 1, platform);
    assert.equal(started.ran[0].file, program);
    assert.deepEqual(started.ran[0].args, args);
    assert.deepEqual(started.ran[0].options.env, session && { SystemRoot: 'C:\\Windows', ...session }, platform);
  }
  // The engine's own opener is this one: no PowerShell on the way to the tab.
  const source = readFileSync(new URL('../install/sign-in-open.js', import.meta.url), 'utf8');
  assert.match(source, /open: openOwnAddress,/);
  assert.doesNotMatch(source, /openExternalPath|powershell/i);
});

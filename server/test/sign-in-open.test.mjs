// One start of the engine, from "listening" to a browser tab or to nothing.
//
// sign-in-open-rule.test.mjs checks the rule; this checks what is done with it: which
// questions the system is asked and in what order, that the sign-in is written down before
// anything opens, that a failure anywhere ends in no tab and never in an error the engine
// would die of, and what exactly would be run to open the tab on each system. The system,
// the settings, the file and the browser are all stand-ins: nothing here reads a task, writes
// to the data folder or starts a program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { openDashboardAtSignIn, signInOpenSupported, dashboardUrl } = require('../install/sign-in-open.js');
const { readSeen, writeSeen, MAX_ID_LENGTH } = require('../install/sign-in-seen.js');
const { openExternalPath } = require('../deck/open-external-path.js');
const { DECK_ACTIONS_SCRIPT } = require('../deck/script-paths.js');

const INSTALLED = { port: 3030 };

/** A computer where everything says yes, with a record of what was asked of it. */
function computer(changed = {}) {
  const did = [];
  const state = { seen: '', ...changed.state };
  const backend = {
    signIn: async () => { did.push('signIn'); return { id: 'sign-in-1', ageMs: 60_000 }; },
    appAtSignIn: async () => { did.push('appAtSignIn'); return false; },
    canOpen: () => true,
    ...changed.backend,
  };
  const deps = {
    startedAtMs: 1_800_000_000_000,
    backend,
    readSettings: async () => { did.push('readSettings'); return { autoOpenArmed: true, autoOpenBrowser: true }; },
    readSeen: async () => { did.push('readSeen'); return state.seen; },
    writeSeen: async (id) => { did.push('writeSeen ' + id); state.seen = id; },
    open: async (url) => { did.push('open ' + url); return { ok: true }; },
    log: (line) => { did.push('log ' + line); },
    ...changed.deps,
  };
  const opened = () => did.filter((step) => step.startsWith('open '));
  const said = () => did.filter((step) => step.startsWith('log ')).map((step) => step.slice(4));
  return { deps, did, state, opened, said };
}

test('the start of a sign-in opens the engine own address, once, after writing the sign-in down', async () => {
  const pc = computer();
  const verdict = await openDashboardAtSignIn(INSTALLED, pc.deps);
  assert.deepEqual(verdict, { open: true, why: 'sign_in', remember: true });
  assert.deepEqual(pc.did, [
    'signIn', 'readSeen', 'readSettings', 'writeSeen sign-in-1', 'appAtSignIn',
    'open http://127.0.0.1:3030/',
    'log [startup] dashboard in the browser at sign-in: opened',
  ]);
});

test('the engine restarts three times in the same session: still one tab', async () => {
  const pc = computer();
  for (let start = 0; start < 4; start += 1) await openDashboardAtSignIn(INSTALLED, pc.deps);
  assert.deepEqual(pc.opened(), ['open http://127.0.0.1:3030/']);
  assert.equal(pc.said().at(-1), '[startup] dashboard in the browser at sign-in: not opened (sign_in_seen)');
});

test('a copy on another port asks the system nothing, opens nothing and says nothing', async () => {
  for (const port of [3031, 3039, 3043, 3050, 8080]) {
    const pc = computer();
    const verdict = await openDashboardAtSignIn({ port }, pc.deps);
    assert.deepEqual(verdict, { open: false, why: 'side_copy', remember: false });
    assert.deepEqual(pc.did, [], 'port ' + port);
  }
});

test('a start the system cannot place reads no settings and writes nothing', async () => {
  const pc = computer({ backend: { signIn: async () => null } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, pc.deps)).why, 'start_unknown');
  assert.deepEqual(pc.did, ['log [startup] dashboard in the browser at sign-in: not opened (start_unknown)']);
  const none = computer({ deps: { backend: null } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, none.deps)).why, 'start_unknown');
  assert.deepEqual(none.opened(), []);
});

test('the engine is told when its process started, to measure the sign-in against', async () => {
  let asked = null;
  const pc = computer({ backend: { signIn: async (when) => { asked = when; return null; } } });
  await openDashboardAtSignIn(INSTALLED, pc.deps);
  assert.deepEqual(asked, { startedAtMs: 1_800_000_000_000 });
});

test('nobody asked for the tab: nothing opens, and the app is not even looked for', async () => {
  const never = computer({ deps: { readSettings: async () => ({ autoOpenBrowser: true }) } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, never.deps)).why, 'never_asked');
  assert.deepEqual(never.opened(), []);
  assert.ok(!never.did.includes('appAtSignIn'), 'no task and no registry read for someone who gets no tab');
  assert.equal(never.state.seen, 'sign-in-1', 'the sign-in is used up all the same');

  const off = computer({ deps: { readSettings: async () => ({ autoOpenArmed: true, autoOpenBrowser: false }) } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, off.deps)).why, 'switched_off');
  assert.deepEqual(off.opened(), []);

  const empty = computer({ deps: { readSettings: async () => null } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, empty.deps)).why, 'never_asked');
});

test('only a stored true counts as asked', async () => {
  for (const autoOpenArmed of ['true', 1, {}, null, undefined]) {
    const pc = computer({ deps: { readSettings: async () => ({ autoOpenArmed, autoOpenBrowser: true }) } });
    assert.equal((await openDashboardAtSignIn(INSTALLED, pc.deps)).open, false, String(autoOpenArmed));
  }
});

test('the Xenon app opens at sign-in: no tab beside it, and the sign-in is used up', async () => {
  const pc = computer({ backend: { appAtSignIn: async () => true } });
  assert.deepEqual(await openDashboardAtSignIn(INSTALLED, pc.deps), { open: false, why: 'app_shows_it', remember: true });
  assert.deepEqual(pc.opened(), []);
  assert.equal(pc.state.seen, 'sign-in-1');
});

test('a system with no display to open a browser on: no tab', async () => {
  const pc = computer({ backend: { canOpen: () => false } });
  assert.equal((await openDashboardAtSignIn(INSTALLED, pc.deps)).why, 'cannot_open');
  assert.deepEqual(pc.opened(), []);
});

test('a marker that cannot be read means no tab, and it is left as it is', async () => {
  const pc = computer({ deps: { readSeen: async () => null } });
  assert.deepEqual(await openDashboardAtSignIn(INSTALLED, pc.deps), { open: false, why: 'seen_unreadable', remember: false });
  assert.deepEqual(pc.did.filter((step) => step.startsWith('writeSeen') || step.startsWith('open')), []);
});

test('a sign-in that cannot be written down gets no tab: the next start could not know', async () => {
  const pc = computer({ deps: { writeSeen: async () => { throw new Error('disk full'); } } });
  const verdict = await openDashboardAtSignIn(INSTALLED, pc.deps);
  assert.equal(verdict.open, false);
  assert.equal(verdict.why, 'failed');
  assert.deepEqual(pc.opened(), []);
  assert.deepEqual(pc.said(), ['[startup] dashboard in the browser at sign-in: failed (disk full)']);
});

test('a browser that does not start is said, not thrown, and not tried again', async () => {
  const pc = computer({ deps: { open: async () => { throw new Error('no handler for http'); } } });
  const verdict = await openDashboardAtSignIn(INSTALLED, pc.deps);
  assert.deepEqual(verdict, { open: false, why: 'open_failed', remember: true });
  assert.deepEqual(pc.said(), ['[startup] dashboard in the browser at sign-in: open_failed (no handler for http)']);
  pc.deps.open = async (url) => { pc.did.push('open ' + url); };
  assert.equal((await openDashboardAtSignIn(INSTALLED, pc.deps)).why, 'sign_in_seen', 'the sign-in was used up by the try');
});

test('whatever breaks, the start-up is not broken with it', async () => {
  const boom = () => { throw new Error('broken'); };
  const breaks = [
    { backend: { signIn: boom } },
    { backend: { appAtSignIn: boom } },
    { backend: { canOpen: boom } },
    { deps: { readSettings: boom } },
    { deps: { readSeen: boom } },
    { deps: { log: boom, backend: null } },
  ];
  for (const broken of breaks) {
    const pc = computer(broken);
    const verdict = await openDashboardAtSignIn(INSTALLED, pc.deps);
    assert.equal(verdict.open, false);
    assert.deepEqual(pc.opened(), []);
  }
  assert.equal((await openDashboardAtSignIn({}, computer().deps)).open, false, 'no port');
  assert.equal((await openDashboardAtSignIn({ port: '3030' }, computer().deps)).why, 'side_copy', 'a port that is not a number is not the installed one');
});

// ── The address ──────────────────────────────────────────────────────────────

test('the address is this computer and the engine port, and nothing else can get into it', () => {
  assert.equal(dashboardUrl(3030), 'http://127.0.0.1:3030/');
  for (const port of [0, -1, 65536, 3030.5, '3030', '3030/../x', null, undefined, Number.NaN]) {
    assert.throws(() => dashboardUrl(port), /no port/, String(port));
  }
});

// ── What would be run ────────────────────────────────────────────────────────

/** Stand-ins for the two ways a program is started, recording instead of starting. */
function recorder() {
  const ran = [];
  return {
    ran,
    run: (file, args, options, done) => { ran.push({ file, args, options }); done(null); },
    runScript: async (script, args, timeout) => { ran.push({ script, args, timeout }); return { ok: true }; },
  };
}

test('opening the tab runs one program with the address as one argument, on every system', async () => {
  const url = dashboardUrl(3030);
  const windows = recorder();
  await openExternalPath(url, undefined, { platform: 'win32', ...windows });
  assert.deepEqual(windows.ran, [{ script: DECK_ACTIONS_SCRIPT, args: ['open', url], timeout: 8000 }]);

  const mac = recorder();
  await openExternalPath(url, undefined, { platform: 'darwin', ...mac });
  assert.deepEqual(mac.ran, [{ file: '/usr/bin/open', args: ['--', url], options: { timeout: 8000 } }]);

  const linux = recorder();
  await openExternalPath(url, undefined, { platform: 'linux', ...linux });
  assert.deepEqual(linux.ran, [{ file: 'xdg-open', args: [url], options: { timeout: 8000 } }]);
});

test('a program that fails to start rejects, so the engine can say the tab did not open', async () => {
  const run = (_file, _args, _options, done) => done(new Error('spawn xdg-open ENOENT'));
  await assert.rejects(openExternalPath('http://127.0.0.1:3030/', undefined, { platform: 'linux', run }), /ENOENT/);
});

test('from sign-in to the program that opens the tab, on each system', async () => {
  for (const [platform, program] of [['win32', 'open'], ['darwin', '/usr/bin/open'], ['linux', 'xdg-open']]) {
    const started = recorder();
    const pc = computer({ deps: { open: (url) => openExternalPath(url, undefined, { platform, ...started }) } });
    assert.equal((await openDashboardAtSignIn(INSTALLED, pc.deps)).open, true, platform);
    assert.equal(started.ran.length, 1, platform);
    const { file, args } = started.ran[0];
    assert.equal(file ?? args[0], program);
    assert.equal(args.at(-1), 'http://127.0.0.1:3030/');
  }
});

// ── Whether the switch means anything here ───────────────────────────────────

test('the switch is offered where the engine can tell a sign-in, open a browser, and the app does not start by itself', async () => {
  assert.equal(await signInOpenSupported(INSTALLED, computer().deps), true);
  assert.equal(await signInOpenSupported({ port: 3043 }, computer().deps), false, 'a copy beside the installed engine');
  assert.equal(await signInOpenSupported(INSTALLED, computer({ deps: { backend: null } }).deps), false, 'a system nobody wrote this for');
  assert.equal(await signInOpenSupported(INSTALLED, computer({ backend: { canOpen: () => false } }).deps), false);
  assert.equal(await signInOpenSupported(INSTALLED, computer({ backend: { signIn: async () => null } }).deps), false, 'started by hand');
  assert.equal(await signInOpenSupported(INSTALLED, computer({ backend: { appAtSignIn: async () => true } }).deps), false);
  const broken = computer({ backend: { appAtSignIn: async () => { throw new Error('broken'); } } });
  assert.equal(await signInOpenSupported(INSTALLED, broken.deps), false);
});

test('asking whether the switch is offered changes nothing and opens nothing', async () => {
  const pc = computer();
  await signInOpenSupported(INSTALLED, pc.deps);
  assert.deepEqual(pc.did, ['signIn', 'appAtSignIn']);
});

// ── The marker on disk ───────────────────────────────────────────────────────

test('the sign-in written down is read back, in a folder that may not exist yet', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'sign-in-seen-'));
  try {
    const file = path.join(folder, 'data', 'sign-in-seen.json');
    assert.equal(await readSeen(file), '', 'a new install');
    await writeSeen('sign-in-1', file);
    assert.equal(await readSeen(file), 'sign-in-1');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { id: 'sign-in-1' }, 'the id and nothing about the person');
    await writeSeen('sign-in-2', file);
    assert.equal(await readSeen(file), 'sign-in-2');
    await writeSeen('x'.repeat(MAX_ID_LENGTH + 50), file);
    assert.equal((await readSeen(file)).length, MAX_ID_LENGTH);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a marker that holds something else reads as no sign-in; one that cannot be read at all as unknown', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'sign-in-seen-'));
  try {
    const file = path.join(folder, 'sign-in-seen.json');
    for (const text of ['', 'not json', '[]', 'null', '{"id":7}', '{"other":"x"}']) {
      writeFileSync(file, text);
      assert.equal(await readSeen(file), '', JSON.stringify(text));
    }
    // A folder where the file should be: the read fails with something other than "not there".
    assert.equal(await readSeen(folder), null);
    await assert.rejects(writeSeen('sign-in-1', path.join(file, 'below-a-file.json')), 'a write that cannot happen rejects');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

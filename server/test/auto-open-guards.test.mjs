// Who may ask for the browser tab at sign-in, and what happens around the old task: followed
// through the engine's own code instead of read off its text.
//
// auto-open-switch.test.mjs and auto-open-task.test.mjs check that the address is in the
// engine's lists and that the start decides before the old task is read. Here the same two
// things are run: requests as browsers send them go through the gate every request passes,
// and several starts of the engine go through the decision and the clean-up over one
// scheduler and one settings object. The scheduler, the settings and the browser are
// stand-ins: no task is read or removed, nothing is saved and nothing opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { refusedCrossSite } = require('../cross-site.js');
const { remotePathAllowed } = require('../remote-access.js');
const { openDashboardAtSignIn } = require('../install/sign-in-open.js');
const { retireBrowserTask, BROWSER_TASK_NAME } = require('../install/browser-auto-open-task.js');
const win = require('../install/sign-in-windows.js');

const ADDRESS = '/startup/auto-open';
const PORT = 3030;

// ── A page that is not the dashboard ─────────────────────────────────────────

const request = (method, headers = {}) => ({ method, headers });
const refused = (method, headers) => refusedCrossSite(request(method, headers), PORT, ADDRESS);

test('a page on another site cannot ask for the tab, however it sends the request', () => {
  const elsewhere = [
    ['a fetch from a website', { origin: 'https://example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }],
    ['a form posted from a website', { origin: 'https://example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }],
    ['a no-cors fetch', { origin: 'https://example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }],
    ['a sandboxed frame or a file opened from disk', { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }],
    ['the same from a browser too old to say more', { origin: 'null' }],
    ['a website, from an old browser', { origin: 'https://example.com' }],
    ['a page of another program on this PC', { origin: 'http://localhost:8080', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }],
    ['a copy of the engine on another port', { origin: 'http://127.0.0.1:3031', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }],
    ['an address made to look like the engine', { origin: 'http://127.0.0.1.example.com:3030', 'sec-fetch-site': 'cross-site' }],
    ['the engine port over https', { origin: 'https://127.0.0.1:3030', 'sec-fetch-site': 'cross-site' }],
    ['a browser that sent the site and no origin', { 'sec-fetch-site': 'cross-site' }],
  ];
  for (const [who, headers] of elsewhere) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(refused(method, headers), true, who + ', ' + method);
  }
});

test('nor can it read whether somebody asked, with a fetch, a picture, a link or a preflight', () => {
  const site = { 'sec-fetch-site': 'cross-site' };
  assert.equal(refused('GET', { ...site, origin: 'https://example.com', 'sec-fetch-mode': 'cors' }), true, 'fetch');
  assert.equal(refused('GET', { ...site, 'sec-fetch-mode': 'no-cors' }), true, '<img> or <script>');
  assert.equal(refused('GET', { ...site, 'sec-fetch-mode': 'navigate' }), true, 'a link or a frame');
  assert.equal(refused('GET', { ...site }), true, 'no mode at all');
  assert.equal(refused('GET', { origin: 'null' }), true, 'a sandboxed frame');
  assert.equal(refused('OPTIONS', { ...site, origin: 'https://example.com', 'sec-fetch-mode': 'cors' }), true, 'the preflight of a POST');
  assert.equal(refused('HEAD', { ...site, 'sec-fetch-mode': 'no-cors' }), true);
});

test('the dashboard itself may ask, under either name of this computer', () => {
  const own = [
    { origin: 'http://127.0.0.1:3030', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    // Opened as localhost and calling 127.0.0.1: the browser calls that cross-site, and names the origin itself.
    { origin: 'http://localhost:3030', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
    { origin: 'http://127.0.0.1:3030' },
  ];
  for (const headers of own) {
    assert.equal(refused('POST', headers), false, JSON.stringify(headers));
    assert.equal(refused('GET', headers), false, JSON.stringify(headers));
  }
  assert.equal(refused('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }), false, 'a same-origin read sends no origin');
});

test('a paired device is refused before any of this, for every way of asking', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal(remotePathAllowed(ADDRESS, method), false, method);
  }
});

// ── The old task and the tab, over several starts ────────────────────────────

const APP_EXE = 'C:\\Apps\\Xenon\\xenon-native.exe';
const APP_TASK = `<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>"${APP_EXE}"</Command></Exec></Actions></Task>`;

/** A PC with a scheduler, settings and a marker in memory, and a record of the tabs opened. */
function pc({ oldTask = true, armed = false, appTask = false } = {}) {
  const tasks = new Set(oldTask ? [BROWSER_TASK_NAME] : []);
  if (appTask) tasks.add('Xenon App');
  const state = { tasks, settings: { autoOpenArmed: armed, autoOpenBrowser: true }, seen: '', tabs: 0, deleteFails: false, said: [] };
  const list = async () => [...tasks].map((name) => `"\\${name}","N/A","Ready"`).join('\r\n') + '\r\n';
  // What the engine does when it listens at a sign-in: decide, and open or not.
  const start = (signIn) => openDashboardAtSignIn({ port: PORT }, {
    startedAtMs: 0,
    backend: {
      signIn: async () => ({ id: signIn, ageMs: 30_000 }),
      canOpen: () => true,
      appAtSignIn: () => win.appAtSignIn({ tasks: list, readTask: async () => APP_TASK, query: async () => '', exists: async () => true }),
      oldLauncher: () => win.oldLauncher({ tasks: list }),
    },
    readSettings: async () => ({ ...state.settings }),
    readSeen: async () => state.seen,
    writeSeen: async (id) => { state.seen = id; },
    open: async () => { state.tabs += 1; },
    log: (line) => state.said.push(line),
  });
  // What it does a minute later: the old task is read, its meaning kept, and it is removed.
  const tidy = () => retireBrowserTask({
    platform: 'win32',
    port: PORT,
    run: async (args) => {
      if (!tasks.has(args[2])) throw new Error('not there');
      if (args[0] === '/Delete') { if (state.deleteFails) throw new Error('Access is denied.'); tasks.delete(args[2]); }
      return '';
    },
    arm: async () => { state.settings.autoOpenArmed = true; return true; },
  });
  return { state, start, tidy };
}

test('the update start opens nothing, the task goes a minute later, and the next sign-in opens one tab', async () => {
  const { state, start, tidy } = pc();
  // The first start of the new version, at a sign-in where the old task also ran.
  assert.equal((await start('monday')).open, false);
  assert.equal(state.tabs, 0, 'the old task may have opened its own: the engine adds none');
  assert.equal(await tidy(), 'removed');
  assert.equal(state.settings.autoOpenArmed, true, 'the task meant this person had it on');
  // Restarted in the same session, now asked for and with the task gone: that sign-in is used up.
  assert.equal((await start('monday')).why, 'sign_in_seen');
  assert.equal(state.tabs, 0);
  // The next sign-in.
  assert.deepEqual(await start('tuesday'), { open: true, why: 'sign_in', remember: true });
  assert.equal(await tidy(), 'no_task');
  assert.equal((await start('tuesday')).open, false);
  assert.equal(state.tabs, 1);
});

test('while the old task cannot be removed the engine opens no tab, and it is tried again at every start', async () => {
  const { state, start, tidy } = pc();
  state.deleteFails = true;
  await start('monday');
  assert.equal(await tidy(), 'kept');
  assert.equal(state.settings.autoOpenArmed, true);
  // Asked for, switch on, a new sign-in, and the task still there: it opens the browser, not the engine.
  assert.deepEqual(await start('tuesday'), { open: false, why: 'old_task', remember: true });
  assert.equal(await tidy(), 'kept');
  assert.deepEqual(await start('wednesday'), { open: false, why: 'old_task', remember: true });
  assert.equal(state.tabs, 0);
  assert.match(state.said.at(-1), /not opened \(old_task\)$/);
  // The delete works at last, a minute into Wednesday; Thursday gets its tab from the engine.
  state.deleteFails = false;
  assert.equal(await tidy(), 'removed');
  assert.equal((await start('wednesday')).why, 'sign_in_seen');
  assert.equal((await start('thursday')).open, true);
  assert.equal(state.tabs, 1);
});

test('somebody turns the switch on while the old task is still there: still no second tab', async () => {
  const { state, start } = pc({ armed: true });
  assert.equal((await start('monday')).why, 'old_task');
  assert.equal(state.tabs, 0);
});

test('a scheduler that cannot say whether the old task is there means no tab', async () => {
  const opened = [];
  const written = [];
  const verdict = await openDashboardAtSignIn({ port: PORT }, {
    startedAtMs: 0,
    backend: {
      signIn: async () => ({ id: 'monday', ageMs: 30_000 }),
      canOpen: () => true,
      appAtSignIn: async () => false,
      oldLauncher: () => win.oldLauncher({ tasks: async () => { throw Object.assign(new Error('timed out'), { killed: true }); } }),
    },
    readSettings: async () => ({ autoOpenArmed: true, autoOpenBrowser: true }),
    readSeen: async () => '',
    writeSeen: async (id) => { written.push(id); },
    open: async (url) => { opened.push(url); },
    log: () => {},
  });
  assert.equal(verdict.open, false);
  assert.equal(verdict.why, 'failed');
  assert.deepEqual(opened, []);
  assert.deepEqual(written, ['monday'], 'the sign-in is used up: a restart does not try again');
});

test('the old task is looked for by its exact name, in the list the scheduler prints', async () => {
  const lists = (text) => ({ tasks: async () => text });
  assert.equal(await win.oldLauncher(lists('"\\Xenon Edge Dashboard","N/A","Ready"\r\n')), true);
  assert.equal(await win.oldLauncher(lists('"\\Xenon Edge Widget","N/A","Ready"\r\n"\\Xenon App","N/A","Ready"\r\n')), false);
  assert.equal(await win.oldLauncher(lists('"\\Xenon Edge Dashboard 2","N/A","Ready"\r\n')), false);
  assert.equal(await win.oldLauncher(lists('')), false);
});

test('the app starting at sign-in still comes first: no tab, with or without the old task', async () => {
  for (const oldTask of [true, false]) {
    const { state, start } = pc({ oldTask, armed: true, appTask: true });
    assert.deepEqual(await start('monday'), { open: false, why: 'app_shows_it', remember: true });
    assert.equal(state.tabs, 0);
  }
});

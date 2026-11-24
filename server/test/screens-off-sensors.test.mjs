// While the PC's screens are off, the engine reads no sensors (screens-off/state.js).
//
// A report: an RTX 4090's driver failed as the screens woke, never on the nights
// nothing read the GPU. The Windows app tells the kiosk page, the page tells the
// engine, and the system tick, the processes stream and the sensors stream skip
// their reads until a while after the screens are back. A paired device watching
// keeps them going.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const state = require('../screens-off/state.js');
const { routes } = require('../screens-off/routes.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => state.reset());

test('the reads wait while the screens are off and a while after they are back', () => {
  const t0 = 1_000_000;
  assert.equal(state.readsWait([{}], t0), false, 'screens on: the reads run');
  state.setScreensOff(true, t0);
  assert.equal(state.readsWait([{}], t0 + 60_000), true);
  state.setScreensOff(false, t0 + 120_000);
  assert.equal(state.readsWait([{}], t0 + 120_000 + state.WAKE_QUIET_MS - 1), true, 'the driver is still bringing the screens up');
  assert.equal(state.readsWait([{}], t0 + 120_000 + state.WAKE_QUIET_MS), false);
});

test('a repeated report does not restart the wait after the screens are back', () => {
  state.setScreensOff(true, 0);
  state.setScreensOff(false, 1000);
  state.setScreensOff(false, 1000 + state.WAKE_QUIET_MS);
  assert.equal(state.readsWait([], 1000 + state.WAKE_QUIET_MS), false);
});

test('a paired device watching keeps the reads going', () => {
  state.setScreensOff(true, 0);
  assert.equal(state.readsWait([{}, { _xenonDevice: 'phone' }], 10), false);
  assert.equal(state.readsWait(new Set([{}]), 10), true);
});

test('POST /screens-off takes a boolean and nothing else', async () => {
  const call = async (body) => {
    let out = null;
    await routes['POST /screens-off']({}, {}, { json: (o) => { out = o; }, readBody: async () => body });
    return out;
  };
  assert.deepEqual(await call('{"off":"yes"}'), { ok: false, error: 'bad_request' });
  assert.deepEqual(await call('nope'), { ok: false, error: 'bad_request' });
  assert.equal(state.quiet(), false);
  assert.deepEqual(await call('{"off":true}'), { ok: true });
  assert.equal(state.quiet(), true);
});

test('the engine wires it: the three sensor loops skip, the path is guarded', () => {
  const server = engineSource();
  assert.match(server, /const screensOff = require\('\.\/screens-off\/state\.js'\);/);
  // RivaTuner drawing over a game (server/rtss/) reads too: the screen showing the game is on.
  assert.match(server, /async function _systemTick\(\) \{\n {2}if \(\(sseClients\.size > 0 && !screensOff\.readsWait\(sseClients\)\) \|\| require\('\.\/rtss\/index\.js'\)\.drawing\(\)\) \{/);
  assert.match(server, /if \(!processesWanted\(\) \|\| screensOff\.readsWait\(sseClients\)\) return;/);
  assert.match(server, /!sdkStreamGranted\('sensors'\) \|\| screensOff\.readsWait\(sseClients\)\) return;/);
  assert.match(server, /'\/hints\/reset', '\/screens-off',/, 'in CSRF_MUTATION_PATHS');
  assert.match(server, /res\._xenonDevice = remote\.device\.id;/, 'paired streams are marked');
  assert.match(read('../paired/refused-paths.js'), /\n {2}'\/screens-off',\n/, 'closed to paired devices');
  assert.match(read('../feature-routes.js'), /require\('\.\/screens-off\/routes\.js'\)/);
});

test('the page tells the engine when the screens change, and on every stream open', () => {
  const posts = [];
  const body = { classList: { toggle() {} } };
  const win = {};
  const ctx = { window: win, document: { body }, fetch: (url, opts) => { posts.push([url, JSON.parse(opts.body).off]); return Promise.resolve(); } };
  vm.runInNewContext(read('../js/ambient/ambient-freeze.js'), ctx);
  win.ambientFreeze('settings', true);
  assert.equal(posts.length, 0, 'another freeze says nothing');
  win.ambientFreeze('screens-off', true);
  win.ambientFreeze('screens-off', true);
  win.ambientFreeze('screens-off', false);
  assert.deepEqual(posts, [['/screens-off', true], ['/screens-off', false]]);
  win.ambientFreeze.reportScreens();
  assert.deepEqual(posts.at(-1), ['/screens-off', false]);
  const stream = read('../js/grid/data-stream.js');
  assert.match(stream, /&& !isLayerPage\(\)\) \{\n\s+fetch\('\/spotlight\/claimed'[^\n]*\n\s+if \(window\.ambientFreeze && typeof window\.ambientFreeze\.reportScreens === 'function'\) window\.ambientFreeze\.reportScreens\(\);/);
});

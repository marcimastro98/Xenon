import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const featureRoutes = require('../feature-routes.js');
const { remotePathAllowed } = require('../remote-access.js');
const { createRead } = require('../net-path/routes.js');

// Every route in feature-routes.js with what the gates in front of it decide. A
// new route fails here until someone classifies it: may a paired device reach
// it, and (for anything but a read) is it in CSRF_MUTATION_PATHS.
const CLASSIFIED = Object.freeze({
  'GET /api/net-path': { remote: true },
  'GET /api/energy': { remote: true },
  // The app's own strings: the dashboard on a paired phone fetches them too.
  'GET /i18n-langs.json': { remote: true },
});

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const CSRF = SERVER.slice(SERVER.indexOf('const CSRF_MUTATION_PATHS = new Set(['), SERVER.indexOf(']);', SERVER.indexOf('const CSRF_MUTATION_PATHS')));

test('every feature route is classified for both gates', () => {
  assert.deepEqual([...featureRoutes.keys()].sort(), Object.keys(CLASSIFIED).sort());
  for (const [key, want] of Object.entries(CLASSIFIED)) {
    const [method, path] = key.split(' ');
    assert.equal(remotePathAllowed(path, method), want.remote, `${key}: paired-device door`);
    if (method !== 'GET' && method !== 'HEAD') assert.ok(CSRF.includes(`'${path}'`), `${key} in CSRF_MUTATION_PATHS`);
  }
});

test('only an exact method and path reaches a handler', async () => {
  assert.equal(featureRoutes.has('GET', '/api/net-path'), true);
  assert.equal(featureRoutes.has('POST', '/api/net-path'), false);
  assert.equal(featureRoutes.has('GET', '/api/net-path/'), false);
  assert.equal(featureRoutes.has('GET', '/api/net-pat'), false);
  assert.equal(await featureRoutes.run('GET', '/api/nothing-here', null, null, {}), false);
});

function call(reader, granted) {
  const sent = [];
  const asked = [];
  const read = createRead(reader);
  return read(null, null, { json: (v) => sent.push(v), sdkStreamGranted: (s) => { asked.push(s); return granted; } })
    .then(() => ({ sent, asked }));
}

test('without the grant the route answers not_granted and starts nothing', async () => {
  let reads = 0;
  const { sent, asked } = await call({ read: async () => { reads += 1; return { ok: true }; } }, false);
  assert.deepEqual(asked, ['netPath']);
  assert.deepEqual(sent, [{ ok: false, error: 'not_granted' }]);
  assert.equal(reads, 0);
});

test('with the grant the reading goes out as it is', async () => {
  const reading = { ok: true, link: 'wired', router: null };
  const { sent } = await call({ read: async () => reading }, true);
  assert.deepEqual(sent, [reading]);
});

test('a failed read is a fixed word, never the message, which could name an address', async () => {
  const { sent } = await call({ read: async () => { throw new Error('no route to 192.0.2.1'); } }, true);
  assert.deepEqual(sent, [{ ok: false, error: 'failed' }]);
});

test('stop at shutdown never throws', () => {
  assert.doesNotThrow(() => featureRoutes.stop());
});

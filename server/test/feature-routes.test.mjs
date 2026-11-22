import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const featureRoutes = require('../feature-routes.js');
const { remotePathAllowed } = require('../paired/remote-access.js');
const { createRead } = require('../net-path/routes.js');

// Every route in feature-routes.js with what the gates in front of it decide. A
// new route fails here until someone classifies it: may a paired device reach
// it, and (for anything but a read) is it in CSRF_MUTATION_PATHS.
const CLASSIFIED = Object.freeze({
  'GET /api/net-path': { remote: true },
  'GET /api/energy': { remote: true },
  // The app's own strings: the dashboard on a paired phone fetches them too.
  'GET /i18n-langs.json': { remote: true },
  // Whether FFmpeg is there may be read anywhere; installing it is the PC's call.
  'GET /api/ffmpeg/status': { remote: true },
  'POST /api/ffmpeg/install': { remote: false },
  // Whether the sensor service runs and is current: a read, like /system.
  'GET /api/sensor-service': { remote: true },
  // A question for Bit opens a window on this PC: never from a phone.
  'POST /spotlight/ask': { remote: false },
  'POST /spotlight/ask/take': { remote: false },
  // The hints this PC has shown: read and reset at the PC only.
  'GET /hints': { remote: false },
  'POST /hints/seen': { remote: false },
  'POST /hints/reset': { remote: false },
  // The PC's screens went off or came back: only the PC knows.
  'POST /screens-off': { remote: false },
  // Pump screens: a phone may read and change them like the dashboard; the face page
  // and its hello belong to the pump on this PC.
  'GET /pump': { remote: false },
  'POST /pump': { remote: true },
  'POST /pump/hello': { remote: false },
  'GET /pump/here': { remote: false },
  'POST /pump/colors': { remote: false },
  'GET /pump-widget': { remote: false },
  'POST /pump/picture': { remote: true },
  'GET /pump-face': { remote: false },
  // The trial asked from the app: the request names this PC to the hub and the poll
  // hands back a trial code, so the PC only; a paired phone opens the hub's page.
  'GET /api/community/trial/pending': { remote: false },
  'POST /api/community/trial/request': { remote: false },
  'POST /api/community/trial/poll': { remote: false },
  'POST /api/community/trial/forget': { remote: false },
});

const SERVER = engineSource();
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

// A copy of the list of its own, so a table loaded here is not one another test finds.
function freshList() {
  const file = require.resolve('../feature-routes.js');
  const kept = require.cache[file];
  delete require.cache[file];
  try { return require('../feature-routes.js'); } finally { require.cache[file] = kept; }
}

test('a table answers the whole addresses its keys name, and no address a key only begins', async () => {
  const list = freshList();
  const calls = [];
  const answer = (name) => async (...handed) => { calls.push([name, ...handed]); };
  const branches = { 'GET /t/one': answer('one'), 'POST|GET /t/both': answer('both'), 'POST /t/x|/t/y': answer('xy'), 'GET /t/files/*': answer('files'), '* /t/any/*': answer('any') };
  assert.deepEqual(list.tableRoutes(branches).map(([key]) => key), ['GET /t/one', 'POST /t/both', 'GET /t/both', 'POST /t/x', 'POST /t/y']);
  list.loadTables([{ branches }, { branches: {} }]);
  assert.deepEqual(list.tableKeys(), ['GET /t/one', 'POST /t/both', 'GET /t/both', 'POST /t/x', 'POST /t/y']);
  assert.deepEqual(list.keys(), featureRoutes.keys(), 'the older features are counted apart');
  for (const [method, path, want] of [['GET', '/t/one', true], ['POST', '/t/one', false], ['GET', '/t/both', true], ['POST', '/t/y', true],
    ['GET', '/t/files/a', false], ['GET', '/t/files/', false], ['GET', '/t/any/a', false], ['GET', '/t/one/', false]]) {
    assert.equal(list.has(method, path), want, `${method} ${path}`);
  }
  const [req, res, ctx, engine] = [{}, {}, { json: 1 }, { store: 2 }];
  assert.equal(await list.run('POST', '/t/y', req, res, ctx, engine), true);
  assert.deepEqual(calls, [['xy', req, res, ctx, engine]], 'the function is handed the request, the answer, the handler\'s values and the names of server.js');
  assert.equal(await list.run('GET', '/t/files/a', req, res, ctx, engine), false);
  assert.equal(featureRoutes.has('GET', '/t/one'), false);
});

test('the names of server.js are asked for once, at the first request a table answers, and not before', async () => {
  const list = freshList();
  const got = [];
  list.loadTables([{ branches: { 'GET /t/one': async (_req, _res, _ctx, engine) => { got.push(engine); } } }]);
  let asked = 0;
  const names = () => { asked += 1; return { store: 2 }; };
  assert.equal(await list.run('GET', '/t/none', {}, {}, {}, names), false);
  assert.equal(asked, 0, 'an address no table answers asks for nothing');
  await list.run('GET', '/t/one', {}, {}, {}, names);
  await list.run('GET', '/t/one', {}, {}, {}, names);
  assert.equal(asked, 1);
  assert.equal(got[0], got[1], 'every request is handed the same object');
  assert.deepEqual(got[0], { store: 2 });
  assert.ok(Object.isFrozen(got[0]), 'and no function can put a name of its own in it for the next request');
  await list.run('GET', '/t/one', {}, {}, {}, () => ({ store: 3 }));
  assert.deepEqual(got[2], { store: 3 }, 'another list is another object');
});

test('two functions for one address stop the engine from starting', () => {
  const again = { branches: { 'GET /t/one': async () => {} } };
  assert.throws(() => freshList().loadTables([again, { branches: { 'POST|GET /t/one': async () => {} } }]), /feature-routes\.js: two functions answer GET \/t\/one/);
  assert.throws(() => freshList().loadTables([{ branches: { 'GET /api/net-path': async () => {} } }]), /two functions answer GET \/api\/net-path/, 'an address of an older feature counts');
});

test('a function of a table that throws is not caught here: the handler\'s boundary answers', async () => {
  const list = freshList();
  list.loadTables([{ branches: { 'GET /t/broken': async () => { throw new Error('broken'); } } }]);
  await assert.rejects(list.run('GET', '/t/broken', {}, {}, {}, {}), /broken/);
});

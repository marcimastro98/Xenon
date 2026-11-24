// Airflow's doors: GET /airflow (server/airflow/routes.js) on a stand-in engine, what a paired
// phone may run, and the two ways a PC says "this machine drives its own fans" (a Mac has no
// driver, a laptop answers before anything is asked: laptop-windows.js, drivers.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);

// routes.js with a stand-in for ./index.js, so loading it starts no engine.
function loadRoutes(engine) {
  const indexPath = require.resolve('../airflow/index.js');
  const routesPath = require.resolve('../airflow/routes.js');
  const saved = require.cache[indexPath];
  delete require.cache[routesPath];
  require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: engine };
  try { return require(routesPath); } finally {
    delete require.cache[routesPath];
    if (saved) require.cache[indexPath] = saved; else delete require.cache[indexPath];
  }
}

function engine({ available = true, view = async () => ({ state: 'off', fans: [] }) } = {}) {
  const calls = { start: 0 };
  return {
    calls,
    available: () => available,
    actions: { view },
    start: () => { calls.start += 1; },
    stop: async () => {},
  };
}

async function get(routes) {
  let body = null;
  await routes.routes['GET /airflow']({}, {}, { json: (b) => { body = b; } });
  return body;
}

test('GET /airflow: how the fans are, unavailable where Xenon cannot reach them, a fixed word on a failed read', async (t) => {
  const ok = engine({ view: async () => ({ state: 'driving', why: 'idle', fans: [{ id: 'lhm:a', rpm: 900 }] }) });
  const r = loadRoutes(ok);
  assert.equal(ok.calls.start, 1, 'loading the route starts the engine once');
  assert.equal(r.stop, ok.stop, 'shutdown stops the same engine');
  assert.deepEqual(await get(r), { ok: true, state: 'driving', why: 'idle', fans: [{ id: 'lhm:a', rpm: 900 }] });

  let read = 0;
  const none = engine({ available: false, view: async () => { read += 1; return {}; } });
  assert.deepEqual(await get(loadRoutes(none)), { ok: false, error: 'unavailable' });
  assert.equal(read, 0, 'a PC with no fans to drive is not read');

  const warned = [];
  t.mock.method(console, 'warn', (m) => warned.push(String(m)));
  const broken = engine({ view: async () => { throw new Error('fan.json is stale'); } });
  assert.deepEqual(await get(loadRoutes(broken)), { ok: false, error: 'read_failed' });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^airflow: /);
});

test('the route is a feature route, never a branch in server.js', () => {
  const table = readFileSync(new URL('../feature-routes.js', import.meta.url), 'utf8');
  assert.match(table, /require\('\.\/airflow\/routes\.js'\)/);
  const server = engineSource();
  assert.doesNotMatch(server, /['"]\/airflow['"]/);
});

test('a paired phone reads the fans and changes the mode, never starts the fan check', () => {
  const access = require('../paired/remote-access.js');
  const ra = require('../paired/remote-actions.js');
  assert.equal(access.remotePathAllowed('/airflow', 'GET'), true);
  for (const type of ['airflowMode', 'airflowSet', 'airflowGet']) assert.ok(ra.FREE.has(type), type);
  assert.deepEqual(ra.remoteMayRun({ type: 'airflowMode', mode: 'quiet' }, {}), { ok: true });
  const check = { type: 'airflowCheck', do: 'start' };
  const deckWithCheck = { profiles: [{ keys: [{ action: check }] }] };
  assert.deepEqual(ra.remoteMayRun(check, deckWithCheck), { ok: false, error: 'pc_only' }, 'not even from a Deck key that holds it');
});

test('laptop on Windows: a system battery that is not a UPS', () => {
  const { laptopFromCaps, CAPS_BYTES } = require('../airflow/laptop-windows.js');
  const caps = (present, shortTerm) => {
    const b = new Uint8Array(CAPS_BYTES);
    b[30] = present; b[31] = shortTerm;
    return b;
  };
  assert.equal(laptopFromCaps(caps(1, 0)), true);
  assert.equal(laptopFromCaps(caps(1, 1)), false, 'a UPS is a short-term battery');
  assert.equal(laptopFromCaps(caps(0, 0)), false);
  assert.equal(laptopFromCaps(new Uint8Array(CAPS_BYTES - 1).fill(1)), false, 'a short answer is no laptop');
  assert.equal(laptopFromCaps(null), false);
});

test('drivers: Windows answers "laptop" before asking the sensor service, and a failed probe is no laptop', async () => {
  const { driversFor, notOnLaptop } = require('../airflow/drivers.js');
  const win = driversFor({ platform: 'win32', dataDir: '.', laptop: async () => true });
  assert.equal(win.none, null);
  assert.deepEqual(win.drivers.map((d) => d.id), ['lhm', 'link']);
  assert.deepEqual(await win.drivers[0].available(), { ok: false, why: 'laptop' });
  assert.deepEqual(await win.drivers[1].available(), { ok: false, why: 'laptop' });

  let asked = 0;
  const driver = { id: 'x', available: async () => { asked += 1; return { ok: true, why: null }; } };
  const failing = notOnLaptop(driver, async () => { throw new Error('powrprof missing'); });
  assert.deepEqual(await failing.available(), { ok: true, why: null });
  await failing.available();
  assert.equal(asked, 2);

  const mac = driversFor({ platform: 'darwin', dataDir: '.' });
  assert.deepEqual(mac.drivers, []);
  assert.equal(mac.none, 'platform');
});

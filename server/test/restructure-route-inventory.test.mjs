// The route inventory (tools/restructure/route-inventory.mjs): the committed file is
// what the code makes now, and the gate classes it reads hold the rules of the HTTP
// trust boundary as they stand today (paired-device door, cross-site guard, JSONP).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { openParser, parserAvailable, REPO_ROOT } from '../../tools/restructure/parser.mjs';
import { addressRules } from '../../tools/restructure/route-inventory-gate.mjs';
import { featureFiles, routesOfKey } from '../../tools/restructure/route-inventory-read.mjs';
import { buildInventory, INVENTORY, render } from '../../tools/restructure/route-inventory.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const read = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const inventory = parser ? buildInventory({ read, parser }) : null;
const rowOf = (method, address) => inventory.rows.find((row) => row.method === method && row.path === address);

test('the committed inventory is what the code makes now', (t) => {
  if (!parser) return t.skip(SKIP);
  const kept = read(INVENTORY).replace(/\r\n/g, '\n');
  assert.ok(kept === render(inventory), `${INVENTORY} is not current: run node tools/restructure/route-inventory.mjs --write and review the diff`);
});

test('every address a gate list names is answered by a route, and no route is answered twice', (t) => {
  if (!parser) return t.skip(SKIP);
  for (const [list, addresses] of Object.entries(inventory.loose)) assert.deepEqual(addresses, [], `${list} names addresses no route answers`);
  assert.deepEqual(inventory.twice, []);
  assert.ok(inventory.rows.length > 400, 'the chain, the tables and the sockets were all read');
});

test('JSONP answers GET /status and nothing else', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual([...inventory.gate.jsonp], ['/status']);
  assert.deepEqual(inventory.rows.filter((row) => row.jsonp).map((row) => `${row.method} ${row.path}`), ['GET /status']);
});

test('no GET a paired device may ask is one that changes something, but for the named reads', (t) => {
  if (!parser) return t.skip(SKIP);
  const reads = inventory.gate.remote.GET_READ_EXCEPTIONS;
  const open = inventory.rows.filter((row) => row.method === 'GET' && row.guard === 'CSRF_MUTATION_PATHS' && row.paired.startsWith('yes'));
  assert.deepEqual(open.filter((row) => !reads.has(row.path)).map((row) => row.path), []);
});

test('a GET that runs the body of a POST is a listed mutator and refused to a paired device', (t) => {
  if (!parser) return t.skip(SKIP);
  const shared = inventory.rows.filter((row) => row.method === 'GET' && /^(?:[A-Z]+\|)*GET(?:\|[A-Z]+)* /.test(row.key ?? '') && /POST|DELETE|PATCH/.test(row.key));
  assert.ok(shared.length > 0, 'the iCUE-shaped routes were read');
  for (const row of shared) {
    assert.equal(row.guard, 'CSRF_MUTATION_PATHS', `${row.key}: the GET shape is not in CSRF_MUTATION_PATHS`);
    assert.equal(row.paired, 'no: a GET that changes something', `${row.key}: the GET shape is open to a paired device`);
  }
});

test('the door before pairing, the management routes and the sockets', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual(inventory.rows.filter((row) => row.paired === 'yes, before pairing').map((row) => `${row.method} ${row.path}`).sort(),
    ['GET /pair', 'POST /api/remote-access/redeem']);
  for (const tail of ['status', 'enable', 'pair', 'pair/cancel', 'rename', 'revoke', 'revoke-all', 'https', 'https/setup']) {
    const rows = inventory.rows.filter((row) => row.path === `/api/remote-access/${tail}`);
    assert.ok(rows.length > 0, `/api/remote-access/${tail} is answered`);
    for (const row of rows) assert.equal(row.paired, 'no: REMOTE_ADMIN', `${row.method} ${row.path}`);
  }
  const sockets = inventory.rows.filter((row) => row.method === 'WS');
  assert.ok(sockets.length > 0);
  for (const row of sockets) assert.equal(row.paired, 'no: sockets take the loopback door only');
  assert.equal(rowOf('*', '/api/mcp/dev/*').paired, 'no: REMOTE_DENY_PREFIXES');
});

// What invariants-security-core.md says of single routes: [method, address, paired device, cross-site guard].
const NAMED = [
  ['POST', '/deck/press', 'no: REMOTE_DENY', 'CSRF_MUTATION_PATHS'],
  ['POST', '/pages/hotkey-press', 'no: REMOTE_DENY', ''],
  ['POST', '/search/hotkey-press', 'no: REMOTE_DENY', ''],
  ['POST', '/api/claude/run', 'no: REMOTE_DENY', 'CSRF_MUTATION_PATHS'],
  ['POST', '/remote/tailscale/login', 'no: REMOTE_DENY', ''],
  ['POST', '/backup/import', 'no: REMOTE_DENY', ''],
  ['POST', '/api/ffmpeg/install', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['GET', '/api/ffmpeg/status', 'yes', ''],
  ['POST', '/api/devclean/compact', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/features/devclean/unlock', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/community/supporter/forget', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/community/supporter/save', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/community/buy', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/community/sparks/save', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/community/sparks/forget', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/community/trial/check', 'yes', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/community/trial/tried', 'yes', 'CSRF_MUTATION_PATHS'],
  ['GET', '/api/lyrics', 'yes (GET_READ_EXCEPTIONS)', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/features/lyrics/unlock', 'no: REMOTE_ADMIN', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/features/lyrics/trial', 'yes', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/lyrics/offset', 'yes', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/lyrics/translate', 'yes', 'CSRF_MUTATION_PATHS'],
  ['POST', '/api/ai/turn/stop', 'yes', 'CSRF_MUTATION_PATHS'],
  ['GET', '/api/ai/turn', 'yes', ''],
  ['GET', '/api/performance/shield', 'yes', ''],
  ['POST', '/api/performance/state', 'no: REMOTE_DENY', 'CSRF_MUTATION_PATHS'],
  ['GET', '/api/ai-local/scan', 'no: a GET that changes something', 'CSRF_MUTATION_PATHS'],
  ['GET', '/notes', 'no: a GET that changes something', 'CSRF_MUTATION_PATHS'],
  ['POST', '/sdk/fetch', 'yes', 'isSdkSensitive'],
  ['POST', '/sdk/hook/*', 'yes', 'isSdkSensitive'],
  ['DELETE', '/icon-pack/*', 'yes', 'isPackMutation'],
  ['DELETE', '/sound-pack/*', 'yes', 'isPackMutation'],
];

test('the routes the security invariants name keep their gate class', (t) => {
  if (!parser) return t.skip(SKIP);
  for (const [method, address, paired, guard] of NAMED) {
    const row = rowOf(method, address);
    assert.ok(row, `${method} ${address} is answered`);
    assert.deepEqual([row.paired, row.guard], [paired, guard], `${method} ${address}`);
  }
  for (const tail of ['key', 'subscribe', 'unsubscribe', 'test']) assert.equal(rowOf('POST', `/api/push/${tail}`).guard, 'CSRF_MUTATION_PATHS', `/api/push/${tail}`);
});

test('keys and rules are read as written, and anything else is refused', () => {
  assert.deepEqual(routesOfKey('POST|GET /a|/b').map((one) => `${one.method} ${one.path}`), ['POST /a', 'POST /b', 'GET /a', 'GET /b']);
  assert.deepEqual(routesOfKey('* /x/*'), [{ method: '*', path: '/x/*', key: '* /x/*' }]);
  assert.deepEqual(addressRules("reqPath === '/a' || reqPath.startsWith('/b/')"), { exact: ['/a'], prefix: ['/b/'] });
  assert.throws(() => addressRules("reqPath === '/a' || isOther(reqPath)"), /cannot read/);
  assert.deepEqual(featureFiles("const FEATURES = Object.freeze([\n  require('./a/routes.js'),\n]);\n"), ['a/routes.js']);
  assert.throws(() => featureFiles("const FEATURES = Object.freeze([\n  require(name),\n]);\n"), /not one required file/);
});

// What was seen of the personal Bit, as anonymous counts (server/bit/seen.js, POST /api/bit/seen):
// a fixed list of ids that engine/usage-stats.js takes, counted only while the person allows it,
// and never from a paired phone (js/ai/bit-app.js seen()).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from './browser-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const usage = require('../engine/usage-stats.js');
const Seen = require('../bit/seen.js');
const { KINDS } = require('../../packages/core/src/bit-signs.js');

after(() => usage._reset()); // no save left waiting

function counting(on) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-bit-seen-'));
  usage._reset?.();
  usage.configure({ dataDir: dir, enabled: () => on });
  return dir;
}

test('the list: the pocket, a desktop try-on and one id per sign, each one the counter takes', () => {
  assert.deepEqual([...Seen.SEEN], ['pocket', 'tryon', ...KINDS.map((k) => 'sign.' + k)]);
  counting(true);
  for (const id of Seen.IDS) assert.equal(usage.record(id), true, id);
});

test('anything off the list is not counted; nothing is while counting is off', () => {
  counting(true);
  for (const bad of ['sign.', 'sign.nope', 'pocket ', 'C:\Users', '', null, 7, { what: 'pocket' }]) assert.equal(Seen.seen(bad), false, String(bad));
  counting(false);
  assert.equal(Seen.seen('pocket'), false);
});

test('POST /api/bit/seen counts one listed id, and refuses anything else', async () => {
  counting(true);
  const { routes, stop } = require('../bit/routes.js');
  const ask = async (body) => {
    let said = null;
    await routes['POST /api/bit/seen']({}, {}, { json: (o) => { said = o; }, readBody: async () => body }, {});
    return said;
  };
  try {
    assert.deepEqual(await ask(JSON.stringify({ what: 'sign.done' })), { ok: true, counted: true });
    assert.deepEqual(await ask(JSON.stringify({ what: 'sign.secret' })), { ok: false, error: 'bad_request' });
    assert.deepEqual(await ask('not json'), { ok: false, error: 'bad_request' });
  } finally { stop(); }
});

test('the page counts from the PC only, and another site cannot count for it', () => {
  const app = readFileSync(new URL('../js/ai/bit-app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("if (!window.RemoteSurface?.isRemote?.()) fetch(SERVER + '/api/bit/seen'"));
  assert.ok(engineSource().includes("'/api/bit/prefs', '/api/bit/seen',"), 'in CSRF_MUTATION_PATHS');
});

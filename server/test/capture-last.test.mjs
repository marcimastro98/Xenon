// capture-last.js: the last steps document and bug report, remembered across
// restarts in one JSON. Pinned here: a missing or broken file is an empty
// memory, writes go one after the other and keep the other kind, and server.js
// hands each recorder its own kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createCaptureLast } = require('../capture-last.js');

function store(initial) {
  const disk = { text: initial };
  const writes = [];
  const last = createCaptureLast({
    file: 'capture-last.json',
    readFile: async () => {
      if (disk.text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return disk.text;
    },
    write: async (file, text) => { writes.push(text); disk.text = text; },
  });
  return { last, disk, writes };
}

test('nothing on disk or a broken file is nothing remembered', async () => {
  assert.equal(await store(undefined).last.load('steps'), null);
  assert.equal(await store('{not json').last.load('steps'), null);
  assert.equal(await store('[1]').last.load('steps'), null);
  assert.equal(await store('{"steps":"x"}').last.load('steps'), null);
});

test('each kind is saved beside the other, one write after the other', async () => {
  const s = store(JSON.stringify({ bugreport: { file: 'C:\\a\\Bug report x.zip', name: 'Bug report x.zip' } }));
  const steps = s.last.forKind('steps');
  steps.save({ dir: 'C:\\d', html: 'C:\\d\\steps.html', name: 'd' });
  await steps.save({ dir: 'C:\\e', html: 'C:\\e\\steps.html', name: 'e' });
  assert.equal(s.writes.length, 2);
  const saved = JSON.parse(s.disk.text);
  assert.equal(saved.steps.name, 'e');
  assert.equal(saved.bugreport.name, 'Bug report x.zip');
  assert.deepEqual(await steps.load(), saved.steps);
});

test('a failed write does not break the next one', async () => {
  let fail = true;
  const writes = [];
  const last = createCaptureLast({
    file: 'f',
    readFile: async () => '{}',
    write: async (f, text) => {
      if (fail) { fail = false; throw new Error('disk'); }
      writes.push(text);
    },
  });
  await last.save('steps', { a: 1 });
  await last.save('steps', { a: 2 });
  assert.deepEqual(JSON.parse(writes[0]), { steps: { a: 2 } });
});

test('server.js gives each recorder its kind and checks the document is on disk', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /file: path\.join\(DATA_DIR, 'capture-last\.json'\)/);
  assert.match(src, /remember: _captureLast\.forKind\('steps'\),\n\s+exists: \(file\) => fs\.promises\.access\(file\)/);
  assert.match(src, /remember: _captureLast\.forKind\('bugreport'\),/);
});

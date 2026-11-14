// A browser script that Node loads too (tools/restructure/browser-node-loads.mjs):
// a test or the engine `require`s it, and there it is one file with a scope of its
// own. What Node reaches in it has to stay in it, and `browser extract` has to say
// so before the move, not the test run after it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeRun } from '../../tools/restructure/browser-analyze.mjs';
import { mentionsOf } from '../../tools/restructure/browser-consumers.mjs';
import { perform } from '../../tools/restructure/browser-extract.mjs';
import { nodeKeeps, nodeLoadProblems, nodeLoadersOf, reachedInNode } from '../../tools/restructure/browser-node-loads.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const CODEC = ["'use strict';", '', 'const LIMIT = 3;', '', 'function clamp(value) {', '  return Math.min(value, LIMIT);', '}', '',
  'function encode(value) {', '  return clamp(value) * 2;', '}', '', 'function paint(canvas) {', '  canvas.width = encode(1);', '}', '',
  'function onClick() {', '  paint(document.body);', '}', '',
  "if (typeof window !== 'undefined') {", '  window.Codec = { encode, paint };', "  document.addEventListener('click', onClick);", '}',
  "if (typeof module !== 'undefined' && module.exports) module.exports = { encode };", ''].join('\n');

test('what Node reaches is what its statements use, however deep, and not what only a page runs', (t) => {
  if (!parser) return t.skip(SKIP);
  const run = analyzeRun([{ file: 'server/js/codec.js', text: CODEC }], parser);
  const reached = reachedInNode(run, 0);
  assert.deepEqual([...reached.inside].sort(), ['LIMIT', 'clamp', 'encode'], 'the export line reaches encode, encode reaches clamp, clamp reads LIMIT');
  assert.deepEqual([...reached.outside], []);
});

test('a script already split: a name Node reaches that sits in another script is a problem', (t) => {
  if (!parser) return t.skip(SKIP);
  const part = ["'use strict';", '', 'function clamp(value) {', '  return Math.min(value, 3);', '}', ''].join('\n');
  const rest = CODEC.replace('function clamp(value) {\n  return Math.min(value, LIMIT);\n}\n\n', '');
  const run = analyzeRun([{ file: 'server/js/codec/clamp.js', text: part }, { file: 'server/js/codec.js', text: rest }], parser);
  assert.deepEqual([...reachedInNode(run, 1).outside], ['clamp']);
});

function tempRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-node-loads-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}

const FILES = {
  'server/js/codec.js': CODEC,
  'server/js/other/codec.js': 'function other() {}\n',
  'server/index.html': '<script src="js/codec.js"></script>\n',
  'server/test/codec.test.mjs': "import { createRequire } from 'node:module';\nimport { readFileSync } from './browser-source.mjs';\n"
    + "const require = createRequire(import.meta.url);\nconst Codec = require('../js/codec.js');\nreadFileSync('server/js/codec.js');\n",
  'server/engine.js': "const { encode } = require('./js/codec.js');\n",
  'server/reads.js': "fs.readFileSync(path.join(__dirname, 'js', 'x', 'codec.js'));\nconst other = require('./js/other/codec.js');\n",
  'tools/site.mjs': "import Codec from '../server/js/codec.js';\nconst later = await import('../server/js/codec.js');\n",
  'tools/map/frozen-paths.json': JSON.stringify({ paths: [], whole: [] }),
};

test('a require or an import of the script is found wherever it stands, and a read of its text is not one', () => {
  const root = tempRepo(FILES);
  try {
    assert.deepEqual(nodeLoadersOf(root, 'server/js/codec.js'), ['server/engine.js:1', 'server/test/codec.test.mjs:4', 'tools/site.mjs:1']);
    const loads = Object.fromEntries(mentionsOf(root, 'server/js/codec.js').map((mention) => [mention.file, mention.loads]));
    assert.deepEqual(loads['tools/site.mjs'], [1, 2], 'import from, and import()');
    assert.deepEqual(loads['server/index.html'], [], 'a tag is a page loading it');
    assert.deepEqual(loads['server/reads.js'], [], 'its bare name in a path is a mention, and the codec.js of another folder is another file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extract refuses to take out what Node reaches, names who loads the file, and lets the rest go', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = tempRepo(FILES);
  const move = (names) => ({ kind: 'script', from: 'server/js/codec.js', file: 'server/js/codec/part.js', about: 'A part.', names });
  try {
    const run = analyzeRun([{ file: 'server/js/codec.js', text: CODEC }], parser);
    assert.deepEqual([...nodeKeeps(root, 'server/js/codec.js', run, 0)].map(([name, who]) => `${name} <- ${who}`),
      ['LIMIT <- server/engine.js:1', 'encode <- server/engine.js:1', 'clamp <- server/engine.js:1']);
    assert.throws(() => perform({ root, parser, move: move(['clamp', 'paint']), dryRun: true }), (error) => {
      assert.ok(error instanceof Refusal);
      assert.match(error.reasons.join('\n'), /clamp stays in server\/js\/codec\.js: server\/engine\.js:1 loads the file in Node, alone, and what runs there reaches clamp/);
      assert.doesNotMatch(error.reasons.join('\n'), /paint stays/);
      return true;
    });
    assert.deepEqual(nodeLoadProblems(root, 'server/js/codec.js', run, 0), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a script nothing loads in Node keeps no name for that reason', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = tempRepo({ 'server/js/codec.js': CODEC, 'server/index.html': '<script src="js/codec.js"></script>\n' });
  try {
    const run = analyzeRun([{ file: 'server/js/codec.js', text: CODEC }], parser);
    assert.equal(nodeKeeps(root, 'server/js/codec.js', run, 0).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

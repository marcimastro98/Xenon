// A test that puts a script's name together from pieces (browser-built-names.mjs) is one of the script's
// readers: found by the search for who names it, refused before a move, and pointed at the reader like the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { builtFolders, builtMentions } from '../../tools/restructure/browser-built-names.mjs';
import { consumerProblems, mentionsOf, withOneSearch } from '../../tools/restructure/browser-consumers.mjs';
import { retargetTests } from '../../tools/restructure/browser-test-readers.mjs';

const FILE = 'server/js/capture-gallery.js';
// The shapes met in the tests of this repo: a template over a list of names, the ending added, a join of path parts.
const TEMPLATE = ["const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');", "const SOURCES = ['capture-toast', 'capture-gallery'].map((name) => read(`../js/${name}.js`));", ''].join('\n');
const ADDED = ["const SOURCES = ['capture-toast', \"capture-gallery\"].map((name) => read('../js/' + name + '.js'));", ''].join('\n');
const JOINED = ["const read = (name) => readFileSync(path.join(HERE, '..', 'js', `${name}.js`), 'utf8');", '', "const GALLERY = read('capture-gallery');", ''].join('\n');

test('a text that builds names ending in .js says under which folders', () => {
  assert.deepEqual(builtFolders(TEMPLATE), ['js']);
  assert.deepEqual(builtFolders(ADDED), [''], 'the ending added to a name: any folder');
  assert.deepEqual(builtFolders(JOINED), [''], 'a join of path parts hands the folders over apart');
  assert.deepEqual(builtFolders('load(`${ROOT}/js/i18n/${code}.js`); load(`./${name}.js`);'), ['js/i18n', '']);
  assert.equal(builtFolders("const FILE = 'js/capture-gallery.js';"), null, 'a name written out is not built');
  assert.equal(builtFolders('const text = `${count} files in .js`;'), null);
});

test('the script is named where its name stands without the ending, as a whole string', () => {
  assert.deepEqual(builtMentions(TEMPLATE, FILE), [2]);
  assert.deepEqual(builtMentions(ADDED, FILE), [1]);
  assert.deepEqual(builtMentions(JOINED, FILE), [3]);
  assert.deepEqual(builtMentions(TEMPLATE, 'server/js/capture-toast.js'), [2]);
  assert.deepEqual(builtMentions(TEMPLATE, 'server/js/capture.js'), [], 'a part of a longer name is another script');
  assert.deepEqual(builtMentions(TEMPLATE, 'server/js/capture-gallery/words.js'), [], 'a part of the script has a name of its own');
  assert.deepEqual(builtMentions("const KIND = 'capture-gallery';", FILE), [], 'the word alone, in a text that builds no name');
  // The folder a template writes decides: `js/i18n/${code}.js` reads js/i18n/it.js and not a js/it.js.
  const languages = "for (const code of ['en', 'it']) load(`../js/i18n/${code}.js`);";
  assert.deepEqual(builtMentions(languages, 'server/js/i18n/it.js'), [1]);
  assert.deepEqual(builtMentions(languages, 'server/js/it.js'), []);
  assert.deepEqual(builtMentions(TEMPLATE, 'server/components/Gallery/capture-gallery.js'), [], 'built under js/, and this one is elsewhere');
});

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-built-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}
const FS = "import { readFileSync } from 'node:fs';\n";
const SCRIPT = "'use strict';\n(function () {\n  window.CaptureGallery = {};\n})();\n";
const TREE = {
  [FILE]: SCRIPT, 'server/js/capture-toast.js': SCRIPT, 'server/index.html': '<body>\n<script src="js/capture-gallery.js"></script>\n</body>\n',
  'server/test/gallery-window.test.mjs': FS + TEMPLATE, 'server/test/gallery-added.test.mjs': FS + ADDED, 'server/test/gallery-joined.test.mjs': FS + JOINED,
  // Neither of these reads it: one only says the word, the other builds names and never this one.
  'server/test/gallery-word.test.mjs': "const KIND = 'capture-gallery';\n", 'server/test/toast.test.mjs': "const SOURCES = ['capture-toast'].map((name) => read(`../js/${name}.js`));\n",
  'server/test/gallery-note.test.mjs': "// ['capture-gallery'] is read below\nconst SOURCES = ['capture-toast'].map((name) => read(`../js/${name}.js`));\n",
  'tools/shots.mjs': "for (const name of ['capture-gallery']) open(`server/js/${name}.js`);\n",
};
const BUILT = ['code tools/shots.mjs 1', 'test server/test/gallery-added.test.mjs 2', 'test server/test/gallery-joined.test.mjs 4', 'test server/test/gallery-window.test.mjs 3'];

test('who names a script includes the files that build its name, and the move is refused until each is accounted for', (t) => {
  const root = repo(t, TREE);
  const named = () => mentionsOf(root, FILE).filter((mention) => mention.kind !== 'page').map((mention) => `${mention.kind} ${mention.file} ${mention.lines.join(',')}`).sort();
  assert.deepEqual(named(), BUILT, 'a name in a comment, the word alone and a list without it are not readers');
  assert.deepEqual(withOneSearch(root, [FILE, 'server/js/capture-toast.js'], named), BUILT, 'asked about many scripts at once, the same answer');
  const problems = consumerProblems(root, FILE);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /server\/test\/gallery-window\.test\.mjs:3 reads or names capture-gallery\.js without server\/test\/browser-source\.mjs/);
  assert.match(problems.join('\n'), /tools\/shots\.mjs:1 names capture-gallery\.js in code/);
  // A file that names the script outright and builds its name too is one reader, with every line.
  fs.writeFileSync(path.join(root, 'tools/shots.mjs'), `${TREE['tools/shots.mjs']}const FIRST = 'server/js/capture-gallery.js';\n`);
  assert.equal(named()[0], 'code tools/shots.mjs 1,2');
});

test('the tests that build the name are pointed at the reader with the others, and then stand in nobody\'s way', (t) => {
  const root = repo(t, TREE);
  const moved = retargetTests(root, FILE, true);
  assert.deepEqual(moved, { changed: ['server/test/gallery-added.test.mjs', 'server/test/gallery-joined.test.mjs', 'server/test/gallery-window.test.mjs'], byHand: [] });
  assert.equal(fs.readFileSync(path.join(root, 'server/test/gallery-window.test.mjs'), 'utf8'), `import { readFileSync } from './browser-source.mjs';\n${TEMPLATE}`);
  assert.deepEqual(consumerProblems(root, FILE).map((line) => line.split(':')[0]), ['tools/shots.mjs'], 'the tool that builds the name still has to be written down');
  assert.deepEqual(retargetTests(root, FILE, true), { changed: [], byHand: [] }, 'a second run changes nothing');
});

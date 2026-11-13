// Giving the places a file finds next to itself a module of their own
// (tools/restructure paths): the lines go there with SERVER_DIR in place of
// __dirname, the file requires each name where it stood, and old and new value
// are worked out and compared. What is not such a place is refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { quietModules } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { planPaths, provePaths } from '../../tools/restructure/paths.mjs';
import { oldPathsText, oldSpelling } from '../../tools/restructure/paths-undo.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const [OLD, NEW] = ['server/demo.js', 'server/part/places.js'];
const plan = (text, names, more = {}) => planPaths({ text, parser, source: OLD, target: NEW, about: 'Where the parts sit.', names, ...more });
const refusal = (text, names, more) => {
  try { plan(text, names, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made) => provePaths({ before: text, after: made.newSource, moduleText: made.moduleText, plan: made, parser, source: OLD, target: NEW });

const SOURCE = ["'use strict';", "const path = require('path');", '// The user data: never served. Found from __dirname.', "const DATA = path.join(__dirname, 'data');",
  "const TOOL = path.join(__dirname, 'tools',", "  process.platform === 'win32' ? 'tool.exe' : 'tool'); // the companion", 'let calls = 0;',
  "const ROOT_FILE = path.join(__dirname, '..', 'package.json');", "const NOTES = path.join(DATA, 'notes.txt');",
  'function show() { calls += 1; return [DATA, TOOL, ROOT_FILE, NOTES].join("|"); }', 'process.stdout.write(show());', ''].join('\n');

test('the lines go to the module with SERVER_DIR for __dirname, and the file requires each name where it stood', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['ROOT_FILE', 'DATA', 'TOOL']);
  assert.equal(made.moduleText, ["'use strict';", '// Where the parts sit.', '', "const path = require('node:path');", '',
    "const SERVER_DIR = path.join(__dirname, '..');", '', '// The user data: never served. Found from __dirname.', "const DATA = path.join(SERVER_DIR, 'data');",
    "const TOOL = path.join(SERVER_DIR, 'tools',", "  process.platform === 'win32' ? 'tool.exe' : 'tool'); // the companion", '',
    "const ROOT_FILE = path.join(SERVER_DIR, '..', 'package.json');", '', 'module.exports = { DATA, TOOL, ROOT_FILE };', ''].join('\n'),
  'the comment keeps its word, neighbours stay together, a constant that stood apart is set apart');
  const lines = SOURCE.split('\n');
  assert.equal(made.newSource, [lines[0], lines[1], "const { DATA, TOOL } = require('./part/places.js');", lines[6],
    "const { ROOT_FILE } = require('./part/places.js');", ...lines.slice(8)].join('\n'), 'every other line is where it was');
  assert.deepEqual(made.names, ['DATA', 'TOOL', 'ROOT_FILE'], 'in the order of the file, whatever order they were asked in');
  assert.deepEqual(proven(SOURCE, made), []);
  assert.equal(oldPathsText(made.moduleText).split('\n').slice(6, 9).join('\n'), lines.slice(2, 5).join('\n'), 'with the old word back the lines are the old lines');
  assert.ok(!oldPathsText(made.moduleText).includes('SERVER_DIR'), 'and the line that works out the home folder is gone');
  assert.equal(oldSpelling('MY_SERVER_DIR SERVER_DIR2 $SERVER_DIR (SERVER_DIR, SERVER_DIR)'), 'MY_SERVER_DIR SERVER_DIR2 $SERVER_DIR (__dirname, __dirname)', 'only the whole word is put back');
  assert.deepEqual([...quietModules([{ file: NEW, paths: true }, { file: 'server/part/x.js', lift: true }])], [NEW], 'the module runs nothing: a later move may drop its require');
});

// A sample engine in a temp folder, named by its real path: Node gives a file the real path of its folder,
// and on macOS the temp folder is reached through a link (/var is /private/var).
function sampleFolder(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'xenon-paths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'server', 'part'), { recursive: true });
  return root;
}
const placesUnder = (root) => `0|${[path.join(root, 'server', 'data'), path.join(root, 'server', 'tools', process.platform === 'win32' ? 'tool.exe' : 'tool'),
  path.join(root, 'package.json'), path.join(root, 'server', 'data', 'notes.txt')].join('|')}`;
// Runs the sample, started through `reached` (the folder itself, or a link to it), in its old form and then in its new one.
function bothForms(root, reached) {
  const run = () => {
    const done = spawnSync(process.execPath, [path.join(reached, 'server', 'demo.js')], { encoding: 'utf8', timeout: 20000 });
    return `${done.status}|${done.stdout}`;
  };
  writeFileSync(path.join(root, 'server', 'demo.js'), SOURCE);
  const before = run();
  const made = plan(SOURCE, ['DATA', 'TOOL', 'ROOT_FILE']);
  writeFileSync(path.join(root, 'server', 'demo.js'), made.newSource);
  writeFileSync(path.join(root, NEW), made.moduleText);
  return { before, after: run() };
}

test('the engine gets the same places: both forms run and print the same', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = sampleFolder(t);
  const { before, after } = bothForms(root, root);
  assert.equal(before, placesUnder(root));
  assert.equal(after, before);
});

test('started through a link to its folder, both forms still print the same places', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = sampleFolder(t);
  const link = `${root}-link`;
  try {
    // A junction on Windows needs no special right; elsewhere an ordinary link to a folder.
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    return t.skip(`this system does not let the test make a link to a folder (${error.code})`);
  }
  t.after(() => rmSync(link, { recursive: true, force: true }));
  const { before, after } = bothForms(root, link);
  // Node names a file by the real path of its folder, the file it was started with too: neither form sees the link.
  assert.equal(before, placesUnder(root), 'the old form names the real folder');
  assert.equal(after, before, 'and the module one folder down works out the very same text');
});

test('nothing that starts the engine asks Node to keep links in the paths it hands out', () => {
  // The one start where the two forms would name the folder differently: --preserve-symlinks-main without
  // --preserve-symlinks, from a folder reached through a link. No launcher passes either, or sets them through
  // the environment.
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const starters = [path.join(repo, 'package.json'),
    ...readdirSync(path.join(repo, 'server')).filter((name) => /.(ps1|sh|vbs|cmd|bat|plist|service)$/.test(name)).map((name) => path.join(repo, 'server', name)),
    ...readdirSync(path.join(repo, 'apps', 'native', 'src-tauri', 'src'), { recursive: true }).filter((name) => String(name).endsWith('.rs'))
      .map((name) => path.join(repo, 'apps', 'native', 'src-tauri', 'src', String(name)))].filter((file) => statSync(file).isFile());
  assert.ok(starters.length > 20, 'the launchers were found');
  for (const file of starters) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /preserve-symlinks|NODE_PRESERVE_SYMLINKS|NODE_OPTIONS/i, path.relative(repo, file));
  }
});

test('what is not a place next to the file, or could change, is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const swapped = (from, to) => SOURCE.replace(from, to);
  assert.match(refusal(SOURCE, ['nope']), /nope is not a top-level declaration/);
  assert.match(refusal(SOURCE, ['NOTES']), /NOTES \(server\/demo\.js:9\) is built from DATA: only __dirname, path\.join, plain text and process\.platform/);
  assert.match(refusal(SOURCE, ['show']), /show \(server\/demo\.js:10\) is not written as one `const name = value;`/);
  assert.match(refusal(SOURCE, ['calls']), /calls \(server\/demo\.js:7\) is not written as one/);
  assert.match(refusal(swapped("'data')", "'data'), OTHER = 1"), ['DATA']), /is not written as one/);
  assert.match(refusal(swapped("path.join(__dirname, 'data')", "path.resolve(__dirname, 'data')"), ['DATA']), /is built from path\.resolve\(__dirname, 'data'\)/);
  assert.match(refusal(swapped("path.join(__dirname, 'data')", "path.join(__dirname, process.env.DEMO_DATA)"), ['DATA']), /is built from process\.env\.DEMO_DATA/);
  assert.match(refusal(swapped("path.join(__dirname, 'data')", "path.join(__dirname, `data`)"), ['DATA']), /is built from `data`/);
  assert.match(refusal(swapped("path.join(__dirname, 'data')", "path.join(__dirname, (() => 'data')())"), ['DATA']), /is built from/);
  assert.match(refusal(swapped("path.join(__dirname, 'data')", "path.join('data', 'x')"), ['DATA']), /does not use __dirname: `extract` moves it as it is/);
  assert.match(refusal(swapped("process.platform === 'win32'", "process.arch === 'x64'"), ['TOOL']), /is built from process\.arch/);
  assert.match(refusal(swapped('// The user data: never served.', '// SERVER_DIR is not this.'), ['DATA']), /already has the word SERVER_DIR in its lines/);
  assert.match(refusal(swapped("require('path')", "require('./path')"), ['DATA']), /does not hold Node's path module under the name path/);
  assert.match(refusal(swapped('let calls = 0;', 'let process = 0;'), ['DATA']), /declares process or SERVER_DIR itself/);
  assert.match(refusal(swapped('let calls = 0;', "let calls = 0; const X = path.join(__dirname, 'x');"), ['X']), /shares a line with another statement/);
  assert.match(refusal(SOURCE, ['DATA'], { protectedNames: new Set(['DATA']) }), /is part of the security prelude and stays where it is/);
  assert.match(refusal(SOURCE.replace(/\n/g, '\r\n'), ['DATA']), /Windows line endings/);
  assert.match(refusal(SOURCE, ['DATA'], { about: ' ' }), /say in one sentence what the new file holds/);
  assert.match(refusal(SOURCE, ['DATA'], { maxLines: 5 }), /would be 11 lines, the limit for a new file is 5/);
});

test('the proof notices another place, a changed byte, a respelled comment and a line that moved', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['DATA', 'TOOL', 'ROOT_FILE']);
  const bent = (from, to) => proven(SOURCE, { ...made, moduleText: made.moduleText.replace(from, to) }).join('\n');
  assert.match(bent("path.join(__dirname, '..')", "path.join(__dirname, '..', '..')"), /not a comment, the path module, the home folder/);
  assert.match(bent("'tool.exe' : 'tool'", "'tool' : 'tool.exe'"), /not in the new module unchanged but for the home folder/);
  assert.match(bent('Found from __dirname.', 'Found from SERVER_DIR.'), /SERVER_DIR stands in the moved lines more often than __dirname stood in the values/);
  assert.match(bent("path.join(SERVER_DIR, 'data')", "path.join(__dirname, 'data')"), /DATA is built from __dirname/);
  assert.match(bent("module.exports = { DATA, TOOL, ROOT_FILE };", "module.exports = { DATA, TOOL };"), /not a comment, the path module, the home folder/);
  assert.match(bent("\nmodule.exports", "process.title = 'x';\n\nmodule.exports"), /not in the new module unchanged|statements besides the constants/);
  const moved = { ...made, newSource: made.newSource.replace('let calls = 0;\n', '').replace("{ ROOT_FILE } = require('./part/places.js');\n", "{ ROOT_FILE } = require('./part/places.js');\nlet calls = 0;\n") };
  assert.match(proven(SOURCE, moved).join('\n'), /the old file is not the old text with the constants replaced by a require where they stood/);
  // A module one folder deeper than the tool wrote for would work out another home: the values are compared, so it shows.
  const deeper = provePaths({ before: SOURCE, after: made.newSource.replaceAll('./part/places.js', './part/deep/places.js'), moduleText: made.moduleText, plan: made,
    parser, source: OLD, target: 'server/part/deep/places.js' }).join('\n');
  assert.match(deeper, /not a comment, the path module, the home folder/);
});

test('a recorded move is redone from the old text and has to give the files on disk', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-paths-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const made = plan(SOURCE, ['DATA', 'TOOL']);
  mkdirSync(path.join(root, 'server', 'part'), { recursive: true });
  mkdirSync(path.join(root, 'tools', 'restructure'), { recursive: true });
  writeFileSync(path.join(root, OLD), made.newSource);
  writeFileSync(path.join(root, NEW), made.moduleText);
  writeFileSync(path.join(root, 'tools', 'restructure', 'protected.json'), '{ "files": {} }');
  writeFileSync(path.join(root, 'tools', 'restructure', 'extracted.json'), JSON.stringify({ note: '', sources: { [OLD]: [{ file: NEW, about: 'Where the parts sit.', names: ['DATA', 'TOOL'], paths: true }] } }));
  const show = (_root, _rev, file) => (file === OLD ? SOURCE : null);
  assert.deepEqual(replay({ root, parser, base: 'HEAD', show }).problems, []);
  writeFileSync(path.join(root, NEW), made.moduleText.replace("'data'", "'data2'"));
  assert.match(replay({ root, parser, base: 'HEAD', show }).problems.join('\n'), /places\.js is not what the tool writes/);
});

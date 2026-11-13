// Giving a value the file works out at load a module of its own (tools/restructure
// lift): the statements go there as they are, the file requires the module on the
// line where they stood, and what could change the value or its timing is refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { planExtraction, Refusal } from '../../tools/restructure/extract-plan.mjs';
import { quietModules } from '../../tools/restructure/ledger.mjs';
import { planLift, proveLift } from '../../tools/restructure/lift.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

// The old file is server/demo.js, the new one server/part/x.js: one folder deeper.
const [OLD, NEW] = ['server/demo.js', 'server/part/x.js'];
const FILES = new Set(['server/linux.js', 'server/mac.js', 'server/nosy.js', 'package.json']);
const fileOf = (spec, from) => {
  const base = path.posix.join(path.posix.dirname(from), spec);
  return [base, `${base}.js`].find((file) => FILES.has(file)) ?? null;
};
const rewrite = (spec, from, to) => {
  const file = fileOf(spec, from);
  if (!file) throw new Error(`require('${spec}') in ${from} points at no file`);
  const relative = path.posix.relative(path.posix.dirname(to), file);
  return { spec: relative.startsWith('.') ? relative : `./${relative}`, kind: 'file', file };
};

const plan = (text, name, more = {}) => planLift({ text, parser, source: OLD, target: NEW, about: 'What the part does.', name, rewrite, ...more });
const refusal = (text, name, more) => {
  try { plan(text, name, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made) => proveLift({ before: text, after: made.newSource, moduleText: made.moduleText, plan: made, parser,
  source: OLD, target: NEW, fileOf });

const SOURCE = ['const os = require("os");', '// The version, read once.', "let VERSION = '';", '// Without a leading v.',
  "try { VERSION = String(require('../package.json').version || '').trim().replace(/^v/i, ''); } catch {}", '',
  '// Elsewhere this is done natively.', 'const native =', "  process.env.DEMO_OS === 'linux' ? require('./linux') :",
  '  process.env.DEMO_OS === "darwin" ? require("./mac") : null;', 'const HOME = os.EOL.length;',
  'function show() { return `${VERSION} ${native ? native.name : "none"} ${HOME}`; }', 'process.stdout.write(show());', ''].join('\n');

test('the statements that make the value go to the module unchanged, the file requires it where they stood', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, 'VERSION');
  assert.equal(made.moduleText, ['// What the part does.', '', '// The version, read once.', "let VERSION = '';", '// Without a leading v.',
    "try { VERSION = String(require('../../package.json').version || '').trim().replace(/^v/i, ''); } catch {}", '',
    'module.exports = { VERSION };', ''].join('\n'));
  const lines = SOURCE.split('\n');
  assert.equal(made.newSource, [lines[0], "const { VERSION } = require('./part/x.js');", ...lines.slice(5)].join('\n'),
    'every other line is where it was, the blank line after the statements too');
  assert.deepEqual(made.requires, [{ from: '../package.json', to: '../../package.json', file: 'package.json' }]);
  assert.deepEqual(proven(SOURCE, made), []);
});

test('a const made by a choice of requires keeps its quotes and its comment', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, 'native');
  assert.equal(made.moduleText, ['// What the part does.', '', '// Elsewhere this is done natively.', 'const native =',
    "  process.env.DEMO_OS === 'linux' ? require('../linux.js') :", '  process.env.DEMO_OS === "darwin" ? require("../mac.js") : null;', '',
    'module.exports = { native };', ''].join('\n'));
  assert.equal(made.newSource.split('\n')[6], "const { native } = require('./part/x.js');");
  assert.equal(made.newSource.split('\n').length, SOURCE.split('\n').length - 3);
  assert.deepEqual(proven(SOURCE, made), []);
  const strict = plan(`'use strict';\n${SOURCE}`, 'native');
  assert.equal(strict.moduleText.split('\n')[0], "'use strict';", 'a strict file makes a strict module');
  assert.deepEqual(proven(`'use strict';\n${SOURCE}`, strict), []);
});

test('the engine gets the same value at the same moment: both forms run and print the same', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-lift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'server', 'part'), { recursive: true });
  // Each helper prints when it loads, so a change of order would show.
  writeFileSync(path.join(root, 'server', 'linux.js'), "process.stdout.write('[linux loads]'); module.exports = { name: 'linux' };\n");
  writeFileSync(path.join(root, 'server', 'mac.js'), "process.stdout.write('[mac loads]'); module.exports = { name: 'mac' };\n");
  const run = (DEMO_OS) => {
    const done = spawnSync(process.execPath, [path.join(root, 'server', 'demo.js')], { encoding: 'utf8', env: { ...process.env, DEMO_OS }, timeout: 20000 });
    return `${done.status}|${done.stdout}`;
  };
  const noisy = SOURCE.replace('const HOME', "process.stdout.write('[after]'); const HOME");
  const first = plan(noisy, 'VERSION');
  const second = planLift({ text: first.newSource, parser, source: OLD, target: 'server/part/y.js', about: 'The other part.', name: 'native', rewrite });
  for (const version of ['{ "version": " v1.2.3 " }', '{}', null]) {
    if (version === null) rmSync(path.join(root, 'package.json'));
    else writeFileSync(path.join(root, 'package.json'), version);
    rmSync(path.join(root, 'server', 'part', 'x.js'), { force: true });
    rmSync(path.join(root, 'server', 'part', 'y.js'), { force: true });
    writeFileSync(path.join(root, 'server', 'demo.js'), noisy);
    const before = ['linux', 'darwin', 'other'].map(run);
    writeFileSync(path.join(root, 'server', 'demo.js'), second.newSource);
    writeFileSync(path.join(root, 'server', 'part', 'x.js'), first.moduleText);
    writeFileSync(path.join(root, 'server', 'part', 'y.js'), second.moduleText);
    assert.deepEqual(['linux', 'darwin', 'other'].map(run), before, `package.json: ${version}`);
    if (version === '{ "version": " v1.2.3 " }') assert.deepEqual(before, ['0|[linux loads][after]1.2.3 linux 1', '0|[mac loads][after]1.2.3 mac 1', '0|[after]1.2.3 none 1'].map((line) => line.replace(/ 1$/, ` ${os.EOL.length}`)));
    else assert.match(before[2], /^0\|\[after\] none \d$/, 'an unreadable or empty package.json gives the empty version in both');
  }
});

test('what could change the value, or mean another thing in another file, is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const lines = SOURCE.split('\n');
  const withLine = (at, line) => [...lines.slice(0, at), line, ...lines.slice(at)].join('\n');
  const swapped = (from, to) => SOURCE.replace(from, to);
  assert.match(refusal(SOURCE, 'nope'), /nope is not a top-level declaration/);
  assert.match(refusal(SOURCE, 'show'), /show is a function/);
  assert.match(refusal(SOURCE, 'os'), /os is a require/);
  assert.match(refusal(SOURCE, 'HOME'), /line 11 uses os of server\/demo\.js/);
  assert.match(refusal(withLine(12, 'function set() { VERSION = "9"; }'), 'VERSION'), /line 13 assigns VERSION again/);
  assert.match(refusal(withLine(12, 'VERSION += "-dev";'), 'VERSION'), /line 13 assigns VERSION again/);
  assert.match(refusal(swapped("let VERSION = '';", "let VERSION = '', OTHER = 1;"), 'VERSION'), /declared together with OTHER/);
  assert.match(refusal(swapped("require('./linux')", 'require(__dirname + "/linux")'), 'native'), /uses __dirname/);
  assert.match(refusal(swapped("require('./linux')", 'require(process.env.DEMO_FILE)'), 'native'), /require as something other than require\('<text>'\)/);
  assert.match(refusal(swapped("require('./linux')", 'require.resolve("./linux")'), 'native'), /require as something other than/);
  assert.match(refusal(swapped("require('./linux')", 'module.children'), 'native'), /uses module, which means another thing/);
  assert.match(refusal(swapped("require('./linux')", 'this.linux'), 'native'), /uses this, which is the file's own exports/);
  assert.match(refusal(swapped("require('./linux')", '(() => 1)()'), 'native'), /holds a function/);
  assert.match(refusal(swapped("require('./linux')", "require('./gone')"), 'native'), /require\('\.\/gone'\) in server\/demo\.js points at no file/);
  assert.match(refusal(swapped("require('./linux')", "require('./nosy')"), 'native', { readFile: () => 'if (module.parent) run();' }),
    /server\/nosy\.js reads module\.parent, which would be the new module/);
  assert.match(refusal(swapped('.trim()', '.trim() + HOME'), 'VERSION'), /uses HOME of server\/demo\.js/);
  assert.match(refusal(SOURCE.replace(/\n/g, '\r\n'), 'native'), /Windows line endings/);
  assert.match(refusal(SOURCE, 'native', { about: ' ' }), /say in one sentence what the new file does/);
  assert.match(refusal(SOURCE, 'native', { maxLines: 5 }), /would be 8 lines, the limit for a new file is 5/);
  assert.match(refusal(SOURCE, 'native', { protectedNames: new Set(['native']) }), /protected stretch: list it under "liftable"/);
  assert.equal(refusal(SOURCE, 'native', { protectedNames: new Set(['native']), liftable: new Set(['native']) }), '', 'listed, it may');
});

test('the proof notices a changed byte, a require that reaches another file, and a value that is assigned again', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, 'native');
  const bent = (from, to) => proven(SOURCE, { ...made, moduleText: made.moduleText.replace(from, to) }).join('\n');
  assert.match(bent("=== 'linux'", "!== 'linux'"), /line 9 is not in the new module unchanged/);
  assert.match(bent('../linux.js', '../mac.js'), /line 9: require\('\.\/linux'\) became require\('\.\.\/mac\.js'\), which is not the same file/);
  assert.match(bent('../linux.js', './linux'), /which is not the same file/, 'the old spelling reaches nothing from the new folder');
  assert.match(bent('// Elsewhere this is done natively.', '// Elsewhere.'), /line 7 is not in the new module unchanged/);
  assert.match(bent('module.exports = { native };', 'module.exports = { native, os };'), /not a comment, the lifted lines and one export/);
  assert.match(bent('// What the part does.', 'run();'), /not a comment, the lifted lines and one export/);
  const touched = (from, to) => proven(SOURCE, { ...made, newSource: made.newSource.replace(from, to) }).join('\n');
  assert.match(touched('const HOME = os.EOL.length;', 'const HOME = 2;'), /not the old text with the lifted lines replaced by one require/);
  assert.match(touched("require('./part/x.js')", "require('./part/other.js')"), /native is not what the file requires from server\/part\/x\.js/);
  // A plan for a file where something else writes the value: the planner refuses it, and so would the proof alone.
  const later = `${SOURCE}native = null;\n`;
  const forced = { ...made, newSource: `${made.newSource}native = null;\n` };
  assert.match(proven(later, forced).join('\n'), /native is assigned again in the file/);
  const closure = SOURCE.replace("require('./linux')", "(() => require('./linux'))()");
  const hidden = { ...made, newSource: made.newSource, moduleText: made.moduleText.replace("require('../linux.js')", "(() => require('../linux.js'))()") };
  assert.match(proven(closure, hidden).join('\n'), /holds a function, this or a require that is not a plain call/);
});

test('a lifted module runs code when it loads: a later move never drops its require, nor lets it load earlier', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual([...quietModules([{ file: 'server/a/moved.js' }, { file: 'server/part/x.js', lift: true }, { file: 'server/b/state.js', state: {} }])],
    ['server/a/moved.js', 'server/b/state.js']);
  const lifted = plan(SOURCE, 'native').newSource.replace(/function show[^\n]*\n[^\n]*\n/,
    'function tell() { return native ? native.name : "none"; }\nfunction use() { return tell() + VERSION + HOME; }\n');
  const moved = planExtraction({ text: lifted, analysis: analyze(lifted, parser, OLD), names: ['tell'], source: OLD, target: 'server/part/tell.js',
    about: 'Shows it.', ownModules: quietModules([{ file: NEW, lift: true }]),
    rewrite: (spec) => ({ spec: spec === './part/x.js' ? './x.js' : spec, kind: 'file', file: spec === './part/x.js' ? NEW : null }) });
  assert.ok(moved.newSource.includes("\nrequire('./part/x.js');\n"), 'nobody in the file uses the value any more: its module is still loaded on that line');
  assert.match(moved.moduleText, /const \{ native \} = require\('\.\/x\.js'\);/);
  // A function that runs while the file loads, above the line that works the value out, cannot take the value along.
  const early = ['function peek() { return native; }', 'const first = peek();', ...lifted.split('\n')].join('\n');
  const blocked = analyze(early, parser, OLD).records.find((record) => record.names.includes('peek')).blockers;
  assert.deepEqual(blocked.map((blocker) => blocker.code), ['needs-a-module-loaded-later']);
});

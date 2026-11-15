// tools/restructure/move.mjs: whole files of server/ go to the folder of their feature. These tests pin what the
// tool rewrites, what it refuses and that a step can be put back, on small invented repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyStep, edited, planStep, readMoved, shimText, undoStep, writeShims } from '../../tools/restructure/move-apply.mjs';
import { archiveProblems } from '../../tools/restructure/move-check.mjs';
import { dropUnused, putBack } from '../../tools/restructure/move-map.mjs';
import { ownLoads, targets, whyNot } from '../../tools/restructure/move-plan.mjs';
import { findSites, respell, stops } from '../../tools/restructure/move-refs.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const FEATURES = [
  { id: 'pulse', files: ['server/pulse/**', 'server/pulse-*.js'] },
  { id: 'bot', files: ['server/brain/**', 'server/brain-*.js'] },
  { id: 'phone', files: ['server/transfer/**', 'server/handset.js'] },
  { id: 'updates', files: ['server/updates/**', 'server/renew.js'] },
  { id: 'rest', files: ['**'] },
];
const LEFT = { homes: { bot: 'brain' }, features: { updates: 'the updater' }, files: { 'server/brain-kept.js': 'kept on purpose' } };
const MOVE = { from: 'server/pulse-nag.js', to: 'server/pulse/pulse-nag.js' };

const facts = (files, extra = {}) => ({
  tracked: new Set(Object.keys(files)), frozen: { paths: ['server/server.js'], whole: ['server/*.html'] }, features: FEATURES,
  dirty: new Set(), ignored: () => false, read: (file) => files[file] ?? null, ...extra,
});

test('a loose file goes to the folder named like its feature, or to the one the list gives the feature', () => {
  const tracked = ['server/pulse/index.js', 'server/pulse-nag.js', 'server/brain/chat.js', 'server/brain-memory.js', 'server/brain-kept.js',
    'server/transfer/inbox.js', 'server/handset.js', 'server/updates/a.js', 'server/renew.js', 'server/pulse/deep/x.js'];
  const { moves, stay } = targets({ tracked, features: FEATURES, left: LEFT });
  assert.deepEqual(moves.map((move) => `${move.from} -> ${move.to}`).sort(), ['server/brain-memory.js -> server/brain/brain-memory.js', 'server/pulse-nag.js -> server/pulse/pulse-nag.js']);
  const why = Object.fromEntries(stay.map((entry) => [entry.file, entry.why]));
  assert.equal(why['server/brain-kept.js'], 'kept on purpose');
  assert.equal(why['server/renew.js'], 'the updater');
  assert.match(why['server/handset.js'], /no folder of its own/, 'a folder with another name is not made the home of a feature');
  assert.deepEqual(targets({ tracked, features: FEATURES, left: LEFT, only: 'pulse' }).moves.length, 1);
});

test('a move is refused for what the repo says about the file', () => {
  const files = { 'server/pulse-nag.js': 'const a = 1;\n', 'server/pulse/index.js': '', 'server/server.js': '', 'server/js/app.js': '', 'server/x.js': '', 'server/capture/y.js': '' };
  assert.equal(whyNot(MOVE, facts(files)), null);
  assert.match(whyNot({ from: 'server/server.js', to: 'server/pulse/server.js' }, facts(files)), /frozen/);
  assert.match(whyNot(MOVE, facts(files, { dirty: new Set([MOVE.from]) })), /not committed/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/pulse/nag.js' }, facts(files)), /keeps the name/);
  assert.match(whyNot({ from: 'server/x.js', to: 'server/x/x.js' }, facts(files)), /never become the folder/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/brand-new/pulse-nag.js' }, facts(files)), /makes no folder/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/js/pulse-nag.js' }, facts(files)), /handed out to pages/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/capture/pulse-nag.js' }, facts(files, { ignored: (file) => file.startsWith('server/capture/') })), /ignored by git/);
  assert.match(whyNot(MOVE, facts({ ...files, 'server/pulse/pulse-nag.js': '' })), /already there/);
  const owned = facts({ ...files, 'server/brain/chat.js': '' });
  assert.match(whyNot({ from: MOVE.from, to: 'server/brain/pulse-nag.js' }, owned), /another feature/);
});

test('a file whose place is part of what it does stays', () => {
  const says = (code) => whyNot(MOVE, facts({ 'server/pulse-nag.js': code, 'server/pulse/index.js': '' }));
  for (const code of ['path.join(__dirname, "a.ps1")', 'spawn(__filename)', 'require.resolve("./a")', 'if (require.main === module) run()',
    'process.argv[1]', 'import.meta.url', 'require(name)', 'require("./" + name)', 'delete require.cache[a]', 'module.paths.push(a)']) {
    assert.match(says(code) ?? '', /its place is part of what it does/, code);
  }
  assert.equal(says('// not code: __dirname\nconst a = require("./a.js");'), null, 'a comment that says the word stops nothing');
});

test('the loads of a moving file are spelled for its new folder, with or without .js as they were', () => {
  const loads = [{ start: 1, end: 2, was: './safe-write' }, { start: 3, end: 4, was: './pulse/copy.js' }, { start: 5, end: 6, was: './pulse-state.js' },
    { start: 7, end: 8, was: './pulse-state' }, { start: 9, end: 10, was: '../packages/core/src/a.js' }];
  const other = { from: 'server/pulse-state.js', to: 'server/pulse/pulse-state.js' };
  assert.deepEqual(ownLoads(MOVE, loads, [MOVE, other]).map((load) => load.text), ['../safe-write', './copy.js', '../../packages/core/src/a.js'], 'a neighbour that moves along keeps its spelling');
  assert.deepEqual(ownLoads(MOVE, loads, [MOVE]).map((load) => load.text), ['../safe-write', './copy.js', '../pulse-state.js', '../pulse-state', '../../packages/core/src/a.js']);
  assert.equal(respell('server/test/a.test.mjs', '../pulse-nag.js', MOVE.to), '../pulse/pulse-nag.js');
  assert.equal(respell('server/server.js', './pulse-nag', MOVE.to), './pulse/pulse-nag');
});

test('edits are placed from the end, and a text that is not what was read stops everything', () => {
  assert.equal(edited('abcdef', [{ start: 1, end: 2, was: 'b', text: 'BB' }, { start: 4, end: 5, was: 'e', text: '' }]), 'aBBcdf');
  assert.throws(() => edited('abcdef', [{ start: 1, end: 3, was: 'bc', text: 'x' }, { start: 2, end: 4, was: 'cd', text: 'y' }]), /overlap/);
  assert.throws(() => edited('abcdef', [{ start: 1, end: 2, was: 'x', text: 'y' }]), /is not/);
});

test('the old path keeps one line that hands on the module', () => {
  assert.equal(shimText(MOVE).split('\n').filter(Boolean).pop(), "module.exports = require('./pulse/pulse-nag.js');");
  assert.equal(shimText(MOVE).split('\n').length, 3, 'a sentence, the line, nothing else');
});

test('an install may differ from the base by the moved files alone', () => {
  const before = new Set(['server/pulse-nag.js', 'server/server.js']);
  assert.deepEqual(archiveProblems(before, new Set(['server/pulse/pulse-nag.js', 'server/server.js']), [MOVE]), []);
  assert.deepEqual(archiveProblems(before, new Set(['server/pulse/pulse-nag.js', 'server/pulse-nag.js', 'server/server.js']), [{ ...MOVE, shim: true }]), []);
  const problems = archiveProblems(before, new Set(['server/server.js', 'server/new.js']), [{ ...MOVE, shim: true }]);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems.join('\n'), /no move made it: server\/new\.js/);
  assert.match(problems.join('\n'), /missing from an install/);
  assert.match(archiveProblems(before, new Set(['server/pulse/pulse-nag.js']), [MOVE]).join('\n'), /no move took it: server\/server\.js/);
});

test('a pattern of the map that points at nothing after a move goes, and comes back with the line at the old path', () => {
  const map = { features: FEATURES };
  const after = ['server/pulse/index.js', 'server/pulse/pulse-nag.js', 'server/brain/chat.js', 'server/brain-memory.js', 'server/transfer/a.js', 'server/handset.js', 'server/updates/a.js', 'server/renew.js', 'README.md'];
  const { map: without, dropped } = dropUnused(map, after);
  assert.deepEqual(dropped, [{ feature: 'pulse', glob: 'server/pulse-*.js', at: 1 }]);
  assert.deepEqual(without.features[0].files, ['server/pulse/**']);
  const back = putBack(without, dropped, [...after, 'server/pulse-nag.js']);
  assert.deepEqual(back.map, map);
  assert.deepEqual(back.still, []);
  assert.deepEqual(putBack(without, dropped, after).still, dropped, 'no file at the old path: the pattern stays out');
});

const TEST_FILES = {
  'server/server.js': "const nag = require('./pulse-nag');\nconst other = require('./pulse/index.js');\n// see server/pulse-nag.js\n",
  'server/pulse/index.js': "const { a } = require('../pulse-nag.js');\nconst b = require('./pulse-nag.js');\n",
  'server/pulse/pulse-nag.js': '',
  'server/pulse-nag.js': "const w = require('./safe-write');\n",
  'server/safe-write.js': '',
  'server/test/a.test.mjs': [
    "import { readFileSync } from 'node:fs';", "import { dirname, join } from 'node:path';", "import { fileURLToPath } from 'node:url';",
    "const HERE = dirname(fileURLToPath(import.meta.url));", "const SERVER = join(HERE, '..');",
    "const read = (name) => readFileSync(join(SERVER, name), 'utf8');",
    "const one = readFileSync(join(SERVER, 'pulse-nag.js'), 'utf8');",
    "const two = readFileSync(new URL('../pulse-nag.js', import.meta.url), 'utf8');",
    "const three = read('pulse-nag.js');",
    "const four = engineSource('server/pulse-nag.js');",
    "const five = require('../pulse-nag.js');",
    "const six = join(HERE, '..', 'pulse', 'pulse-nag.js');",
    '',
  ].join('\n'),
  'tools/list.json': '{ "server/pulse-nag.js TS2339": 2, "server/pulse-nag.json": 1 }\n',
  'CHANGELOG.md': 'Fixed server/pulse-nag.js\n',
};

const sitesOf = async (files, moves = [MOVE]) => {
  const parser = await openParser();
  try { return findSites({ files: Object.keys(files), read: (file) => files[file], parser, moves }); } finally { await parser.close(); }
};

test('every place that names a moved file is found and given its new spelling', { skip: !parserAvailable() && 'TypeScript is not installed here' }, async () => {
  const sites = await sitesOf(TEST_FILES);
  assert.deepEqual(sites.filter((site) => stops(site)), []);
  const text = (file) => edited(TEST_FILES[file], sites.filter((site) => site.file === file));
  assert.equal(text('server/server.js'), "const nag = require('./pulse/pulse-nag');\nconst other = require('./pulse/index.js');\n// see server/pulse/pulse-nag.js\n");
  assert.equal(text('server/pulse/index.js'), "const { a } = require('./pulse-nag.js');\nconst b = require('./pulse-nag.js');\n", 'the file of the same name already in the folder is another file');
  const lines = text('server/test/a.test.mjs').split('\n');
  assert.equal(lines[6], "const one = readFileSync(join(SERVER, 'pulse/pulse-nag.js'), 'utf8');");
  assert.equal(lines[7], "const two = readFileSync(new URL('../pulse/pulse-nag.js', import.meta.url), 'utf8');");
  assert.equal(lines[8], "const three = read('pulse/pulse-nag.js');");
  assert.equal(lines[9], "const four = engineSource('server/pulse/pulse-nag.js');");
  assert.equal(lines[10], "const five = require('../pulse/pulse-nag.js');");
  assert.equal(lines[11], "const six = join(HERE, '..', 'pulse', 'pulse-nag.js');");
  assert.equal(text('tools/list.json'), '{ "server/pulse/pulse-nag.js TS2339": 2, "server/pulse-nag.json": 1 }\n');
  assert.equal(sites.some((site) => site.file === 'CHANGELOG.md'), false, 'history keeps the names of its day');
});

test('what the tool cannot follow, and what runs the file by path, stops the move', { skip: !parserAvailable() && 'TypeScript is not installed here' }, async () => {
  const why = async (file, text) => (await sitesOf({ [file]: text, 'server/pulse-nag.js': '', 'server/js/pulse-nag.js': '' })).map((site) => stops(site)).filter(Boolean).join(' | ');
  assert.match(await why('server/test/b.test.mjs', "const list = ['pulse-nag.js'];\n"), /bare name/);
  assert.match(await why('server/test/b.test.mjs', 'const a = `${SERVER}/pulse-nag.js`;\n'), /template/);
  assert.match(await why('server/test/b.test.mjs', "const a = join(process.cwd(), 'server', 'pulse-nag.js');\n"), /bare name/);
  assert.match(await why('server/run.js', "spawn(process.execPath, [path.join(__dirname, 'pulse-nag.js')]);\n"), /code that ships puts its path together/);
  assert.match(await why('server/run.js', "const worker = new Worker('./pulse-nag.js');\n"), /code that ships puts its path together/);
  assert.match(await why('server/run.js', "log('node server/pulse-nag.js failed');\n"), /holds its path in a string/);
  assert.match(await why('server/install.ps1', 'node "$root\\server\\pulse-nag.js"\n'), /installer/);
  assert.match(await why('server/index.html', '<script src="pulse-nag.js"></script>\n'), /installer, a page/);
  assert.match(await why('apps/native/src/invented.rs', 'let script = "pulse-nag.js";\n'), /native code names it/);
  assert.match(await why('package.json', '{ "scripts": { "nag": "node server/pulse-nag.js" } }\n'), /package file/);
  assert.equal(await why('server/install.ps1', '# the popup is drawn by pulse-nag.js\n'), '', 'a comment of an installer is a mention');
  assert.equal(await why('server/index.html', '<script src="js/pulse-nag.js"></script>\n<!-- pulse-nag.js -->\n'), '');
  assert.equal(await why('server/run.js', "log('[pulse-nag.js] started');\nconst other = 'pulse-nag';\n"), '', 'a word in a message is not a path');
});

function tempRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-move-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'start');
  return { root, git, read: (file) => readFileSync(path.join(root, file), 'utf8') };
}

test('a step moves, rewrites and lists; undo puts every file back; the line at the old path comes in its own step', { skip: !parserAvailable() && 'TypeScript is not installed here' }, async () => {
  const files = { ...TEST_FILES };
  delete files['server/pulse/pulse-nag.js'];
  files['server/pulse/index.js'] = "const { a } = require('../pulse-nag.js');\n";
  const body = Array.from({ length: 12 }, (_, at) => `exports.value${at} = ${at};\n`).join('');
  files[MOVE.from] += body;
  files['server/pulse-state.js'] = "const nag = require('./pulse-nag.js');\nconst here = __dirname;\n";
  const mapped = [FEATURES[0], FEATURES[4]].map((feature) => ({ id: feature.id, area: 'all', name: feature.id, what: 'Invented.', files: feature.files }));
  files['tools/map/features.json'] = `${JSON.stringify({ intro: ['An invented map.'], areas: [{ id: 'all', name: 'All', what: 'Everything.' }], features: mapped }, null, 2)}\n`;
  files['MAP.md'] = 'old\n';
  files['tools/restructure/move-left.json'] = `${JSON.stringify(LEFT)}\n`;
  files['tools/map/frozen-paths.json'] = JSON.stringify({ paths: ['server/server.js'], whole: [] });
  const repo = tempRepo(files);
  const parser = await openParser();
  try {
    const asked = [MOVE, { from: 'server/pulse-state.js', to: 'server/pulse/pulse-state.js' }];
    const step = planStep(repo.root, asked, parser);
    assert.deepEqual(step.moves, [MOVE]);
    assert.match(step.refused[0].why.join(' '), /__dirname/);
    applyStep(repo.root, step);
    assert.equal(existsSync(path.join(repo.root, MOVE.from)), false);
    assert.equal(repo.read(MOVE.to), `const w = require('../safe-write');\n${body}`);
    assert.equal(repo.read('server/pulse-state.js'), "const nag = require('./pulse/pulse-nag.js');\nconst here = __dirname;\n");
    assert.equal(repo.read('server/pulse/index.js'), "const { a } = require('./pulse-nag.js');\n");
    assert.deepEqual(readMoved(repo.root).moves, [MOVE]);
    assert.deepEqual(readMoved(repo.root).patterns, [], 'server/pulse-state.js still answers the pattern');
    assert.match(repo.git('status', '--porcelain'), /^R {2}server\/pulse-nag\.js -> server\/pulse\/pulse-nag\.js$/m);

    assert.match(undoStep(repo.root), /put back/);
    assert.equal(repo.git('status', '--porcelain'), '');
    assert.equal(repo.read(MOVE.from), files[MOVE.from]);

    applyStep(repo.root, planStep(repo.root, asked, parser));
    repo.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'move');
    assert.match(undoStep(repo.root), /git revert/, 'after the commit the step is git\'s to undo');
    assert.deepEqual(writeShims(repo.root, true), [MOVE.from]);
    assert.deepEqual(writeShims(repo.root, false), [MOVE.from]);
    assert.equal(repo.read(MOVE.from), shimText(MOVE));
    assert.equal(readMoved(repo.root).moves[0].shim, true);
    assert.deepEqual(writeShims(repo.root, false), [], 'a second run writes nothing');
    const again = planStep(repo.root, [MOVE], parser);
    assert.match(again.refused[0].why.join(' '), /not committed/, 'the line at the old path is not a file to move again');
  } finally {
    await parser.close();
    rmSync(repo.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

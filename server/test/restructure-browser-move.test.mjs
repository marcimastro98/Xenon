// tools/restructure/browser-move.mjs: whole browser scripts go from the root of server/js/ to the folder of their
// feature, and their address changes with them. These tests pin what the tool rewrites, what keeps a script where
// it is and that a step can be put back, on small invented repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyStep, changedCopies, leftovers, listsNow, planStep, readMoved, undoStep } from '../../tools/restructure/browser-move-apply.mjs';
import { outsideProblems, targets, whyNot, withHomes } from '../../tools/restructure/browser-move-plan.mjs';
import { findBrowserSites, stops } from '../../tools/restructure/browser-move-refs.mjs';
import { edited } from '../../tools/restructure/move-apply.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const FEATURES = [
  { id: 'pulse', files: ['server/pulse/**', 'server/js/pulse*.js'] },
  { id: 'bot', files: ['server/js/brain/**', 'server/js/brain-*.js'] },
  { id: 'roots', files: ['server/js/state.js'] },
  { id: 'rest', files: ['**'] },
];
const LEFT = { homes: { bot: 'brain' }, features: { roots: 'a shared root' }, files: { 'server/js/brain-kept.js': 'named outside' }, lists: ['server/js/pulse-list.js'] };
const MOVE = { from: 'server/js/pulse-bar.js', to: 'server/js/pulse/pulse-bar.js', feature: 'pulse' };
const needsParser = { skip: !parserAvailable() && 'TypeScript is not installed here' };

const facts = (files, extra = {}) => ({
  tracked: new Set(Object.keys(files)), frozen: { paths: ['server/sw.js'], whole: ['server/*.html'] }, features: withHomes(FEATURES, [MOVE]),
  dirty: new Set(), ignored: () => false, read: (file) => files[file] ?? null, ...extra,
});

test('a loose script goes to the folder named like its feature, or to the one the list gives the feature', () => {
  const tracked = ['server/js/pulse-bar.js', 'server/js/pulse.js', 'server/js/brain-memory.js', 'server/js/brain-kept.js', 'server/js/brain/chat.js',
    'server/js/state.js', 'server/js/pulse/deep.js', 'server/pulse/index.js'];
  const { moves, stay } = targets({ tracked, features: FEATURES, left: LEFT });
  assert.deepEqual(moves.map((move) => `${move.from} -> ${move.to}`).sort(), ['server/js/brain-memory.js -> server/js/brain/brain-memory.js',
    'server/js/pulse-bar.js -> server/js/pulse/pulse-bar.js', 'server/js/pulse.js -> server/js/pulse/pulse.js']);
  assert.deepEqual(Object.fromEntries(stay.map((entry) => [entry.file, entry.why])), { 'server/js/brain-kept.js': 'named outside', 'server/js/state.js': 'a shared root' });
  assert.equal(targets({ tracked, features: FEATURES, left: LEFT, only: 'bot' }).moves.length, 1);
  assert.deepEqual(withHomes(FEATURES, moves)[0].files, ['server/pulse/**', 'server/js/pulse*.js', 'server/js/pulse/**'], 'the map gets the folder, named by the id it already has');
  assert.equal(withHomes(FEATURES, moves)[1], FEATURES[1], 'a folder the map already names is not added twice');
});

test('a move is refused for what the repo says about the script', () => {
  const files = { 'server/js/pulse-bar.js': 'const a = 1;\n', 'server/js/pulse.js': '', 'server/js/brain/chat.js': '', 'server/sw.js': '' };
  assert.equal(whyNot(MOVE, facts(files)), null);
  assert.equal(whyNot({ from: 'server/js/pulse.js', to: 'server/js/pulse/pulse.js' }, facts(files)), null, 'a script goes into the folder of its own name, under its own name');
  const split = { ...files, 'server/js/pulse.js': '', 'server/js/pulse/saved.js': '', 'server/js/pulse-bar/draw.js': '' };
  assert.equal(whyNot({ from: 'server/js/pulse.js', to: 'server/js/pulse/pulse.js' }, facts(split)), null, 'a split script goes in with its parts');
  assert.match(whyNot({ from: 'server/js/pulse-bar.js', to: 'server/js/pulse/pulse-bar.js' }, facts(split)), /parts split from it live in server\/js\/pulse-bar\/: it goes in with them/);
  assert.equal(targets({ tracked: Object.keys(split), features: FEATURES, left: LEFT }).moves.find((move) => move.from === 'server/js/pulse-bar.js').to, 'server/js/pulse-bar/pulse-bar.js', 'whatever the folder of its feature');
  assert.match(whyNot({ from: 'server/sw.js', to: 'server/js/pulse/sw.js' }, facts(files)), /not a loose script/);
  assert.match(whyNot(MOVE, facts(files, { frozen: { paths: [MOVE.from], whole: [] } })), /frozen/);
  assert.match(whyNot(MOVE, facts(files, { dirty: new Set([MOVE.from]) })), /not committed/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/js/pulse/bar.js' }, facts(files)), /keeps the name/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/js/pulse/deep/pulse-bar.js' }, facts(files)), /one folder down/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/js/vendor/pulse-bar.js' }, facts(files)), /not the folder of a feature/);
  assert.match(whyNot(MOVE, facts(files, { ignored: () => true })), /ignored by git/);
  assert.match(whyNot(MOVE, facts({ ...files, [MOVE.to]: '' })), /already there/);
  assert.match(whyNot({ from: MOVE.from, to: 'server/js/brain/pulse-bar.js' }, facts(files)), /another feature/);
  for (const code of ['const here = document.currentScript.src;', 'path.join(__dirname, "a")', 'import.meta.url', 'require(name)']) {
    assert.match(whyNot(MOVE, facts({ ...files, [MOVE.from]: code })) ?? '', /its place is part of what it does/, code);
  }
  assert.equal(whyNot(MOVE, facts({ ...files, [MOVE.from]: '// not code: currentScript\n' })), null);
});

const FILES = {
  'server/index.html': '<!-- drawn by js/pulse-bar.js -->\n<script src="js/state.js"></script>\n<script src="js/pulse-bar.js"></script>\n<script src="js/pulse-bar-extra.js" defer></script>\n',
  'server/js/pulse-bar.js': "const state = require('./state.js');\nconst part = require('./pulse/deep.js');\n",
  'server/js/pulse-list.js': "const LISTS = { lite: ['js/state.js', 'js/pulse-bar.js'] };\n",
  'server/js/state.js': '// read by js/pulse-bar.js\n',
  'server/js/pulse/deep.js': '',
  'server/pulse/index.js': "const bar = require('../js/pulse-bar.js');\nconst same = require('../js/pulse-bar');\n",
  'server/sw.js': '// never caches js/pulse-bar.js\n',
  'server/test/a.test.mjs': [
    "import { readFileSync } from 'node:fs';", "import { dirname, join } from 'node:path';", "import { fileURLToPath } from 'node:url';",
    "const HERE = dirname(fileURLToPath(import.meta.url));", "const JS = join(HERE, '..', 'js');",
    "const one = readFileSync(join(JS, 'pulse-bar.js'), 'utf8');",
    "const two = readFileSync(new URL('../js/pulse-bar.js', import.meta.url), 'utf8');",
    "const three = read('js/pulse-bar.js');",
    "const four = source('server/js/pulse-bar.js');",
    String.raw`assert.match(page, /<script src="js\/pulse-bar\.js"><\/script>/);`,
    "const five = read('pulse-bar.js');",
    "const six = widget('widgets/clock/js/pulse-bar.js');",
    '',
  ].join('\n'),
  'tools/list.json': '{ "server/js/pulse-bar.js TS2339": 2, "server/js/pulse-bar.json": 1 }\n',
  'tools/page/gallery.html': '<script src="js/pulse-bar.js"></script>\n',
  'packages/mcp/template/index.html': '<script src="js/pulse-bar.js"></script>\n',
  'CHANGELOG.md': 'Fixed server/js/pulse-bar.js\n',
};

test('a script read from outside this repo by its name moves one folder down while no second folder holds the name', () => {
  const files = { 'server/js/pulse-bar.js': 'const a = 1;\n', 'server/js/pulse/deep.js': '', 'server/js/brain/chat.js': '' };
  const outside = new Set(['pulse-bar.js']);
  assert.equal(whyNot(MOVE, facts(files, { outside })), null, 'one place before, one place after');
  assert.match(whyNot(MOVE, facts({ ...files, 'server/js/brain/pulse-bar.js': '' }, { outside })), /read from outside this repo by its name, and server\/js\/brain\/pulse-bar\.js has the same name/);
  assert.equal(whyNot(MOVE, facts({ ...files, 'server/js/brain/pulse-bar.js': '' })), null, 'a name nothing outside reads may live in two folders');
  assert.equal(whyNot(MOVE, facts({ ...files, 'server/js/brain/parts/pulse-bar.js': '', 'server/test/pulse-bar.js': '' }, { outside })), null, 'the outside reader does not look deeper, or outside server/js/');
  assert.deepEqual(outsideProblems(['server/js/pulse-bar.js', 'server/js/brain/chat.js', 'server/pulse-bar.js'], ['pulse-bar.js', 'chat.js']), []);
  assert.match(outsideProblems(['server/js/pulse/pulse-bar.js', 'server/js/brain/pulse-bar.js'], ['pulse-bar.js']).join('\n'), /pulse-bar\.js is read from outside this repo by its name and has 2 places: server\/js\/pulse\/pulse-bar\.js, server\/js\/brain\/pulse-bar\.js/);
  assert.match(outsideProblems(['server/js/pulse-bar.js', 'server/js/pulse/pulse-bar.js'], ['pulse-bar.js']).join('\n'), /has 2 places/, 'the root and a folder are two places too');
  assert.match(outsideProblems(['server/js/pulse/deep/pulse-bar.js'], ['pulse-bar.js']).join('\n'), /neither in server\/js\/ nor one folder down \(server\/js\/pulse\/deep\/pulse-bar\.js\)/);
  assert.match(outsideProblems([], ['pulse-bar.js']).join('\n'), /neither in server\/js\/ nor one folder down$/);
});

test('the names read from outside this repo each have one place in this repo today', () => {
  const left = JSON.parse(readFileSync(new URL('../../tools/restructure/browser-move-left.json', import.meta.url), 'utf8'));
  const tracked = execFileSync('git', ['ls-files', 'server/js'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(left.outside.length >= 27);
  assert.deepEqual(outsideProblems(tracked, left.outside), []);
});

const sitesOf = async (files, moves = [MOVE], lists = LEFT.lists) => {
  const parser = await openParser();
  try { return findBrowserSites({ files: Object.keys(files), read: (file) => files[file], parser, moves, lists: new Set(lists) }); } finally { await parser.close(); }
};

test('every place that names a moved script is found and given its new spelling', needsParser, async () => {
  const sites = await sitesOf(FILES);
  assert.deepEqual(sites.filter((site) => stops(site)), []);
  assert.equal(sites.some((site) => site.file.startsWith('packages/')), false, 'a package has a js/ folder of its own');
  const text = (file) => edited(FILES[file], sites.filter((site) => site.file === file && site.text !== undefined));
  assert.equal(text('server/index.html'), '<!-- drawn by js/pulse/pulse-bar.js -->\n<script src="js/state.js"></script>\n<script src="js/pulse/pulse-bar.js"></script>\n<script src="js/pulse-bar-extra.js" defer></script>\n',
    'the tags keep their order and the page its lines; a longer name is another script');
  assert.equal(text('server/js/pulse-list.js'), "const LISTS = { lite: ['js/state.js', 'js/pulse/pulse-bar.js'] };\n", 'the list of a page the engine writes follows like a tag');
  assert.equal(text('server/pulse/index.js'), "const bar = require('../js/pulse/pulse-bar.js');\nconst same = require('../js/pulse/pulse-bar');\n");
  assert.equal(text('server/js/state.js'), '// read by js/pulse/pulse-bar.js\n');
  const lines = text('server/test/a.test.mjs').split('\n');
  assert.equal(lines[5], "const one = readFileSync(join(JS, 'pulse/pulse-bar.js'), 'utf8');");
  assert.equal(lines[6], "const two = readFileSync(new URL('../js/pulse/pulse-bar.js', import.meta.url), 'utf8');");
  assert.equal(lines[7], "const three = read('js/pulse/pulse-bar.js');");
  assert.equal(lines[8], "const four = source('server/js/pulse/pulse-bar.js');");
  assert.equal(lines[9], String.raw`assert.match(page, /<script src="js\/pulse\/pulse-bar\.js"><\/script>/);`);
  assert.equal(lines[10], "const five = read('pulse-bar.js');", 'a bare name is told, never rewritten');
  assert.equal(lines[11], "const six = widget('widgets/clock/js/pulse-bar.js');", 'the js/ folder of a widget package is another folder');
  assert.equal(sites.filter((site) => site.kind === 'bare').length, 1);
  assert.equal(text('tools/list.json'), '{ "server/js/pulse/pulse-bar.js TS2339": 2, "server/js/pulse-bar.json": 1 }\n');
  assert.equal(text('tools/page/gallery.html'), '<script src="js/pulse/pulse-bar.js"></script>\n', 'the page of a tool serves server/ as the app does');
  assert.equal(sites.some((site) => site.file === 'CHANGELOG.md' || site.file === 'server/sw.js'), false, 'history and a note of the service worker stay as written');
});

test('an address asked for after the page started is spelled again and told; a script named where the tool cannot follow stays', needsParser, async () => {
  const why = async (file, text) => (await sitesOf({ [file]: text, 'server/js/pulse-bar.js': '' })).map((site) => stops(site)).filter(Boolean).join(' | ');
  for (const [text, made] of [["const s = document.createElement('script');\ns.src = 'js/pulse-bar.js';\n", "const s = document.createElement('script');\ns.src = 'js/pulse/pulse-bar.js';\n"],
    ['const url = `${SERVER}/js/pulse-bar.js?v=${version}`;\n', 'const url = `${SERVER}/js/pulse/pulse-bar.js?v=${version}`;\n']]) {
    const sites = await sitesOf({ 'server/js/loader.js': text, 'server/js/pulse-bar.js': '' });
    assert.deepEqual(sites.map((site) => [site.kind, stops(site)]), [['asks', null]], 'told as asked for late, and no reason to stay');
    assert.equal(edited(text, sites), made);
  }
  assert.match(await why('server/js/loader.js', "const LATER = ['pulse-bar.js'];\n"), /bare name/);
  assert.match(await why('server/js/loader.js', "const worker = new Worker('./pulse-bar.js');\n"), /puts its path together/);
  assert.match(await why('server/static.js', "const file = path.join(__dirname, 'js', 'pulse-bar.js');\n"), /bare name|puts its path together/);
  assert.match(await why('server/static.js', "log('server/js/pulse-bar.js is missing');\n"), /holds its path in a string/);
  assert.match(await why('server/sw.js', "const KEEP = ['js/pulse-bar.js'];\n"), /service worker/);
  assert.match(await why('server/index.html', '<script>load("js/pulse-bar.js")</script>\n'), /outside its script tags/);
  assert.match(await why('server/index.html', '<link rel="preload" href="js/pulse-bar.js">\n'), /outside its script tags/);
  assert.match(await why('apps/native/src/invented.rs', 'let script = "js/pulse-bar.js";\n'), /native code names it/);
  assert.equal(await why('apps/native/src/invented.rs', '// the bar is drawn by js/pulse-bar.js\n'), '', 'a comment of native code is a mention');
  assert.equal(await why('server/js/loader.js', "log('[pulse-bar.js] started');\nconst tile = 'pulse-bar';\n// see js/pulse-bar.js\n"), '', 'a word in a message is not an address');
  assert.equal(await why('server/test/b.test.mjs', "const list = ['pulse-bar.js'];\n"), '', 'a bare name in a test stops nothing: the tests say whether it was the file');
});

function tempRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-move-'));
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

test('a step moves, rewrites, maps and lists; undo puts every file back; nothing is left at the old address', needsParser, async () => {
  const files = { ...FILES };
  delete files['packages/mcp/template/index.html'];
  delete files['server/js/pulse/deep.js'];
  files['server/js/pulse-part.js'] = '';
  files[MOVE.from] = "const state = require('./state.js');\nconst part = require('./pulse-part.js');\n";
  files['server/js/pulse.js'] = '';
  files['server/js/pulse-late.js'] = '';
  files['server/js/loader.js'] = "const s = document.createElement('script');\ns.src = 'js/pulse-late.js';\n";
  files['server/pulse/index.js'] = "const bar = require('../js/pulse-bar.js');\nconst tile = require('../js/pulse');\n";
  const mapped = [FEATURES[0], FEATURES[3]].map((feature) => ({ id: feature.id, area: 'all', name: feature.id, what: 'Invented.', files: feature.files }));
  files['tools/map/features.json'] = `${JSON.stringify({ intro: ['An invented map.'], areas: [{ id: 'all', name: 'All', what: 'Everything.' }], features: mapped }, null, 2)}\n`;
  files['MAP.md'] = 'old\n';
  files['tools/restructure/browser-move-left.json'] = `${JSON.stringify(LEFT)}\n`;
  files['tools/map/frozen-paths.json'] = JSON.stringify({ paths: ['server/sw.js'], whole: ['server/*.html'] });
  const repo = tempRepo(files);
  const parser = await openParser();
  try {
    const asked = ['pulse-bar', 'pulse-part', 'pulse', 'pulse-late'].map((name) => ({ from: `server/js/${name}.js`, to: `server/js/pulse/${name}.js`, feature: 'pulse' }));
    const step = planStep(repo.root, asked, parser, LEFT.lists);
    assert.deepEqual(step.moves.map((move) => move.from), [MOVE.from, 'server/js/pulse-part.js', 'server/js/pulse-late.js']);
    const refused = Object.fromEntries(step.refused.map((entry) => [entry.move.from, entry.why.join(' ')]));
    assert.deepEqual(step.edits.get('server/js/loader.js').map((site) => [site.kind, site.line, site.text]), [['asks', 2, 'js/pulse/pulse-late.js']], 'the loader asks for the new address in the same step');
    assert.match(refused['server/js/pulse.js'], /index\.js:2 loads it without `\.js`/, 'beside an old pulse.js, require(\'../js/pulse\') would not find the folder');
    applyStep(repo.root, step);
    assert.equal(existsSync(path.join(repo.root, MOVE.from)), false, 'no line is left at the old address');
    assert.equal(repo.read(MOVE.to), "const state = require('../state.js');\nconst part = require('./pulse-part.js');\n", 'a neighbour that moves along keeps its spelling');
    assert.equal(repo.read('server/index.html').split('\n')[2], '<script src="js/pulse/pulse-bar.js"></script>');
    assert.equal(repo.read('server/index.html').split('\n').length, files['server/index.html'].split('\n').length);
    assert.equal(repo.read('server/pulse/index.js'), "const bar = require('../js/pulse/pulse-bar.js');\nconst tile = require('../js/pulse');\n");
    assert.deepEqual(readMoved(repo.root).moves, step.moves.map(({ from, to }) => ({ from, to })));
    const map = JSON.parse(repo.read('tools/map/features.json')).features[0].files;
    assert.deepEqual(map, ['server/pulse/**', 'server/js/pulse*.js', 'server/js/pulse/**'], 'pulse.js still answers the old pattern');
    assert.match(repo.read('MAP.md'), /server\/js\/pulse\/\*\*/);
    assert.match(repo.git('status', '--porcelain'), /^R {2}server\/js\/pulse-bar\.js -> server\/js\/pulse\/pulse-bar\.js$/m);

    assert.match(undoStep(repo.root), /put back/);
    assert.equal(repo.git('status', '--porcelain'), '');
    assert.equal(repo.read(MOVE.from), files[MOVE.from]);
    assert.equal(existsSync(path.join(repo.root, 'server/js/pulse')), false, 'the folder the step made is gone with it');

    applyStep(repo.root, planStep(repo.root, asked, parser, LEFT.lists));
    repo.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'move');
    assert.match(undoStep(repo.root), /git revert/, 'after the commit the step is git\'s to undo');
    assert.deepEqual(leftovers(repo.root, parser, LEFT.lists), []);
    assert.deepEqual([...listsNow(repo.root, [MOVE.from, 'server/js/state.js'])], [MOVE.to, 'server/js/state.js'], 'a list file that moved is read at its new place');
    writeFileSync(path.join(repo.root, 'server/index.html'), '<script src="js/pulse-bar.js"></script>\n');
    assert.match(leftovers(repo.root, parser, LEFT.lists).join('\n'), /server\/index\.html:1 still says js\/pulse-bar\.js/);
  } finally {
    await parser.close();
    rmSync(repo.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('a script kept byte for byte moves with the same bytes, or stays; a step never writes into one', needsParser, async () => {
  const copies = ['pulse-read.js', 'pulse-write.js', 'pulse-alone.js', 'pulse-scene.js'];
  const files = {
    'server/index.html': '<script src="js/pulse-read.js"></script>\n<script src="js/pulse-write.js"></script>\n',
    'server/js/state.js': '',
    'server/js/pulse-bar.js': 'const a = 1;\n',
    'server/js/pulse-tiles.js': 'const b = 2;\n',
    'server/js/pulse-read.js': '// the bar is drawn by js/pulse-bar.js\nconst c = 3;\n',
    'server/js/pulse-write.js': "// reads with js/pulse-read.js\nconst read = require('./pulse-read.js');\n",
    'server/js/pulse-alone.js': "const state = require('./state.js');\n",
    'server/js/pulse-scene.js': "// see js/pulse-bar.js\nconst tiles = require('./pulse-tiles.js');\n",
    'tools/map/features.json': `${JSON.stringify({ intro: ['An invented map.'], areas: [{ id: 'all', name: 'All', what: 'Everything.' }],
      features: [FEATURES[0], FEATURES[3]].map((feature) => ({ id: feature.id, area: 'all', name: feature.id, what: 'Invented.', files: feature.files })) }, null, 2)}\n`,
    'MAP.md': 'old\n',
    'tools/map/frozen-paths.json': JSON.stringify({ paths: [], whole: ['server/*.html'] }),
    'tools/restructure/browser-move-left.json': `${JSON.stringify({ copies })}\n`,
  };
  const repo = tempRepo(files);
  const parser = await openParser();
  try {
    const base = repo.git('rev-parse', 'HEAD').trim();
    const asked = ['pulse-bar', 'pulse-tiles', 'pulse-read', 'pulse-write', 'pulse-alone'].map((name) => ({ from: `server/js/${name}.js`, to: `server/js/pulse/${name}.js`, feature: 'pulse' }));
    const step = planStep(repo.root, asked, parser, [], [], copies);
    assert.deepEqual(step.moves.map((move) => path.posix.basename(move.from)), ['pulse-bar.js', 'pulse-read.js', 'pulse-write.js']);
    const refused = Object.fromEntries(step.refused.map((entry) => [path.posix.basename(entry.move.from), entry.why.join(' ')]));
    assert.match(refused['pulse-alone.js'], /kept byte for byte \(Xenon Maker holds a copy\), and a path it loads would be spelled again/, 'what it loads stays in the root');
    assert.match(refused['pulse-tiles.js'], /server\/js\/pulse-scene\.js:2 names it, and that script is kept byte for byte/, 'the script that loads it stays, and may not be written');
    assert.deepEqual([...step.edits.keys()], ['server/index.html'], 'no edit lands in a kept script');
    applyStep(repo.root, step);
    repo.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'move');
    for (const name of ['pulse-read.js', 'pulse-write.js']) assert.equal(repo.read(`server/js/pulse/${name}`), files[`server/js/${name}`], `${name} is the same bytes at its new place`);
    assert.equal(repo.read('server/js/pulse-scene.js'), files['server/js/pulse-scene.js'], 'a note in a kept script keeps the address of its day');
    assert.deepEqual(leftovers(repo.root, parser, [], copies), [], 'and the check does not ask for it');
    assert.match(leftovers(repo.root, parser, []).join('\n'), /pulse-scene\.js:1 still says js\/pulse-bar\.js/, 'in any other script the same note is a leftover');
    const moves = readMoved(repo.root).moves;
    assert.deepEqual(changedCopies(repo.root, base, moves, copies), []);
    writeFileSync(path.join(repo.root, 'server/js/pulse/pulse-read.js'), '// the bar is drawn by js/pulse/pulse-bar.js\nconst c = 3;\n');
    repo.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-a', '-m', 'note');
    assert.match(changedCopies(repo.root, base, moves, copies).join('\n'), /^server\/js\/pulse\/pulse-read\.js is not byte for byte what server\/js\/pulse-read\.js was/);
  } finally {
    await parser.close();
    rmSync(repo.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the list of extractions keeps both spellings of a require true: the one its module writes now and the one server.js wrote', needsParser, async () => {
  const spelled = (now, before) => `${JSON.stringify({ sources: { 'server/server.js': [{ file: 'server/pulse/tools.js', about: 'Invented.', names: ['tools'], spelled: { [now]: before } }] } })}\n`;
  const files = {
    'server/index.html': '<script src="js/pulse-bar.js"></script>\n',
    'server/js/pulse-bar.js': 'const a = 1;\n',
    'server/pulse/tools.js': "const ids = () => require('../js/pulse-bar.js').ids();\n",
    'server/server.js': "const bar = require('./js/pulse-bar.js');\n",
    'tools/restructure/extracted.json': spelled('../js/pulse-bar.js', './js/pulse-bar.js'),
    'tools/map/features.json': `${JSON.stringify({ intro: ['An invented map.'], areas: [{ id: 'all', name: 'All', what: 'Everything.' }],
      features: [FEATURES[0], FEATURES[3]].map((feature) => ({ id: feature.id, area: 'all', name: feature.id, what: 'Invented.', files: feature.files })) }, null, 2)}\n`,
    'MAP.md': 'old\n',
    'tools/map/frozen-paths.json': JSON.stringify({ paths: [], whole: ['server/*.html'] }),
  };
  const repo = tempRepo(files);
  const parser = await openParser();
  try {
    applyStep(repo.root, planStep(repo.root, [MOVE], parser, []));
    assert.equal(repo.read('server/pulse/tools.js'), "const ids = () => require('../js/pulse/pulse-bar.js').ids();\n");
    assert.equal(repo.read('tools/restructure/extracted.json'), spelled('../js/pulse/pulse-bar.js', './js/pulse/pulse-bar.js'), 'a reader that turns the module back into the text of server.js finds the path the module writes');
  } finally {
    await parser.close();
    rmSync(repo.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

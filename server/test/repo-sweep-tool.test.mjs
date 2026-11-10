// tools/repo-sweep: the finders behind `node tools/repo-sweep.mjs`, on small
// made-up inputs. Values that look personal are built at run time, so this file
// never holds one: the personal sweep reads it too.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { builtNamePatterns } from '../../tools/repo-sweep/built-names.mjs';
import { findDeadCode } from '../../tools/repo-sweep/functions.mjs';
import { classifyKeys, definedKeys, loadTables, removeKeys, sha256, writeIfUnchanged } from '../../tools/repo-sweep/i18n.mjs';
import { classifyMedia, namesInRevisions, releaseTags, SHIPPED_PATHS } from '../../tools/repo-sweep/media.mjs';
import { imageMetadata, isThisUser, machineName, mask, scanText } from '../../tools/repo-sweep/personal.mjs';
import { sweepI18n, sweepMedia } from '../../tools/repo-sweep/run.mjs';

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const NEEDS_GIT = { skip: !HAS_GIT && 'needs git' };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sweep-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A throwaway repo that reads no global or system git config: the developer's
// signing, hooks and line-ending settings stay out of it.
function tempRepo(t) {
  const dir = tempDir(t);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, '.no-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  return {
    dir,
    git,
    write(rel, content) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    },
    commit(message) {
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
  };
}

// --- names built at runtime -------------------------------------------------

const MEDIA_NAMES = { nameChars: 'A-Za-z0-9_.@-', minStatic: 2, ignoreExt: true };
const KEY_NAMES = { nameChars: 'A-Za-z0-9_.', minStatic: 3 };
const patternsIn = (code, opts) => builtNamePatterns(new Map([['app.js', code]]), opts);
const builds = (patterns, name) => patterns.some((p) => p.re.test(name));

test('built names: a template literal matches the names it can build', () => {
  const p = patternsIn('img.src = `edge-${look}.webp`;', MEDIA_NAMES);
  assert.ok(builds(p, 'edge-dusk.webp'));
  assert.ok(!builds(p, 'amb-dusk.webp'));
});

test('built names: a literal ending with - is a prefix, inside a ternary too', () => {
  const p = patternsIn("const src = (amb ? 'amb-' : 'edge-') + id;", MEDIA_NAMES);
  assert.ok(builds(p, 'amb-forest.webp'));
  assert.ok(builds(p, 'edge-forest.webp'));
});

test('built names: a literal added after a name is a suffix', () => {
  const p = patternsIn("label = t(id + '_title');", KEY_NAMES);
  assert.ok(builds(p, 'deck_title'));
  assert.ok(!builds(p, 'deck_name'));
});

test('built names: holes joined by punctuation, or by a bare extension, fix nothing', () => {
  assert.deepEqual(patternsIn('const day = `${y}-${m}-${d}`; const f = `${name}.png`;', MEDIA_NAMES), []);
});

// --- media ------------------------------------------------------------------

test('media: used, maybe built, named only by a tool, or unused', () => {
  const media = ['docs/images/shown.png', 'docs/images/edge-dusk.webp', 'docs/images/made.png', 'docs/images/orphan.png'];
  const texts = new Map([
    ['docs/index.html', '<img src="images/shown.png">'],
    ['docs/home.js', 'img.src = `images/edge-${look}.webp`;'],
    ['tools/shots/build.mjs', "save('made.png');"],
  ]);
  const r = classifyMedia({ media, texts });
  assert.deepEqual(r.unused.map((x) => x.file), ['docs/images/orphan.png']);
  assert.deepEqual(r.toolsOnly.map((x) => x.file), ['docs/images/made.png']);
  assert.deepEqual(r.maybe.map((x) => x.file), ['docs/images/edge-dusk.webp']);
});

test('media: a release tag or another repo can keep a picture, an SVG naming itself cannot', () => {
  const r = classifyMedia({
    media: ['docs/images/old.png', 'docs/images/hub.png', 'docs/images/logo.svg'],
    texts: new Map([['docs/images/logo.svg', '<svg><title>logo.svg</title></svg>']]),
    revNames: new Set(['old.png']),
    extraTexts: new Map([['../hub:mail.html', '<img src="hub.png">']]),
  });
  assert.deepEqual(r.unused.map((x) => x.file), ['docs/images/logo.svg']);
});

test('media: release tags count only where an installed app runs from', NEEDS_GIT, (t) => {
  const repo = tempRepo(t);
  repo.write('server/js/app.js', "const shot = 'old-shot.png';\n");
  repo.write('docs/index.html', '<img src="images/site-only.png">\n');
  repo.commit('one');
  repo.git('tag', 'v1.0.0');
  repo.write('server/js/app.js', 'const shot = null;\n');
  repo.write('docs/index.html', '<p>No pictures any more</p>\n');
  for (const name of ['old-shot.png', 'site-only.png']) repo.write(`docs/images/${name}`, 'not really a png');
  repo.commit('two');
  repo.git('tag', 'nightly');

  const names = ['old-shot.png', 'site-only.png'];
  assert.deepEqual(releaseTags(repo.dir), ['v1.0.0']);
  assert.deepEqual([...namesInRevisions(repo.dir, ['v1.0.0'], names)].sort(), names);
  assert.deepEqual([...namesInRevisions(repo.dir, ['v1.0.0'], names, SHIPPED_PATHS)], ['old-shot.png']);
  // The old app still loads old-shot.png from main; the old site page is gone.
  assert.deepEqual(sweepMedia(repo.dir).unused.map((x) => x.file), ['docs/images/site-only.png']);
  assert.deepEqual(sweepMedia(repo.dir, { tags: false }).unused.map((x) => x.file).sort(), ['docs/images/old-shot.png', 'docs/images/site-only.png']);
});

// --- dead functions -----------------------------------------------------------

test('functions: never called, called only by tests, exported but read by nobody else', () => {
  const r = findDeadCode(new Map([
    ['server/js/a.js', 'function used() {}\nfunction lonely() {}\nfunction testedOnly() {}\nfunction fromPage() {}\n'],
    ['server/js/b.js', "used();\nrequire('../lib').outer();\n"],
    ['server/index.html', '<button onclick="fromPage()">Go</button>\n'],
    ['server/test/a.test.mjs', 'testedOnly();\n'],
    ['server/lib.js', 'function inner() { return 1; }\nfunction outer() { return inner(); }\nmodule.exports = { inner, outer };\n'],
  ]));
  assert.deepEqual(r.dead.map((d) => d.name), ['lonely']);
  assert.deepEqual(r.onlyTests.map((d) => d.name), ['testedOnly']);
  assert.deepEqual(r.unusedExports.map((d) => d.name), ['inner']);
});

// --- app strings ------------------------------------------------------------

// The shape of server/js/i18n.js: two main blocks, a later language spreading
// English, an override block, then the functions.
const TABLES = [
  'const i18n = {',
  '  it: {',
  "    used_key: 'Usata',",
  "    old_key: 'Vecchia',",
  "    skip_me: 'Salta',",
  "    deck_err_busy: 'Occupato',",
  "    test_only_key: 'Solo nei test',",
  "    weekdays: ['Lun', 'Mar'],",
  '  },',
  '  en: {',
  "    used_key: 'Used',",
  "    old_key: 'Old',",
  "    skip_me: 'Skip',",
  "    deck_err_busy: 'Busy',",
  "    test_only_key: 'Only in tests',",
  "    weekdays: ['Mon', 'Tue'],",
  '  },',
  '};',
  'Object.assign(i18n, {',
  '  ko: {',
  '    ...i18n.en,',
  "    used_key: '사용',",
  '  },',
  '});',
  'Object.assign(i18n.it, {',
  "    old_key: 'Vecchia, di nuovo',",
  '});',
];
const CODE = ['function t(key) {', '  return key;', '}', ''];
const i18nSource = () => [...TABLES, ...CODE].join('\n');
const APP_JS = "t('used_key'); t('weekdays'); t(`deck_err_${code}`);\n";
const plain = (value) => JSON.parse(JSON.stringify(value)); // out of the vm realm

test('i18n: unused, used only by tests, or maybe built at runtime', () => {
  const r = classifyKeys({
    keys: definedKeys(loadTables(i18nSource())),
    texts: new Map([
      ['server/js/i18n.js', i18nSource()],
      ['server/js/app.js', APP_JS],
      ['server/test/app.test.mjs', "t('test_only_key');\n"],
    ]),
  });
  assert.deepEqual(r.unused.map((u) => u.key), ['old_key', 'skip_me']);
  assert.deepEqual(r.onlyTests.map((u) => u.key), ['test_only_key']);
  assert.deepEqual(r.maybe.map((u) => u.key), ['deck_err_busy']);
});

test('i18n: a key holding a dot counts, and so does one reached as a property', () => {
  const r = classifyKeys({
    keys: new Set(['remote.panel_status', 'disk_title']),
    texts: new Map([['server/js/app.js', "tr('remote.panel_status'); L.disk_title;"]]),
  });
  assert.deepEqual(r.unused, []);
});

test('i18n: a removed key leaves every language, nothing else moves', () => {
  const source = i18nSource();
  const { source: next } = removeKeys(source, ['old_key']);
  const before = plain(loadTables(source));
  const after = plain(loadTables(next));
  for (const lang of Object.keys(before)) delete before[lang].old_key;
  // weekdays is an array: two vm runs never share one, so this also proves the
  // comparison inside removeKeys looks at values, not identity.
  assert.deepEqual(after, before);
  assert.ok(next.endsWith(CODE.join('\n')));
});

test('i18n: a removal that would touch the code after the tables is refused', () => {
  const source = i18nSource().replace('  return key;', "  return key || { old_key: 'kept in code' };");
  assert.throws(() => removeKeys(source, ['old_key']), /code after the tables changed/);
});

test('i18n: the write is refused when the file changed after it was read', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'i18n.js');
  fs.writeFileSync(file, 'one');
  const readHash = sha256(fs.readFileSync(file));
  fs.writeFileSync(file, 'two'); // another session got there first
  assert.throws(() => writeIfUnchanged(file, readHash, 'three'), /changed while the sweep ran/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  writeIfUnchanged(file, sha256(fs.readFileSync(file)), 'three');
  assert.equal(fs.readFileSync(file, 'utf8'), 'three');
  assert.deepEqual(fs.readdirSync(dir), ['i18n.js']);
});

test('i18n --remove: only committed keys go, and never a skipped prefix', NEEDS_GIT, (t) => {
  const repo = tempRepo(t);
  repo.write('server/js/i18n.js', i18nSource());
  repo.write('server/js/app.js', APP_JS);
  repo.write('server/test/app.test.mjs', "t('test_only_key');\n");
  repo.commit('tables');
  // Another session adds a key it has not wired up yet.
  repo.write('server/js/i18n.js', i18nSource().replace("    used_key: 'Used',", "    used_key: 'Used',\n    new_key: 'New',"));

  const r = sweepI18n(repo.dir, { remove: true, skip: ['skip_'] });
  assert.deepEqual(r.removed, ['old_key']);
  assert.deepEqual(r.keptNew, ['new_key']);
  assert.deepEqual(r.keptSkipped, ['skip_me']);
  const tables = loadTables(fs.readFileSync(path.join(repo.dir, 'server/js/i18n.js'), 'utf8'));
  for (const lang of ['it', 'en', 'ko']) assert.ok(!Object.hasOwn(tables[lang], 'old_key'), lang);
  assert.deepEqual(Object.keys(tables.en).sort(), ['deck_err_busy', 'new_key', 'skip_me', 'test_only_key', 'used_key', 'weekdays']);
});

// --- personal data ----------------------------------------------------------

// +999 is a country code nobody holds, and the mailbox's top-level domain does
// not exist: found by the sweep, yet nobody's.
const PHONE = ['+999', '4417', '2093'].join(' ');
const MAILBOX = ['nobody', 'mailbox.notatld'].join('@');
const DEVICE_MAC = ['A4', '00', '00', '00', '00', '01'].join(':');

test('personal: real-looking numbers, addresses and MACs are found, the invented ones pass', () => {
  const text = [
    `call('${PHONE}');`,
    "call('+39 333 123 4567');",
    `mail('${MAILBOX}');`,
    "mail('someone@example.com'); mail('noreply@xenon-app.com');",
    `pair('${DEVICE_MAC}');`,
    "pair('00-00-5E-00-53-01'); pair('02:00:00:00:00:01');",
  ].join('\n');
  assert.deepEqual(scanText('server/x.js', text).map((f) => `${f.line} ${f.kind}`), ['1 phone', '3 email', '5 mac']);
});

test("personal: this PC's home folder and name are found, other accounts are not", () => {
  const text = 'C:\\Users\\giulia\\Desktop\nC:\\Users\\someone\\Desktop\n/home/runner/work\nbuilt on DESKTOP-7Q2ZK4M\n';
  const found = scanText('notes.md', text, { user: 'giulia', machine: machineName('DESKTOP-7Q2ZK4M') });
  assert.deepEqual(found.map((f) => `${f.line} ${f.kind}`), ['1 home-folder', '4 machine-name']);
  assert.ok(isThisUser('GIOVAN~1', 'giovanna.bianchi'), 'the 8.3 short form');
  assert.ok(!isThisUser('runner', 'runner'), 'a CI account is nobody');
  assert.equal(machineName('laptop'), null);
});

test('personal: a secret is found unless it says it is a stand-in', () => {
  const token = ['gh', 'p_', 'Q7a9'.repeat(9)].join('');
  assert.deepEqual(scanText('a.js', `const t = '${token}';`).map((f) => f.kind), ['secret']);
  assert.deepEqual(scanText('a.js', `const t = 'ghp_${'x'.repeat(36)}';`), []);
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

test('personal: camera metadata is found by walking the chunks, not by searching pixels', () => {
  const png = (...chunks) => Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13)), ...chunks, pngChunk('IEND')]);
  assert.equal(imageMetadata('a.png', png()), null);
  assert.equal(imageMetadata('a.png', png(pngChunk('eXIf', Buffer.from('MM')))), 'EXIF/XMP');
  assert.equal(imageMetadata('a.png', png(pngChunk('IDAT', Buffer.from('eXIf Exif')))), null);
  const exif = Buffer.from('Exif\0\0', 'latin1');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, exif.length + 2]), exif, Buffer.from([0xff, 0xd9])]);
  assert.equal(imageMetadata('a.jpg', jpeg), 'EXIF/XMP');
});

test('personal: a finding is printed masked', () => {
  const shown = mask('+39 333 123 4567');
  assert.ok(shown.startsWith('+3') && shown.endsWith('67'));
  assert.doesNotMatch(shown, /333|123/);
});

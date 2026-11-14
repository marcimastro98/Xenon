// The two reviewed lists after a move (tools/restructure relist): a file a person read keeps
// its entry when code was only moved out of it and the move is proven, and loses it for
// anything else, above all a change to the function the entry is about.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extract } from '../../tools/restructure/extract.mjs';
import { PROTECTED } from '../../tools/restructure/ledger.mjs';
import { registrationsFor, textHash } from '../../tools/restructure/load-registrations.mjs';
import { afterLoadFor } from '../../tools/restructure/after-load.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { pinWarnings, pinsOf, planRelist, relist, relistText, renderRelist } from '../../tools/restructure/relist.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const REGISTRATIONS = 'tools/restructure/load-registrations.json';
const AFTER_LOAD = 'tools/restructure/after-load.json';
const KEEPER = 'server/remote-control/keeper.js';
const PART = 'server/remote-control/keeper-clean.js';
const OTHER = 'server/remote-control/other.js';
// The file that was read: createKeeper only keeps the function it is handed, which is what an entry says of it.
const READ = ["'use strict';", '', '// Tidies a name.', 'function clean(name) {', '  return String(name).trim();', '}', '',
  'function createKeeper(onDone) {', '  return { done: (name) => onDone(clean(name)) };', '}', '',
  'module.exports = { createKeeper, clean };', ''].join('\n');
const text = (json) => `${JSON.stringify(json, null, 2)}\n`;
const listsFor = (hash) => ({
  [REGISTRATIONS]: text({ note: 'n', files: { 'server/demo.js': [
    { statement: 'const keeper = createKeeper(() => run());', callees: { [KEEPER]: hash, [OTHER]: textHash('other') }, reason: 'It keeps the function.' }] } }),
  [AFTER_LOAD]: text({ note: 'n', files: { 'server/demo.js': [
    { name: 'run', statements: { 'const keeper = createKeeper(() => run());': 'abc' }, read: { [KEEPER]: hash }, reason: 'Called from an answer.' }] } }),
});

// A repo held in memory: the files on disk, the files of the base revision, the list of moves.
function memory({ disk, base, sources = {} }) {
  const read = (file) => { if (!(file in disk)) throw new Error(`no ${file}`); return disk[file]; };
  return { read, show: (file) => base[file] ?? null, ledger: { sources } };
}
const moved = { [KEEPER]: 'the keeper without clean\n', [PART]: 'clean\n', [OTHER]: 'other' };
const provenMove = () => memory({ disk: { ...listsFor(textHash(READ)), ...moved }, base: { [KEEPER]: READ, [OTHER]: 'other' },
  sources: { [KEEPER]: [{ file: PART, about: 'x', names: ['clean'] }] } });

test('every pinned file of both lists is found, and a plan that touches one is told so before it starts', () => {
  const { read } = provenMove();
  assert.deepEqual(pinsOf(read).map((pin) => [pin.list, pin.file, pin.entry, pin.pinned]), [
    [REGISTRATIONS, 'server/demo.js', 'const keeper = createKeeper(() => run());', KEEPER],
    [REGISTRATIONS, 'server/demo.js', 'const keeper = createKeeper(() => run());', OTHER],
    [AFTER_LOAD, 'server/demo.js', 'run', KEEPER]]);
  const said = pinWarnings([KEEPER, 'server/free.js', KEEPER], read);
  assert.equal(said.length, 1, 'one line per pinned file, none for a file no list knows');
  assert.match(said[0], /^Warning: server\/remote-control\/keeper\.js is a file that was read for .*load-registrations\.json \("const keeper = createKeeper.*after-load\.json \("run" of server\/demo\.js\)/);
  assert.match(said[0], /cli\.mjs verify, then node tools\/restructure\/cli\.mjs relist\.$/);
  assert.deepEqual(pinWarnings(['server/free.js'], read), []);
  assert.deepEqual(pinsOf(() => { throw new Error('no list here'); }), [], 'a repo without the lists pins nothing');
});

test('after a proven move the file gets its new fingerprint and the new module is pinned next to it, in both lists', () => {
  const repo = provenMove();
  const plan = planRelist({ ...repo, problems: [], base: 'BASE' });
  assert.deepEqual(plan, { refusals: [], changes: [{ pinned: KEEPER, was: textHash(READ), now: textHash(moved[KEEPER]), lists: [REGISTRATIONS, AFTER_LOAD],
    modules: [{ file: PART, hash: textHash('clean\n') }] }] });
  const callees = JSON.parse(relistText(repo.read(REGISTRATIONS), 'callees', plan.changes)).files['server/demo.js'][0].callees;
  assert.deepEqual(Object.entries(callees), [[KEEPER, textHash(moved[KEEPER])], [PART, textHash('clean\n')], [OTHER, textHash('other')]],
    'the module follows the file it came out of, and a file that did not change keeps its line');
  const reads = JSON.parse(relistText(repo.read(AFTER_LOAD), 'read', plan.changes)).files['server/demo.js'][0];
  assert.deepEqual(reads.read, { [KEEPER]: textHash(moved[KEEPER]), [PART]: textHash('clean\n') });
  assert.deepEqual(reads.statements, { 'const keeper = createKeeper(() => run());': 'abc' }, 'the statements of the entry are never touched');
  assert.equal(relistText(repo.read(REGISTRATIONS), 'callees', []), repo.read(REGISTRATIONS), 'no change, the same text');
  assert.throws(() => relistText(repo.read(REGISTRATIONS).replace(/\n {2}/g, '\n    '), 'callees', plan.changes), /not written the way this tool writes it/);
});

test('nothing is recorded again when the move is not proven, or the file changed by hand, or it was rewritten', () => {
  const refusals = (repo, problems = []) => planRelist({ ...repo, problems, base: 'BASE' });
  // The replay found a difference: for instance the function the entry is about was edited in the same step.
  const unproven = refusals(provenMove(), [`${KEEPER} differs from BASE by more than the recorded moves: commit other edits apart from a move`]);
  assert.deepEqual(unproven.changes, []);
  assert.match(unproven.refusals.join('\n'), /the moves since BASE are not proven, so no fingerprint is recorded again[\s\S]*differs from BASE by more than the recorded moves/);
  // The entry had already stopped counting before the move: someone changed the file and nobody read it again.
  const lists = listsFor(textHash('an older text'));
  const before = refusals(memory({ disk: { ...lists, ...moved }, base: { [KEEPER]: READ, [OTHER]: 'other' }, sources: { [KEEPER]: [{ file: PART, names: ['clean'] }] } }));
  assert.deepEqual(before.changes, []);
  assert.match(before.refusals[0], /keeper\.js: at BASE it was already not the text that was read: it changed by hand before any move\. Read the file again/);
  // The file differs and the list of moves knows no move out of it.
  const hand = refusals(memory({ disk: { ...listsFor(textHash(READ)), ...moved }, base: { [KEEPER]: READ, [PART]: 'clean\n', [OTHER]: 'other' },
    sources: { [KEEPER]: [{ file: PART, names: ['clean'] }] } }));
  assert.match(hand.refusals[0], /keeper\.js: it differs from BASE and no move out of it is recorded: it changed by hand/);
  // A rewrite changes the words that were read, however well it is proven.
  for (const kind of ['state', 'lift', 'paths', 'inner']) {
    const rewritten = refusals(memory({ disk: { ...listsFor(textHash(READ)), ...moved }, base: { [KEEPER]: READ, [OTHER]: 'other' },
      sources: { [KEEPER]: [{ file: PART, names: ['clean'], [kind]: kind === 'state' ? { object: 'kept', props: {} } : true }] } }));
    assert.match(rewritten.refusals[0], /keeper-clean\.js came out of it by a rewrite, which changes the words that were read/, kind);
    assert.deepEqual(rewritten.changes, []);
  }
  const gone = refusals(memory({ disk: { ...listsFor(textHash(READ)), [OTHER]: 'other' }, base: { [KEEPER]: READ, [OTHER]: 'other' } }));
  assert.match(gone.refusals[0], /keeper\.js: it is pinned and cannot be read/);
  assert.deepEqual(refusals(memory({ disk: { ...listsFor(textHash(READ)), [KEEPER]: READ, [OTHER]: 'other' }, base: {} }), ['a problem elsewhere']),
    { changes: [], refusals: [] }, 'nothing stale, nothing to say');
});

test('the command says what it recorded, and exits 1 on a refusal', () => {
  const change = { pinned: KEEPER, was: 'a'.repeat(64), now: 'b'.repeat(64), lists: [REGISTRATIONS], modules: [{ file: PART, hash: 'c'.repeat(64) }] };
  assert.deepEqual(renderRelist({ changes: [], refusals: [], written: [] }, { base: 'HEAD' }), { lines: ['Nothing to record: every pinned file is the text that was read.'], code: 0 });
  const done = renderRelist({ changes: [change], refusals: [], written: [REGISTRATIONS] }, { base: 'HEAD' });
  assert.equal(done.code, 0);
  assert.match(done.lines.join('\n'), /^Recorded again in tools\/restructure\/load-registrations\.json, after the moves redone from HEAD gave the files on disk byte for byte:\n {2}server\/remote-control\/keeper\.js: aaaaaaaaaaaa -> bbbbbbbbbbbb, and pinned with it server\/remote-control\/keeper-clean\.js$/);
  assert.match(renderRelist({ changes: [change], refusals: [], written: [REGISTRATIONS] }, { base: 'HEAD', dryRun: true }).lines[0], /^Would record again/);
  assert.deepEqual(renderRelist({ changes: [], refusals: ['x: y'], written: [] }, { base: 'HEAD' }), { lines: ['Refused:', '  x: y'], code: 1 });
});

function demoRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-relist-'));
  for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, 'tools', 'map', 'frozen-paths.json'), '{}\n');
  writeFileSync(path.join(root, PROTECTED), '{ "files": {} }\n');
  writeFileSync(path.join(root, KEEPER), READ);
  writeFileSync(path.join(root, OTHER), 'other');
  for (const [list, body] of Object.entries(listsFor(textHash(READ)))) writeFileSync(path.join(root, list), body);
  return root;
}

test('on disk: a real move out of a pinned file is recorded again, and a change to the function the entry is about is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const root = demoRepo();
  try {
    const read = (file) => readFileSync(path.join(root, file), 'utf8');
    const atBase = { [KEEPER]: READ, [OTHER]: 'other', ...listsFor(textHash(READ)) };
    const show = (_root, _rev, file) => atBase[file] ?? null;
    const counts = () => [registrationsFor('server/demo.js', { read })[0].problem, afterLoadFor('server/demo.js', { read })[0].problem];
    assert.deepEqual(counts(), ['', ''], 'before the move both entries count');
    assert.deepEqual(relist({ root, parser, base: 'BASE', show }), { changes: [], refusals: [], written: [] });

    extract({ root, parser, source: KEEPER, target: PART, about: 'Tidies a name.', names: ['clean'] });
    assert.match(counts().join('\n'), /keeper\.js changed since it was read[\s\S]*keeper\.js changed since it was read/, 'the move alone drops both entries');

    // The function the entry is about is edited in the same step: the replay sees it, and nothing is recorded.
    const afterMove = read(KEEPER);
    writeFileSync(path.join(root, KEEPER), afterMove.replace('onDone(clean(name))', 'onDone(clean(name)) || onDone()'));
    const lists = [read(REGISTRATIONS), read(AFTER_LOAD)];
    const refused = relist({ root, parser, base: 'BASE', show });
    assert.deepEqual([refused.changes, refused.written], [[], []]);
    assert.match(refused.refusals.join('\n'), /not proven[\s\S]*keeper\.js differs from BASE by more than the recorded moves/);
    assert.deepEqual([read(REGISTRATIONS), read(AFTER_LOAD)], lists, 'a refusal writes nothing');
    writeFileSync(path.join(root, KEEPER), afterMove);

    const dry = relist({ root, parser, base: 'BASE', show, dryRun: true });
    assert.deepEqual([dry.written, read(REGISTRATIONS), read(AFTER_LOAD)], [[REGISTRATIONS, AFTER_LOAD], ...lists], 'a dry run names the lists and writes nothing');
    const done = relist({ root, parser, base: 'BASE', show });
    assert.deepEqual(done.written, [REGISTRATIONS, AFTER_LOAD]);
    assert.deepEqual(done.changes.map((change) => [change.pinned, change.modules.map((module) => module.file)]), [[KEEPER, [PART]]]);
    assert.deepEqual(counts(), ['', ''], 'both entries count again');
    assert.deepEqual(JSON.parse(read(REGISTRATIONS)).files['server/demo.js'][0].callees,
      { [KEEPER]: textHash(read(KEEPER)), [PART]: textHash(read(PART)), [OTHER]: textHash('other') });
    assert.deepEqual(relist({ root, parser, base: 'BASE', show }), { changes: [], refusals: [], written: [] }, 'run again, it finds nothing to do');

    // The new module is pinned too: a later hand edit of it drops the entry, and is not recorded again.
    writeFileSync(path.join(root, PART), read(PART).replace('.trim()', '.trim().toLowerCase()'));
    assert.match(counts()[0], /keeper-clean\.js changed since it was read/);
    assert.match(relist({ root, parser, base: 'BASE', show }).refusals.join('\n'), /not proven|changed by hand/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// tools/dev-install: the rules that decide where the dev code may go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installRootFromTaskXml, refuseRoot, stagedJson, readOutcome, parseArgs } from '../../tools/dev-install/lib.mjs';
import { parseSnapshotArgs, pickPaths } from '../../tools/dev-install/snapshot-lib.mjs';

const xml = (args, cmd = 'C:\\Windows\\System32\\wscript.exe') =>
  `<Task><Actions Context="Author"><Exec><Command>${cmd}</Command><Arguments>${args}</Arguments></Exec></Actions></Task>`;

test('the install root comes from the launcher the engine task starts', () => {
  assert.equal(installRootFromTaskXml(xml('"C:\\Users\\u\\AppData\\Local\\Programs\\Xenon\\server\\start-hidden.vbs"')),
    'C:\\Users\\u\\AppData\\Local\\Programs\\Xenon');
  assert.equal(installRootFromTaskXml(xml('&quot;D:\\X &amp; Y\\server\\start-hidden.vbs&quot;')), 'D:\\X & Y');
});

test('a task that is not the engine launcher gives no root', () => {
  assert.equal(installRootFromTaskXml(xml('"C:\\X\\server\\other.vbs"')), '');
  assert.equal(installRootFromTaskXml(xml('"C:\\X\\start-hidden.vbs"')), '');
  assert.equal(installRootFromTaskXml(xml('start-hidden.vbs')), '');
  assert.equal(installRootFromTaskXml('<Task></Task>'), '');
  assert.equal(installRootFromTaskXml(''), '');
});

test('the root is refused when it is this checkout, a git tree, or not an install', () => {
  const has = (...present) => (p) => present.some((x) => p.toLowerCase().endsWith(x));
  const ok = has('\\server\\update-apply.ps1', '\\server\\data');
  assert.equal(refuseRoot('C:\\I', 'F:\\repo', ok), '');
  assert.match(refuseRoot('', 'F:\\repo', ok), /no installed engine/);
  assert.match(refuseRoot('F:\\Repo\\', 'F:\\repo', ok), /this checkout/);
  assert.match(refuseRoot('C:\\I', 'F:\\repo', has('\\.git', '\\server\\update-apply.ps1', '\\server\\data')), /git checkout/);
  assert.match(refuseRoot('C:\\I', 'F:\\repo', has('\\server\\data')), /update-apply/);
  assert.match(refuseRoot('C:\\I', 'F:\\repo', has('\\server\\update-apply.ps1')), /server\\data/);
});

test('staged.json carries the version the applier checks /version against', () => {
  const s = JSON.parse(stagedJson('5.1.0', 'HEAD', 'abc1234'));
  assert.equal(s.version, '5.1.0');
  assert.equal(s.commit, 'abc1234');
});

test('only a result newer than the one before counts, and a failure says if it rolled back', () => {
  const old = JSON.stringify({ ok: true, from: '4.11.13', to: '5.0.0', at: '1' });
  assert.deepEqual(readOutcome(old, old), { done: false });
  assert.deepEqual(readOutcome(old, ''), { done: false });
  assert.deepEqual(readOutcome(old, '{"ok":tr'), { done: false });
  assert.deepEqual(readOutcome('', '\uFEFF' + JSON.stringify({ ok: true, from: '5.0.0', to: '5.1.0' })),
    { done: true, ok: true, detail: '5.0.0 -> 5.1.0' });
  const fail = readOutcome(old, JSON.stringify({ ok: false, reason: 'npm_install', detail: 'EPERM', rolledBack: true }));
  assert.equal(fail.ok, false);
  assert.match(fail.detail, /npm_install: EPERM \(previous version restored\)/);
  assert.match(readOutcome(old, JSON.stringify({ ok: false, reason: 'verify' })).detail, /rollback NOT confirmed/);
});

test('an unknown or misspelt argument stops the tool instead of installing', () => {
  assert.deepEqual(parseArgs([]), { ref: 'HEAD', dryRun: false });
  assert.deepEqual(parseArgs(['--ref', 'abc123', '--dry-run']), { ref: 'abc123', dryRun: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['-h']), { help: true });
  assert.match(parseArgs(['--dryrun']).error, /unknown argument: --dryrun/);
  assert.match(parseArgs(['main']).error, /unknown argument: main/);
  assert.match(parseArgs(['--ref']).error, /--ref needs/);
  assert.match(parseArgs(['--ref', '--dry-run']).error, /--ref needs/);
});

// tools/dev-install/snapshot.mjs: uncommitted work installed apart from another session's.
test('snapshot: the command line is read strictly, and a skip is a path, never a pattern', () => {
  assert.deepEqual(parseSnapshotArgs([]), { base: 'HEAD', skip: [], dryRun: false });
  assert.deepEqual(parseSnapshotArgs(['--base', 'abc', '--skip', 'server\\airflow\\', '--skip', 'a.js', '--dry-run']),
    { base: 'abc', skip: ['server/airflow', 'a.js'], dryRun: true });
  assert.deepEqual(parseSnapshotArgs(['-h']), { help: true });
  assert.match(parseSnapshotArgs(['--skip']).error, /--skip needs/);
  assert.match(parseSnapshotArgs(['--base', '--dry-run']).error, /--base needs/);
  assert.match(parseSnapshotArgs(['--ref', 'x']).error, /unknown argument: --ref/);

  const { take, skipped } = pickPaths(['server/a.js', 'server/airflow/brain.js', 'CHANGELOG.md'],
    ['server/ab.js', 'server/a.js', 'old-trace.txt'], ['server/airflow', 'server/a', 'old-trace.txt']);
  assert.deepEqual(take, ['CHANGELOG.md', 'server/a.js', 'server/ab.js']);
  assert.deepEqual(skipped, ['old-trace.txt', 'server/airflow/brain.js']);
});

// The GitHub workflows: what each of them must keep true, and what ci.yml must cover.
// The rules live in tools/quality/workflow-guard.mjs; here they run on the real files,
// and on small broken samples, because a check nobody has seen fail proves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../../tools/quality/repo-files.mjs';
import {
  RELEASE_TRIGGER_ALLOWED, STRICT, WORKFLOW_DIR, ciProblems, engineLines, jobs, listWorkflows,
  missingTargets, strictProblems, triggers, workflowProblems,
} from '../../tools/quality/workflow-guard.mjs';

// A copy of the tree without .github (an install, a tar of the app) has nothing to check.
const NO_WORKFLOWS = existsSync(path.join(REPO_ROOT, WORKFLOW_DIR)) ? false : 'this copy carries no .github/workflows';
const workflows = NO_WORKFLOWS ? [] : listWorkflows(REPO_ROOT);
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const textOf = (name) => {
  const found = workflows.find((w) => w.name === name);
  assert.ok(found, `${name} is missing from ${WORKFLOW_DIR}`);
  return found.text;
};

const SHA = 'a'.repeat(40);
const GOOD = [
  'name: Sample',
  'on:',
  '  push:',
  "    branches: ['**']",
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'concurrency:',
  '  group: sample-${{ github.ref }}',
  '  cancel-in-progress: true',
  'jobs:',
  '  test:',
  '    strategy:',
  '      matrix:',
  '        os: [windows-latest, macos-latest, ubuntu-latest]',
  '        node: [22, 26]',
  '    runs-on: ${{ matrix.os }}',
  '    timeout-minutes: 30',
  '    steps:',
  `      - uses: actions/checkout@${SHA} # v7.0.1`,
  '        with:',
  '          persist-credentials: false',
  '      - run: npm ci',
  '      - run: npm run quality:install',
  '      - run: npm test',
  '      - run: node tools/ci/boot-check.mjs',
  '      - run: npm run doctor',
  '  native:',
  '    strategy:',
  '      matrix:',
  '        os: [windows-latest, macos-latest, ubuntu-latest]',
  '    runs-on: ${{ matrix.os }}',
  '    timeout-minutes: 30',
  '    steps:',
  '      - name: Platform APIs',
  '        run: npm run check:platform-apis',
  '',
].join('\n');
const ENGINES = '>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1';
const broken = (from, to) => {
  assert.ok(GOOD.includes(from), `the sample has no "${from}"`);
  return GOOD.replace(from, to);
};

test('the sample workflow passes every rule, so each break below is the only thing wrong', () => {
  assert.deepEqual(workflowProblems('sample.yml', GOOD), []);
  assert.deepEqual(strictProblems('sample.yml', GOOD), []);
  assert.deepEqual(ciProblems(GOOD, ENGINES), []);
  assert.deepEqual(triggers(GOOD), ['push', 'pull_request']);
  assert.deepEqual(jobs(GOOD).map((j) => j.id), ['test', 'native']);
});

test('an action taken by a tag, a branch or a short commit is refused', () => {
  for (const ref of ['actions/checkout@v7', 'actions/checkout@main', `actions/checkout@${SHA.slice(0, 12)} # v7.0.1`, `actions/checkout@${SHA}`]) {
    const problems = workflowProblems('sample.yml', broken(`actions/checkout@${SHA} # v7.0.1`, ref));
    assert.ok(problems.some((p) => p.includes('not pinned')), `${ref}: ${JSON.stringify(problems)}`);
  }
  // An action in this repo is the repo's own code at the same commit: nothing to pin.
  assert.deepEqual(workflowProblems('sample.yml', `${GOOD}      - uses: ./.github/actions/local\n`), []);
});

test('a checkout that keeps its token, a fork-trusting trigger and missing permissions are refused', () => {
  const has = (text, word) => workflowProblems('sample.yml', text).some((p) => p.includes(word));
  assert.ok(has(broken('          persist-credentials: false\n', ''), 'persist-credentials'));
  assert.ok(has(broken('persist-credentials: false', 'persist-credentials: true'), 'persist-credentials'));
  assert.ok(has(broken('  pull_request:', '  pull_request_target:'), 'pull_request_target'));
  assert.ok(has(broken('permissions:\n  contents: read\n', ''), 'no top-level permissions'));
  assert.ok(has(broken('on:\n  push:\n    branches: [\'**\']\n  pull_request:\n', ''), 'no trigger'));
});

test('only the two listed workflows may start from a published release', () => {
  const onRelease = broken('  pull_request:', '  release:\n    types: [published]');
  assert.ok(workflowProblems('helper.yml', onRelease).some((p) => p.includes('starts on a release')));
  assert.ok(workflowProblems('helper.yml', 'on: [push, release]\npermissions: {}\n').some((p) => p.includes('starts on a release')));
  for (const name of Object.keys(RELEASE_TRIGGER_ALLOWED)) {
    assert.ok(!workflowProblems(name, onRelease).some((p) => p.includes('starts on a release')), name);
  }
  assert.deepEqual(Object.keys(RELEASE_TRIGGER_ALLOWED).sort(), ['discord-announce.yml', 'release.yml']);
});

test('the strict rules refuse wider rights, secrets, quiet failures and jobs without a limit', () => {
  const has = (text, word) => strictProblems('sample.yml', text).some((p) => p.includes(word));
  assert.ok(has(broken('  contents: read', '  contents: write'), 'exactly "contents: read"'));
  assert.ok(has(broken('  contents: read', '  contents: read\n  packages: write'), 'write permission "packages"'));
  assert.ok(has(broken('      - run: npm test', '      - run: npm test\n        env:\n          TOKEN: ${{ secrets.TOKEN }}'), 'uses a secret'));
  assert.ok(has(broken('      - run: npm test', '      - run: npm test\n        continue-on-error: true'), 'continue-on-error'));
  assert.ok(has(broken('  cancel-in-progress: true', '  cancel-in-progress: false'), 'concurrency'));
  assert.ok(has(broken('    runs-on: ${{ matrix.os }}\n    timeout-minutes: 30\n    steps:\n      - name', '    runs-on: ${{ matrix.os }}\n    steps:\n      - name'), 'job "native" has no timeout-minutes'));
  // A step's own limit is not the job's.
  assert.ok(has(broken('    timeout-minutes: 30\n    steps:\n      - uses', '    steps:\n      - timeout-minutes: 5\n        uses'), 'job "test" has no timeout-minutes'));
  // Filing CodeQL results is the one write the strict workflows may ask for.
  assert.ok(!has(broken('    timeout-minutes: 30', '    timeout-minutes: 30\n    permissions:\n      security-events: write'), 'write permission'));
});

test('ci.yml must cover the three systems, the Node lines of "engines" and every check', () => {
  const has = (text, word, engines = ENGINES) => ciProblems(text, engines).some((p) => p.includes(word));
  assert.ok(has(broken('os: [windows-latest, macos-latest, ubuntu-latest]', 'os: [windows-latest, ubuntu-latest]'), 'leaves out macos-latest'));
  assert.ok(has(broken('  pull_request:\n', ''), 'does not run on pull_request'));
  assert.ok(has(broken('node: [22, 26]', 'node: [20, 26]'), 'Node 20 is outside'));
  assert.ok(has(broken('node: [22, 26]', 'node: [24, 26]'), 'oldest Node'));
  assert.ok(has(GOOD, 'Node 22 is outside', '>=24.22.1'));
  assert.ok(has(broken('      - run: npm test\n', ''), 'never runs "npm test"'));
  assert.ok(has(broken('      - run: npm run doctor\n', ''), 'never runs "npm run doctor"'));
});

test('the Node lines are read from an "engines" range', () => {
  const lines = engineLines(ENGINES);
  assert.equal(lines.lowest, 22);
  assert.deepEqual([20, 22, 23, 24, 25, 26, 28].map(lines.accepts), [false, true, false, true, false, true, true]);
  assert.equal(engineLines('>=22 <24.3.0').accepts(24), true);
  assert.equal(engineLines('>=22 <24').accepts(24), false);
  assert.throws(() => engineLines('^22'), /cannot read/);
});

test('a file, a folder or an npm script a workflow names must exist', () => {
  const scripts = { test: 'x' };
  const text = 'jobs:\n  a:\n    steps:\n      - run: node tools/ci/no-such-file.mjs "$X"\n      - run: npm run no-such-script\n      - run: cargo check --manifest-path apps/nowhere/Cargo.toml\n      - run: npm test\n';
  const missing = missingTargets(text, REPO_ROOT, scripts).join(' | ');
  assert.match(missing, /tools\/ci\/no-such-file\.mjs/);
  assert.match(missing, /npm script "no-such-script"/);
  assert.match(missing, /apps\/nowhere\/Cargo\.toml/);
  assert.deepEqual(missingTargets('      - run: node tools/ci/boot-check.mjs\n', REPO_ROOT, scripts), []);
});

test('every workflow in the repo keeps the rules', { skip: NO_WORKFLOWS }, () => {
  assert.ok(workflows.length >= 10, `only ${workflows.length} workflows were read`);
  const problems = workflows.flatMap((w) => workflowProblems(w.name, w.text));
  assert.deepEqual(problems, []);
  for (const w of workflows) assert.ok(jobs(w.text).length, `${w.name}: no jobs were read, so its rules checked nothing`);
});

test('ci.yml and security.yml keep the strict rules and name only things that exist', { skip: NO_WORKFLOWS }, () => {
  for (const name of STRICT) {
    const text = textOf(name);
    assert.deepEqual(strictProblems(name, text), []);
    assert.deepEqual(missingTargets(text, REPO_ROOT, pkg.scripts), [], name);
  }
});

test('ci.yml runs the tests, the boot and the native code on Windows, macOS and Linux', { skip: NO_WORKFLOWS }, () => {
  assert.deepEqual(ciProblems(textOf('ci.yml'), pkg.engines.node), []);
  // The workflow ci.yml replaced ran the same checks with the tests allowed to fail.
  assert.equal(existsSync(path.join(REPO_ROOT, WORKFLOW_DIR, 'mac-linux-check.yml')), false);
});

test('CodeQL reads every language the repo ships', { skip: NO_WORKFLOWS }, () => {
  const text = textOf('security.yml');
  for (const language of ['javascript-typescript', 'actions', 'csharp', 'swift', 'rust']) {
    assert.match(text, new RegExp(`language: ${language}\\b`), language);
  }
  assert.match(text, /npm audit --omit=dev --audit-level=high/);
  assert.match(text, /cargo audit --file apps\/native\/src-tauri\/Cargo\.lock/);
  assert.match(text, /cargo audit --file apps\/capture\/Cargo\.lock/);
});

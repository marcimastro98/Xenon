// js/claude-roadmap.js — the phases of a plan and where the work has got to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePhases, advance, roadmap } = require('../js/claude-roadmap.js');

const PLAN = [
  '# Plan: notifications',
  '## Context',
  'Why we do it.',
  '### 1. Island shows one at a time',
  'Edit `morphIsland` in server/js/island-notch.js.',
  '### 2. Counter badge',
  'Update server/js/toast.js and the css.',
  '### 3. Verify',
  'Run npm test.',
].join('\n');

test('numbered headings become the phases, with the files they name', () => {
  const p = parsePhases(PLAN);
  assert.deepEqual(p.map((x) => x.title), ['Island shows one at a time', 'Counter badge', 'Verify']);
  assert.ok(p[0].tokens.includes('island-notch.js') && p[0].tokens.includes('morphisland'));
  assert.ok(p[1].tokens.includes('toast.js'));
});

test('a numbered list is read when there are no numbered headings', () => {
  const p = parsePhases('Intro\n\n1. First thing\n   more\n2. Second thing\n');
  assert.deepEqual(p.map((x) => x.title), ['First thing', 'Second thing']);
});

test('main headings are the fallback, minus context and verification', () => {
  const p = parsePhases('## Context\nx\n## Island\ny\n## Toasts\nz\n## Verification\nw\n');
  assert.deepEqual(p.map((x) => x.title), ['Island', 'Toasts']);
});

test('a plan with no steps has no phases', () => {
  assert.deepEqual(parsePhases('Just do the thing.'), []);
  assert.deepEqual(parsePhases(''), []);
});

test('an edit of a phase\'s file moves the roadmap there, and never back', () => {
  const p = parsePhases(PLAN);
  let at = advance(0, p, [{ tool: 'Read', detail: 'server/js/toast.js', at: 10 }], 5);
  assert.equal(at, 0);                                            // reading is not working
  at = advance(at, p, [{ tool: 'Edit', detail: 'C:/x/server/js/toast.js', at: 20 }], 5);
  assert.equal(at, 1);
  at = advance(at, p, [{ tool: 'Edit', detail: 'C:/x/server/js/island-notch.js', at: 30 }], 5);
  assert.equal(at, 1);                                            // phase 0's file again: stays
  assert.equal(advance(0, p, [{ tool: 'Edit', detail: 'toast.js', at: 1 }], 5), 0);   // before the plan
});

test('the roadmap marks done, doing and todo, or follows a todo list of the same length', () => {
  const p = parsePhases(PLAN);
  assert.deepEqual(roadmap(p, null, 1, true).map((x) => x.state), ['done', 'doing', 'todo']);
  assert.deepEqual(roadmap(p, null, 1, false).map((x) => x.state), ['done', 'todo', 'todo']);
  const todos = [{ status: 'done' }, { status: 'done' }, { status: 'doing' }];
  assert.deepEqual(roadmap(p, todos, 0, true).map((x) => x.state), ['done', 'done', 'doing']);
  assert.deepEqual(roadmap(p, [{ status: 'done' }], 0, true).map((x) => x.state), ['doing', 'todo', 'todo']);
});

test('numbered steps under Verification or Context are not the phases', () => {
  const plan = [
    '# Plan', '## Context', '1. a fact', '2. another fact',
    '### 1. First step', 'body', '### 2. Second step', 'body', '### 3. Third step',
    '## Verification', '1. Run npm test', '2. Check the screen',
  ].join('\n');
  assert.deepEqual(parsePhases(plan).map((p) => p.title), ['First step', 'Second step', 'Third step']);
  const list = ['# Plan', '## Context', '1. fact', '2. fact', '## Steps', '1. Do A', '2. Do B', '## Verification', '1. test', '2. look'].join('\n');
  assert.deepEqual(parsePhases(list).map((p) => p.title), ['Do A', 'Do B']);
});

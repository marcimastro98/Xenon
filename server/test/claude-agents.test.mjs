'use strict';
// js/claude-agents.js — the Agents view's data half. Pinned: working agents
// come first in the order they started, finished ones after, newest first; the
// live entry wins over the agent's file, which only fills what is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { order, counts, merge, ladder } = require('../js/claude-agents.js');

const run = (id, ageMs) => ({ id, status: 'running', ageMs, endedMs: 0 });
const done = (id, endedMs) => ({ id, status: 'done', ageMs: endedMs + 5000, endedMs });

test('running agents first, oldest on top; finished ones after, newest first', () => {
  const got = order([done('d-old', 90000), run('r-new', 1000), done('d-new', 2000), run('r-old', 30000)]);
  assert.deepEqual(got.map((a) => a.id), ['r-old', 'r-new', 'd-new', 'd-old']);
});

test('order copes with nothing and never sorts the caller\'s array', () => {
  assert.deepEqual(order(null), []);
  const list = [done('a', 1), run('b', 1)];
  order(list);
  assert.deepEqual(list.map((a) => a.id), ['a', 'b']);
});

test('counts splits working from finished', () => {
  assert.deepEqual(counts([run('a', 1), done('b', 1), done('c', 1)]), { running: 1, done: 2, total: 3 });
  assert.deepEqual(counts(undefined), { running: 0, done: 0, total: 0 });
});

test('the live entry wins and the file fills the gaps', () => {
  const live = { id: 'x', status: 'running', type: 'Explore', desc: '', model: '', effort: 'high', tokens: 0, tools: 3, tool: 'Read', detail: 'a.js', ageMs: 4000 };
  const file = { ok: true, type: 'general', description: 'Find the notch', model: 'claude-opus-5-5', effort: 'low', tokens: 48000, tools: [{ tool: 'Grep', detail: 'x' }] };
  const m = merge(live, file);
  assert.equal(m.type, 'Explore');
  assert.equal(m.desc, 'Find the notch');
  assert.equal(m.model, 'claude-opus-5-5');
  assert.equal(m.effort, 'high');
  assert.equal(m.tokens, 48000);
  assert.equal(m.tools, 3);
  assert.equal(m.running, true);
  assert.deepEqual(m.recent, [{ tool: 'Grep', detail: 'x' }]);
});

test('a failed or missing file read changes nothing', () => {
  const live = { id: 'x', status: 'done', type: 'Plan', model: 'claude-sonnet-5-5', tools: 2, ageMs: 9000, endedMs: 1000 };
  for (const extra of [null, { ok: false, model: 'nope' }]) {
    const m = merge(live, extra);
    assert.equal(m.model, 'claude-sonnet-5-5');
    assert.equal(m.running, false);
    assert.deepEqual(m.recent, []);
  }
});

test('the plan ladder has one segment per step and folds to a bar past twelve', () => {
  assert.deepEqual(ladder(['done', 'doing', 'todo', 'pending', null]), ['done', 'doing', 'todo', 'todo', 'todo']);
  assert.equal(ladder([]), null);
  assert.equal(ladder(undefined), null);
  assert.equal(ladder(Array(12).fill('todo')).length, 12);
  assert.equal(ladder(Array(13).fill('todo')), null);
});

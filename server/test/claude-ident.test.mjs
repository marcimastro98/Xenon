'use strict';
// js/claude-ident.js — who a Claude Code session is in the Claude tile. Pinned:
// a session keeps its colour slot for its whole life, the title prefers the
// chat's own name over the folder, the project is never said twice, and the
// short id is always there to match the rail, the console and the terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SLOTS, slot, shortId, describe, toolLabel } = require('../js/claude-ident.js');

const ID = '3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6';

test('the slot is stable and inside the palette', () => {
  assert.equal(slot(ID), slot(ID));
  for (let i = 0; i < 200; i++) {
    const n = slot('session-' + i);
    assert.ok(Number.isInteger(n) && n >= 0 && n < SLOTS);
  }
  assert.equal(slot(''), slot(undefined));
});

test('ids spread over every slot', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(slot('session-' + i));
  assert.equal(seen.size, SLOTS);
});

test('title: the session name, then the transcript title, then the project, then the fallback', () => {
  assert.equal(describe({ id: ID, name: 'Refactor', project: 'xenon' }, { [ID]: 'Ignored' }).title, 'Refactor');
  assert.equal(describe({ id: ID, project: 'xenon' }, { [ID]: 'Pulizia sviluppatore' }).title, 'Pulizia sviluppatore');
  assert.equal(describe({ id: ID, project: 'xenon' }, {}).title, 'xenon');
  assert.equal(describe({ id: ID }, null, 'session').title, 'session');
});

test('sub: project only when something else names the session, then branch and #id4', () => {
  const named = describe({ id: ID, project: 'xenon', branch: 'main' }, { [ID]: 'Fix' });
  assert.deepEqual(named.sub, ['xenon', 'main', '#3f2a']);
  const bare = describe({ id: ID, project: 'xenon', branch: 'main' }, {});
  assert.deepEqual(bare.sub, ['main', '#3f2a']);
  assert.equal(bare.tag, '#3f2a');
});

test('no id: no tag, no crash', () => {
  const who = describe(null, undefined, 'session');
  assert.deepEqual(who.sub, []);
  assert.equal(who.tag, '');
  assert.equal(shortId(null), '');
});

test('an MCP tool reads as server · tool; a built-in one is left alone', () => {
  assert.equal(toolLabel('mcp__claude-in-chrome__computer'), 'claude-in-chrome · computer');
  assert.equal(toolLabel('mcp__plugin_context7_context7__query-docs'), 'plugin_context7_context7 · query-docs');
  assert.equal(toolLabel('Bash'), 'Bash');
  assert.equal(toolLabel(undefined), '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ct = require('../claude-transcript.js');

// A projects directory shaped the way Claude Code writes one: a folder per
// project, each holding <session-id>.jsonl.
function makeProjects(sessionId, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tx-'));
  const proj = path.join(root, '-C--work-xenon');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, sessionId + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return root;
}

const userLine = (text, ts) => ({ type: 'user', timestamp: ts, message: { content: text } });
const claudeLine = (text, ts) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });

test('reads the conversation, oldest first, both roles', async () => {
  const root = makeProjects('abc123', [
    userLine('fix the build', '2026-07-19T10:00:00Z'),
    claudeLine('Looking at it now.', '2026-07-19T10:00:05Z'),
  ]);
  const out = await ct.readTail(root, 'abc123');
  assert.equal(out.ok, true);
  assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(out.messages[0].text, 'fix the build');
  assert.equal(out.messages[1].text, 'Looking at it now.');
});

test('a session id that could climb out of the directory is refused', async () => {
  const root = makeProjects('abc123', [userLine('hi', '2026-07-19T10:00:00Z')]);
  for (const bad of ['../secrets', 'a/b', 'a\\b', '', '.', 'x'.repeat(200)]) {
    assert.equal((await ct.readTail(root, bad)).error, 'bad_session', JSON.stringify(bad));
  }
});

test('a session with no transcript says so rather than throwing', async () => {
  const root = makeProjects('abc123', [userLine('hi', '2026-07-19T10:00:00Z')]);
  assert.equal((await ct.readTail(root, 'nosuchsession')).error, 'not_found');
});

test('harness-injected user turns are not shown as things you said', async () => {
  const root = makeProjects('abc123', [
    userLine('<system-reminder>plumbing</system-reminder>', '2026-07-19T10:00:00Z'),
    userLine('Caveat: the messages below were generated', '2026-07-19T10:00:01Z'),
    userLine('the real question', '2026-07-19T10:00:02Z'),
  ]);
  const out = await ct.readTail(root, 'abc123');
  assert.deepEqual(out.messages.map(m => m.text), ['the real question']);
});

test('tool calls and results are left out; only text survives', async () => {
  const root = makeProjects('abc123', [
    { type: 'assistant', timestamp: '2026-07-19T10:00:00Z', message: { content: [
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ] } },
    { type: 'assistant', timestamp: '2026-07-19T10:00:01Z', message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ] } },
  ]);
  const out = await ct.readTail(root, 'abc123');
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].text, 'Running it.');
});

test('only the last turns come back, and each is bounded', async () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(userLine('turn ' + i, '2026-07-19T10:00:00Z'));
  // Derived from the cap, so raising MAX_TEXT does not quietly stop this test
  // from exercising truncation at all.
  many.push(userLine('x'.repeat(ct._internal.MAX_TEXT + 500), '2026-07-19T10:00:00Z'));
  const root = makeProjects('abc123', many);
  const out = await ct.readTail(root, 'abc123');
  assert.equal(out.messages.length, ct._internal.MAX_MESSAGES);
  const last = out.messages[out.messages.length - 1];
  assert.equal(last.text.length, ct._internal.MAX_TEXT);
  assert.equal(last.truncated, true);
});

test('malformed lines are skipped, not fatal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tx-'));
  const proj = path.join(root, 'p');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'abc123.jsonl'),
    'not json\n{"broken":\n' + JSON.stringify(userLine('survived', '2026-07-19T10:00:00Z')) + '\n');
  const out = await ct.readTail(root, 'abc123');
  assert.equal(out.ok, true);
  assert.deepEqual(out.messages.map(m => m.text), ['survived']);
});

test('closed: true once the turn-closing lines follow the last message', async () => {
  const sys = (subtype) => ({ type: 'system', subtype, timestamp: '2026-07-19T10:00:09Z' });
  const open = makeProjects('t1', [userLine('go', '2026-07-19T10:00:00Z'), claudeLine('done', '2026-07-19T10:00:05Z')]);
  assert.equal((await ct.readTail(open, 't1')).closed, false);
  const shut = makeProjects('t2', [userLine('go', '2026-07-19T10:00:00Z'), claudeLine('done', '2026-07-19T10:00:05Z'), sys('stop_hook_summary'), sys('turn_duration')]);
  assert.equal((await ct.readTail(shut, 't2')).closed, true);
  const reopened = makeProjects('t3', [sys('turn_duration'), userLine('again', '2026-07-19T10:01:00Z')]);
  assert.equal((await ct.readTail(reopened, 't3')).closed, false);
});

test('the newest reply is never cut at the per-message cap; full uncuts the rest', async () => {
  const long = 'x'.repeat(ct._internal.MAX_TEXT + 500);
  const root = makeProjects('t4', [claudeLine(long, '2026-07-19T10:00:00Z'), userLine('more', '2026-07-19T10:00:01Z'), claudeLine(long, '2026-07-19T10:00:05Z')]);
  const out = await ct.readTail(root, 't4');
  assert.equal(out.messages[0].truncated, true);
  assert.equal(out.messages.at(-1).truncated, false);
  assert.equal(out.messages.at(-1).text.length, long.length);
  const all = await ct.readTail(root, 't4', { full: true });
  assert.equal(all.messages[0].truncated, false);
});

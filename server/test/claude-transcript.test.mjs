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

test('tool calls are grouped into one entry after the text; results are left out', async () => {
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
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].text, 'Running it.');
  assert.equal(out.messages[1].text, '');
  assert.deepEqual(out.messages[1].tools.map((t) => t.detail), ['npm test', 'ls']);
});

test('a slash command is shown as it was typed', async () => {
  const cmd = '<command-name>/plan</command-name> <command-message>plan</command-message> <command-args>redo the toast</command-args>';
  const root = makeProjects('cmd1', [
    { type: 'user', timestamp: '2026-10-18T10:00:00Z', message: { content: cmd } },
    { type: 'user', timestamp: '2026-10-18T10:00:01Z', message: { content: '<local-command-stdout>Enabled plan mode</local-command-stdout>' } },
  ]);
  const out = await ct.readTail(root, 'cmd1');
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.messages[0].text, '/plan redo the toast');
});

test('a few huge pictures at the end do not empty the thread', async () => {
  const big = 'A'.repeat(900 * 1024);
  const pic = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } };
  const root = makeProjects('big1', [
    userLine('older question', '2026-10-18T09:00:00Z'),
    claudeLine('older answer', '2026-10-18T09:00:01Z'),
    { type: 'user', timestamp: '2026-10-18T09:01:00Z', message: { content: [{ type: 'tool_result', content: [pic] }] } },
    { type: 'user', timestamp: '2026-10-18T09:02:00Z', message: { content: [{ type: 'tool_result', content: [pic] }] } },
  ]);
  const out = await ct.readTail(root, 'big1');
  assert.ok(out.messages.some((m) => m.text === 'older answer'));
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

test('an Esc in the terminal is the last line of the transcript, and only a newer one counts', async () => {
  const root = makeProjects('esc1', [
    userLine('go', '2026-07-19T10:00:00Z'),
    claudeLine('on it', '2026-07-19T10:00:05Z'),
    userLine('[Request interrupted by user]', '2026-07-19T10:00:09Z'),
  ]);
  const since = (iso) => Date.parse(iso);
  assert.equal(await ct.interruptedSince(root, 'esc1', since('2026-07-19T10:00:00Z')), true);
  assert.equal(await ct.interruptedSince(root, 'esc1', since('2026-07-19T10:00:20Z')), false, 'an earlier turn');

  const after = makeProjects('esc2', [
    userLine('[Request interrupted by user]', '2026-07-19T10:00:09Z'),
    userLine('continue', '2026-07-19T10:00:30Z'),
  ]);
  assert.equal(await ct.interruptedSince(after, 'esc2', since('2026-07-19T10:00:00Z')), false, 'a new prompt came after');
  assert.equal(await ct.interruptedSince(root, 'nope', 0), false);
});

test('lastPlan returns the newest ExitPlanMode plan, and nothing for other sessions', async () => {
  const exitPlan = (plan, ts) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan } }] } });
  const root = makeProjects('plan1', [
    userLine('go', '2026-10-17T10:00:00Z'),
    exitPlan('# old plan', '2026-10-17T10:01:00Z'),
    exitPlan('# new plan\n### 1. Step', '2026-10-17T10:05:00Z'),
    claudeLine('working', '2026-10-17T10:06:00Z'),
  ]);
  const out = await ct.lastPlan(root, 'plan1');
  assert.equal(out.ok, true);
  assert.equal(out.plan, '# new plan\n### 1. Step');
  assert.equal(out.at, Date.parse('2026-10-17T10:05:00Z'));
  assert.equal((await ct.lastPlan(root, 'nope')).ok, false);
  assert.equal((await ct.lastPlan(root, '../x')).ok, false);
  const none = makeProjects('plan2', [userLine('hi', '2026-10-17T10:00:00Z')]);
  assert.equal((await ct.lastPlan(none, 'plan2')).ok, false);
});

test('pictures are listed by id in the thread and read back one at a time', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');
  const pic = (type) => ({ type: 'image', source: { type: 'base64', media_type: type, data: png } });
  const root = makeProjects('img1', [
    { type: 'user', timestamp: '2026-10-17T10:00:00Z', message: { content: [{ type: 'text', text: 'look' }, pic('image/png')] } },
    { type: 'user', timestamp: '2026-10-17T10:01:00Z', message: { content: [{ type: 'tool_result', content: [pic('image/jpeg')] }] } },
    { type: 'user', timestamp: '2026-10-17T10:02:00Z', message: { content: [{ type: 'tool_result', content: [pic('image/svg+xml')] }] } },
  ]);
  const out = await ct.readTail(root, 'img1');
  assert.equal(out.messages.length, 2);                         // the svg one is no picture
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.messages[1].role, 'assistant');              // a tool result's picture is Claude's
  assert.equal(out.messages[0].images.length, 1);
  const first = await ct.readImage(root, 'img1', out.messages[0].images[0]);
  assert.equal(first.ok, true);
  assert.equal(first.mime, 'image/png');
  assert.ok(first.data.length > 0);
  assert.equal((await ct.readImage(root, 'img1', out.messages[1].images[0])).mime, 'image/jpeg');
  assert.equal((await ct.readImage(root, 'img1', '3.0')).ok, false);        // not the start of a line
  assert.equal((await ct.readImage(root, 'img1', '../x')).ok, false);
  assert.equal((await ct.readImage(root, '../x', '0.0')).ok, false);
});

test('a message typed mid-turn is read from its queued command, pictures included', async () => {
  const data = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');
  const root = makeProjects('q1', [
    { type: 'attachment', timestamp: '2026-10-18T11:41:51Z', attachment: { type: 'queued_command', prompt: [
      { type: 'text', text: 'the X is not centred [Image #7]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ] } },
    { type: 'attachment', timestamp: '2026-10-18T11:42:00Z', attachment: { type: 'queued_command', prompt: 'plain one' } },
    { type: 'attachment', timestamp: '2026-10-18T11:43:00Z', attachment: { type: 'hook_success' } },
  ]);
  const out = await ct.readTail(root, 'q1');
  assert.deepEqual(out.messages.map((m) => [m.role, m.text]), [['user', 'the X is not centred [Image #7]'], ['user', 'plain one']]);
  assert.equal(out.messages[0].images.length, 1);
  assert.equal((await ct.readImage(root, 'q1', out.messages[0].images[0])).mime, 'image/png');
});

test('lastPlan reads only what was appended, and a newer plan wins', async () => {
  const planLine = (plan, ts) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan } }] } });
  const root = makeProjects('plan2', [planLine('# First', '2026-10-18T10:00:00Z'), claudeLine('ok', '2026-10-18T10:01:00Z')]);
  assert.equal((await ct.lastPlan(root, 'plan2')).plan, '# First');
  const file = path.join(root, '-C--work-xenon', 'plan2.jsonl');
  fs.appendFileSync(file, JSON.stringify(claudeLine('more', '2026-10-18T10:02:00Z')) + '\n');
  assert.equal((await ct.lastPlan(root, 'plan2')).plan, '# First');
  fs.appendFileSync(file, JSON.stringify(planLine('# Second', '2026-10-18T10:03:00Z')) + '\n');
  assert.equal((await ct.lastPlan(root, 'plan2')).plan, '# Second');
});

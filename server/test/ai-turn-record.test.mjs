// What Bit really did in a reply must survive into the next turn's history:
// without it the model took back a clip it had saved ("I didn't actually make
// the save call"). Real repro, 30 Oct 2026, Sparks + Sonnet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const record = require('../ai-turn-record.js');
const { geminiHistoryToAnthropic } = require('../ai-anthropic.js');
const { geminiHistoryToOpenAI } = require('../ai-local.js');

test('a reply with no tools stays a plain text message', () => {
  const r = record.create();
  assert.deepEqual(r.message('Hello'), { role: 'model', parts: [{ text: 'Hello' }] });
});

test('the record line names each tool and how it ended, before the reply', () => {
  const r = record.create();
  const out = { fnResult: { ok: true, seconds: 43 }, clientActions: [] };
  assert.equal(r.note('save_replay', out), out);
  r.note('copy_capture_to_folder', { fnResult: { ok: true } });
  r.note('take_screenshot', { fnResult: { error: 'no_engine' } });
  const msg = r.message('Saved.');
  assert.equal(msg.role, 'model');
  assert.equal(msg.parts.length, 2);
  assert.equal(msg.parts[1].text, 'Saved.');
  assert.equal(msg.parts[0].text,
    '[Xenon record: tools you ran in this reply: save_replay ok; copy_capture_to_folder ok; take_screenshot failed (no_engine)]');
});

test('never copies arguments, paths or sentences into the record', () => {
  const r = record.create();
  r.note('copy_capture_to_folder', { fnResult: { ok: false, error: 'Folder C:\\Users\\me\\Secret not found' } });
  r.note('../../etc', { fnResult: { ok: true } });
  r.note('mcp__xenon__save_replay', { fnResult: { success: false, reason: 'off' } });
  const text = r.message('x').parts[0].text;
  assert.ok(!/Users|Secret|etc/.test(text), text);
  assert.match(text, /copy_capture_to_folder failed;/);
  assert.match(text, /save_replay failed \(off\)\]$/);
});

test('a long turn is capped', () => {
  const r = record.create();
  for (let i = 0; i < 15; i++) r.note('list_tasks', { fnResult: { tasks: [] } });
  assert.match(r.message('').parts[0].text, /; and 3 more\]$/);
  assert.equal(r.count(), 15);
});

test("Gemini's own content keeps its parts after the record line", () => {
  const r = record.create();
  r.note('save_replay', { fnResult: { ok: true } });
  const native = { role: 'model', parts: [{ text: 'Done', thoughtSignature: 'abc' }] };
  const msg = r.message(native);
  assert.deepEqual(msg.parts[1], native.parts[0]);
  assert.match(msg.parts[0].text, /^\[Xenon record/);
  assert.equal(native.parts.length, 1, 'the provider content is not mutated');
});

test('the record reaches Claude and OpenAI-style models on the next turn', () => {
  const r = record.create();
  r.note('save_replay', { fnResult: { ok: true } });
  const history = [
    { role: 'user', parts: [{ text: 'Save the last 42 seconds to my Desktop' }] },
    r.message('Saved to your Desktop.'),
    { role: 'user', parts: [{ text: 'Why is my game stuttering?' }] },
  ];
  const claude = geminiHistoryToAnthropic(history);
  assert.equal(claude[1].role, 'assistant');
  assert.match(claude[1].content[0].text, /save_replay ok/);
  const openai = geminiHistoryToOpenAI(history);
  assert.match(openai[1].content, /save_replay ok.*Saved to your Desktop/);
});

test('every provider path in /api/ai records its tools and returns the record', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = src.indexOf("reqPath === '/api/ai' && req.method === 'POST'");
  const end = src.indexOf("reqPath === '/api/ai/summarize'", start);
  const route = src.slice(start, end);
  // ollama, local server, CLI, Sparks, OpenAI/Anthropic, Gemini.
  assert.equal(route.split('turnRecord.note(fnName, r)').length - 1, 6);
  assert.equal(route.split('newContent: turnRecord.message(').length - 1, 6);
  assert.ok(!/newContent: (result\.newContent|content)\b/.test(route), 'no path returns the bare reply');
  assert.ok(route.includes('aiTurnRecord.SYSTEM_NOTE'), 'the model is told what the line is');
});

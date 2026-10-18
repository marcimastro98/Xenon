// claude-subagent.js — one subagent read back from Claude Code's own files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readAgent } = require('../claude-subagent.js');

function makeSession(sessionId, agentId, meta, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sub-'));
  const proj = path.join(root, '-C--work-xenon');
  fs.mkdirSync(path.join(proj, sessionId, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, sessionId + '.jsonl'), '{}\n');
  const base = path.join(proj, sessionId, 'subagents', 'agent-' + agentId);
  fs.writeFileSync(base + '.meta.json', JSON.stringify(meta));
  fs.writeFileSync(base + '.jsonl', lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return root;
}

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30000, cache_creation_input_tokens: 200 };

test('an agent is read with its label, model, effort, context and last tools, never its prompt', async () => {
  const root = makeSession('s1', 'a08c0b15', { agentType: 'Explore', description: 'Find the callers' }, [
    { type: 'user', message: { content: 'the secret prompt' } },
    { type: 'assistant', effort: 'medium', message: { model: 'claude-haiku-5-5', stop_reason: 'tool_use', usage,
      content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'paint(' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'secret result' }] } },
    { type: 'assistant', effort: 'medium', message: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Done' }] } },
  ]);
  const out = await readAgent(root, 's1', 'a08c0b15');
  assert.equal(out.ok, true);
  assert.equal(out.type, 'Explore');
  assert.equal(out.description, 'Find the callers');
  assert.equal(out.model, 'claude-haiku-5-5');
  assert.equal(out.effort, 'medium');
  assert.equal(out.tokens, 30215);
  assert.equal(out.done, true);
  assert.deepEqual(out.tools, [{ tool: 'Grep', detail: 'paint(' }]);
  assert.ok(!JSON.stringify(out).includes('secret'));
});

test('ids are shape-checked before any path is built', async () => {
  const root = makeSession('s2', 'a1', {}, []);
  assert.equal((await readAgent(root, 's2', '../s2')).error, 'bad_request');
  assert.equal((await readAgent(root, '..', 'a1')).error, 'bad_request');
  assert.equal((await readAgent(root, 's2', 'missing')).error, 'not_found');
});

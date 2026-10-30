// The voice (Live) session gets its own short system instruction. Creations must
// work by voice too: the same grounding and self-check as typed chat, and code
// is never read aloud. Evaluated from server.js itself, so it tests what ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadBuilder() {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = src.indexOf('function _buildLiveSystemInstruction(');
  assert.ok(start >= 0, 'builder present in server.js');
  const end = src.indexOf('\n}\n', start);
  const ctx = { _serverHubSettings: null, aiMemory: { count: () => 0 }, Intl, Date };
  vm.runInNewContext(src.slice(start, end + 2) + '\nthis.build = _buildLiveSystemInstruction;', ctx);
  return ctx.build;
}

test('voice instruction: creations are grounded, self-checked and never read aloud', () => {
  const text = loadBuilder()({ langName: 'Italian', summary: '' });
  for (const tool of ['preset_reference', 'create_preset']) assert.match(text, new RegExp(tool));
  assert.match(text, /critique "fix" item/);
  assert.match(text, /import window/);
  assert.match(text, /Never read codes, JSON or file contents aloud/);
  assert.match(text, /Always reply in Italian\./);
});

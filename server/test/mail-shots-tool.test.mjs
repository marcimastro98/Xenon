import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOKS } from '../../tools/mail-shots/shoot.mjs';

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'mail-shots', 'shoot.mjs');

test('the mail pictures cover paper, dark mode and a phone', () => {
  assert.ok(LOOKS.some((l) => l.scheme === 'light' && l.width >= 600));
  assert.ok(LOOKS.some((l) => l.scheme === 'dark'));
  assert.ok(LOOKS.some((l) => l.width <= 390));
});

test('the tool says where the pictures must go instead of writing them anywhere', () => {
  const run = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--out <dir>/);
});

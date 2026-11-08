import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// A loop with a smooth timing keeps the window presenting at the display's rate
// whatever its size. Measured on the top bar's colon at 240 Hz: 229 presents a
// second down to 22 once in steps, with the GPU process at about half the time.

test('the clock colon blinks in steps, never with a smooth loop', () => {
  const rule = read('components/Topbar/Topbar.css').match(/\n\.clock-sep \{[^}]*\}/)[0];
  assert.match(rule, /animation: clock-colon-blink 1s steps\(\d+, jump-none\) infinite;/);
});

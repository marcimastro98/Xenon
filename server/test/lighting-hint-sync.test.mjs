// Every lighting effect drives the LEDs INDEPENDENTLY of the master toggle
// (see wantsPaint()/shouldConnect() in server/lighting.js), so the Settings page
// must surface a failed iCUE session whenever ANY of them is on — not only when
// the master is on. Gating that hint on `status.enabled` left the users relying
// on Album → LED or an event flash with the master off staring at dead lights and
// an empty page, while the server had the reason ready in /api/lighting/status.
//
// The client mirror (wantsSession in js/lighting-page.js) can't import the server
// function, so pin the two against each other at the source level: the same set of
// effect keys, and the hint actually gated on the mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = readFileSync(join(ROOT, 'server', 'lighting.js'), 'utf8');
const client = readFileSync(join(ROOT, 'server', 'js', 'lighting-page.js'), 'utf8');

// Body of `function NAME(...) { ... }` up to the closing brace at column 0.
function body(src, name) {
  const m = src.match(new RegExp('\\nfunction\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}', 'm'))
         || src.match(new RegExp('\\n  function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}', 'm'));
  assert.ok(m, name + ' not found');
  return m[1];
}

// Effect keys read off the `e` alias for config.effects / status.effects.
function effectKeys(fnBody) {
  const keys = new Set();
  for (const m of fnBody.matchAll(/\be\.([A-Za-z]\w*)/g)) keys.add(m[1]);
  return [...keys].sort();
}

test('lighting-page wantsSession mirrors lighting.js shouldConnect effect list', () => {
  const expected = effectKeys(body(server, 'shouldConnect'));
  // Guard against a vacuous pass: if a rename broke the extraction both sides
  // would come back empty and the comparison below would prove nothing.
  assert.ok(expected.length >= 3, 'no effect keys extracted from shouldConnect');
  assert.deepEqual(effectKeys(body(client, 'wantsSession')), expected);
});

test('lighting-page wantsSession honours the master toggle too', () => {
  assert.match(body(client, 'wantsSession'), /status\.enabled/);
});

test('the iCUE connection hint is gated on wantsSession, not on the master toggle', () => {
  // Not [^)]* — the condition itself contains a call, so stop at the block brace.
  const m = client.match(/if\s*\((.*?!status\.connected.*?)\)\s*\{/);
  assert.ok(m, 'connection-hint condition not found in lighting-page.js');
  assert.match(m[1], /wantsSession\(status\)/);
  assert.doesNotMatch(m[1], /status\.enabled/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Lighting tile listed iCUE devices by their raw id ("{e1bc9e47-…}"): the
// server sends their name as `model`, as Settings already reads it.

const src = readFileSync(new URL('../js/lighting-widget.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function absorb() {
  const at = src.indexOf('  function absorb(d) {');
  const fn = src.slice(at, src.indexOf('\n  }\n', at) + 4);
  return new Function(`const st = { devices: [] };\n${fn}\nreturn (d) => { absorb(d); return st.devices; };`)();
}

test('an iCUE device shows its model, never its id', () => {
  const rows = absorb()({ devices: [{ id: '{e1bc9e47-7c49-4482-a0fd-d58196c58906}', model: 'iCUE LINK H150i' }] });
  assert.equal(rows[0].name, 'iCUE LINK H150i');
});

test('a device with no name at all still gets a row, by id', () => {
  const rows = absorb()({ devices: [{ id: 'dev-1' }], providers: [{ name: 'WLED', devices: [{ id: 'w1', name: 'Desk strip' }] }] });
  assert.deepEqual(rows.map((r) => r.name), ['dev-1', 'WLED · Desk strip']);
});

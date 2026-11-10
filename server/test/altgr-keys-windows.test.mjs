// What this PC's keyboards type with AltGr (altgr-keys-windows.js), read through
// a stand-in for user32: no real keyboard, no key sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { typedKeys, altGrKeys, KEYS } = require('../altgr-keys-windows.js');

// Two layouts: the first types € on E with AltGr, the second has a dead key on 5.
function fakeUser32(typed) {
  const seen = [];
  return {
    seen,
    list: (max, out) => { out[0] = 'it'; out[1] = 'pl'; return 2; },
    scan: (vk) => vk + 1000,
    type: (vk, scan, state, buf, len, flags, hkl) => {
      seen.push({ state: [state[0x11], state[0x12], state[0xA2], state[0xA5]], flags });
      return (typed[hkl] || {})[String.fromCharCode(vk)] || 0;
    },
  };
}

test('a key counts when any layout types a character or a dead key with AltGr', () => {
  const f = fakeUser32({ it: { E: 1 }, pl: { 5: -1 } });
  assert.deepEqual(typedKeys(f).sort(), ['5', 'e']);
  assert.equal(f.seen.length, KEYS.length * 2);
  // AltGr held, and the keyboard state left as it was.
  assert.ok(f.seen.every((s) => s.state.every((v) => v === 0x80) && s.flags === 0x4));
});

test('no layout read means nothing known: the caller keeps every Ctrl+Alt letter refused', () => {
  assert.equal(typedKeys({ list: () => 0 }), null);
  if (process.platform !== 'win32') assert.equal(altGrKeys(), null);
});

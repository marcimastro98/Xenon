import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateAction, actionSpec } = require('../js/deck-actions.js');
const { createRegistry, normalizeKeys } = require('../actions/registry.js');

// ---------------------------------------------------------------------------
// catalog + validateAction
// ---------------------------------------------------------------------------

test('hotkey is in the catalog with a single text "keys" param', () => {
  const spec = actionSpec('hotkey');
  assert.ok(spec, 'hotkey spec exists');
  assert.deepEqual(spec.params.map(p => p.name), ['keys']);
  assert.equal(spec.params[0].kind, 'text');
});

test('validateAction: hotkey keeps only keys, capped, strips junk', () => {
  assert.deepEqual(validateAction({ type: 'hotkey', keys: 'ctrl+shift+m', junk: 1 }),
    { type: 'hotkey', keys: 'ctrl+shift+m' });
});

// ---------------------------------------------------------------------------
// normalizeKeys — the security boundary before the PowerShell runner
// ---------------------------------------------------------------------------

test('normalizeKeys: accepts and canonicalises a valid combo', () => {
  assert.equal(normalizeKeys('Ctrl+Shift+M'), 'ctrl+shift+m');
  assert.equal(normalizeKeys('  alt + f4 '), 'alt+f4');
  assert.equal(normalizeKeys('win+up'), 'win+up');
  assert.equal(normalizeKeys('a'), 'a');
});

test('normalizeKeys: requires exactly one non-modifier key', () => {
  assert.equal(normalizeKeys('ctrl+shift'), '');     // modifiers only
  assert.equal(normalizeKeys('a+b'), '');            // two main keys
  assert.equal(normalizeKeys(''), '');
});

test('normalizeKeys: rejects unknown tokens and injection attempts', () => {
  assert.equal(normalizeKeys('ctrl+; rm -rf'), '');
  assert.equal(normalizeKeys('ctrl+m & calc'), '');
  assert.equal(normalizeKeys('f25'), '');            // out of F1..F24
  assert.equal(normalizeKeys('ctrl+foobar'), '');
});

// ---------------------------------------------------------------------------
// registry dispatch
// ---------------------------------------------------------------------------

test('registry: hotkey returns hotkey_unavailable when no dep is injected', async () => {
  const reg = createRegistry({});
  assert.deepEqual(await reg.run({ type: 'hotkey', keys: 'ctrl+m' }),
    { ok: false, error: 'hotkey_unavailable' });
});

test('registry: hotkey rejects a bad combo before calling the dep', async () => {
  let called = false;
  const reg = createRegistry({ sendHotkey: async () => { called = true; return { ok: true }; } });
  const res = await reg.run({ type: 'hotkey', keys: 'ctrl+; rm -rf' });
  assert.deepEqual(res, { ok: false, error: 'bad_keys' });
  assert.equal(called, false, 'dep must not be called for an invalid combo');
});

test('registry: hotkey forwards a normalised combo to the dep', async () => {
  let received = null;
  const reg = createRegistry({ sendHotkey: async (keys) => { received = keys; return { ok: true }; } });
  assert.deepEqual(await reg.run({ type: 'hotkey', keys: 'Ctrl+Shift+M' }), { ok: true });
  assert.equal(received, 'ctrl+shift+m');
});

test('registry: hotkey surfaces the dep failure reason', async () => {
  const reg = createRegistry({ sendHotkey: async () => ({ ok: false, error: 'no_target' }) });
  assert.deepEqual(await reg.run({ type: 'hotkey', keys: 'ctrl+m' }),
    { ok: false, error: 'no_target' });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPerfRegistry } = require('../actions/perf-registry.js');
const { validatePerfAction } = require('../js/performance-actions.js');

test('validatePerfAction enforces the typed allowlist', () => {
  assert.equal(validatePerfAction(null), null);
  assert.equal(validatePerfAction({ type: 'bogus' }), null);
  // closeApp: id must be 1–24 digits (a Win32 HWND).
  assert.deepEqual(validatePerfAction({ type: 'closeApp', id: '12345' }), { type: 'closeApp', id: '12345' });
  assert.equal(validatePerfAction({ type: 'closeApp', id: 'abc' }), null);
  assert.equal(validatePerfAction({ type: 'closeApp', id: '' }), null);
  assert.equal(validatePerfAction({ type: 'closeApp' }), null);
  // launchApp: path is a capped string (the registry re-checks ext + existence).
  assert.deepEqual(validatePerfAction({ type: 'launchApp', path: 'C:/a/b.exe' }), { type: 'launchApp', path: 'C:/a/b.exe' });
  // setPriority: process name sanitized (no path/ext), level coerced to a valid option.
  assert.deepEqual(validatePerfAction({ type: 'setPriority', name: 'cs2.exe', level: 'high' }), { type: 'setPriority', name: 'cs2', level: 'high' });
  assert.deepEqual(validatePerfAction({ type: 'setPriority', name: 'cs2', level: 'bogus' }), { type: 'setPriority', name: 'cs2', level: 'high' });
  assert.equal(validatePerfAction({ type: 'setPriority', name: 'C:/games/cs2.exe', level: 'high' }), null);
  assert.equal(validatePerfAction({ type: 'setPriority', name: '', level: 'normal' }), null);
});

test('run rejects unknown actions', async () => {
  const r = createPerfRegistry({});
  assert.deepEqual(await r.run({ type: 'bogus' }), { ok: false, error: 'unknown_action' });
  assert.deepEqual(await r.run(null), { ok: false, error: 'unknown_action' });
  assert.deepEqual(await r.run({ type: 'closeApp', id: 'nope' }), { ok: false, error: 'unknown_action' });
});

test('launchApp enforces extension + existence before opening', async () => {
  const calls = [];
  const okDeps = { fileExists: () => true, openExternal: (p) => { calls.push(p); return Promise.resolve(); } };
  // Non-executable path is rejected before existence is checked.
  assert.deepEqual(await createPerfRegistry(okDeps).run({ type: 'launchApp', path: 'C:/x/doc.txt' }), { ok: false, error: 'bad_app_path' });
  // Executable that doesn't exist → not_found.
  const missingDeps = { fileExists: () => false, openExternal: () => Promise.resolve() };
  assert.deepEqual(await createPerfRegistry(missingDeps).run({ type: 'launchApp', path: 'C:/x/app.exe' }), { ok: false, error: 'not_found' });
  // Existing executable launches.
  assert.deepEqual(await createPerfRegistry(okDeps).run({ type: 'launchApp', path: 'C:/x/app.exe' }), { ok: true });
  assert.deepEqual(calls, ['C:/x/app.exe']);
});

test('closeApp passes the validated id to the injected window helper', async () => {
  const ids = [];
  const deps = { closeWindow: (id) => { ids.push(id); return Promise.resolve({ ok: true, app: 'spotify', path: 'C:/x/spotify.exe' }); } };
  assert.deepEqual(await createPerfRegistry(deps).run({ type: 'closeApp', id: '987654' }),
    { ok: true, app: 'spotify', path: 'C:/x/spotify.exe' });
  assert.deepEqual(ids, ['987654']);
  // Missing dep degrades cleanly.
  assert.deepEqual(await createPerfRegistry({}).run({ type: 'closeApp', id: '1' }), { ok: false, error: 'unavailable' });
});

test('setPriority passes the validated name + level to the injected helper', async () => {
  const calls = [];
  const deps = { setPriority: (name, level) => { calls.push([name, level]); return Promise.resolve({ ok: true, count: 1 }); } };
  assert.deepEqual(await createPerfRegistry(deps).run({ type: 'setPriority', name: 'cs2.exe', level: 'high' }), { ok: true, count: 1 });
  assert.deepEqual(calls, [['cs2', 'high']]);
  // Missing dep degrades cleanly.
  assert.deepEqual(await createPerfRegistry({}).run({ type: 'setPriority', name: 'cs2', level: 'normal' }), { ok: false, error: 'unavailable' });
});

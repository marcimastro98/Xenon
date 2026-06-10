import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateAction } = require('../js/deck-actions.js');
const { createRegistry } = require('../actions/registry.js');

// ---------------------------------------------------------------------------
// validateAction
// ---------------------------------------------------------------------------

test('validateAction: appVolume strips junk and keeps valid params', () => {
  assert.deepEqual(
    validateAction({ type: 'appVolume', app: 'spotify', mode: 'down', junk: 1 }),
    { type: 'appVolume', app: 'spotify', mode: 'down' }
  );
});

test('validateAction: appVolume coerces bogus mode to first option (up)', () => {
  const result = validateAction({ type: 'appVolume', app: 'x', mode: 'bogus' });
  assert.equal(result.mode, 'up');
});

test('validateAction: appMute coerces bogus mode to first option (toggle)', () => {
  const result = validateAction({ type: 'appMute', app: 'x', mode: 'bogus' });
  assert.equal(result.mode, 'toggle');
});

// ---------------------------------------------------------------------------
// registry: appVolume
// ---------------------------------------------------------------------------

test('registry: appVolume trims app, calls dep with trimmed app+mode, returns ok:true', async () => {
  let calledWith = null;
  const d = {
    appVolume: async (app, mode) => { calledWith = { app, mode }; },
  };
  const r = createRegistry(d);
  const result = await r.run({ type: 'appVolume', app: ' chrome ', mode: 'down' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calledWith, { app: 'chrome', mode: 'down' });
});

test('registry: appVolume with empty app returns no_app and does not call dep', async () => {
  let called = false;
  const d = { appVolume: async () => { called = true; } };
  const r = createRegistry(d);
  const result = await r.run({ type: 'appVolume', app: '  ', mode: 'up' });
  assert.deepEqual(result, { ok: false, error: 'no_app' });
  assert.equal(called, false, 'dep must not be called for empty app');
});

test('registry: appVolume with missing dep returns unavailable', async () => {
  const r = createRegistry({});
  const result = await r.run({ type: 'appVolume', app: 'spotify', mode: 'up' });
  assert.deepEqual(result, { ok: false, error: 'unavailable' });
});

test('registry: appVolume dep returning {ok:false, error:"boom"} is forwarded', async () => {
  const d = { appVolume: async () => ({ ok: false, error: 'boom' }) };
  const r = createRegistry(d);
  const result = await r.run({ type: 'appVolume', app: 'spotify', mode: 'up' });
  assert.deepEqual(result, { ok: false, error: 'boom' });
});

// ---------------------------------------------------------------------------
// registry: appMute
// ---------------------------------------------------------------------------

test('registry: appMute trims app, calls dep with trimmed app+mode, returns ok:true', async () => {
  let calledWith = null;
  const d = {
    appMute: async (app, mode) => { calledWith = { app, mode }; },
  };
  const r = createRegistry(d);
  const result = await r.run({ type: 'appMute', app: ' discord ', mode: 'mute' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calledWith, { app: 'discord', mode: 'mute' });
});

test('registry: appMute with empty app returns no_app and does not call dep', async () => {
  let called = false;
  const d = { appMute: async () => { called = true; } };
  const r = createRegistry(d);
  const result = await r.run({ type: 'appMute', app: '  ', mode: 'toggle' });
  assert.deepEqual(result, { ok: false, error: 'no_app' });
  assert.equal(called, false, 'dep must not be called for empty app');
});

test('registry: appMute with missing dep returns unavailable', async () => {
  const r = createRegistry({});
  const result = await r.run({ type: 'appMute', app: 'discord', mode: 'toggle' });
  assert.deepEqual(result, { ok: false, error: 'unavailable' });
});

test('registry: appMute dep returning {ok:false, error:"boom"} is forwarded', async () => {
  const d = { appMute: async () => ({ ok: false, error: 'boom' }) };
  const r = createRegistry(d);
  const result = await r.run({ type: 'appMute', app: 'discord', mode: 'toggle' });
  assert.deepEqual(result, { ok: false, error: 'boom' });
});

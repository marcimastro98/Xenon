import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateAction } = require('../js/deck-actions.js');
const { createRegistry } = require('../actions/registry.js');

// The `tasks` action category (taskAdd/taskToggle/taskDelete) — the write path
// behind the TTY // TODO widget. validateAction is the boundary that caps/keeps
// only the declared params; the registry dispatches to injected deps and never
// throws.

// ── validateAction ──────────────────────────────────────────────────────────
test('validateAction: taskAdd keeps only text, drops junk', () => {
  assert.deepEqual(
    validateAction({ type: 'taskAdd', text: 'buy milk', id: 'x', junk: 1 }),
    { type: 'taskAdd', text: 'buy milk' }
  );
});

test('validateAction: taskAdd caps very long text at 1024 chars', () => {
  const r = validateAction({ type: 'taskAdd', text: 'a'.repeat(5000) });
  assert.equal(r.text.length, 1024);
});

test('validateAction: taskToggle / taskDelete keep only id', () => {
  assert.deepEqual(validateAction({ type: 'taskToggle', id: 'n1', text: 'no' }), { type: 'taskToggle', id: 'n1' });
  assert.deepEqual(validateAction({ type: 'taskDelete', id: 'n2' }), { type: 'taskDelete', id: 'n2' });
});

// ── registry: taskAdd ─────────────────────────────────────────────────────────
test('registry: taskAdd trims text, calls dep, returns ok', async () => {
  let got = null;
  const r = createRegistry({ taskAdd: async (text) => { got = text; } });
  const res = await r.run({ type: 'taskAdd', text: '  water plants  ' });
  assert.deepEqual(res, { ok: true });
  assert.equal(got, 'water plants');
});

test('registry: taskAdd with empty text returns empty_text and never calls dep', async () => {
  let called = false;
  const r = createRegistry({ taskAdd: async () => { called = true; } });
  const res = await r.run({ type: 'taskAdd', text: '   ' });
  assert.deepEqual(res, { ok: false, error: 'empty_text' });
  assert.equal(called, false);
});

test('registry: taskAdd without a dep returns unavailable', async () => {
  const r = createRegistry({});
  assert.deepEqual(await r.run({ type: 'taskAdd', text: 'x' }), { ok: false, error: 'unavailable' });
});

// ── registry: taskToggle / taskDelete ─────────────────────────────────────────
test('registry: taskToggle forwards trimmed id and surfaces not_found', async () => {
  let got = null;
  const ok = createRegistry({ taskToggle: async (id) => { got = id; return { ok: true }; } });
  assert.deepEqual(await ok.run({ type: 'taskToggle', id: ' n1 ' }), { ok: true });
  assert.equal(got, 'n1');
  const miss = createRegistry({ taskToggle: async () => ({ ok: false, error: 'not_found' }) });
  assert.deepEqual(await miss.run({ type: 'taskToggle', id: 'zzz' }), { ok: false, error: 'not_found' });
});

test('registry: taskDelete with empty id returns empty_id', async () => {
  let called = false;
  const r = createRegistry({ taskDelete: async () => { called = true; } });
  assert.deepEqual(await r.run({ type: 'taskDelete', id: '' }), { ok: false, error: 'empty_id' });
  assert.equal(called, false);
});

// ── SDK exposure: the category is in the widget allowlist ─────────────────────
test('sdk-widgets: tasks category exposes exactly the three task action types', () => {
  const sdk = require('../sdk-widgets.js');
  assert.deepEqual(sdk.SDK_ACTION_CATEGORIES.tasks, ['taskAdd', 'taskToggle', 'taskDelete']);
  for (const t of ['taskAdd', 'taskToggle', 'taskDelete']) {
    assert.ok(sdk.SDK_ACTION_TYPES.includes(t), t + ' must be a valid SDK action type');
  }
});

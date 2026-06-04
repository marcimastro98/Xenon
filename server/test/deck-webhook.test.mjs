import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateAction } = require('../js/deck-actions.js');
const { createRegistry } = require('../actions/registry.js');

// ---------------------------------------------------------------------------
// validateAction
// ---------------------------------------------------------------------------

test('validateAction: webhook strips junk and keeps valid params', () => {
  assert.deepEqual(
    validateAction({ type: 'webhook', url: 'x', method: 'POST', body: '{}', junk: 1 }),
    { type: 'webhook', url: 'x', method: 'POST', body: '{}' }
  );
});

test('validateAction: bad method is coerced to GET (select default)', () => {
  assert.deepEqual(
    validateAction({ type: 'webhook', url: 'https://example.com', method: 'DELETE', body: '' }),
    { type: 'webhook', url: 'https://example.com', method: 'GET', body: '' }
  );
});

test('validateAction: missing method defaults to GET', () => {
  const result = validateAction({ type: 'webhook', url: 'https://example.com' });
  assert.equal(result.method, 'GET');
});

// ---------------------------------------------------------------------------
// registry: webhook case
// ---------------------------------------------------------------------------

test('registry: non-http url returns bad_url without calling fetch', async () => {
  const saved = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true }; };
  try {
    const r = createRegistry({});
    const result = await r.run({ type: 'webhook', url: 'javascript:alert(1)', method: 'GET', body: '' });
    assert.deepEqual(result, { ok: false, error: 'bad_url' });
    assert.equal(fetchCalled, false, 'fetch must not be called for a bad url');
  } finally {
    globalThis.fetch = saved;
  }
});

test('registry: successful GET response yields ok:true', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const r = createRegistry({});
    const result = await r.run({ type: 'webhook', url: 'https://example.com', method: 'GET', body: '' });
    assert.deepEqual(result, { ok: true });
  } finally {
    globalThis.fetch = saved;
  }
});

test('registry: 500 response yields ok:false error:http_500', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    const r = createRegistry({});
    const result = await r.run({ type: 'webhook', url: 'https://example.com', method: 'POST', body: '{"a":1}' });
    assert.deepEqual(result, { ok: false, error: 'http_500' });
  } finally {
    globalThis.fetch = saved;
  }
});

test('registry: TimeoutError yields ok:false error:timeout', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
  try {
    const r = createRegistry({});
    const result = await r.run({ type: 'webhook', url: 'https://example.com', method: 'GET', body: '' });
    assert.deepEqual(result, { ok: false, error: 'timeout' });
  } finally {
    globalThis.fetch = saved;
  }
});

test('registry: generic fetch error yields ok:false error:fetch_failed', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network unreachable'); };
  try {
    const r = createRegistry({});
    const result = await r.run({ type: 'webhook', url: 'https://example.com', method: 'GET', body: '' });
    assert.deepEqual(result, { ok: false, error: 'fetch_failed' });
  } finally {
    globalThis.fetch = saved;
  }
});

test('registry: POST with body passes body and Content-Type to fetch', async () => {
  const saved = globalThis.fetch;
  let capturedInit;
  globalThis.fetch = async (_url, init) => { capturedInit = init; return { ok: true }; };
  try {
    const r = createRegistry({});
    await r.run({ type: 'webhook', url: 'https://example.com', method: 'POST', body: '{"a":1}' });
    assert.equal(capturedInit.body, '{"a":1}');
    assert.equal(capturedInit.headers['Content-Type'], 'application/json');
  } finally {
    globalThis.fetch = saved;
  }
});

test('registry: GET does not attach a body', async () => {
  const saved = globalThis.fetch;
  let capturedInit;
  globalThis.fetch = async (_url, init) => { capturedInit = init; return { ok: true }; };
  try {
    const r = createRegistry({});
    await r.run({ type: 'webhook', url: 'https://example.com', method: 'GET', body: 'ignored' });
    assert.equal(capturedInit.body, undefined);
    assert.equal(capturedInit.headers, undefined);
  } finally {
    globalThis.fetch = saved;
  }
});

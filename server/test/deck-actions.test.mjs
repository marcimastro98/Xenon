import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const da = require('../js/deck-actions.js');

test('ACTION_CATALOG entries each have type, group, labelKey, params[]', () => {
  assert.ok(Array.isArray(da.ACTION_CATALOG) && da.ACTION_CATALOG.length > 0);
  for (const a of da.ACTION_CATALOG) {
    assert.equal(typeof a.type, 'string');
    assert.equal(typeof a.group, 'string');
    assert.equal(typeof a.labelKey, 'string');
    assert.ok(Array.isArray(a.params));
  }
});

test('actionSpec returns the spec or null', () => {
  assert.equal(da.actionSpec('openUrl').type, 'openUrl');
  assert.equal(da.actionSpec('nope'), null);
});

test('validateAction rejects unknown/garbage and returns null', () => {
  assert.equal(da.validateAction(null), null);
  assert.equal(da.validateAction({ type: 'bogus' }), null);
  assert.equal(da.validateAction('hi'), null);
});

test('validateAction keeps only spec params and coerces select to a valid option', () => {
  const a = da.validateAction({ type: 'media', cmd: 'next', extra: 'drop me' });
  assert.deepEqual(a, { type: 'media', cmd: 'next' });
  const b = da.validateAction({ type: 'media', cmd: 'not-an-option' });
  assert.equal(b.cmd, 'playpause');
});

test('validateAction stringifies and length-caps text/url/path params', () => {
  const a = da.validateAction({ type: 'openUrl', url: 123 });
  assert.equal(a.url, '123');
  const long = 'x'.repeat(5000);
  const b = da.validateAction({ type: 'openApp', path: long });
  assert.ok(b.path.length <= 1024);
});

test('validateAction: sdkHandler args carries JSON and gets the wider per-param cap', () => {
  // 4 params × 200-char values whose JSON escaping doubles them exceeds the
  // default 1024 cap; a mid-string truncation would make the stored JSON
  // unparseable and every press fail with bad_args — args declares maxLen 4096.
  const quoteHeavy = '"'.repeat(200);   // escapes to 400 chars per value
  const argsJson = JSON.stringify({ a: quoteHeavy, b: quoteHeavy, c: quoteHeavy, d: quoteHeavy });
  assert.ok(argsJson.length > 1024);
  const a = da.validateAction({ type: 'sdkHandler', handler: 'pkg/run', args: argsJson });
  assert.equal(a.args, argsJson);                     // survives whole → still parseable
  assert.deepEqual(JSON.parse(a.args).a.length, 200);
  const over = da.validateAction({ type: 'sdkHandler', handler: 'pkg/run', args: 'x'.repeat(9000) });
  assert.equal(over.args.length, 4096);               // still bounded
});

test('clampDelay coerces to an int in 0..10000', () => {
  assert.equal(da.clampDelay(120), 120);
  assert.equal(da.clampDelay(-5), 0);
  assert.equal(da.clampDelay(999999), 10000);
  assert.equal(da.clampDelay('abc'), 0);
  assert.equal(da.clampDelay(undefined), 0);
});

test('triggerSteps canonicalises a single action into one zero-delay step', () => {
  assert.deepEqual(da.triggerSteps({ type: 'media', cmd: 'next' }), [{ action: { type: 'media', cmd: 'next' }, delayMs: 0 }]);
});

test('triggerSteps expands a multi-action, validating each step and dropping bad ones', () => {
  const t = { steps: [
    { action: { type: 'media', cmd: 'next' }, delayMs: 100 },
    { action: { type: 'bogus' }, delayMs: 50 },
    { action: { type: 'micMute', mode: 'toggle' } },
  ] };
  assert.deepEqual(da.triggerSteps(t), [
    { action: { type: 'media', cmd: 'next' }, delayMs: 100 },
    { action: { type: 'micMute', mode: 'toggle' }, delayMs: 0 },
  ]);
});

test('triggerSteps returns [] for empty/invalid triggers', () => {
  assert.deepEqual(da.triggerSteps(null), []);
  assert.deepEqual(da.triggerSteps({}), []);
  assert.deepEqual(da.triggerSteps({ type: 'bogus' }), []);
  assert.deepEqual(da.triggerSteps({ steps: [] }), []);
});

test('compactTrigger drops invalid steps and returns null when empty', () => {
  assert.equal(da.compactTrigger(null), null);
  assert.equal(da.compactTrigger([]), null);
  assert.equal(da.compactTrigger([{ action: { type: 'bogus' }, delayMs: 0 }]), null);
});

test('compactTrigger returns a bare Action for a single zero-delay step', () => {
  assert.deepEqual(da.compactTrigger([{ action: { type: 'media', cmd: 'next' }, delayMs: 0 }]), { type: 'media', cmd: 'next' });
});

test('compactTrigger returns {steps} for multiple steps or a non-zero delay', () => {
  assert.deepEqual(
    da.compactTrigger([{ action: { type: 'media', cmd: 'next' }, delayMs: 200 }]),
    { steps: [{ action: { type: 'media', cmd: 'next' }, delayMs: 200 }] },
  );
  assert.deepEqual(
    da.compactTrigger([
      { action: { type: 'media', cmd: 'next' }, delayMs: 0 },
      { action: { type: 'micMute', mode: 'toggle' }, delayMs: 120 },
    ]),
    { steps: [
      { action: { type: 'media', cmd: 'next' }, delayMs: 0 },
      { action: { type: 'micMute', mode: 'toggle' }, delayMs: 120 },
    ] },
  );
});

test('compactTrigger round-trips through triggerSteps', () => {
  const compact = da.compactTrigger([
    { action: { type: 'openUrl', url: 'https://x.com' }, delayMs: 0 },
    { action: { type: 'micMute', mode: 'toggle' }, delayMs: 50 },
  ]);
  assert.deepEqual(da.triggerSteps(compact), [
    { action: { type: 'openUrl', url: 'https://x.com' }, delayMs: 0 },
    { action: { type: 'micMute', mode: 'toggle' }, delayMs: 50 },
  ]);
});

test('validateAction normalises the ai action (mode default + prompt)', () => {
  // mode defaults to the first option (prompt); prompt is kept as text.
  assert.deepEqual(da.validateAction({ type: 'ai' }), { type: 'ai', mode: 'prompt', prompt: '' });
  assert.deepEqual(da.validateAction({ type: 'ai', mode: 'voice', prompt: 'ignored' }), { type: 'ai', mode: 'voice', prompt: 'ignored' });
  // an unknown mode falls back to the first option.
  assert.equal(da.validateAction({ type: 'ai', mode: 'bogus' }).mode, 'prompt');
});

test('validateAction normalises the lighting action', () => {
  assert.deepEqual(da.validateAction({ type: 'lighting' }), { type: 'lighting', mode: 'set', color: '', style: 'solid' });
  assert.deepEqual(da.validateAction({ type: 'lighting', mode: 'restore', color: '#ff0000', style: 'breathing' }), { type: 'lighting', mode: 'restore', color: '#ff0000', style: 'breathing' });
  assert.equal(da.validateAction({ type: 'lighting', style: 'bogus' }).style, 'solid'); // bad style → first option
});

test('valida remoteDisconnect (nessun parametro)', () => {
  assert.deepEqual(da.validateAction({ type: 'remoteDisconnect' }), { type: 'remoteDisconnect' });
});

test('valida remoteBlock con mode coerentizzato', () => {
  assert.equal(da.validateAction({ type: 'remoteBlock', mode: 'block' }).mode, 'block');
  assert.equal(da.validateAction({ type: 'remoteBlock', mode: 'xxx' }).mode, 'toggle');
});

test('valida remoteScreenCycle (nessun parametro)', () => {
  assert.deepEqual(da.validateAction({ type: 'remoteScreenCycle' }), { type: 'remoteScreenCycle' });
});

// Hub message targeting (js/hub-match.js). This is the code that decides who
// sees an announcement, and it runs on the user's machine so no identifier ever
// leaves. A bug here is not recoverable: a message meant for a few installs
// reaches everyone, and it cannot be unsent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HubMatch = require('../js/hub-match.js');

const ctx = (over = {}) => ({
  version: '4.9.0',
  os: 'win32',
  lang: 'it',
  installed: new Set(['dgm-news']),
  ...over,
});
const withMatch = (match) => ({ id: 'm', level: 'toast', title: 'T', match });

// ── Version comparison ─────────────────────────────────────────────────────
test('cmpVersion orders numerically, not lexically', () => {
  const { cmpVersion } = HubMatch;
  assert.equal(cmpVersion('4.9.0', '4.9.0'), 0);
  assert.equal(cmpVersion('4.10.0', '4.9.0'), 1, '10 is above 9, not below');
  assert.equal(cmpVersion('4.9.0', '4.10.0'), -1);
  assert.equal(cmpVersion('5.0.0', '4.9.9'), 1);
});

test('a shorter version is zero-padded, so 4.9 and 4.9.0 are the same', () => {
  const { cmpVersion } = HubMatch;
  assert.equal(cmpVersion('4.9', '4.9.0'), 0);
  assert.equal(cmpVersion('4.9.0', '4.9'), 0);
  assert.equal(cmpVersion('4.9.1', '4.9'), 1);
  assert.equal(cmpVersion('5', '4.9.9'), 1);
});

test('junk sorts as zero rather than throwing', () => {
  const { cmpVersion } = HubMatch;
  assert.equal(cmpVersion('', ''), 0);
  assert.equal(cmpVersion(null, undefined), 0);
  assert.equal(cmpVersion('4.x.0', '4.0.0'), 0, 'the bad part reads as 0');
});

// ── No conditions ──────────────────────────────────────────────────────────
test('a message with no match block goes to everyone', () => {
  assert.equal(HubMatch.matches({ id: 'm', title: 'T' }, ctx()), true);
  assert.equal(HubMatch.matches(withMatch(null), ctx()), true);
  assert.equal(HubMatch.matches(withMatch(undefined), ctx()), true);
});

// ── The fail-closed rule ───────────────────────────────────────────────────
// This is the one that matters most. A dashboard that shipped before a
// condition existed must show the message to NOBODY, not to everybody.
test('an unknown condition matches nobody', () => {
  assert.equal(HubMatch.matches(withMatch({ supporter: true }), ctx()), false);
  assert.equal(HubMatch.matches(withMatch({ hasHardware: 'xeneon-edge' }), ctx()), false);
  // Even alongside conditions that DO pass.
  assert.equal(HubMatch.matches(withMatch({ os: ['win32'], supporter: true }), ctx()), false);
  // A malformed block is not a missing block.
  assert.equal(HubMatch.matches(withMatch([]), ctx()), false);
  assert.equal(HubMatch.matches(withMatch('supporters'), ctx()), false);
});

// ── Version bounds ─────────────────────────────────────────────────────────
test('version bounds are inclusive at both ends', () => {
  assert.equal(HubMatch.matches(withMatch({ minVersion: '4.9.0' }), ctx()), true);
  assert.equal(HubMatch.matches(withMatch({ maxVersion: '4.9.0' }), ctx()), true);
  assert.equal(HubMatch.matches(withMatch({ minVersion: '4.9.1' }), ctx()), false);
  assert.equal(HubMatch.matches(withMatch({ maxVersion: '4.8.9' }), ctx()), false);
  assert.equal(HubMatch.matches(withMatch({ minVersion: '4.8.0', maxVersion: '5.0.0' }), ctx()), true);
});

test('an unknown local version fails a version bound instead of passing it', () => {
  const blind = ctx({ version: '' });
  assert.equal(HubMatch.matches(withMatch({ minVersion: '4.0.0' }), blind), false);
  assert.equal(HubMatch.matches(withMatch({ maxVersion: '9.0.0' }), blind), false);
  // With no version condition, an unknown version is irrelevant.
  assert.equal(HubMatch.matches(withMatch({ os: ['win32'] }), blind), true);
});

// ── Platform and language ──────────────────────────────────────────────────
test('os and lang are membership tests', () => {
  assert.equal(HubMatch.matches(withMatch({ os: ['win32', 'linux'] }), ctx()), true);
  assert.equal(HubMatch.matches(withMatch({ os: ['linux'] }), ctx()), false);
  assert.equal(HubMatch.matches(withMatch({ lang: ['it', 'es'] }), ctx()), true);
  assert.equal(HubMatch.matches(withMatch({ lang: ['en'] }), ctx()), false);
  assert.equal(HubMatch.matches(withMatch({ os: ['win32'] }), ctx({ os: '' })), false);
});

// ── Installed entries ──────────────────────────────────────────────────────
test('hasEntry matches anyone running ANY of the listed entries', () => {
  assert.equal(HubMatch.matches(withMatch({ hasEntry: ['dgm-news'] }), ctx()), true);
  assert.equal(HubMatch.matches(withMatch({ hasEntry: ['neon-pack', 'dgm-news'] }), ctx()), true);
  assert.equal(HubMatch.matches(withMatch({ hasEntry: ['neon-pack'] }), ctx()), false);
  assert.equal(HubMatch.matches(withMatch({ hasEntry: ['dgm-news'] }), ctx({ installed: new Set() })), false);
});

test('installed accepts a Set or a plain array', () => {
  const m = withMatch({ hasEntry: ['dgm-news'] });
  assert.equal(HubMatch.matches(m, ctx({ installed: ['dgm-news'] })), true);
  assert.equal(HubMatch.matches(m, ctx({ installed: ['other'] })), false);
  assert.equal(HubMatch.matches(m, ctx({ installed: null })), false);
});

// ── Conditions combine with AND ────────────────────────────────────────────
test('every condition must hold, not just one', () => {
  const m = withMatch({ minVersion: '4.9.0', os: ['win32'], hasEntry: ['dgm-news'] });
  assert.equal(HubMatch.matches(m, ctx()), true);
  assert.equal(HubMatch.matches(m, ctx({ os: 'linux' })), false);
  assert.equal(HubMatch.matches(m, ctx({ version: '4.8.0' })), false);
  assert.equal(HubMatch.matches(m, ctx({ installed: new Set(['other']) })), false);
});

test('a missing context does not crash the filter', () => {
  assert.equal(HubMatch.matches(withMatch({ os: ['win32'] }), undefined), false);
  assert.equal(HubMatch.matches({ id: 'm', title: 'T' }, undefined), true);
});

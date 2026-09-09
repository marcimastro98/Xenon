// "Is there a reference voice clip on how to voice activate Xenon AI?"
//
// Asked on Discord, and the honest answer is that there is nothing to learn by
// ear: the matcher is deliberately loose about the name. What there IS to know
// is the timing, and it was documented nowhere — say the wake phrase as the
// start of a sentence, in one breath, and it is thrown away, because anything
// longer than MAX_SEGMENT_MS is conversation rather than a wake phrase. That is
// exactly what a first-time user does.
//
// The docs now say it. These assertions keep them true: a doc that drifts from
// the constant is worse than no doc, because it teaches the wrong habit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wake = require('../wakeword.js');
const FEATURES = readFileSync(new URL('../../FEATURES.md', import.meta.url), 'utf8');
const SRC = readFileSync(new URL('../wakeword.js', import.meta.url), 'utf8');

test('the documented pause limit is the one the code enforces', () => {
  const ms = Number(SRC.match(/const MAX_SEGMENT_MS = (\d+);/)[1]);
  const doc = FEATURES.match(/\*\*(\d+) seconds of unbroken speech\*\*/);
  assert.ok(doc, 'FEATURES.md no longer states the limit');
  assert.equal(Number(doc[1]) * 1000, ms, 'the docs and MAX_SEGMENT_MS disagree');
});

test('every spelling the docs promise really does match', () => {
  // The list in FEATURES.md is a promise to the reader; each one has to pass the
  // matcher or the promise is false.
  for (const said of ['zenon', 'senon', 'sanon', 'zenone', 'xeneon', 'xenon']) {
    assert.ok(wake.matchesWakeWord(said), `"${said}" is documented but does not match`);
    assert.ok(FEATURES.includes(said), `${said} is matched but not in the documented list`);
  }
});

test('"Hey" really is optional, as the docs say', () => {
  assert.match(FEATURES, /\*\*"Hey" is optional\*\*/);
  assert.ok(wake.matchesWakeWord('xenon'));
  assert.ok(wake.matchesWakeWord('hey xenon'));
  assert.ok(wake.matchesWakeWord('ehi zenon'));
});

test('the loose match still refuses ordinary speech', () => {
  // The reason the docs can promise "say it however it comes out" is that the
  // skeleton is anchored. If these ever start matching, the advice becomes a
  // dashboard that opens while you talk to someone.
  for (const said of ['se non', 'season', 'sano', 'send it over', 'the sun on my face']) {
    assert.ok(!wake.matchesWakeWord(said), `"${said}" would wake the assistant`);
  }
});

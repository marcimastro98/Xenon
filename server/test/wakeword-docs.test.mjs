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
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

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

test('the setting itself says how to say it, in every language', () => {
  // FEATURES.md is where someone looks afterwards; the hint under the switch is
  // where they look BEFORE trying it, which is when the timing matters. Five of
  // these languages used to inherit the English hint through the `...i18n.en`
  // spread, so the whole setting read in English for them.
  for (const key of ['settings_wake', 'settings_wake_hint']) {
    const owned = I18N.split('\n').filter((l) => {
      const t = l.trimStart();
      return t.startsWith(`${key}:`) || t.startsWith(`'${key}':`) || t.startsWith(`"${key}":`);
    });
    assert.equal(owned.length, LANGS.length,
      `${key} is defined ${owned.length} times, expected one per language (${LANGS.length})`);
  }
});

test('every hint carries the pause, not just the phrase', () => {
  // The one thing that makes the difference between it working and not.
  const hints = I18N.split('\n').filter((l) => l.trimStart().replace(/^["']/, '').startsWith('settings_wake_hint'));
  assert.equal(hints.length, LANGS.length);
  for (const line of hints) {
    // Each language words it its own way; what has to be there is a second
    // sentence about saying it alone, so a one-sentence hint fails this.
    const value = line.slice(line.indexOf(':') + 1);
    assert.ok(value.split(/[.。！]/).filter((p) => p.trim()).length >= 4,
      `a hint lost its timing sentence: ${value.slice(0, 60)}…`);
  }
});

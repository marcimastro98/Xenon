// What normalizeHubSettings answers, pinned: the real function is asked a fixed list of
// questions and every answer, key order included, is compared with the answers written down
// in fixtures/settings-normalize-snapshot.json. The function is being cut into parts by
// tools/restructure; this test does not read how it is written, so it passes unchanged
// whatever the cut, and fails the day one answer or the order of two keys changes.
//
// The answers were written by this test's first run and committed. To write them again
// after a change of behaviour that is meant (never to make a restructure step pass):
//   XENON_WRITE_SNAPSHOT=1 node --test server/test/settings-normalize-behaviour.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { liveFunction, NO_PARSER } from './engine-live.mjs';
import { BATTERY, brief, digest, layoutQuestions, leavesOf, otherLeaves, realistic, show, TOGETHER, withLeaf } from './settings-normalize-corpus.mjs';

const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'settings-normalize-snapshot.json');
const WRITE = process.env.XENON_WRITE_SNAPSHOT === '1';
const AS_DEFAULT = 'as with nothing stored';
const REST = 'every other value';
const MANY = 8;
// The one answer that depends on the computer: the folder file search starts from.
const HERE = new Set(['C:\\', os.homedir()]);
const mask = (text) => (HERE.has(text) ? '<where file search starts>' : text);
const text = (value) => show(value, mask);

const normalize = await liveFunction('normalizeHubSettings');

/** How an answer differs from the answer to nothing: the keys in another order, and each key with another value. */
function differenceFrom(base, result) {
  const keys = Object.keys(result);
  const order = isDeepStrictEqual(keys, base.keys) ? [] : [`keys: ${keys.join(',')}`];
  const changed = keys.filter((key) => !isDeepStrictEqual(result[key], base.result[key])).map((key) => `${key}=${brief(text(result[key]))}`);
  return [...order, ...changed].join(' | ') || AS_DEFAULT;
}

// The battery values that get the same answer are written once: [the values, the answer], the largest group as "every other value".
function grouped(answers) {
  const groups = new Map();
  for (const [label, answer] of answers) groups.set(answer, [...(groups.get(answer) ?? []), label]);
  const largest = [...groups.values()].reduce((most, labels) => (labels.length > most.length ? labels : most), []);
  // A key that keeps any text as it is gives one answer per value: too many to read, so they are written as one digest.
  if (groups.size > MANY) return [[`${groups.size} different answers`, digest(answers.map(([label, answer]) => `${label}: ${answer}`).join('\n'))]];
  return [...groups].map(([answer, labels]) => [labels === largest ? REST : labels.join(' '), answer]);
}

// The questions by section, each asked only when its answers are wanted.
function questionsOf(ask) {
  const result = ask({});
  const base = { keys: Object.keys(result), result };
  const differs = (input) => differenceFrom(base, ask(input));
  const version = { dashboardLayoutVersion: result.dashboardLayoutVersion };
  const structured = base.keys.filter((key) => result[key] !== null && typeof result[key] === 'object');
  const person = realistic(result);
  return {
    'not settings at all': () => Object.fromEntries([['nothing', undefined], ['null', null], ['a text', 'text'], ['a number', 7], ['a list', []],
      ['a list of settings', [{ appearance: 'light' }]], ['true', true]].map(([label, value]) => [label, differenceFrom(base, ask(value))])),
    'nothing stored': () => ({ keys: base.keys, values: Object.fromEntries(base.keys.map((key) => [key, JSON.parse(text(result[key]))])) }),
    'one key stored': () => Object.fromEntries(base.keys.map((key) => [key, grouped(BATTERY.map(([label, value]) => [label, differs({ [key]: value })]))])),
    'every key stored with the same value': () => Object.fromEntries(BATTERY.map(([label, value]) => [label,
      digest(text(ask(Object.fromEntries(base.keys.map((key) => [key, value])))))])),
    'one value changed inside a key': () => Object.fromEntries(structured.map((key) => {
      // A value that depends on the computer is not changed: the question would differ from one computer to the next.
      const answers = leavesOf(result[key]).filter(({ value }) => !HERE.has(value)).flatMap(({ path: where, value }) => otherLeaves(value).map((leaf) => differs({ ...version, [key]: withLeaf(result[key], where, leaf) })));
      return [key, `${answers.length} questions, ${digest(answers.join('\n'))}`];
    })),
    'the settings of a person': () => ({
      whole: differs(person).split(' | '),
      'one key of them': Object.fromEntries(Object.keys(person).map((key) => [key, differs({ [key]: person[key] })])),
    }),
    'the layout and its version': () => Object.fromEntries(layoutQuestions(result).map(({ label, input }) => [label, differs(input)])),
    'keys read together': () => Object.fromEntries(TOGETHER.map(([label, input]) => [label, differs(input)])),
  };
}

/** The answers of `ask` as they are written down: every section, or the ones named. */
function answersOf(ask, only) {
  return Object.fromEntries(Object.entries(questionsOf(ask)).filter(([section]) => !only || only.includes(section)).map(([section, answers]) => [section, answers()]));
}

// The first place two written answers differ, to say where to look.
function firstDifference(was, now, where = '') {
  if (isDeepStrictEqual(was, now)) return '';
  const both = [was, now].every((side) => side !== null && typeof side === 'object');
  if (!both) return `${where}\n  was: ${JSON.stringify(was)}\n  now: ${JSON.stringify(now)}`;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const found = firstDifference(was[key], now[key], where ? `${where} > ${key}` : key);
    if (found) return found;
  }
  return `${where}: the same answers in another order`;
}

const made = normalize ? answersOf(normalize) : null;
if (made && WRITE) writeFileSync(SNAPSHOT, `${JSON.stringify(made, null, 1)}\n`);
const written = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : null;
// What is compared is what a file can hold: the answers after a trip through JSON.
const asWritten = made && JSON.parse(JSON.stringify(made));

test('the answers were written down, and for the same questions', (t) => {
  if (!made) return t.skip(NO_PARSER);
  assert.ok(written, 'no answers are written down: run once with XENON_WRITE_SNAPSHOT=1 and commit the file');
  assert.deepEqual(Object.keys(written), Object.keys(asWritten));
});

for (const section of Object.keys(asWritten ?? {})) {
  test(`normalizeHubSettings answers as written down: ${section}`, () => {
    assert.ok(written, 'no answers are written down');
    assert.equal(firstDifference(written[section], asWritten[section]), '');
    // Key order is part of an answer, and deepEqual does not look at it.
    assert.equal(JSON.stringify(asWritten[section]), JSON.stringify(written[section]));
  });
}

test('every answer has the keys of the answer to nothing, in the same order', (t) => {
  if (!made) return t.skip(NO_PARSER);
  const keys = Object.keys(normalize({}));
  assert.ok(keys.length > 150, `only ${keys.length} keys`);
  assert.equal(new Set(keys).size, keys.length);
  const person = realistic(normalize({}));
  for (const input of [person, ...BATTERY.map(([, value]) => Object.fromEntries(keys.map((key) => [key, value]))), ...TOGETHER.map(([, value]) => value)]) {
    assert.deepEqual(Object.keys(normalize(input)), keys);
  }
});

test('asked again, the function gives the same answers', (t) => {
  if (!made) return t.skip(NO_PARSER);
  const again = answersOf(normalize, Object.keys(made).filter((section) => section !== 'one key stored'));
  for (const section of Object.keys(again)) assert.equal(JSON.stringify(again[section]), JSON.stringify(made[section]), section);
});

test('the questions are enough to notice a change: an answer bent on purpose is found, and so is a key out of place', (t) => {
  if (!made) return t.skip(NO_PARSER);
  const keys = Object.keys(normalize({}));
  const bent = (key, how) => (input) => { const result = normalize(input); return { ...result, [key]: how(result[key], input) }; };
  const swapped = (input) => { const result = normalize(input); const order = [keys[1], keys[0], ...keys.slice(2)]; return Object.fromEntries(order.map((key) => [key, result[key]])); };
  const late = (input) => { const { [keys[5]]: moved, ...rest } = normalize(input); return { ...rest, [keys[5]]: moved }; };
  const changes = [
    ['two keys swapped', swapped, 'nothing stored'], ['a key moved to the end', late, 'every key stored with the same value'],
    ['a default changed', bent('lyricsOffsetMs', (value, input) => (input && Object.hasOwn(input, 'lyricsOffsetMs') ? value : 1)), 'nothing stored'],
    ['one valid value refused', bent('appearance', (value) => (value === 'light' ? 'dark' : value)), 'the settings of a person'],
    ['one invalid value let through', bent('weekStart', (value, input) => (input?.weekStart === 7 ? 7 : value)), 'one key stored'],
    ['one value inside a key no longer read', bent('weather', (value, input) => (input?.weather?.refreshMin ? normalize({}).weather : value)), 'one value changed inside a key'],
    ['the layout kept when it must be made new', bent('dashboardLayout', (value, input) => (input?.dashboardLayout && !input.dashboardLayoutVersion ? { kept: true } : value)), 'the layout and its version'],
    ['a key that reads another one no longer does', bent('surfaceChoice', (value, input) => (input?.surface && !input.surfaceChoice ? normalize({}).surfaceChoice : value)), 'keys read together'],
  ];
  for (const [what, changed, section] of changes) {
    assert.notEqual(JSON.stringify(answersOf(changed, [section])[section]), JSON.stringify(made[section]), `${what}: no question of "${section}" noticed`);
  }
});

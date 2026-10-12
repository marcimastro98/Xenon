// LRC parsing for the lyrics view. Fixture text is invented, never real lyrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseLrc, parsePlain } = require('../lyrics.js');

test('parses centiseconds, milliseconds and tenths', () => {
  const lines = parseLrc('[00:01.50]alpha\n[00:02.250]beta\n[01:03.7]gamma');
  assert.deepEqual(lines, [
    { t: 1500, text: 'alpha' },
    { t: 2250, text: 'beta' },
    { t: 63700, text: 'gamma' },
  ]);
});

test('a line with several stamps repeats, output is sorted', () => {
  const lines = parseLrc('[00:10.00][00:30.00]refrain\n[00:20.00]verse');
  assert.deepEqual(lines.map(l => [l.t, l.text]), [[10000, 'refrain'], [20000, 'verse'], [30000, 'refrain']]);
});

test('metadata tags are skipped and a positive offset shows lines earlier', () => {
  const lines = parseLrc('[ar:Someone]\n[ti:Something]\n[length:03:00]\n[offset:+500]\n[00:02.00]one');
  assert.deepEqual(lines, [{ t: 1500, text: 'one' }]);
});

test('word stamps (enhanced LRC) are dropped from the text', () => {
  const lines = parseLrc('[00:05.00]<00:05.00>red <00:05.40>blue <00:05.90>green');
  assert.equal(lines[0].text, 'red blue green');
});

test('empty lines are kept as one pause, runs collapse', () => {
  const lines = parseLrc('[00:01.00]a\n[00:05.00]\n[00:06.00]\n[00:09.00]b');
  assert.deepEqual(lines.map(l => l.text), ['a', '', 'b']);
});

test('control and bidi characters are stripped, long lines capped', () => {
  const lines = parseLrc('[00:01.00]x‮y\u0007z\n[00:02.00]' + 'w'.repeat(500));
  assert.equal(lines[0].text, 'xyz');
  assert.equal(lines[1].text.length, 300);
});

test('malformed or non-string input yields no lines', () => {
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc(42), []);
  assert.deepEqual(parseLrc('no stamps here\n[xx:yy]nope'), []);
  assert.deepEqual(parseLrc('text before [00:01.00] is not a stamp line'), []);
});

test('line count is capped', () => {
  const src = Array.from({ length: 2500 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}.00]l${i}`).join('\n');
  assert.equal(parseLrc(src).length, 2000);
});

test('plain lyrics trim blank edges and keep inner blank lines', () => {
  assert.deepEqual(parsePlain('\n\nfirst\n\nsecond\n\n'), ['first', '', 'second']);
  assert.deepEqual(parsePlain(undefined), []);
});

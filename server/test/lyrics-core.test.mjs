import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// The timing half of js/lyrics-core.js is pure: which line is active at a
// position, which pause dot is lit, and when the view next has to change. The
// script is a browser IIFE, so it runs here in a vm with just enough of a
// window and document to load. Lines are invented, never real lyrics.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'js', 'lyrics-core.js'), 'utf8');

function loadCore() {
  const listeners = { addEventListener() {} };
  const ctx = { window: { ...listeners }, document: { ...listeners }, console };
  vm.runInNewContext(SRC, ctx);
  return ctx.window.LyricsCore;
}

const core = loadCore();
const LINES = [
  { t: 1000, text: 'first made-up line' },
  { t: 4000, text: 'second made-up line' },
  { t: 7000, text: '' },
  { t: 19000, text: 'after a long pause' },
  { t: 21000, text: '' },
  { t: 23000, text: 'last line' },
];

test('activeIndex: before the first line, on boundaries and after the last', () => {
  assert.equal(core.activeIndex(LINES, 0), -1);
  assert.equal(core.activeIndex(LINES, 999), -1);
  assert.equal(core.activeIndex(LINES, 1000), 0);
  assert.equal(core.activeIndex(LINES, 3999), 0);
  assert.equal(core.activeIndex(LINES, 4000), 1);
  assert.equal(core.activeIndex(LINES, 60000), LINES.length - 1);
  assert.equal(core.activeIndex([], 5000), -1);
});

test('activeIndex: repeated timestamps land on the last of them', () => {
  const same = [{ t: 0, text: 'a' }, { t: 2000, text: 'b' }, { t: 2000, text: 'c' }, { t: 5000, text: 'd' }];
  assert.equal(core.activeIndex(same, 2000), 2);
});

test('gapStep: only a blank line followed by a long pause shows dots', () => {
  assert.equal(core.gapStep(LINES, 0, 2000), -1, 'a sung line is not a pause');
  assert.equal(core.gapStep(LINES, 2, 7000), 0, '12 s pause, first third');
  assert.equal(core.gapStep(LINES, 2, 11000), 1, 'second third');
  assert.equal(core.gapStep(LINES, 2, 18900), 2, 'last third');
  assert.equal(core.gapStep(LINES, 4, 21500), -1, 'a 2 s breath is shorter than the threshold');
  assert.equal(core.gapStep([{ t: 0, text: '' }], 0, 100), -1, 'a trailing blank has no end');
});

test('wordStarts: time follows syllables, not letters', () => {
  // "through" (1 beat, 7 letters) must take less time than "area" (3 beats, 4 letters).
  const [a, b, c] = core.wordStarts(['through', 'area', 'end'], 3000);
  assert.equal(a, 0);
  assert.ok(b - a < c - b, `one-beat word ${b - a} ms, three-beat word ${c - b} ms`);
});

test('wordStarts: a short slot is filled, a long one is sung at pace', () => {
  const words = ['made', 'up', 'little', 'words', 'here'];
  const tight = core.wordStarts(words, 1500);
  assert.ok(tight[tight.length - 1] < 1500 * 0.88, 'the last word starts before the line ends');
  const slow = core.wordStarts(words, 60000);
  assert.ok(slow[slow.length - 1] < 4000, 'a minute-long slot is not stretched over');
  const last = core.wordStarts(words, null);
  assert.deepEqual(last, slow, 'the last line is sung at the same pace');
});

test('wordStarts: a comma leaves a breath, kana and CJK count per character', () => {
  const [, plainNext] = core.wordStarts(['one', 'two', 'three'], 3000);
  const [, commaNext] = core.wordStarts(['one,', 'two', 'three'], 3000);
  assert.ok(commaNext > plainNext);
  const [, kanaNext] = core.wordStarts(['あいうえお', 'か'], 3000);
  assert.ok(kanaNext > 2000, 'five kana take most of the line');
  assert.deepEqual(core.wordStarts([], 3000), []);
});

test('withImpliedPauses: a line held through a long break gets the pause dots', () => {
  const lines = [
    { t: 1000, text: 'a made-up line sung before a long break' },
    { t: 25000, text: 'the next invented line' },
    { t: 28000, text: 'a third one' },
  ];
  const out = core.withImpliedPauses(lines);
  assert.equal(out.length, 4);
  assert.equal(out[1].text, '', 'a blank line after the sung one');
  assert.ok(out[1].t > 1000 + 3000, `not before a slow singer is done (${out[1].t})`);
  assert.ok(out[2].t - out[1].t >= core.GAP_MIN_MS, 'long enough to show the dots');
  assert.equal(core.gapStep(out, 1, out[1].t), 0);
});

test('withImpliedPauses: normal lines, existing blanks and the last line are left alone', () => {
  // JSON: arrays built inside the vm have another realm's prototype.
  const same = (lines, msg) => assert.equal(JSON.stringify(core.withImpliedPauses(lines)), JSON.stringify(lines), msg);
  same(LINES);
  same([{ t: 0, text: 'one slow invented line' }, { t: 9000, text: 'next' }], 'a 9 s line may still be sung');
  same([]);
});

test('nextChangeAt: the next line, or the next pause step', () => {
  assert.equal(core.nextChangeAt(LINES, 0, 2000), 4000);
  assert.equal(core.nextChangeAt(LINES, 2, 7000), 11000);
  assert.equal(core.nextChangeAt(LINES, 2, 11000), 15000);
  assert.equal(core.nextChangeAt(LINES, 2, 15000), 19000, 'last step waits for the line itself');
  assert.equal(core.nextChangeAt(LINES, LINES.length - 1, 30000), null, 'nothing after the last line');
});

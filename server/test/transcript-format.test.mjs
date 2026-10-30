// transcript-format.js: the pure shapes of a recording's transcript. Pinned
// here: whisper's JSON read into lines (bad offsets and silence dropped), the
// chapters Bit sends checked (a numbered list is not a time, nothing past the
// end, one per second, sorted, capped), a stored file checked on the way in,
// the subtitle files, and the AI's reading cut at its limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../transcript-format.js');

test('clock: m:ss under an hour, h:mm:ss over', () => {
  assert.equal(F.clock(0), '0:00');
  assert.equal(F.clock(65.9), '1:05');
  assert.equal(F.clock(3725), '1:02:05');
  assert.equal(F.clock(-3), '0:00');
  assert.equal(F.clock('x'), '0:00');
});

test('linesFromWhisper: seconds from ms, bad offsets and empty lines dropped', () => {
  const json = {
    transcription: [
      { offsets: { from: 0, to: 3660 }, text: ' Ciao, questa è una prova.' },
      { offsets: { from: 4000, to: 3000 }, text: 'backwards' },
      { offsets: { from: 'x', to: 10 }, text: 'bad' },
      { offsets: { from: 5000, to: 6000 }, text: ' [BLANK_AUDIO]' },
      { offsets: { from: 8440, to: 12000 }, text: 'x'.repeat(900) },
    ],
  };
  const clean = s => String(s).replace('[BLANK_AUDIO]', '').trim();
  const lines = F.linesFromWhisper(json, clean);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { start: 0, end: 3.66, text: 'Ciao, questa è una prova.' });
  assert.equal(lines[1].start, 8.44);
  assert.equal(lines[1].text.length, 400);
  assert.deepEqual(F.linesFromWhisper(null), []);
  assert.deepEqual(F.linesFromWhisper({ transcription: 'no' }), []);
});

test('chaptersFromText: times with a colon, inside the video, sorted, one per second', () => {
  const text = [
    '0:00 Intro',
    '1. Not a time',
    '[1:05] - Setting up the folder',
    '(0:30): Recording',
    '1:05 Same second again',
    '1:02:05 Past the end',
    '2:10',
    '   ',
  ].join('\n');
  assert.deepEqual(F.chaptersFromText(text, 600), [
    { at: 0, title: 'Intro' },
    { at: 30, title: 'Recording' },
    { at: 65, title: 'Setting up the folder' },
  ]);
  // Without a length every time is kept.
  assert.equal(F.chaptersFromText('1:02:05 Late', 0)[0].at, 3725);
});

test('chaptersFromText: titles trimmed and control characters gone, at most 30', () => {
  const long = F.chaptersFromText('0:00 ' + 'a'.repeat(200) + '\u0007b', 0);
  assert.equal(long[0].title.length, F.TITLE_MAX_CHARS);
  const many = Array.from({ length: 40 }, (_, i) => `0:${String(i).padStart(2, '0')} Part ${i}`).join('\n');
  assert.equal(F.chaptersFromText(many, 0).length, F.MAX_CHAPTERS);
  assert.deepEqual(F.chaptersFromText('0:00 a\u0001b', 0), [{ at: 0, title: 'a b' }]);
});

test('cleanSummary keeps line breaks, drops other control characters, caps the length', () => {
  assert.equal(F.cleanSummary('One.\nTwo.\u0007'), 'One.\nTwo.');
  assert.equal(F.cleanSummary('x'.repeat(2000)).length, F.SUMMARY_MAX_CHARS);
  assert.equal(F.cleanSummary(null), '');
});

test('normalizeStored: only well-formed lines and chapters come in from disk', () => {
  assert.equal(F.normalizeStored(null), null);
  assert.equal(F.normalizeStored({ lines: 'no' }), null);
  const t = F.normalizeStored({
    lang: 'it-longer-than-eight', seconds: 12, cut: 'yes',
    lines: [{ start: 0, end: 1, text: 'ok' }, { start: 'x', end: 1, text: 'bad' }, null],
    chapters: [{ at: 0, title: 'A' }, { at: 1.5, title: 'B' }, { at: -1, title: 'C' }],
    summary: 'S',
  });
  assert.deepEqual(t, {
    lang: 'it-longe', seconds: 12, cut: false,
    lines: [{ start: 0, end: 1, text: 'ok' }], chapters: [{ at: 0, title: 'A' }], summary: 'S',
  });
});

test('toSrt and toVtt: numbered cues, comma and dot milliseconds', () => {
  const lines = [{ start: 0, end: 3.66, text: 'Ciao' }, { start: 3725.5, end: 3727, text: 'Dopo' }];
  assert.equal(F.toSrt(lines), '1\n00:00:00,000 --> 00:00:03,660\nCiao\n\n2\n01:02:05,500 --> 01:02:07,000\nDopo\n');
  assert.equal(F.toVtt(lines), 'WEBVTT\n\n00:00:00.000 --> 00:00:03.660\nCiao\n\n01:02:05.500 --> 01:02:07.000\nDopo\n');
});

test('aiText: "[m:ss] words" per line, cut before the limit', () => {
  const r = F.aiText([{ start: 0, end: 1, text: 'Uno' }, { start: 65, end: 66, text: 'Due' }]);
  assert.deepEqual(r, { text: '[0:00] Uno\n[1:05] Due', cut: false });
  const many = Array.from({ length: 2000 }, (_, i) => ({ start: i, end: i + 1, text: 'parola '.repeat(5) }));
  const cut = F.aiText(many);
  assert.equal(cut.cut, true);
  assert.ok(cut.text.length <= F.AI_TEXT_MAX_CHARS);
  assert.ok(cut.text.endsWith('parola'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wake = require('../wakeword.js');

// ── Wake-phrase matcher: fuzzy on purpose (whisper renders accents freely) ──

test('matcher: accepts the wake phrase and its common whisper renderings', () => {
  const yes = [
    'Hey Xenon', 'hey xenon.', 'XENON', 'xenon',
    'Ehi, Zenon!', 'hei senon', 'Zenone', 'ei zenon',
    'Hey Xenon, come stai?', 'ok xenon accendi le luci',
    'Hey Xeneon',           // users read the product name off the display
    'zeneon', 'ei senone',  // more accent renderings the vowel-tolerant regex covers
    'héy xénon',            // diacritics stripped before matching
  ];
  for (const s of yes) assert.equal(wake.matchesWakeWord(s), true, `"${s}" must match`);
});

test('matcher: rejects normal speech containing similar words', () => {
  const no = [
    'hello world', 'zenith', 'lexicon', 'season', 'nonsense',
    'xenophobia is bad', 'se non andiamo ora', 'senonché piove',
    'sano nano', 'hey there', '', '   ',
  ];
  for (const s of no) assert.equal(wake.matchesWakeWord(s), false, `"${s}" must NOT match`);
  assert.equal(wake.matchesWakeWord(null), false);
  assert.equal(wake.matchesWakeWord(42), false);
});

// ── Energy-VAD segmenter ─────────────────────────────────────────────────────

const FRAME_BYTES = 960; // 30 ms @ 16 kHz s16le mono — mirrors the module

function pcmFrames(amplitude, frames) {
  const buf = Buffer.alloc(FRAME_BYTES * frames);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(amplitude, i);
  return buf;
}

test('segmenter: a short loud burst between silence emits one segment', () => {
  const segments = [];
  const seg = wake._createSegmenter(b => segments.push(b));
  seg.feed(pcmFrames(50, 20));     // silence — settles the noise floor
  seg.feed(pcmFrames(6000, 20));   // ~600 ms of speech
  seg.feed(pcmFrames(50, 20));     // silence closes the segment
  assert.equal(segments.length, 1);
  // Segment carries the speech plus pre-roll/trailing frames.
  assert.ok(segments[0].length >= 20 * FRAME_BYTES);
});

test('segmenter: a single loud frame (a click) does not trigger', () => {
  const segments = [];
  const seg = wake._createSegmenter(b => segments.push(b));
  seg.feed(pcmFrames(50, 20));
  seg.feed(pcmFrames(6000, 1));
  seg.feed(pcmFrames(50, 30));
  assert.equal(segments.length, 0);
});

test('segmenter: sustained speech/music is skipped, then recovery works', () => {
  const segments = [];
  const seg = wake._createSegmenter(b => segments.push(b));
  seg.feed(pcmFrames(50, 20));
  seg.feed(pcmFrames(6000, 120));  // 3.6 s — longer than any wake phrase
  seg.feed(pcmFrames(50, 30));     // waited out
  assert.equal(segments.length, 0, 'long utterance must not cost a transcription');
  seg.feed(pcmFrames(6000, 20));   // a normal burst afterwards still works
  seg.feed(pcmFrames(50, 20));
  assert.equal(segments.length, 1);
});

test('segmenter: reassembles frames across arbitrary chunk boundaries', () => {
  const segments = [];
  const seg = wake._createSegmenter(b => segments.push(b));
  const stream = Buffer.concat([pcmFrames(50, 20), pcmFrames(6000, 20), pcmFrames(50, 20)]);
  for (let i = 0; i < stream.length; i += 1000) seg.feed(stream.subarray(i, i + 1000));
  assert.equal(segments.length, 1);
});

// ── WAV wrapper ──────────────────────────────────────────────────────────────

test('wav: wraps PCM in a valid 16 kHz mono RIFF header', () => {
  const pcm = pcmFrames(1234, 4);
  const wav = wake._wavFromPcm(pcm);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);  // sample rate
  assert.equal(wav.readUInt16LE(22), 1);      // mono
  assert.equal(wav.readUInt16LE(34), 16);     // bits per sample
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

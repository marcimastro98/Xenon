// js/capture-transcript-view.js and how the gallery reaches it. Pinned here:
// the line being said is found by time (a gap of over a second marks none);
// the clock matches the server's; the panel writes text only as text; the
// viewer shows "Transcript" for videos on the PC and, on a paired phone, only
// for a video that already has one, loads the panel on first use and closes it
// with the video; the dashboard relays SSE `transcript` to an open gallery; and
// "Chapters with Bit" closes the gallery before asking (the chat is under it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const view = require('../js/capture-transcript-view.js');
const F = require('../transcript-format.js');
const read = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const LINES = [{ start: 0, end: 3.6 }, { start: 4.2, end: 7.8 }, { start: 20, end: 22 }];

test('lineAt: the line being said, none in a long gap', () => {
  assert.equal(view.lineAt(LINES, 0), 0);
  assert.equal(view.lineAt(LINES, 4.1), 0, 'within a second of its end');
  assert.equal(view.lineAt(LINES, 5), 1);
  assert.equal(view.lineAt(LINES, 12), -1);
  assert.equal(view.lineAt(LINES, 21), 2);
  assert.equal(view.lineAt([], 3), -1);
});

test('the clock is the server\'s', () => {
  for (const s of [0, 9.9, 65, 3599, 3725]) assert.equal(view.clock(s), F.clock(s));
});

test('the panel writes words as text only and loads nothing itself', () => {
  const src = read('js/capture-transcript-view.js');
  assert.equal(/innerHTML|insertAdjacentHTML|eval\(/.test(src), false);
  assert.match(src, /'\/captures\/transcribe'/);
  assert.match(src, /format=srt/);
  // A phone writes one down too (whisper runs on the PC): no remote special case.
  assert.match(src, /if \(!t \|\| t\.error !== 'no_transcript'\)/);
});

test('viewer: Transcript for videos on the PC and on a phone where the engine can write it', () => {
  const src = read('js/capture-gallery-viewer.js');
  assert.match(src, /if \(e\.transcript \|\| \(o\.editable && can\.speech\)\) actions\.appendChild\(wordsButton\(\)\);/);
  // On the PC: wherever the engine can write the words down (not yet on Linux), or one is there.
  assert.match(src, /if \(can\.speech \|\| e\.transcript\) actions\.appendChild\(wordsButton\(\)\);/);
  assert.match(src, /loadScript\('js\/capture-transcript-view\.js'/);
  // Moving to another capture, closing the viewer or opening Export closes the panel.
  assert.equal((src.match(/if \(words\) \{ words\.close\(\); words = null; \}/g) || []).length, 3);
  assert.match(src, /return \{\s+close, sync, onTranscript,/);
});

test('gallery and dashboard: SSE transcript reaches the panel; Bit asked after the gallery closes', () => {
  const main = read('js/main.js');
  assert.match(main, /es\.addEventListener\('transcript', e => \{\n\s+try \{ if \(window\.CaptureGallery\) window\.CaptureGallery\.onTranscript\(JSON\.parse\(e\.data\)\); \} catch \{\}/);
  const gal = read('js/capture-gallery.js');
  assert.match(gal, /\? \(text\) => \{ close\(\); window\.aiAsk\(text\); \} : null,/);
  assert.match(gal, /askBit: !window\.__xenonRemote && typeof window\.aiAsk === 'function'/);
  assert.match(gal, /window\.CaptureGallery = \{ open, close, changed, onTranscript,/);
  const css = read('components/CaptureGallery/CaptureGallery.css');
  for (const cls of ['.capg-tx ', '.capg-tx-line', '.capg-tx-foot']) assert.ok(css.includes(cls), cls);
});

test('the list says which videos have one; a phone reads and starts one, never by a GET', () => {
  const src = read('server.js');
  assert.match(src, /_transcripts\.has\(e\.id\) \? \{ \.\.\.e, transcript: true \} : e/);
  const ra = require('../remote-access.js');
  assert.equal(ra.remotePathAllowed('/captures/transcript', 'GET'), true);
  assert.equal(ra.remotePathAllowed('/captures/transcribe', 'POST'), true);
  assert.equal(ra.remotePathAllowed('/captures/transcribe', 'GET'), false);
});

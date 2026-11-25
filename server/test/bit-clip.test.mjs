// The short video of the person's own Bit (js/bit-companion/clip.js): what it plays, when the
// sheet offers it, what it says when it fails, and that it is drawn from the engine, never
// captured from the screen. The recording itself runs in a real browser (headless Chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appStrings, APP_LANGS } from './i18n-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const bit = require('../shared/src/bit.js');
require('../shared/src/bit-clips-life.js');
const { QUIRKS } = require('../shared/src/bit-genes.js');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SRC = read('js/bit-companion/clip.js');
const KEYS = ['mybit_clip_make', 'mybit_clip_making', 'mybit_clip_save', 'mybit_clip_failed', 'mybit_clip_alt'];
const lengthOf = (c) => c.frames.reduce((s, f) => s + f.ms, 0);

// A browser that records the types it is told it can, or none.
function recorder(types) {
  if (!types) return {};
  const MediaRecorder = function MediaRecorder() {};
  MediaRecorder.isTypeSupported = (t) => types.includes(t);
  return { MediaRecorder };
}

function load(extra = {}, canvas = { prototype: { captureStream() {} } }) {
  const window = { ...extra };
  vm.runInNewContext(SRC, { window, HTMLCanvasElement: canvas, makeEl: extra.makeEl || (() => ({})), JSON, Number, Math });
  return window.BitClip;
}

test('it plays hello, its own quirk, a dance, then more moves to six seconds, and ends held on its pose', () => {
  const C = load();
  const end = { clip: bit.clip('pose'), frame: 3 };
  for (const { id } of QUIRKS) {
    const { steps, total } = C.timeline(id, bit.clip, end);
    const order = steps.filter((s, i) => i === 0 || steps[i - 1].c !== s.c).map((s) => s.c.id);
    assert.ok(total >= 6000, `${id}: ${total} ms`);
    assert.equal(order[0], 'wave', id);
    assert.ok(order.includes(id), `${id} is in its own video`);
    assert.equal(order.at(-1), 'pose', id);
    assert.equal(new Set(order).size, order.length, `${id}: no move twice (${order})`);
    assert.deepEqual([steps.at(-1).i, steps.at(-1).ms], [3, 1600], `${id}: the pose's frame is held`);
    assert.equal(total, steps.reduce((sum, s) => sum + s.ms, 0));
    steps.forEach((s, i) => assert.equal(s.at, i ? steps[i - 1].at + steps[i - 1].ms : 0));
  }
  const peek = C.timeline('wink', bit.clip, { clip: bit.clip('peek'), frame: 5 }).steps.at(-1);
  assert.deepEqual([peek.c.id, peek.i], ['peek', 5], 'another pose ends on its own frame');
  const moves = (e) => [...C.timeline('dance', bit.clip, e).steps.filter((s, i, all) => !i || all[i - 1].c !== s.c).map((s) => s.c.id)];
  assert.deepEqual(moves(end), ['wave', 'dance', 'pose'], 'six seconds already');
  assert.deepEqual(moves({ clip: bit.clip('pose'), frame: 0 }), ['wave', 'dance', 'hop', 'spin', 'pose'], 'moves added only while short of six seconds');
  const unknown = C.timeline('notAMove', bit.clip, end);
  assert.ok(unknown.total >= 6000, 'a quirk this engine does not know is left out, not a hole');
  assert.equal(C.timeline('wave', () => null, null).total, 0, 'no clips: nothing to record');
});

test('it records MP4 where the browser can, WebM where it cannot, and is not offered where it records nothing', () => {
  assert.equal(load(recorder(['video/mp4;codecs=avc1', 'video/webm'])).recorderType(), 'video/mp4;codecs=avc1');
  assert.equal(load(recorder(['video/webm;codecs=vp8', 'video/webm'])).recorderType(), 'video/webm;codecs=vp8');
  assert.equal(load(recorder([])).recorderType(), '');
  assert.equal(load(recorder(null)).recorderType(), '');
  assert.equal(load(recorder(['video/webm']), { prototype: {} }).recorderType(), '', 'a canvas it cannot stream from');
});

// The app's say() on one language's own words, English behind them (js/i18n.js t()).
function sayIn(code) {
  const { en } = appStrings();
  const own = appStrings()[code];
  return (key) => String(own[key] ?? en[key] ?? key);
}

test('the sheet\'s part: one button where it can record; the failure note survives the redraw', async () => {
  const { document } = makeDom();
  const makeEl = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const said = [];
  const h = { say: sayIn('en'), num: String, note: (t) => said.push(['note', t]), redraw: () => said.push(['redraw']), signal: new AbortController().signal };
  const me = { number: 1284, name: 'Pixel', worn: [], genes: { quirk: 'hop' } };
  const parts = { makeEl, BitCard: { paint: {}, words: () => ({}) }, Xenon: { bit: { clip: () => null }, bitLook: { lookOf: () => ({}) }, bitWardrobe: { outfit: () => [] } } };
  assert.equal(load({ ...parts }).section(me, h), null, 'no recorder: nothing offered');
  const C = load({ ...parts, ...recorder(['video/webm']) });
  assert.equal(C.section({ ...me, genes: null }, h), null, 'no genes yet');
  assert.equal(load({ ...parts, ...recorder(['video/webm']), BitCard: null }).section(me, h), null, 'no card painter');
  const part = C.section(me, h);
  const go = part.querySelector('button');
  assert.equal(go.textContent, 'Make a short video');
  go.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(said, [['redraw'], ['note', 'The video could not be made. Try again.']], 'the note comes after the redraw that clears it');
});

test('every video word in all 11 languages', () => {
  const tables = appStrings();
  for (const code of APP_LANGS) {
    for (const key of KEYS) assert.ok(tables[code][key], `${code} ${key}`);
  }
});

test('drawn frame by frame from the engine, never a capture; the sheet offers it and lets it go', () => {
  assert.match(SRC, /X\.bit\.renderFrame\(c, i, \{ look \}\)/);
  assert.match(SRC, /canvas\.captureStream\(FPS\)/);
  for (const bad of ['innerHTML', 'getDisplayMedia', 'html2canvas', 'frameSvg', 'eval(']) assert.ok(!SRC.includes(bad), bad);
  assert.match(SRC, /URL\.revokeObjectURL\(made\.url\)/, 'the video is let go when the sheet closes');
  assert.match(SRC, /prefers-reduced-motion/);
  const sheet = read('js/bit-companion/sheet.js');
  assert.match(sheet, /window\.BitClip\?\.section\(bit, hands\)/);
  assert.match(sheet, /window\.BitClip\?\.reset\(\);/);
  const page = read('index.html');
  const at = page.indexOf('src="js/bit-companion/clip.js"');
  assert.ok(at > page.indexOf('src="js/bit-companion/recap.js"') && at < page.indexOf('src="js/bit-companion/companion.js"'));
});

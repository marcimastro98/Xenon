// The options sheet of the Lyrics tile (js/lyrics-widget-options.js): Esc belongs to it, and the
// key that opened it gets the keyboard back. It sits over the tile, not over the page, so it
// holds nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/lyrics-widget-options.js');
const TILE = read('../js/lyrics-widget.js');

function rig() {
  const { document, descendants } = makeDom();
  const mount = document.createElement('div');
  const opener = document.createElement('button');
  document.body.append(opener, mount);
  opener.focus();
  const window = { LyricsTranslation: { usage: async () => null, reset() {} } };
  const ctx = { window, document, hubSettings: {}, lang: 'en', Intl, Date, Number, Math, String };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const sheet = () => descendants(mount).find((n) => String(n.className).includes('lyo-sheet')) || null;
  const press = (key) => {
    let stopped = false;
    const event = { key, stopPropagation() { stopped = true; } };
    (sheet()._handlers.keydown || []).forEach((fn) => fn(event));
    return stopped;
  };
  return { O: window.LyricsWidgetOptions, document, mount, opener, sheet, press };
}

test('Esc closes the sheet, and the key that opened it takes the keyboard back', () => {
  const r = rig();
  let closed = 0;
  r.O.open(r.mount, () => { closed += 1; });
  assert.notEqual(r.document.activeElement, r.opener, 'the sheet has the keyboard while open');
  r.press('Escape');
  assert.equal(r.sheet(), null);
  assert.equal(r.mount.classList.contains('has-options'), false);
  assert.equal(r.document.activeElement, r.opener);
  assert.equal(closed, 1, 'the tile repaints its timing as it does after Done');
});

test('over Stage mode the first Esc closes only this sheet', () => {
  const r = rig();
  r.O.open(r.mount);
  assert.equal(r.press('Escape'), true);
});

test('another key is left alone', () => {
  const r = rig();
  r.O.open(r.mount);
  assert.equal(r.press('Tab'), false);
  assert.ok(r.sheet());
});

test('a tap on its empty space keeps the keyboard in the sheet, so Esc still answers', () => {
  const r = rig();
  r.O.open(r.mount);
  assert.equal(r.sheet().tabIndex, -1);
});

test('an opener that left the page takes no focus back', () => {
  const r = rig();
  r.O.open(r.mount);
  r.opener.remove();
  r.press('Escape');
  assert.equal(r.sheet(), null);
});

// The tile around the sheet: it fills its mount again on a language switch, goes back to the
// pitch when a trial ends, and a copy arrives cloned with the sheet's mark on it. That mark hides
// everything but the sheet, so a mount filled again without dropping it stays blank for good.
async function tileRig({ status, prepare = () => {} }) {
  const { document, descendants } = makeDom();
  document.readyState = 'complete';
  const panel = document.createElement('section');
  panel.className = 'lyrics-panel';
  const mount = document.createElement('div');
  mount.className = 'lyrics-widget-mount';
  mount.getClientRects = () => [{}];
  panel.append(mount);
  document.body.append(panel);
  prepare(mount);
  const timers = [];
  const answer = { status };
  const window = {
    t: (key) => key,
    LyricsCore: { subscribe: () => () => {}, current: () => ({}), offsetMs: () => 0, sync() {} },
    LyricsView: { create: () => ({ render() {}, setExtras() {}, destroy() {} }) },
    LyricsTranslation: {
      usage: async () => null, reset() {}, subscribe: () => () => {}, status: () => 'off', extras: () => null,
    },
  };
  const ctx = {
    window, document, hubSettings: {}, lang: 'en', Intl, Date, Number, Math, String,
    fetch: async () => ({ status: 200, json: async () => answer.status }),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(TILE, ctx);
  await settle(40);
  const has = (cls) => descendants(mount).some((n) => String(n.className).split(' ').includes(cls));
  return { window, ctx, mount, answer, timers, has, O: window.LyricsWidgetOptions };
}

test('a language switch under the sheet leaves a tile that can be seen', async () => {
  const r = await tileRig({ status: { ok: true, unlocked: true } });
  r.O.open(r.mount);
  assert.equal(r.mount.classList.contains('has-options'), true);

  r.ctx.lang = 'it';
  r.window.LyricsWidget.renderWidgets();
  assert.equal(r.has('lyo-sheet'), false, 'the sheet carried the old language');
  assert.equal(r.mount.classList.contains('has-options'), false, 'its mark hides everything else');
  assert.ok(r.has('lyw-body'));
});

test('a trial that ends under the sheet leaves a pitch that can be seen', async () => {
  const r = await tileRig({ status: { ok: true, unlocked: true, trialEndsAt: Date.now() + 1000 } });
  r.O.open(r.mount);

  r.answer.status = { ok: true, unlocked: false };
  r.timers.at(-1)();
  await settle(40);
  assert.ok(r.has('lyw-pitch'));
  assert.equal(r.mount.classList.contains('has-options'), false);
});

test('a copy cloned with the sheet open does not stay blank', async () => {
  const r = await tileRig({
    status: { ok: true, unlocked: true },
    prepare: (mount) => mount.classList.add('has-options'),
  });
  assert.ok(r.has('lyw-body'));
  assert.equal(r.mount.classList.contains('has-options'), false);
});

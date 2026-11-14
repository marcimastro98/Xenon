// A key whose effect cannot be seen says what it did.
//
// Found by pressing every new key: Do not disturb and "Copy to a folder"
// changed something and showed nothing, so the only sign of a press was the
// glow. Keys whose effect is on the screen (widgets, a sheet, a capture card)
// stay silent: a note there would only repeat what is already in front of you.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { appStringsSource } from './i18n-source.mjs';

const { note } = (await import('../js/deck-done-text.js')).default;
const tt = (key, fallback) => fallback || key;
const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
const I18N = appStringsSource();

test('Do not disturb says the state it ended in', () => {
  for (const quiet of ['always', 'auto', 'off']) {
    const n = note({ type: 'dnd', mode: 'toggle' }, { ok: true, quiet }, (key) => key);
    assert.equal(n.kicker, 'deck_act_dnd');
    assert.equal(n.title, 'settings_notif_quiet_' + quiet);
    assert.equal(n.important, true, 'it must show even when it has just turned quiet on');
  }
  assert.equal(note({ type: 'dnd' }, { ok: true, quiet: 'weird' }, tt), null);
});

test('a copy says where it went and what it was', () => {
  const n = note({ type: 'copyCapture' }, { ok: true, name: 'Clip.mp4', folder: 'pictures' }, tt);
  assert.equal(n.title, 'Copied to Pictures');
  assert.equal(n.message, 'Clip.mp4');
  assert.equal(note({ type: 'copyCapture' }, { ok: true, name: 'x', folder: '../etc' }, tt), null, 'only the five named folders');
});

test('a capture sent to the phone says where to find it', () => {
  const n = note({ type: 'sendCapture' }, { ok: true, name: 'Clip.mp4' }, tt);
  assert.equal(n.title, 'Sent: it is on your phone in File transfer');
  assert.equal(n.message, 'Clip.mp4');
  assert.equal(n.important, true, 'it must show during a game too');
  const again = note({ type: 'sendCapture' }, { ok: true, name: 'Clip.mp4', already: true }, tt);
  assert.equal(again.title, n.title, 'sent before: it is still there');
});

test('a key whose effect is on screen says nothing', () => {
  for (const type of ['layersToggle', 'layersEdit', 'desktopWallpaper', 'screenDraw', 'xenonScreen', 'volume']) {
    assert.equal(note({ type }, { ok: true }, tt), null, type);
  }
  assert.equal(note(null, null, tt), null);
});

test('the dispatcher tells it only after a success', () => {
  const fn = DECK.slice(DECK.indexOf('async function runAction(action)'));
  assert.match(fn.slice(0, fn.indexOf('\n  }')), /if \(data && data\.ok\) tellDone\(action, data\);/);
});

test('the sentence exists in every language', () => {
  assert.equal([...I18N.matchAll(/^\s+deck_done_copied: /gm)].length, 11);
});

test('clips from marks say how many were made, during a game too', () => {
  const one = note({ type: 'markClips' }, { ok: true, clips: 1, of: 1 }, tt);
  assert.equal(one.title, '1 clip made, next to the video');
  assert.equal(one.important, true);
  assert.equal(note({ type: 'markClips' }, { ok: true, clips: 3, of: 3 }, tt).title, '3 clips made, next to the video');
  assert.equal(note({ type: 'markClips' }, { ok: true, clips: 2, of: 5, stopped: true }, tt).title, '2 of 5 clips made, then it stopped');
  assert.equal(note({ type: 'markClips' }, { ok: true, clips: 0 }, tt), null);
});

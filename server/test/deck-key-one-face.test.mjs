// A key whose action brings a state (Instant Replay on, mic muted...) can be set to
// one face instead: the choice survives a save, and the editor offers it in State.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appStringsSource, textsOf } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const EDITOR = readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8');
const I18N = appStringsSource();

const replayStep = { type: 'replay' };
function keyOf(extra) {
  const cfg = dm.normalizeDeckConfig({
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [Object.assign({ id: 'k', kind: 'action', title: 'Replay', triggers: { tap: replayStep } }, extra)] }] } }],
  });
  return cfg.profiles[0].root.pages[0].keys[0];
}

test('one face is kept on a key that follows no state', () => {
  assert.equal(keyOf({ unlit: true }).unlit, true);
  assert.equal(keyOf({}).unlit, undefined);
  assert.equal(keyOf({ unlit: 'yes' }).unlit, undefined, 'only a real true counts');
});

test('a key that follows a state is not one face', () => {
  assert.equal(keyOf({ unlit: true, state: { source: 'replayOn' } }).unlit, undefined);
});

test('a cycle key drops the flag with the rest of its state', () => {
  assert.equal(keyOf({ unlit: true, mode: 'cycle', cycle: [{}] }).unlit, undefined);
});

test('the editor offers the choice in State and saves it', () => {
  assert.match(EDITOR, /let followAuto = !\(existing && existing\.unlit === true\);/);
  assert.match(EDITOR, /\(followAuto \? detectKeyState\(\) : null\)/, 'the state the action brings is dropped when turned off');
  assert.match(EDITOR, /switchRow\('deck_state_sum_follows', followAuto,/);
  assert.match(EDITOR, /if \(!followAuto && detectKeyState\(\) && !key\.state\) key\.unlit = true;/);
  assert.match(EDITOR, /if \(Object\.keys\(ss\)\.length && !key\.unlit\) key\.stateStyle = ss;/, 'no lit face is saved for a one-face key');
});

test('the one-face line exists in every language', () => {
  const n = (k) => textsOf(k).filter(([, text]) => text).length;
  assert.equal(n('deck_state_sum_single'), n('deck_state_sum_follows'));
  assert.equal(n('deck_state_sum_single'), 11);
});

test('the preview offers the same choice where the two faces are seen', () => {
  assert.match(EDITOR, /previewPanel\.appendChild\(faceCountBtn\);/);
  assert.match(EDITOR, /followAuto = !followAuto; followRow\.set\(followAuto\);/, 'the State switch follows the button');
  assert.match(EDITOR, /faceCountBtn\.style\.display = auto && !ownSum \? '' : 'none';/, 'only on a key that lights by itself');
  const n = (k) => textsOf(k).filter(([, text]) => text).length;
  assert.equal(n('deck_face_one'), 11);
  assert.equal(n('deck_face_two'), 11);
});

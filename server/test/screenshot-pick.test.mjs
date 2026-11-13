// "Screenshot" in the Xenon menu lets you choose. Reported 5 Nov 2026: the tile took
// the screen of the active window at once, so with three screens nobody could tell
// what it took, or pick anything, or see that it had happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './native-source.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FUNCTIONS } = require('../menu-functions.js');
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const TOAST = read('js/toast.js');
const PICKER = readFileSync(new URL('../../apps/capture/src/win/picker.rs', import.meta.url), 'utf8');

const tile = (id) => FUNCTIONS.find((f) => f.id === id);

test('the first capture tile opens the picker, the plain shot is named for what it takes', () => {
  assert.equal(FUNCTIONS[0].id, 'area');
  assert.equal(FUNCTIONS[0].label, 'xmenu_shot');
  assert.equal(FUNCTIONS[0].action.target, 'region');
  assert.equal(tile('shot').label, 'xmenu_shot_screen');
  assert.equal(tile('shot').action.target, 'screen');
});

test('Enter in the picker takes the whole screen, which no click reaches under the windows', () => {
  assert.match(PICKER, /VK_RETURN/);
  assert.match(PICKER, /fn take_screen\(&mut self\)/);
});

test('a notification shows the picture it talks about, and only one of ours', () => {
  assert.ok(TOAST.includes("o.image.startsWith('/captures/thumb?')"), 'no remote load');
  assert.ok(TOAST.includes('xtoast-icon--shot'));
});

test('a desktop with no tool to pick an area keeps only the plain shot', () => {
  assert.equal(tile('area').probe, 'captureRegion');
  assert.equal(tile('shot').probe, 'capture');
});

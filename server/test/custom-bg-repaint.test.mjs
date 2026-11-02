// A KVM switch (Discord, Nov 2026): after switching the monitor to another
// computer and back, Xenon on the Edge showed a bright white background behind
// the tiles until it was restarted, with every custom theme.
//
// Custom themes bring an animated background drawn in a canvas inside a frame.
// It is often PAUSED (idle, game mode, and for the whole session on a hybrid-GPU
// PC, which the reporter's is): one picture drawn, then left alone. A screen
// leaving can reset the graphics device, which wipes that canvas; nothing
// redrew it, so the theme's base colour (often light) showed through. Now the
// frame repaints once when the canvas reports it was restored, and when the
// shell reports a display change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SRC = read('../js/custom-bg.js');
const BRIDGE = read('../js/native-bridge.js');
const { buildSrcdoc } = require('../js/custom-bg.js');

const DOC = buildSrcdoc('function draw(ctx,t,w,h){ctx.fillRect(0,0,w,h);}', {}, 30, true);

test('the frame repaints once, paused or not', () => {
  assert.match(DOC, /function repaint\(\)\{if\(!draw\)return;size\(\);try\{draw\(ctx,lastEl,innerWidth,innerHeight,assets\);\}catch\(e\)\{\}\}/);
  // It paints the moment it was showing, not the start of the animation.
  assert.match(DOC, /lastEl=el;/);
});

test('it repaints when the canvas says its contents were lost', () => {
  assert.match(DOC, /canvas\.addEventListener\("contextrestored",repaint\);/);
});

test('a repaint request never pauses or resumes the loop', () => {
  // The same message channel carries pause/play; "repaint" must not be read as
  // "play", or every display change would undo the idle and hybrid-GPU freezes.
  assert.match(DOC, /if\(d\.__xbg==="repaint"\)\{repaint\(\);return;\}extPause=\(d\.__xbg==="pause"\);sync\(\);/);
});

test('the host asks for a repaint after every display change', () => {
  assert.match(SRC, /frameEl\.contentWindow\.postMessage\(\{ __xbg: 'repaint' \}, '\*'\)/);
  assert.match(SRC, /window\.CustomBg = \{\s*apply, repaint,/);
  const at = BRIDGE.indexOf('function onDisplaysChanged(');
  const body = BRIDGE.slice(at, BRIDGE.indexOf('\n  }\n', at));
  assert.match(body, /window\.CustomBg\.repaint\(\)/);
});

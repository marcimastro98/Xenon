// OBS with no preview showed a black box with a thin light edge, and squeezed
// "Configure OBS in Settings" into a strip at its side.
//
// The widget hides the picture with the hidden attribute when it has none, but
// `.obs-preview-img { display: block }` outranks the browser's own
// `[hidden] { display: none }`, so the empty picture kept its room and drew as a
// broken image. Every look had it: not set up, or OBS running before its first frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CSS = read('../components/ObsWidget/ObsWidget.css').replace(/\/\*[\s\S]*?\*\//g, '');
const JS = read('../js/obs-widget.js');

test('the widget still hides the picture it does not have', () => {
  assert.match(JS, /pvImg\.hidden = true/);
});

test('a hidden preview picture takes no room, whatever display its class sets', () => {
  const shown = /\.obs-preview-img\s*\{[^}]*display\s*:\s*(?!none)/.test(CSS);
  const guarded = /\.obs-preview-img\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(CSS);
  assert.ok(!shown || guarded, '.obs-preview-img sets a display, so it needs .obs-preview-img[hidden] { display: none }');
});

// On Wayland GTK sends a window's new input region to the compositor with its next frame. A layer
// window whose page is still draws none, so a widget that was just set to let clicks through (or
// moved, or back) kept the old cut until something repainted (seen on headless sway: the region
// went out one change late). `cut` asks for a redraw, and that frame carries the region
// (layers/linux/wallpaper.rs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shell = fs.readFileSync(new URL('../../apps/native/src-tauri/src/layers/linux/wallpaper.rs', import.meta.url), 'utf8');

function cutBody() {
  const start = shell.indexOf('pub(super) fn cut(');
  assert.ok(start > 0, 'the input shape function is still named cut');
  const end = shell.indexOf('\n}\n', start);
  return shell.slice(start, end);
}

test('a new input region is followed by a redraw, so the compositor gets it now', () => {
  const body = cutBody();
  const shape = body.indexOf('input_shape_combine_region');
  const draw = body.indexOf('queue_draw');
  assert.ok(shape > 0, 'cut sets the input shape');
  assert.ok(draw > shape, 'and queues a redraw after it');
});

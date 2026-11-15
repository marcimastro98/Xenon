import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The glyphs of the Discord tile are one table. Two of them, the struck-through
// microphone and headphones, were once written twice in it: the second drawing
// won, silently, and the first sat there as if it were in use. A key written
// twice is always a drawing nobody sees, so the table may name each one once.

const SOURCE = fs.readFileSync(new URL('../js/discord-widget/icons.js', import.meta.url), 'utf8');

function icons() {
  const window = {};
  vm.runInNewContext(SOURCE, { window });
  return window.DiscordWidgetIcons.ICONS;
}

test('every glyph of the Discord tile is written once', () => {
  const written = [...SOURCE.matchAll(/^ {4}(\w+): '/gm)].map((found) => found[1]);
  assert.deepEqual(written.filter((name, at) => written.indexOf(name) !== at), []);
  assert.deepEqual(written.sort(), Object.keys(icons()).sort(), 'the table holds what is written in it, nothing else');
});

test('muted and deafened are the heavy struck-through drawings', () => {
  // The ones the avatar badge shows at 8px, and the same ones the two buttons
  // of the call switch to: the line across runs corner to corner at weight 3.
  const { micOff, deafOff } = icons();
  for (const drawing of [micOff, deafOff]) {
    assert.match(drawing, /stroke-width="3"/);
    assert.match(drawing, /<path d="m2 2 20 20"\/>/);
  }
  assert.match(micOff, /M12 19v3/, 'the microphone keeps its stand');
  assert.match(deafOff, /M21 14h-1\.343/, 'the headphones keep their right cup');
});

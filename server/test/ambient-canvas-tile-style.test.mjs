// An Ambient scene element's own style (applyTileStyle: text colour, panel)
// must show on the element. Both were silently lost: the text colour because
// items inherited the stage's computed colour, the panel corners because the
// radius rule was invalid CSS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../components/AmbientCanvas/AmbientCanvas.css', import.meta.url), 'utf8');
const rule = (sel) => {
  const at = CSS.indexOf(sel + ' {');
  assert.ok(at >= 0, sel);
  return CSS.slice(at, CSS.indexOf('}', at));
};

test('an element reads its own text colour', () => {
  assert.match(rule('.ac-item'), /color: var\(--text, #e8ecf4\);/);
});

test('an element panel follows the theme radius', () => {
  assert.match(rule('.ac-item[data-tile-style="custom"] > .grid-stack-item-content'), /border-radius: calc\(var\(--radius, 8px\) \* [\d.]+\);/);
});

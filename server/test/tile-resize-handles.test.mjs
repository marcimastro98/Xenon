import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Tiles resize from two corners (Discord request): to fill free space above or
// to the left, a tile no longer has to be moved first and then resized.

const GRID = readFileSync(new URL('../js/dashboard-grid.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/DashboardGrid/DashboardGrid.css', import.meta.url), 'utf8');

test('GridStack builds a top-left and a bottom-right handle', () => {
  assert.match(GRID, /resizable: \{ handles: 'se, nw' \}/);
});

test('both handles are shown while editing, the top-left one under the edit bar', () => {
  assert.match(CSS, /\.layout-editing \.grid-stack > \.grid-stack-item > \.ui-resizable-se,\s*\.layout-editing \.grid-stack > \.grid-stack-item > \.ui-resizable-nw \{\s*display: block;/);
  assert.match(CSS, /> \.ui-resizable-nw \{ left: 4px; top: 46px; \}/,
    'the corner itself holds the edit bar buttons');
  assert.match(CSS, /\.island-clear > \.ui-resizable-nw \{\s*top: calc\(var\(--island-clear, 0px\) \+ 39px\);/,
    'a tile pushed down under the Minimal island takes its handle with it');
});

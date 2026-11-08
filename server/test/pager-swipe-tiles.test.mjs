// A finger dragged sideways on a tile changes the page only if every scroller
// under it lets the drag through. `overscroll-behavior: contain` stops both axes,
// so a list inside a widget made it a dead zone for the swipe: tiles contain the
// vertical axis alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const COMPONENTS = new URL('../components/', import.meta.url);
// Windows over the page, not tiles on it: nothing behind them should move. The
// pager is the scroller itself, and the widget palette (DashboardGrid) opens over it.
const OVER_THE_PAGE = new Set([
  'AmbientCanvasEditor', 'BitMessage', 'CaptureGallery', 'ColorPicker', 'CommunityStore', 'DashboardGrid',
  'DashboardPager', 'LayerHost', 'SettingsModal', 'Spotlight', 'SurfacePicker', 'Topbar',
]);

test('no tile stops the page swipe', () => {
  const stopped = [];
  for (const dir of readdirSync(COMPONENTS, { withFileTypes: true })) {
    if (!dir.isDirectory() || OVER_THE_PAGE.has(dir.name)) continue;
    for (const file of readdirSync(new URL(dir.name + '/', COMPONENTS))) {
      if (!file.endsWith('.css')) continue;
      const css = readFileSync(new URL(`${dir.name}/${file}`, COMPONENTS), 'utf8');
      if (/overscroll-behavior(-x)?\s*:\s*(contain|none)/.test(css)) stopped.push(file);
    }
  }
  assert.deepEqual(stopped, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { insertPreset, normalizePresets } = require('../js/dashboard-presets.js');

// A preset that places a Store widget's host tile ('custom') may reuse the
// hidden primary. Which widget that tile shows lives outside the layout and
// survives hiding, so the reused tile must start empty rather than bring back
// the widget it held last time, which the preset never named.
test('a preset reusing the hidden custom primary clears its old assignment', () => {
  const cleared = [];
  globalThis.window = { CustomWidget: { clearAssign: (id) => cleared.push(id) } };
  try {
    const layout = {
      widgets: { custom: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: false }, notes: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: true } },
      groups: {}, copies: [], pages: [{ id: 'dashboard' }],
    };
    const res = insertPreset(layout, { kind: 'widget', name: 'x', data: { widget: 'custom', w: 4, h: 4 } }, 'dashboard');
    assert.notEqual(res && res.ok, false);
    assert.equal(layout.widgets.custom.visible, true);
    assert.deepEqual(cleared, ['custom']);
    // A built-in widget is not touched.
    cleared.length = 0;
    layout.widgets.notes.visible = false;
    insertPreset(layout, { kind: 'widget', name: 'y', data: { widget: 'notes', w: 4, h: 4 } }, 'dashboard');
    assert.deepEqual(cleared, []);
  } finally { delete globalThis.window; }
});

// A page can name the Store package that fills a custom tile, so a bundle's page
// opens with its widget instead of the chooser. The name is shape-checked and only
// ever read from a custom tile.
test('a page preset keeps a valid package name on a custom tile and reports what to bind', () => {
  globalThis.window = { CustomWidget: { clearAssign() {} } };
  try {
    const raw = [{
      id: 'p1', name: 'Proiezione', kind: 'page', gridCols: 24,
      data: { items: [
        { type: 'widget', widget: 'custom', x: 17, y: 3, w: 7, h: 16, pkg: 'nitrato-didascalia' },
        { type: 'widget', widget: 'notes', x: 0, y: 0, w: 4, h: 4, pkg: 'nitrato-didascalia' },
        { type: 'widget', widget: 'custom', x: 0, y: 8, w: 4, h: 4, pkg: '../evil' },
      ] },
    }];
    const [preset] = normalizePresets(raw, ['custom', 'notes']);
    const items = preset.data.items;
    assert.equal(items[0].pkg, 'nitrato-didascalia');
    assert.equal(items[1].pkg, undefined, 'only a custom tile can name a package');
    assert.equal(items[2].pkg, undefined, 'a malformed id is dropped');

    const layout = {
      widgets: { custom: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: false }, notes: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: false } },
      groups: {}, copies: [], pages: [{ id: 'dashboard' }],
    };
    const res = insertPreset(layout, preset, 'dashboard');
    assert.equal(res.ok, true);
    assert.deepEqual(res.bind, [{ instance: 'custom', pkg: 'nitrato-didascalia' }]);
  } finally { delete globalThis.window; }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { insertPreset } = require('../js/dashboard-presets.js');

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

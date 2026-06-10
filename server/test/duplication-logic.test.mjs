import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const di = require('../js/dashboard-instances.js');

test('baseWidgetOf strips the copy suffix', () => {
  assert.equal(di.baseWidgetOf('system'), 'system');
  assert.equal(di.baseWidgetOf('system~k3f9'), 'system');
  assert.equal(di.baseWidgetOf(''), '');
});

test('makeCopyId returns a unique <widget>~xxxx not in existing', () => {
  const existing = new Set(['system', 'system~aaaa']);
  const id = di.makeCopyId('system', existing);
  assert.match(id, /^system~[a-z0-9]+$/);
  assert.ok(!existing.has(id));
  assert.equal(di.baseWidgetOf(id), 'system');
});

test('normalizeCopies keeps valid copies, drops unknown widgets, clamps page + geometry, dedupes ids', () => {
  const widgets = { system: { visible: true }, mic: { visible: true } };
  const pageIds = ['dashboard', 'lighting'];
  const raw = [
    { id: 'system~a', widget: 'system', x: 2, y: 1, w: 4, h: 3, page: 'lighting' },
    { id: 'ghost~b', widget: 'ghost', x: 0, y: 0, w: 1, h: 1, page: 'dashboard' },
    { id: 'system~c', widget: 'system', x: -5, y: -2, w: 0, h: 0, page: 'nope' },
    { id: 'system~a', widget: 'system', x: 0, y: 0, w: 1, h: 1, page: 'dashboard' },
    { nonsense: true },
  ];
  const out = di.normalizeCopies(raw, widgets, pageIds);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'system~a', widget: 'system', x: 2, y: 1, w: 4, h: 3, page: 'lighting' });
  assert.deepEqual(out[1], { id: 'system~c', widget: 'system', x: 0, y: 0, w: 1, h: 1, page: 'dashboard' });
});

test('placementsForPage returns the primary widget + its copies on that page', () => {
  const layout = {
    widgets: {
      system: { visible: true, page: 'dashboard', x: 0, y: 0, w: 4, h: 4 },
      mic: { visible: false, page: 'dashboard', x: 0, y: 0, w: 4, h: 3 },
    },
    copies: [
      { id: 'system~a', widget: 'system', x: 4, y: 0, w: 4, h: 4, page: 'dashboard' },
      { id: 'system~b', widget: 'system', x: 0, y: 0, w: 4, h: 4, page: 'lighting' },
    ],
    groups: {},
  };
  const out = di.placementsForPage(layout, 'dashboard');
  assert.deepEqual(out, [
    { instanceId: 'system', widget: 'system', x: 0, y: 0, w: 4, h: 4 },
    { instanceId: 'system~a', widget: 'system', x: 4, y: 0, w: 4, h: 4 },
  ]);
});

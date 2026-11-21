// Bit's page map names the Store and Bit-made widgets on each page. Without
// them a page holding only such widgets read "empty", and Bit told the user
// there was nothing to change on it (seen 21 Nov 2026 with a real widget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function describe(layout, names) {
  const ctx = {
    document: { body: { classList: { contains: () => false } } },
    DASHBOARD_WIDGET_IDS: ['media', 'notes', 'custom'],
    DASHBOARD_PAGES_MAX: 8,
    getDashboardLayout: () => layout,
  };
  ctx.window = ctx;
  ctx.CustomWidget = { assignedName: (id) => names[id] || '' };
  vm.runInNewContext(read('../js/first-run/genesis.js'), ctx);
  return JSON.parse(JSON.stringify(ctx.Genesis.describeState()));
}

const layout = {
  pages: [{ id: 'dashboard', name: '' }, { id: 'p2', name: 'Week' }, { id: 'p3', name: 'Empty' }],
  widgets: {
    media: { visible: true, page: 'dashboard' },
    notes: { visible: false, page: 'p2' },
    custom: { visible: true, page: 'dashboard' },
  },
  copies: [
    { id: 'custom~a', widget: 'custom', page: 'p2' },
    { id: 'custom~b', widget: 'custom', page: 'p2' },
    { id: 'custom~c', widget: 'custom', page: 'p2' },
    { id: 'media~x', widget: 'media', page: 'p3' },
  ],
};

test('a page of Store or Bit-made widgets lists them by name, once each', () => {
  const s = describe(layout, { custom: 'Clock Face', 'custom~a': 'Ruled Week', 'custom~b': 'Ruled Week', 'media~x': 'Not theirs' });
  const byId = Object.fromEntries(s.pages.map((p) => [p.id, p]));
  assert.deepEqual(byId.p2.mine, ['Ruled Week'], 'two tiles of one widget, one unassigned tile left out');
  assert.deepEqual(byId.p2.widgets, []);
  assert.deepEqual(byId.dashboard.mine, ['Clock Face'], 'the base tile counts on its own page');
  assert.deepEqual(byId.p3.mine, [], 'a copy of a built-in widget is not one of theirs');
  assert.equal(byId.dashboard.name, 'dashboard');
});

test('without the widget script loaded the map still comes back', () => {
  const ctx = {
    document: { body: { classList: { contains: () => false } } },
    DASHBOARD_WIDGET_IDS: ['media'], DASHBOARD_PAGES_MAX: 8, getDashboardLayout: () => layout,
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/first-run/genesis.js'), ctx);
  const s = ctx.Genesis.describeState();
  assert.ok(s && s.pages.every((p) => p.mine.length === 0));
});

test('the server tells the model those widgets are there and how to change them', () => {
  const server = read('../server.js');
  assert.match(server, /\.concat\(\(Array\.isArray\(p\.mine\) \? p\.mine : \[\]\)\.slice\(0, 16\)\.map\(n => `your widget "\$\{String\(n\)\.replace\(\/\["\\r\\n\]\/g, ''\)\.slice\(0, 40\)\}"`\)\)/);
  assert.match(server, /A "your widget" is one the user installed or made: to change it use my_widgets then create_widget/);
});

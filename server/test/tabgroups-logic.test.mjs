import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tg = require('../js/dashboard-tabgroups.js');

test('rectsOverlapRatio: full overlap = 1, none = 0, half ≈ 0.5', () => {
  assert.equal(tg.rectsOverlapRatio({ x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 0, w: 4, h: 4 }), 1);
  assert.equal(tg.rectsOverlapRatio({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 2, h: 2 }), 0);
  assert.equal(tg.rectsOverlapRatio({ x: 0, y: 0, w: 4, h: 2 }, { x: 2, y: 0, w: 4, h: 2 }), 0.5);
});

test('widgetGroupOf finds the group containing a widget', () => {
  const groups = { g1: { members: ['media', 'chat'] } };
  assert.equal(tg.widgetGroupOf(groups, 'chat'), 'g1');
  assert.equal(tg.widgetGroupOf(groups, 'system'), null);
});

test('mergeWidgets: two standalone → new group at target geometry, active=target', () => {
  const layout = { widgets: { media: { x: 4, y: 0, w: 4, h: 4, page: 'dashboard' }, calendar: { x: 0, y: 0, w: 3, h: 2, page: 'dashboard' } }, groups: {} };
  const gid = tg.mergeWidgets(layout, 'calendar', 'media');
  assert.ok(gid && layout.groups[gid]);
  assert.deepEqual(layout.groups[gid].members.sort(), ['calendar', 'media']);
  assert.equal(layout.groups[gid].active, 'media');
  assert.equal(layout.groups[gid].x, 4); assert.equal(layout.groups[gid].page, 'dashboard');
});

test('mergeWidgets: into an existing group adds the member', () => {
  const layout = { widgets: { system: { x: 8, y: 0, w: 4, h: 4, page: 'dashboard' }, media: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard' }, chat: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard' } }, groups: { g1: { id: 'g1', members: ['media', 'chat'], active: 'media', x: 0, y: 0, w: 4, h: 4, page: 'dashboard' } } };
  const gid = tg.mergeWidgets(layout, 'system', 'media');
  assert.equal(gid, 'g1');
  assert.deepEqual(layout.groups.g1.members.sort(), ['chat', 'media', 'system']);
});

test('mergeWidgets keeps the joining primary\'s page in step with the group', () => {
  const layout = { widgets: { media: { x: 0, y: 0, w: 4, h: 4, page: 'p2' }, calendar: { x: 0, y: 0, w: 3, h: 2, page: 'p1' } }, groups: {} };
  const gid = tg.mergeWidgets(layout, 'calendar', 'media');
  assert.equal(layout.groups[gid].page, 'p2');
  // Without this sync the member's stale page made it "teleport" to p1 when
  // the group (or its page) was later removed.
  assert.equal(layout.widgets.calendar.page, 'p2');
});

// addAsTab reads/writes the layout through free-variable globals in the browser;
// stub them so the copy-vs-move decision can be exercised without a DOM.
function withStubbedLayout(layout, fn) {
  const saved = [];
  globalThis.getDashboardLayout = () => layout;
  globalThis.saveDashboardLayout = (l) => { saved.push(l); };
  globalThis.window = { DashboardInstances: require('../js/dashboard-instances.js') };
  try { fn(); } finally {
    delete globalThis.getDashboardLayout; delete globalThis.saveDashboardLayout; delete globalThis.window;
  }
  return saved;
}

test('addAsTab: a custom widget always joins as a NEW copy, never the hidden base', () => {
  // Every SDK package shares the id 'custom', and which package fills a tile is
  // keyed by INSTANCE id outside the layout — so moving the base in would both
  // restore the last package (no chooser) and cap the group at one custom tab.
  const layout = {
    widgets: { media: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: true }, custom: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: false } },
    groups: {}, copies: [],
  };
  const saved = withStubbedLayout(layout, () => {
    tg.addAsTab('custom', 'media');
    tg.addAsTab('custom', 'media');
  });
  assert.equal(saved.length, 2);
  const g = layout.groups[Object.keys(layout.groups)[0]];
  assert.equal(layout.copies.length, 2, 'each add mints its own copy instance');
  assert.ok(layout.copies.every(c => c.widget === 'custom' && c.id.startsWith('custom~')));
  assert.equal(new Set(layout.copies.map(c => c.id)).size, 2, 'copy ids are distinct');
  assert.deepEqual(g.members, ['media', ...layout.copies.map(c => c.id)]);
  assert.equal(g.active, layout.copies[1].id);
  assert.equal(layout.widgets.custom.visible, false, 'the base custom tile is left alone');
});

test("addAsTab: adding 'custom' onto the custom PRIMARY stacks a new copy (was a silent no-op)", () => {
  // _tabTargetMember resolves a standalone custom tile — and a group whose first
  // member is the custom primary — to the bare id 'custom', so "+ Tab → Custom
  // widget" reaches addAsTab('custom', 'custom'). The old widgetId===targetMember
  // guard swallowed exactly that, so a custom tile could never become a two-tab
  // group of independently-assignable custom widgets (Swiv's report).
  const layout = {
    widgets: { custom: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: true } },
    groups: {}, copies: [],
  };
  const saved = withStubbedLayout(layout, () => { tg.addAsTab('custom', 'custom'); });
  assert.equal(saved.length, 1, 'the add is no longer swallowed');
  const gid = Object.keys(layout.groups)[0];
  assert.ok(gid, 'a tab group is created from the standalone primary');
  const g = layout.groups[gid];
  assert.equal(layout.copies.length, 1, 'a fresh copy instance was minted');
  assert.ok(g.members.includes('custom'), 'the primary stays a member (keeps its own assignment)');
  assert.ok(g.members.includes(layout.copies[0].id), 'the new copy is a member');
  assert.notEqual(layout.copies[0].id, 'custom', 'the copy is a distinct instance id');
  assert.equal(g.active, layout.copies[0].id, 'the freshly added tab is active');
  // A further "+ Tab → Custom" (target still resolves to members[0] === 'custom')
  // keeps stacking distinct copies rather than no-opping.
  withStubbedLayout(layout, () => { tg.addAsTab('custom', 'custom'); });
  assert.equal(layout.copies.length, 2, 'a second custom tab stacks another copy');
  assert.equal(new Set(layout.copies.map(c => c.id)).size, 2, 'copy ids stay distinct');
});

test("addAsTab: a non-custom self-add is still a no-op (guard intact for movable widgets)", () => {
  // The guard must still reject widgetId===targetMember for everything that is
  // NOT the always-copy custom host — a media tile can't be tabbed into itself.
  const layout = {
    widgets: { media: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: true } },
    groups: {}, copies: [],
  };
  const saved = withStubbedLayout(layout, () => { tg.addAsTab('media', 'media'); });
  assert.equal(saved.length, 0, 'self-add of a non-custom widget does nothing');
  assert.equal(Object.keys(layout.groups).length, 0);
});

test('addAsTab: move:true still relocates the existing custom tile, package intact', () => {
  const layout = {
    widgets: { media: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: true }, custom: { x: 0, y: 0, w: 4, h: 4, page: 'dashboard', visible: true } },
    groups: {}, copies: [],
  };
  withStubbedLayout(layout, () => { tg.addAsTab('custom', 'media', { move: true }); });
  const g = layout.groups[Object.keys(layout.groups)[0]];
  assert.deepEqual(g.members, ['media', 'custom']);
  assert.equal(layout.copies.length, 0);
});

test('extractMember: removes a member; dissolves group at one remaining', () => {
  const layout = { widgets: { media: {}, chat: {} }, groups: { g1: { id: 'g1', members: ['media', 'chat'], active: 'media', x: 2, y: 1, w: 4, h: 4, page: 'dashboard' } } };
  const r1 = tg.extractMember(layout, 'g1', 'chat');
  assert.equal(r1.dissolved, true);
  assert.equal(layout.groups.g1, undefined);
  assert.equal(layout.widgets.media.x, 2);
  assert.equal(layout.widgets.media.page, 'dashboard');
  assert.equal(layout.widgets.chat.visible, true);
});

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

test('extractMember: removes a member; dissolves group at one remaining', () => {
  const layout = { widgets: { media: {}, chat: {} }, groups: { g1: { id: 'g1', members: ['media', 'chat'], active: 'media', x: 2, y: 1, w: 4, h: 4, page: 'dashboard' } } };
  const r1 = tg.extractMember(layout, 'g1', 'chat');
  assert.equal(r1.dissolved, true);
  assert.equal(layout.groups.g1, undefined);
  assert.equal(layout.widgets.media.x, 2);
  assert.equal(layout.widgets.media.page, 'dashboard');
  assert.equal(layout.widgets.chat.visible, true);
});

// The `topbar` share code (js/topbar-share.js + preset-share.js). What a user
// would notice if it broke: a shared bar that imports without its buttons or
// rails, a code that hides Settings or Layout, an island option of theirs wiped
// by someone else's bar, or a Store/catalog that does not know the kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TopbarShare = require('../js/topbar-share.js');
const TopbarLook = require('../js/topbar-look.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fnSource(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, signature);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('no closing brace: ' + signature);
}
const SETTINGS = read('../js/settings.js');
const normalizeTopbarClock = Function(
  fnSource(SETTINGS, 'function normalizeTopbarActions(value)')
  + '\nreturn (' + fnSource(SETTINGS, 'function normalizeTopbarClock(value, legacyRoot)') + ')',
)();

const mine = {
  topbarStyle: 'minimal',
  dashboardLayout: { topbarHidden: false, rows: 3 },
  topbarLook: { surface: 'solid', color: '#112233', buttons: { lock: { label: 'Chiudi', labelMode: 'always' } } },
  topbarClock: {
    version: 2, align: 'left', pageLabels: true, takeovers: false, hiddenSources: ['my-widget'],
    items: [{ id: 'date', hidden: false }, { id: 'time', hidden: false }, { id: 'claude', hidden: true }],
    actions: [{ id: 'search', side: 'right', hidden: false }, { id: 'lock', side: 'left', hidden: true }],
  },
  topbarRails: { left: true, right: false },
  topbarRailsAutoHide: false,
};

test('a bar survives the trip: look, style, island, buttons and rails', () => {
  const share = TopbarShare.read(JSON.parse(JSON.stringify(TopbarShare.of(mine))));
  assert.equal(share.style, 'minimal');
  assert.equal(share.look.surface, 'solid');
  assert.equal(share.look.color, '#112233');
  assert.equal(share.look.buttons.lock.label, 'Chiudi');
  assert.equal(share.clock.align, 'left');
  assert.equal(share.clock.pageLabels, true);
  assert.deepEqual(share.clock.items.map((i) => i.id), ['date', 'time', 'claude']);
  assert.deepEqual(share.clock.actions[0], { id: 'search', hidden: false, side: 'right' });
  assert.deepEqual(share.rails, { left: true, right: false });
  assert.equal(share.railsAutoHide, false);
});

test('"None" travels as a style and keeps the style underneath on import', () => {
  const none = TopbarShare.of({ ...mine, dashboardLayout: { topbarHidden: true } });
  assert.equal(none.style, 'none');
  const patch = TopbarShare.patch({ topbarStyle: 'minimal', dashboardLayout: { rows: 3 } }, TopbarShare.read(none));
  assert.equal(patch.topbarStyle, 'minimal');
  assert.deepEqual(patch.dashboardLayout, { rows: 3, topbarHidden: true });
  const full = TopbarShare.patch({ topbarStyle: 'minimal', dashboardLayout: { topbarHidden: true } }, TopbarShare.read({ look: {}, style: 'full' }));
  assert.equal(full.topbarStyle, 'full');
  assert.equal(full.dashboardLayout.topbarHidden, false);
});

test('anything that is not a bar is refused, and only known fields are kept', () => {
  for (const bad of [null, 'x', [], {}, { look: [] }, { look: 'solid' }]) assert.equal(TopbarShare.read(bad), null);
  const share = TopbarShare.read({ look: { surface: 'nope', evil: 1 }, style: 'huge', extra: true, clock: { align: 'up', items: 'x' } });
  assert.deepEqual(Object.keys(share).sort(), ['clock', 'look', 'rails', 'railsAutoHide', 'style']);
  assert.equal(share.style, 'full');
  assert.equal(share.look.surface, TopbarLook.DEFAULTS.surface);
  assert.equal('evil' in share.look, false);
  assert.equal(share.clock.align, 'center');
  assert.deepEqual(share.clock.items, []);
});

test('lists are capped and bad ids dropped before the normalizer sees them', () => {
  const actions = Array.from({ length: 200 }, (_, i) => ({ id: 'b' + i, side: 'right' }));
  actions.unshift({ id: '<img>' }, { id: 42 }, null);
  const share = TopbarShare.read({ look: {}, clock: { actions } });
  assert.ok(share.clock.actions.length <= TopbarShare.MAX_ENTRIES);
  assert.ok(share.clock.actions.every((a) => /^[a-z0-9]/.test(a.id)));
});

test('a shared bar can never hide Settings or Layout', () => {
  const share = TopbarShare.read({
    look: {},
    clock: { actions: [{ id: 'settings', hidden: true }, { id: 'layout', hidden: true }] },
  });
  const patch = TopbarShare.patch(mine, share);
  const clock = normalizeTopbarClock(patch.topbarClock, patch);
  for (const id of ['settings', 'layout']) assert.equal(clock.actions.find((a) => a.id === id).hidden, false, id);
});

test('import keeps the island options that are not part of a bar', () => {
  const patch = TopbarShare.patch(mine, TopbarShare.read({ look: {}, clock: { items: [{ id: 'vitals', hidden: true }] } }));
  assert.equal(patch.topbarClock.takeovers, false);
  assert.deepEqual(patch.topbarClock.hiddenSources, ['my-widget']);
  // The older per-feature switches follow the island list.
  assert.equal(patch.claudeWidget.topbar, true);
  assert.equal(patch.vitals.topbar, false);
});

test('every place that lists the share kinds knows `topbar`', () => {
  const lists = [
    [read('../js/preset-share.js'), /const PRESET_KINDS = \[([^\]]*)\]/],
    [read('../js/preset-share.js'), /const CATALOG_PUBLISH_KINDS = \[([^\]]*)\]/],
    [read('../js/content-installs.js'), /const KINDS = Object\.freeze\(\[([^\]]*)\]/],
    [read('../community-catalog.js'), /const CATALOG_KINDS = new Set\(\[([^\]]*)\]/],
    [read('../js/community-gallery.js'), /const KIND_ORDER = \[([^\]]*)\]/],
    [read('../../docs/catalog/index.html'), /const KINDS = \[([^\]]*)\]/],
  ];
  for (const [src, re] of lists) {
    const m = src.match(re);
    assert.ok(m, String(re));
    assert.match(m[1], /'topbar'/, String(re));
  }
});

test('the import shows a review step and the export is in the Export list', () => {
  const src = read('../js/preset-share.js');
  assert.match(src, /if \(env\.kind === 'topbar'\) \{ close\(\); openTopbarImport\(env\.name, env\.data\); return; \}/);
  assert.match(src, /\{ kind: 'topbar', label: \['settings_share_topbar'/);
  assert.match(src, /if \(sel\.topbar && window\.TopbarShare\) data\.topbar = TopbarShare\.of\(HS\(\)\);/);
  const index = read('../index.html');
  assert.ok(index.indexOf('src="js/topbar-share.js"') > index.indexOf('src="js/topbar-look.js"'));
  assert.ok(index.indexOf('src="js/topbar-share.js"') < index.indexOf('src="js/settings.js"'));
});

test('a theme carries only the bar style, and none at all for an untouched bar', () => {
  assert.equal(TopbarLook.themePart({}), null);
  assert.equal(TopbarLook.themePart(null), null);
  const part = TopbarLook.themePart({ surface: 'solid', railLeft: 'off', buttons: { lock: { label: 'X' } } });
  assert.deepEqual(Object.keys(part).sort(), [...TopbarLook.THEME_KEYS].sort());
  const mineLook = { surface: 'glass', railLeft: 'off', toastPlace: 'top-left', accent: 'lock', buttons: { lock: { label: 'Chiudi' } } };
  const after = TopbarLook.withThemePart(mineLook, part);
  assert.equal(after.surface, 'solid');
  assert.equal(after.railLeft, 'off');
  assert.equal(after.toastPlace, 'top-left');
  assert.equal(after.accent, 'lock');
  assert.equal(after.buttons.lock.label, 'Chiudi');
});

test('saved themes, theme codes and theme import all use the theme part', () => {
  assert.match(SETTINGS, /const bar = TopbarLook\.themePart\(raw\.topbarLook\);\n\s*if \(bar\) theme\.topbarLook = bar;/);
  assert.match(SETTINGS, /patch\.topbarLook = TopbarLook\.withThemePart\(hubSettings\.topbarLook, theme\.topbarLook\)/);
  const share = read('../js/preset-share.js');
  assert.match(share, /const bar = window\.TopbarLook \? TopbarLook\.themePart\(s\.topbarLook\) : null;\n\s*if \(bar\) out\.topbarLook = bar;/);
  assert.match(share, /patch\.topbarLook = TopbarLook\.withThemePart\(HS\(\)\.topbarLook, data\.topbarLook\)/);
});

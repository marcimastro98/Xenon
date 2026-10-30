import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { covers, triedFrom, restoreThemeFor, endedTile, unmarked, endCardItems, trialPageUrl } = require('../js/trial-pass-ui.js');
const { normalizeContentInstalls } = require('../js/content-installs.js');

// The dashboard half of the pass trial: which Store entries get the button,
// what the end of the trial records and takes off, and what a tile shows after.

const NOW = Date.parse('2026-10-26T12:00:00Z');

test('the trial button shows on supporter drops past their first 30 days, never on limited ones', () => {
  const old = '2026-09-01';
  assert.equal(covers({ id: 'wall-plate', supportersOnly: true, addedAt: old }, NOW), true);
  assert.equal(covers({ id: 'wall-plate', locked: true, addedAt: old }, NOW), true);
  assert.equal(covers({ id: 'fresh', supportersOnly: true, addedAt: '2026-10-10' }, NOW), false, 'a fresh drop is for supporters');
  assert.equal(covers({ id: 'nodate', supportersOnly: true }, NOW), false, 'no date: no promise');
  assert.equal(covers({ id: 'ltd', supportersOnly: true, addedAt: old, limited: { dropId: 'x' } }, NOW), false);
  assert.equal(covers({ id: 'free', addedAt: old }, NOW), false, 'a free entry needs no trial');
  assert.equal(covers({ id: 'feature-devclean', supportersOnly: true, addedAt: old }, NOW), false);
  assert.equal(covers({ id: 'feature-lyrics', supportersOnly: true, addedAt: '2026-10-25' }, NOW), true, 'features are in from day one');
});

test('the trial follows the choice made in the hub, and never opens a drop sold only for Sparks', () => {
  const fresh = '2026-10-20';
  assert.equal(covers({ id: 'now', supportersOnly: true, trial: 'now', addedAt: fresh }, NOW), true, "'now' opens a fresh drop");
  assert.equal(covers({ id: 'never', supportersOnly: true, trial: 'never', addedAt: '2026-01-01' }, NOW), false);
  assert.equal(covers({ id: 'feature-x', supportersOnly: true, trial: 'never' }, NOW), false, "'never' wins over a feature");
  assert.equal(covers({ id: 'sparks-only', locked: true, sparks: 150, addedAt: '2026-01-01' }, NOW), false);
  assert.equal(covers({ id: 'both', supportersOnly: true, locked: true, sparks: 150, addedAt: '2026-01-01' }, NOW), true, 'supporters or Sparks stays in');
  assert.equal(covers({ id: 'ltd-now', supportersOnly: true, trial: 'now', limited: { dropId: 'x' } }, NOW), false, 'limited is never in');
});

test('the end records each trial entry once, with the tiles waiting for its widgets', () => {
  const records = [
    { id: 'xi_a', trial: true, sourceId: 'wall-plate', name: 'Wall Plate', kind: 'widget', resources: { widgetIds: ['casa'] } },
    { id: 'xi_b', trial: true, sourceId: 'wall-plate', name: 'again', kind: 'widget', resources: { widgetIds: ['casa'] } },
    { id: 'xi_c', sourceId: 'free-theme', name: 'Mine', resources: { widgetIds: ['x'] } },
    { id: 'xi_d', trial: true, sourceId: 'nitrato', name: 'Nitrato', kind: 'theme', resources: {} },
  ];
  const assign = { custom: 'casa', 'custom-2': 'other', 'custom-3': 'casa' };
  assert.deepEqual(triedFrom(records, assign), [
    { entryId: 'wall-plate', name: 'Wall Plate', kind: 'widget', widgetIds: ['casa'], tiles: ['custom', 'custom-3'] },
    { entryId: 'nitrato', name: 'Nitrato', kind: 'theme', widgetIds: [], tiles: [] },
  ]);
});

test('the theme that comes back is the one before the FIRST trial install', () => {
  assert.equal(restoreThemeFor([
    { trial: true, installedAt: 30, prevThemeId: 'trial-theme-a' },
    { trial: true, installedAt: 10, prevThemeId: 'carbon' },
    { installedAt: 1, prevThemeId: 'ignored' },
  ]), 'carbon');
  assert.equal(restoreThemeFor([{ trial: true, installedAt: 5 }]), '');
});

test('a tile whose widget the trial took off says so; a supporter gets "put it back"', () => {
  const ended = { state: 'ended', tried: [{ entryId: 'wall-plate', name: 'Wall Plate', widgetIds: ['casa'] }] };
  assert.deepEqual(endedTile(ended, 'casa', false), { entryId: 'wall-plate', name: 'Wall Plate', canPutBack: false });
  assert.equal(endedTile(ended, 'casa', true).canPutBack, true);
  assert.equal(endedTile({ ...ended, state: 'converted' }, 'casa', false).canPutBack, true);
  assert.equal(endedTile(ended, 'other', false), null, 'a widget removed by hand stays "removed"');
  assert.equal(endedTile({ ...ended, state: 'active' }, 'casa', false), null);
  assert.equal(endedTile(null, 'casa', false), null);
});

test('receipts keep the trial mark through normalize, and lose it after a conversion', () => {
  const raw = [{
    id: 'xi_abcd1234', name: 'Wall Plate', kind: 'widget', installedAt: 1, source: 'catalog', sourceId: 'wall-plate',
    trial: true, prevThemeId: 'carbon', resources: { widgetIds: ['casa'] },
  }];
  const [rec] = normalizeContentInstalls(raw);
  assert.equal(rec.trial, true);
  assert.equal(rec.prevThemeId, 'carbon');
  const [bad] = normalizeContentInstalls([{ ...raw[0], prevThemeId: '../x' }]);
  assert.equal(bad.prevThemeId, undefined, 'a theme id that is not one is dropped');
  const [plain] = normalizeContentInstalls([{ ...raw[0], trial: 'yes' }]);
  assert.equal(plain.trial, undefined);
  const [kept] = unmarked([rec]);
  assert.equal(kept.trial, undefined);
  assert.equal(kept.prevThemeId, undefined);
  assert.equal(kept.sourceId, 'wall-plate');
});

test('the end card shows a picture of each thing used, from the Store catalog, with its name', () => {
  const tried = [
    { entryId: 'wall-plate', name: 'Wall Plate', kind: 'widget' },
    { entryId: 'gone', name: 'Gone from the Store', kind: 'theme' },
    { entryId: 'noname', name: '' },
    { entryId: 'wall-plate', name: 'again' },
    { entryId: 'feature-lyrics', name: 'Lyrics', kind: 'feature' },
  ];
  const entries = [{ id: 'wall-plate', kind: 'widget', shots: 2 }, { id: 'other', shots: 1 }];
  assert.deepEqual(endCardItems(tried, entries), [
    { entryId: 'wall-plate', name: 'Wall Plate', kind: 'widget', shots: 2, picture: '' },
    { entryId: 'gone', name: 'Gone from the Store', kind: 'theme', shots: 0, picture: '' },
    // Not a Store entry: the website's picture of it.
    { entryId: 'feature-lyrics', name: 'Lyrics', kind: 'feature', shots: 0, picture: 'https://xenon-app.com/images/home/lyrics-widget.webp' },
  ]);
  assert.deepEqual(endCardItems(null, null), []);
  assert.equal(endCardItems(tried, 'not a list')[0].shots, 0, 'no catalog: names only');
});

test('the trial page opens in the app language when the hub has it', () => {
  const base = 'https://xenon-supporter-hub.xenonedge.workers.dev/trial';
  assert.equal(trialPageUrl('it'), base + '?lang=it');
  assert.equal(trialPageUrl('de'), base + '?lang=de', 'the hub falls back by itself');
  assert.equal(trialPageUrl('zh-CN'), base + '?lang=zh');
  assert.equal(trialPageUrl(''), base);
  assert.equal(trialPageUrl('<x>'), base);
});

test('the end card has one main action, "Keep them", and the other two as quiet links', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/trial-pass-ui.js', import.meta.url), 'utf8');
  const card = src.slice(src.indexOf('function showEndCard('), src.indexOf('// ── After a conversion'));
  assert.equal((card.match(/settings-btn primary/g) || []).length, 1);
  assert.match(card, /t\('trial_keep', 'Keep them, 5 USD a month'\)/);
  assert.match(card, /link\(t\('trial_have_code'/);
  assert.match(card, /link\(t\('trial_not_now'/);
  const css = readFileSync(new URL('../components/SettingsModal/SettingsModal.css', import.meta.url), 'utf8');
  assert.match(css, /\.trial-end-link \{[^}]*min-height: 44px/, 'a link is still a full-size touch target');
});

test('nothing in the end card or the tile comes from markup', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/trial-pass-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|document\.write/);
});

// ── Holes found by trying to keep trial content ─────────────────────────────

test('a look saved on top of an imported animated background stays that import', () => {
  const { themeCardMark } = require('../js/content-installs.js');
  const bg = { enabled: true, code: 'draw()', imported: true, installId: 'xi_abcd1234' };
  assert.deepEqual(themeCardMark({ accent: '#f00', bgCustom: bg }), { imported: true, installId: 'xi_abcd1234' });
  assert.deepEqual(themeCardMark({ accent: '#f00', bgCustom: { code: 'mine()' } }), {}, 'your own background: your card');
  assert.deepEqual(themeCardMark({ accent: '#f00' }, { imported: true, installId: 'xi_zzzz9999' }), { imported: true, installId: 'xi_zzzz9999' });
  assert.deepEqual(themeCardMark({ bgCustom: { ...bg, installId: '../x' } }), { imported: true }, 'a bad id is dropped, the marker is not');
});

test('export leaves an imported background or font out of a tweaked theme; removal takes derived cards', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/preset-share.js', import.meta.url), 'utf8');
  const exp = src.slice(src.indexOf('async function themeExportData()'), src.indexOf('async function exportTheme()'));
  assert.match(exp, /bgImported\) delete data\.bgCustom/);
  assert.match(exp, /!fontImported && font/);
  assert.match(src, /filter\(theme => !\(owns\(theme\) && \(themeIds\.has\(theme\.id\) \|\| !legacy\)\)\)/);
  const settings = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /ContentInstalls\.themeCardMark\(snapshot, opts\)/);
});

test('trial content with no trial file comes off; a conversion needs the saved pass', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/trial-pass-ui.js', import.meta.url), 'utf8');
  assert.match(src, /status\.state === 'none'\) \{ await tidyOrphans\(\)/);
  assert.match(src, /now\.state !== 'none'\) return;/, 'asked again before taking anything off');
  assert.match(src, /else if \(supporterSaved\) keepAfterConversion\(\)/);
});

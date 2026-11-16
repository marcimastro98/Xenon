// "Widgets only" (a user, Nov 2026): the Deck placed on the screen had no pencil,
// so its keys could not be changed without the dashboard. The layer window takes
// no typing, so the pencil works there and a key opens its editor in the Xenon
// menu's window: one slot of one Deck, carried as `?open=deckkey`, found again
// in the saved Deck (deck-model.js slotSpot) before anything is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const dm = require('../js/deck-model.js');
const DashboardOpen = require('../js/dashboard-open.js');

function deckWithFolder() {
  let cfg = dm.normalizeDeckConfig({ cols: 2, rows: 1 });
  const root = { profileId: cfg.activeProfile, path: [], pageIndex: 0 };
  cfg = dm.setKeyAt(cfg, root, 0, { id: 'k_a', kind: 'action', title: 'A' });
  cfg = dm.setKeyAt(cfg, root, 1, { id: 'f1', kind: 'folder', title: 'F' });
  cfg = dm.setKeyAt(cfg, { ...root, path: ['f1'] }, 1, { id: 'k_in', kind: 'action', title: 'Inside' });
  return { cfg, root };
}

test('slotSpot finds the key of a slot, inside folders too', () => {
  const { cfg, root } = deckWithFolder();
  assert.equal(dm.slotSpot(cfg, root, 0).key.title, 'A');
  assert.equal(dm.slotSpot(cfg, root, 1).key.kind, 'folder');
  assert.equal(dm.slotSpot(cfg, { ...root, path: ['f1'] }, 1).key.title, 'Inside');
  assert.equal(dm.slotSpot(cfg, { ...root, path: ['f1'] }, 0).key, null, 'an empty slot is a place to add');
});

test('slotSpot grows the page for a slot the fitted Deck on the screen showed', () => {
  const { cfg, root } = deckWithFolder();
  const spot = dm.slotSpot(cfg, root, 3);
  assert.ok(spot);
  assert.equal(spot.key, null);
  const page = spot.config.profiles[0].root.pages[0];
  assert.ok(page.keys.length >= 4);
  assert.equal(page.keys[0].title, 'A', 'the keys already there stay');
  assert.equal(dm.slotSpot(dm.setKeyAt(spot.config, root, 3, { id: 'k_n', kind: 'action', title: 'N' }), root, 3).key.title, 'N');
});

test('slotSpot says nothing when the place is gone', () => {
  const { cfg, root } = deckWithFolder();
  assert.equal(dm.slotSpot(cfg, { ...root, profileId: 'prof_gone' }, 0), null);
  assert.equal(dm.slotSpot(cfg, { ...root, path: ['f_gone'] }, 0), null);
  assert.equal(dm.slotSpot(cfg, { ...root, path: ['k_a'] }, 0), null, 'a key that is not a folder');
  assert.equal(dm.slotSpot(cfg, { ...root, pageIndex: 5 }, 0), null);
  assert.equal(dm.slotSpot(cfg, root, -1), null);
  assert.equal(dm.slotSpot(cfg, root, 1.5), null);
  assert.equal(dm.slotSpot(cfg, null, 0), null);
});

const GOOD = { open: 'deckkey', deck: 'deck~ab12', profile: 'prof_1', path: 'f1.f2', page: 0, slot: 7 };

test('deckkey: one slot of one Deck, whole or nothing', () => {
  assert.deepEqual(DashboardOpen.normalize(GOOD), { open: 'deckkey', deck: 'deck~ab12', profile: 'prof_1', path: 'f1.f2', page: '0', slot: '7' });
  assert.deepEqual(DashboardOpen.normalize({ ...GOOD, deck: 'deck', path: '' }).path, '');
  const bad = [
    { deck: 'notes' }, { deck: 'deck~AB' }, { deck: '../deck' },
    { profile: '' }, { profile: 'a b' }, { path: 'f1..f2' }, { path: '../x' },
    { path: Array(9).fill('f').join('.') }, { page: -1 }, { page: '1e3' }, { slot: 1000 }, { slot: 1.5 }, { slot: undefined },
  ];
  for (const change of bad) assert.equal(DashboardOpen.normalize({ ...GOOD, ...change }), null, JSON.stringify(change));
  assert.ok(DashboardOpen.normalize({ ...GOOD, path: Array(8).fill('f').join('.') }), 'eight folders deep is the limit');
});

test('deckkey: the menu window address carries it and reads it back the same', () => {
  const address = DashboardOpen.sheetAddress(GOOD);
  assert.match(address, /^\/\?panel=sheet&open=deckkey&deck=deck~ab12&profile=prof_1&path=f1\.f2&page=0&slot=7$/);
  assert.deepEqual(DashboardOpen.parse(address.slice(1)), DashboardOpen.normalize(GOOD));
  assert.equal(DashboardOpen.sheetAddress({ ...GOOD, deck: 'x' }), '');
});

test('deckkey: run opens the slot in the Deck editor', () => {
  const asked = [];
  globalThis.window = { Deck: { openSlot: (req) => asked.push(req) } };
  try {
    assert.equal(DashboardOpen.run(GOOD), true);
    assert.deepEqual(asked, [DashboardOpen.normalize(GOOD)]);
    globalThis.window = {};
    assert.equal(DashboardOpen.run(GOOD), false);
  } finally { delete globalThis.window; }
});

test('the Deck on the screen keeps its pencil, and its keys open in the menu window', () => {
  assert.doesNotMatch(read('../components/LayerHost/LayerHost.css'), /\.deck-edit\s*\{[^}]*display:\s*none/);
  const deck = read('../js/deck.js');
  assert.match(deck, /function openEditor\([^)]*\) \{\n\s*if \(onScreenLayer\(\)\) \{ editInMenuWindow\(/);
  assert.match(deck, /const onScreenLayer = \(\) => typeof isLayerPage === 'function' && isLayerPage\(\) && !isSheetPage\(\);/);
  assert.match(deck, /fetch\(SERVER \+ '\/screen-menu', \{ method: 'POST'/);
  assert.match(deck, /d\.where !== 'screen'\) onDashboard\(\)/, 'no menu window: the dashboard opens instead');
  assert.match(deck, /window\.Deck = \{[^}]*openSlot/);
});

test('a key saved in the menu window shows at once on the Deck on the screen', () => {
  // Same browser, same storage: the server copy then equals this window's, so
  // adoptServerDeck sees no change and the grid fitted before would stay.
  const deck = read('../js/deck.js');
  assert.match(deck, /window\.addEventListener\('storage', \(e\) => \{\s*if \(e\.key !== STORE_KEY\) return;\s*displayConfigs\.clear\(\);\s*renderAll\(\);/);
});

test('the slot is found again in the saved Deck before every write', () => {
  const deck = read('../js/deck.js');
  const body = deck.slice(deck.indexOf('async function openSlot('), deck.indexOf('function slotGone('));
  assert.match(body, /await hydrateDeckFromServer\(\)/);
  assert.match(body, /const save = \(change\) => \{\s*const now = spotNow\(\);\s*if \(now\) saveConfig\(req\.deck, change\(now\.config\)\);\s*else slotGone\(\);/);
  assert.equal((body.match(/save\(\(cfg\) =>/g) || []).length, 3, 'save, delete and the page style all go through it');
});

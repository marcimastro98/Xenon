// Pages of the screen widgets: "Work" and "Games", one shown at a time, the
// games page following the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../js/layers-model.js');
const P = require('../layer-pages.js');

const W = (id, over = {}) => ({ id, kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, ...over });
const seq = () => { let i = 0; return () => ((i++ * 0.1379) % 1); };
const base = () => ({ enabled: true, widgets: [W('lw_aaaa0001'), W('lw_aaaa0002', { widget: 'media' })] });
const twoPages = () => P.addPage(base(), 'Games', seq()).layers;

test('fewer than two pages is no pages: widgets carry none and the shape stays the old one', () => {
  const one = L.normalize({ ...base(), pages: [{ id: 'lp_only0001', name: 'Solo' }], page: 'lp_only0001' });
  assert.deepEqual(one.pages, []);
  assert.equal(one.page, '');
  assert.ok(one.widgets.every((w) => !('page' in w)));
});

test('the first new page keeps everything on a first page and shows the new, empty one', () => {
  const r = P.addPage(base(), '  Games\u0007 ', seq());
  const cur = r.layers;
  assert.equal(cur.pages.length, 2);
  assert.equal(cur.pages[0].name, '');
  assert.equal(cur.pages[1].name, 'Games');
  assert.equal(cur.page, cur.pages[1].id);
  assert.ok(cur.widgets.every((w) => w.page === cur.pages[0].id), 'nothing moved');
  assert.deepEqual(L.shownFor(cur, 'desktop:'), [], 'the new page is empty');
  assert.deepEqual(L.surfaceKeys(cur), ['desktop:'], 'the window stays, so switching back is instant');
  assert.deepEqual(P.describePages(cur), [
    { name: 'Page 1', index: 1, active: false, gaming: false, desktop: 0 },
    { name: 'Games', index: 2, active: true, gaming: false, desktop: 0 },
  ]);
});

test('a widget placed now lands on the page shown', () => {
  const cur = twoPages();
  const r = L.addWidget(cur, { kind: 'tile', widget: 'agenda' }, seq());
  const placed = L.normalize(r.layers).widgets.find((w) => w.widget === 'agenda');
  assert.equal(placed.page, cur.page);
  assert.equal(L.shownFor(r.layers, 'desktop:').length, 1);
});

test('pages are found by name, number or id; names are unique and capped', () => {
  let cur = twoPages();
  assert.equal(P.findPage(cur, 'games').id, cur.pages[1].id);
  assert.equal(P.findPage(cur, '1').id, cur.pages[0].id);
  assert.equal(P.findPage(cur, 'page 1').id, cur.pages[0].id);
  assert.equal(P.findPage(cur, '9'), null);
  assert.equal(P.addPage(cur, 'GAMES').error, 'name_taken');
  cur = P.renamePage(cur, 1, 'Work').layers;
  assert.equal(cur.pages[0].name, 'Work');
  assert.equal(P.renamePage(cur, 'Work', 'x'.repeat(80)).page.name.length, L.PAGE_NAME_MAX);
  assert.deepEqual(P.renamePage(cur, 'nope', 'x'), { error: 'unknown_page', choices: ['Work', 'Games'] });
  assert.equal(P.renamePage(base(), 1, 'x').error, 'no_pages');
});

test('never more than MAX_PAGES pages', () => {
  let cur = base();
  const rnd = seq();
  for (let i = 0; i < 20 && !P.addPage(cur, 'p' + i, rnd).error; i++) cur = P.addPage(cur, 'p' + i, rnd).layers;
  assert.equal(cur.pages.length, L.MAX_PAGES);
  assert.equal(P.addPage(cur, 'more', rnd).error, 'too_many_pages');
  assert.equal(new Set(cur.pages.map((p) => p.id)).size, L.MAX_PAGES);
});

test('switching: by name, or "next" going round', () => {
  let cur = twoPages();
  cur = P.setActivePage(cur, 'next').layers;
  assert.equal(cur.page, cur.pages[0].id);
  assert.equal(L.shownFor(cur, 'desktop:').length, 2);
  cur = P.setActivePage(cur, '').layers;
  assert.equal(cur.page, cur.pages[1].id);
  assert.equal(P.setActivePage(cur, 'Kitchen').error, 'unknown_page');
  assert.equal(P.setActivePage(base(), 'next').error, 'no_pages');
});

test('deleting a page deletes its widgets; the last page left means no pages', () => {
  let cur = twoPages();
  cur = L.addWidget(cur, { kind: 'tile', widget: 'agenda' }, seq()).layers;
  const r = P.removePage(cur, 'Games');
  assert.equal(r.removed, 1);
  assert.deepEqual(r.layers.pages, []);
  assert.equal(r.layers.page, '');
  assert.deepEqual(r.layers.widgets.map((w) => w.id), ['lw_aaaa0001', 'lw_aaaa0002']);
  assert.ok(r.layers.widgets.every((w) => !('page' in w)));
  // Three pages, the shown one deleted: the first is shown.
  cur = P.addPage(P.addPage(base(), 'B', seq()).layers, 'C', seq()).layers;
  const r3 = P.removePage(cur, 'C');
  assert.equal(r3.layers.pages.length, 2);
  assert.equal(r3.layers.page, r3.layers.pages[0].id);
});

test('one games page at most; turning it off clears the way back', () => {
  let cur = P.addPage(twoPages(), 'Study', seq()).layers;
  cur = P.setGamingPage(cur, 'Games', true).layers;
  cur = P.setGamingPage(cur, 'Study', true).layers;
  assert.deepEqual(cur.pages.map((p) => !!p.gaming), [false, false, true]);
  cur = P.gamePageSwitch(P.setActivePage(cur, 1).layers, true);
  assert.ok(cur.resume);
  cur = P.setGamingPage(cur, 'Study', false).layers;
  assert.ok(cur.pages.every((p) => !p.gaming));
  assert.equal(cur.resume, undefined);
  // Saved with two games pages: only the first keeps the role.
  const saved = L.normalize({ ...cur, pages: cur.pages.map((p) => ({ ...p, gaming: true })) });
  assert.deepEqual(saved.pages.map((p) => !!p.gaming), [true, false, false]);
});

test('the games page follows the game and the old page comes back after', () => {
  let cur = P.setGamingPage(twoPages(), 'Games', true).layers;
  cur = P.setActivePage(cur, 1).layers;
  const work = cur.page;
  assert.equal(P.gamePageSwitch(cur, false), null, 'no game, nothing to do');
  cur = P.gamePageSwitch(cur, true);
  assert.equal(cur.page, cur.pages[1].id);
  assert.equal(cur.resume, work);
  assert.equal(P.gamePageSwitch(cur, true), null, 'idempotent while the game runs');
  cur = P.gamePageSwitch(cur, false);
  assert.equal(cur.page, work);
  assert.equal(cur.resume, undefined);
  assert.equal(P.gamePageSwitch(cur, false), null);
});

test('a page picked during the game stays when it ends', () => {
  let cur = P.addPage(P.setGamingPage(twoPages(), 'Games', true).layers, 'Music', seq()).layers;
  cur = P.setActivePage(cur, 1).layers;
  cur = P.gamePageSwitch(cur, true);
  cur = P.setActivePage(cur, 'Music').layers;
  assert.equal(P.gamePageSwitch(cur, true), null, 'the game does not take it back');
  cur = P.gamePageSwitch(cur, false);
  assert.equal(P.findPage(cur, 'Music').id, cur.page);
  assert.equal(cur.resume, undefined);
  // Already on the games page when the game starts: nothing to come back to.
  assert.equal(P.gamePageSwitch(P.setActivePage(cur, 'Games').layers, true), null);
});

test('tabs share a box only on the same page; a widget moved alone leaves its tabs', () => {
  let cur = twoPages();
  cur = P.setActivePage(cur, 1).layers;
  cur = L.groupWidgets(cur, 'lw_aaaa0001', 'lw_aaaa0002', seq()).layers;
  assert.equal(L.boxes(L.shownFor(cur, 'desktop:')).length, 1);
  const r = P.moveToPage(cur, 'lw_aaaa0002', 'Games');
  const moved = r.layers.widgets.find((w) => w.id === 'lw_aaaa0002');
  assert.equal(moved.page, r.layers.pages[1].id);
  assert.equal(moved.group, undefined);
  assert.equal(r.layers.widgets.find((w) => w.id === 'lw_aaaa0001').group, undefined, 'a lone tab is a plain widget');
  // A saved group split across pages is settled apart.
  const split = L.normalize({ ...cur, widgets: cur.widgets.map((w) => (w.id === 'lw_aaaa0002' ? { ...w, page: cur.pages[1].id } : w)) });
  assert.ok(split.widgets.every((w) => !w.group));
  assert.equal(P.moveToPage(cur, 'lw_nope0000', 'Games').error, 'not_found');
});

test('stress: any input normalizes to a valid, stable page shape', () => {
  const junk = [null, 1, 'x', [], {}, { id: 'lp_' }, { id: 'lp_ok000001', name: 5 }, { id: 'LP_BAD00001' }, { id: 'lp_ok000001' }, { id: 'lp_ok000002', name: 'a\nb', gaming: 'yes' }];
  for (let i = 0; i < 200; i++) {
    const pages = junk.slice(i % junk.length).concat(junk.slice(0, i % 3));
    const raw = { enabled: true, pages, page: i % 2 ? 'lp_ok000002' : 'zzz', resume: 'lp_ok000001', widgets: [W('lw_aaaa0001', { page: i % 2 ? 'lp_ok000002' : 'nope' })] };
    const once = L.normalize(raw);
    assert.deepEqual(L.normalize(once), once);
    if (once.pages.length) {
      assert.ok(once.pages.some((p) => p.id === once.page));
      assert.ok(once.widgets.every((w) => once.pages.some((p) => p.id === w.page)));
      assert.ok(!once.resume || once.resume !== once.page);
    } else {
      assert.equal(once.page, '');
      assert.equal(once.resume, undefined);
    }
  }
});

test('the status tick switches the games page once, writing only on a real change', async () => {
  let stored = P.setActivePage(P.setGamingPage(twoPages(), 'Games', true).layers, 1).layers;
  const writes = [];
  const update = async (edit) => { const r = edit(stored); if (r.error) return r; stored = r.layers; writes.push(stored.page); return r; };
  const sync = P.createGamePageSync({ current: () => stored, update });
  const settle = () => new Promise((r) => setImmediate(r));
  sync(false); await settle();
  assert.deepEqual(writes, [], 'no game, no write');
  sync(true); sync(true); await settle();
  assert.equal(writes.length, 1, 'a second tick while the first write runs does nothing');
  assert.equal(stored.page, stored.pages[1].id);
  for (let i = 0; i < 10; i++) { sync(true); await settle(); }
  assert.equal(writes.length, 1, 'idempotent while the game runs');
  sync(false); await settle();
  assert.equal(stored.page, stored.pages[0].id);
  assert.equal(writes.length, 2);
  // Without pages the tick costs nothing and never writes.
  const none = P.createGamePageSync({ current: () => base(), update: () => { throw new Error('no'); } });
  none(true); none(false);
});

test('a failed write is reported, and the next tick tries again', async () => {
  const stored = P.setGamingPage(P.setActivePage(twoPages(), 1).layers, 'Games', true).layers;
  const warns = [];
  let fail = true;
  let calls = 0;
  const sync = P.createGamePageSync({ current: () => stored, update: async () => { calls++; if (fail) throw new Error('disk'); return {}; }, warn: (m) => warns.push(m) });
  sync(true); await new Promise((r) => setImmediate(r));
  assert.equal(warns.length, 1);
  assert.ok(!/lp_|Games/.test(warns[0]), 'no user data in the log');
  fail = false;
  sync(true); await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
});

test('server.js: the games page rides the status tick and a generic save never overwrites layers', async () => {
  const { readFileSync } = await import('node:fs');
  const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(SERVER, /const _gamePageSync = LayerPages\.createGamePageSync\(\{\n {2}current: \(\) => _serverHubSettings && _serverHubSettings\.layers,\n {2}update: \(edit\) => updateLayersSetting\(edit\),/);
  assert.match(SERVER, /try \{ _gamePageSync\(st\.gameRunning\); \} catch \{\}/);
  assert.match(SERVER, /if \(prev && prev\.layers && typeof prev\.layers === 'object'\) \{\n {8}incoming\.layers = prev\.layers;/);
});

test('a desktop holds one page at most; 0 unties it and bad numbers are refused', () => {
  let cur = P.addPage(twoPages(), 'Music', seq()).layers;
  cur = P.setDesktopPage(cur, 'Games', 2).layers;
  const res = P.setDesktopPage(cur, 'Music', 2);
  assert.equal(res.desktop, 2);
  cur = res.layers;
  assert.equal(P.findPage(cur, 'Music').desktop, 2);
  assert.equal(P.findPage(cur, 'Games').desktop, undefined, 'the page that had desktop 2 lost it');
  cur = P.setDesktopPage(cur, 'Music', 0).layers;
  assert.ok(cur.pages.every((p) => !p.desktop));
  for (const bad of [-1, 10, 1.5, 'x']) assert.equal(P.setDesktopPage(cur, 'Music', bad).error, 'bad_desktop');
  assert.equal(P.setDesktopPage(cur, 'Nope', 1).error, 'unknown_page');
  assert.equal(P.setDesktopPage(base(), 'Games', 1).error, 'no_pages');
  assert.deepEqual(P.describePages(P.setDesktopPage(cur, 'Games', 3).layers).map((p) => p.desktop), [0, 3, 0]);
});

test('switching desktops shows the tied page, and a free desktop brings back the page from before', () => {
  let cur = P.addPage(twoPages(), 'Music', seq()).layers;
  cur = P.setDesktopPage(cur, 'Games', 2).layers;
  cur = P.setActivePage(cur, 1).layers;
  const work = cur.page;
  assert.equal(P.deskPageSwitch(cur, 1), null, 'a free desktop with a free page: nothing to do');
  cur = P.deskPageSwitch(cur, 2);
  assert.equal(P.findPage(cur, 'Games').id, cur.page);
  assert.equal(cur.deskBack, work);
  assert.equal(P.deskPageSwitch(cur, 2), null, 'idempotent');
  cur = P.deskPageSwitch(cur, 3);
  assert.equal(cur.page, work);
  assert.equal(cur.deskBack, undefined);
  // A page picked by hand on a tied desktop stays when leaving it.
  cur = P.setActivePage(P.deskPageSwitch(cur, 2), 'Music').layers;
  assert.equal(P.deskPageSwitch(cur, 1), null);
  assert.equal(P.findPage(cur, 'Music').id, cur.page);
  // 0 = a desktop without a number (a full-screen Space): like a free one.
  cur = P.deskPageSwitch(P.setActivePage(cur, 1).layers, 2);
  assert.equal(P.deskPageSwitch(cur, 0).page, work);
});

test('the games page wins over the desktop while a game runs', () => {
  let cur = P.addPage(P.setGamingPage(twoPages(), 'Games', true).layers, 'Music', seq()).layers;
  cur = P.setDesktopPage(cur, 'Music', 2).layers;
  cur = P.gamePageSwitch(P.setActivePage(cur, 1).layers, true);
  assert.equal(P.deskPageSwitch(cur, 2), null);
});

test('desktop sync: one write per real change, and a desktop seen while writing is applied after', async () => {
  let stored = P.setActivePage(P.setDesktopPage(twoPages(), 'Games', 2).layers, 1).layers;
  const writes = [];
  let release;
  let gate = Promise.resolve();
  const update = async (edit) => { await gate; const r = edit(stored); if (r.error) return r; stored = r.layers; writes.push(stored.page); return r; };
  const sync = P.createDeskPageSync({ current: () => stored, update });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  sync(1); await settle();
  assert.deepEqual(writes, [], 'nothing tied to desktop 1');
  gate = new Promise((r) => { release = r; });
  sync(2); sync(3); sync(1);
  release(); await settle(); await settle();
  assert.equal(writes.length, 2, 'the switch to 2, then back for the last desktop seen');
  assert.equal(stored.page, stored.pages[0].id);
  const none = P.createDeskPageSync({ current: () => base(), update: () => { throw new Error('no'); } });
  none(2);
});

test('server.js: the shell tells the desktop through a checked, PC-only route', async () => {
  const { readFileSync } = await import('node:fs');
  const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(SERVER, /const _deskPageSync = LayerPages\.createDeskPageSync\(\{\n {2}current: \(\) => _serverHubSettings && _serverHubSettings\.layers,\n {2}update: \(edit\) => updateLayersSetting\(edit\),/);
  assert.match(SERVER, /current > 64 \|\| !Number\.isInteger\(count\)/);
  assert.match(SERVER, /layersHost\.setDesk\(current, count\);\n {6}_deskPageSync\(current\);/);
});

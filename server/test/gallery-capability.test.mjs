// capabilities/gallery.js: the voice and the Virtual Deck open the gallery on
// the PC's screens, and Xenon AI lists what was captured. Pinned here: an
// unknown id is refused before anything opens, 'all' opens with no filter,
// a game is matched by name (case and part of it), an unknown game comes back
// with the names it could have meant, the list is capped, and no path or
// file location ever leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cap = require('../capabilities/gallery.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const T0 = Date.UTC(2026, 9, 27, 10, 0, 0);
const ENTRIES = [
  { id: 'r1', kind: 'replay', name: 'Cyberpunk2077 Replay.mp4', game: 'Cyberpunk2077.exe', createdAt: T0, seconds: 30 },
  { id: 's1', kind: 'screenshot', name: 'Desktop.png', game: '', createdAt: T0 - 1000 },
];

function deps({ entries = ENTRIES, games = [{ label: 'Cyberpunk2077', count: 1 }, { label: 'Desktop', count: 1 }] } = {}) {
  const log = { opened: [], browsed: [] };
  const store = {
    get: id => entries.find(e => e.id === id) || null,
    games: () => games,
    browse: async (q) => { log.browsed.push(q); return { entries: entries.slice(0, q.limit), more: entries.length > q.limit }; },
  };
  const capture = {
    host: { available: () => true },
    store: () => store,
    openGallery: o => log.opened.push(o),
  };
  return { d: { capture }, log };
}

test('open: no filter for "all", the filter for video, a known id passed along', () => {
  const { d, log } = deps();
  assert.deepEqual(cap.open(d, { filter: 'all' }), { ok: true, opened: true });
  assert.deepEqual(cap.open(d, { filter: 'video' }), { ok: true, opened: true });
  assert.deepEqual(cap.open(d, { id: 'r1' }), { ok: true, opened: true });
  assert.deepEqual(cap.open(d, { filter: '../etc' }), { ok: true, opened: true });
  assert.deepEqual(log.opened, [{ filter: '' }, { filter: 'video' }, { filter: '', id: 'r1' }, { filter: '' }]);
});

test('open: an id the index does not know opens nothing; no gallery wiring says unavailable', () => {
  const { d, log } = deps();
  assert.deepEqual(cap.open(d, { id: 'nope' }), { ok: false, error: 'not_found' });
  assert.equal(log.opened.length, 0);
  assert.deepEqual(cap.open({ capture: {} }, {}), { ok: false, error: 'unavailable' });
  assert.deepEqual(cap.open({}, {}), { ok: false, error: 'unavailable' });
});

test('matchGame: exact, then any case, then a part of the name; nothing found is null', () => {
  const labels = ['Cyberpunk2077', 'Desktop', 'Tabletop Simulator'];
  assert.equal(cap.matchGame(labels, 'Desktop'), 'Desktop');
  assert.equal(cap.matchGame(labels, 'desktop'), 'Desktop');
  assert.equal(cap.matchGame(labels, 'cyberpunk'), 'Cyberpunk2077');
  assert.equal(cap.matchGame(labels, '  tabletop '), 'Tabletop Simulator');
  assert.equal(cap.matchGame(labels, ''), '');
  assert.equal(cap.matchGame(labels, 'Halo'), null);
});

test('list: names, kinds, ISO times and lengths, never a file path; games come along', async () => {
  const { d, log } = deps();
  const r = await cap.list(d, { kind: 'video', game: 'cyber', limit: '5' });
  assert.equal(r.ok, true);
  assert.deepEqual(log.browsed, [{ kind: 'video', game: 'Cyberpunk2077', limit: 5 }]);
  assert.deepEqual(r.captures[0], { id: 'r1', kind: 'replay', name: 'Cyberpunk2077 Replay.mp4', game: 'Cyberpunk2077', when: new Date(T0).toISOString(), seconds: 30 });
  assert.equal(r.captures[1].game, 'Desktop');
  assert.ok(!('seconds' in r.captures[1]));
  assert.deepEqual(r.games, ['Cyberpunk2077', 'Desktop']);
  assert.doesNotMatch(JSON.stringify(r), /[A-Z]:\\|\/Users\/|file/i);
});

test('list: unknown game names the ones there are; limit 1-30, default 10; "all" is no kind', async () => {
  const { d, log } = deps();
  assert.deepEqual(await cap.list(d, { game: 'Halo' }), { ok: false, error: 'no_such_game', games: ['Cyberpunk2077', 'Desktop'] });
  await cap.list(d, { kind: 'all' });
  await cap.list(d, { limit: '999' });
  await cap.list(d, { limit: '-3', kind: 'files' });
  assert.deepEqual(log.browsed.map(q => [q.kind, q.limit]), [['', 10], ['', 30], ['', 1]]);
  assert.deepEqual(await cap.list({}, {}), { ok: false, error: 'unavailable' });
});

test('the runner and the voice: gallery and galleryList route here, AI args map to the action', async () => {
  const { d, log } = deps();
  const runner = createCapabilities(d);
  assert.deepEqual(await runner.run({ type: 'gallery', filter: 'screenshot' }), { ok: true, opened: true });
  assert.deepEqual(log.opened, [{ filter: 'screenshot' }]);
  const listed = await runner.run({ type: 'galleryList', kind: 'replay' });
  assert.equal(listed.ok, true);
  const names = aiFunctions(runner.probes()).map(f => f.name);
  assert.ok(names.includes('open_gallery') && names.includes('list_captures'));
  assert.deepEqual(aiAction('open_gallery', { filter: 'video', path: 'C:\\x' }).type, 'gallery');
  assert.equal(aiAction('open_gallery', { path: 'C:\\x' }).path, undefined);
  assert.equal(aiAction('list_captures', { game: 'Halo' }).game, 'Halo');
});

test('the catalog: a safe Deck key in Capture, the list hidden, the hidden id is a string for the AI', () => {
  const key = CAPABILITIES.find(x => x.type === 'gallery');
  assert.equal(key.capability.risk, 'safe');
  assert.equal(key.group, 'capture');
  assert.deepEqual(key.params[0].options, ['all', 'video', 'screenshot']);
  assert.equal(CAPABILITIES.find(x => x.type === 'galleryList').hidden, true);
  const fn = aiFunctions({}).find(f => f.name === 'open_gallery');
  assert.equal(fn.parameters.properties.id.type, 'STRING');
  assert.ok(!(fn.parameters.required || []).includes('id'));
  const i18n = readFileSync(path.join(HERE, '..', 'js', 'i18n.js'), 'utf8');
  for (const k of ['deck_act_gallery', 'deck_act_galleryList', 'deck_param_gallery_filter', 'deck_opt_video', 'deck_opt_screenshot', 'capg_open']) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
});

// A Deck key that shows a Vitals meter (key.live = { source: 'vitals', name }):
// the face text and colour (js/deck-model.js), and the three pages that feed
// snapshot.vitals: the dashboard (js/vitals.js), and the Virtual Deck popup and
// layer pages (js/deck-feed.js), which compute it from the saved settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const core = require('../js/vitals-core.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function keyThrough(raw) {
  const c = dm.normalizeDeckConfig({
    cols: 1, rows: 1,
    profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [raw] }] } }],
    activeProfile: 'p',
  });
  return c.profiles[0].root.pages[0].keys[0];
}

const vitals = {
  enabled: true,
  meters: [
    { id: 'hydration', percent: 18, name: 'Hydration' },
    { id: 'energy', percent: 64, name: 'Energy' },
    { id: 'focus', percent: 1, name: 'Focus' },
  ],
};
const face = (name, v = vitals) => dm.formatLiveValue({ source: 'vitals', name }, { vitals: v }, 0);

test('a Vitals key keeps a known meter, and anything else follows the emptiest', () => {
  assert.ok(dm.DECK_LIVE_SOURCES.includes('vitals'));
  assert.deepEqual(dm.DECK_VITALS_METERS, ['lowest', 'hydration', 'energy', 'stamina', 'focus', 'posture']);
  assert.deepEqual(keyThrough({ id: 'k', kind: 'action', live: { source: 'vitals', name: 'energy' } }).live, { source: 'vitals', name: 'energy' });
  assert.deepEqual(keyThrough({ id: 'k', kind: 'action', live: { source: 'vitals', name: 'coffee' } }).live, { source: 'vitals', name: 'lowest' });
  assert.deepEqual(keyThrough({ id: 'k', kind: 'action', live: { source: 'vitals' } }).live, { source: 'vitals', name: 'lowest' });
});

test('the face shows the percent, coloured like the tile when low or empty', () => {
  assert.deepEqual(face('energy'), { text: '64%' });
  assert.deepEqual(face('hydration'), { text: '18%', color: '#f0b84f' });
  assert.deepEqual(face('focus'), { text: '1%', color: '#ff6268' });
  assert.deepEqual(face('lowest'), { text: 'Focus 1%', color: '#ff6268' }, 'the emptiest one, named');
});

test('Vitals off, a meter that is off, or no data leaves the face empty', () => {
  assert.deepEqual(face('posture'), { text: '' });
  assert.deepEqual(face('energy', { ...vitals, enabled: false }), { text: '' });
  assert.deepEqual(face('lowest', { enabled: true, meters: [] }), { text: '' });
  assert.deepEqual(dm.formatLiveValue({ source: 'vitals', name: 'energy' }, {}, 0), { text: '' });
});

test('the popup math is the tile math: VitalsCore.snapshot feeds the same face', () => {
  const now = new Date(2026, 9, 30, 15, 0, 0).getTime();
  const v = { enabled: true, items: { hydration: { on: true, min: 40 } }, state: { last: { hydration: now - 30 * 60000 } } };
  const snap = core.snapshot(v, now);
  assert.deepEqual(dm.formatLiveValue({ source: 'vitals', name: 'hydration' }, { vitals: snap }, now), { text: '25%', color: '#f0b84f' });
});

test('wiring: the dashboard, the popup and layer pages feed it, only on change', () => {
  const vitalsJs = read('../js/vitals.js');
  assert.ok(vitalsJs.includes('if (sig === deckSig) return;'));
  assert.ok(vitalsJs.includes('window.Deck.refreshStates({ vitals });'));
  assert.match(vitalsJs, /function tick\(\) \{\n    const v = cfg\(\);\n    if \(v\.enabled\) stepActive\(\);\n    publishDeck\(\);/);
  const feed = read('../js/deck-feed.js');
  assert.ok(feed.includes('if (sig === vitalsSig) return;'));
  assert.ok(feed.includes("if (!window.VitalsCore || !hasVitalsKey()) return;"), 'no work without a Vitals key on screen');
  assert.ok(feed.includes("on('settings', () => { vitalsStale = true; vitalsTick(); });"));
  assert.ok(feed.includes('if (!vitalsTimer && window.VitalsCore) vitalsTimer = setInterval(vitalsTick, VITALS_EVERY_MS);'), 'one timer across reconnects');
  assert.match(read('../deck-popup.html'), /js\/deck-model\.js"><\/script>\n<script src="js\/vitals-core\.js">/);
  assert.ok(read('../js/layer-tiles.js').includes("'js/deck-model.js', 'js/vitals-core.js',"));
});

test('the editor offers each meter, and Bit knows the source', () => {
  const editor = read('../js/deck-editor.js');
  assert.ok(editor.includes("o.value = 'vitals:' + m;"));
  assert.ok(editor.includes("else if (liveSource === 'vitals') liveName = v.slice('vitals:'.length);"));
  const server = read('../server.js');
  assert.ok(server.includes('{"source":"vitals","name":"hydration"}'));
  assert.ok(server.includes('vitalsMeters: dm.DECK_VITALS_METERS'));
  const i18n = read('../js/i18n.js');
  assert.equal((i18n.match(/^ {4}deck_live_vitals: /gm) || []).length, 11, 'all 11 app languages');
  assert.equal((i18n.match(/^ {4}deck_live_vitals_lowest: /gm) || []).length, 11);
});

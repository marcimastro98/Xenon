import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { find } = require('../js/xenon-menu-find.js');

const words = (x) => x || '';
const sections = [
  { id: 'now', rows: [
    { kind: 'heading', id: 'h', label: 'Cattura' },
    { kind: 'tile', id: 'area', label: 'Area dello schermo' },
    { kind: 'tile', id: 'record', label: 'Registra video' },
  ] },
  { id: 'capture', rows: [
    { kind: 'choice', id: 'fps', label: 'Fotogrammi', sub: 'Più alti, video più fluidi' },
    { kind: 'add', id: 'add', label: 'Area' },
  ] },
];

test('finds across sections, any order, any case, no accents', () => {
  assert.deepEqual(find(sections, 'SCHERMO area', words).map((s) => s.rows.map((r) => r.id)), [['area']]);
  assert.deepEqual(find(sections, 'piu fluidi', words).map((s) => s.id), ['capture']);
});

test('the group names inside a widget are not results, the rows under them are', () => {
  const placed = [{ id: 'widgets', rows: [{ kind: 'widget', id: 'w', label: 'Meteo', tune: [
    { kind: 'tunehead', id: 'w:h', label: 'Aspetto' },
    { kind: 'choice', id: 'w:size', label: 'Grandezza' },
  ] }] }];
  assert.deepEqual(find(placed, 'aspetto', words), []);
  assert.deepEqual(find(placed, 'grandezza', words)[0].rows.map((r) => r.id), ['w:size']);
});

test('headings and the Add row are never results; a section without a hit is left out', () => {
  assert.deepEqual(find(sections, 'cattura', words), []);
  assert.deepEqual(find(sections, 'area', words).map((s) => s.id), ['now']);
});

test('an empty search finds nothing', () => {
  assert.deepEqual(find(sections, '   ', words), []);
});

test('a reading inside a block of switches is found by its own name', () => {
  const sections = [{ id: 'overlay', rows: [{ kind: 'checks', id: 'parts', label: 'What it shows', groups: [{ id: 'other', label: 'Memory and network', items: [
    { kind: 'toggle', id: 'part-ping', label: 'Ping', sub: 'Delay to the internet' },
    { kind: 'toggle', id: 'part-loss', label: 'Packet loss' },
  ] }] }] }];
  const found = find(sections, 'ping', (x) => x || '');
  assert.deepEqual(found[0].rows.map((r) => r.id), ['part-ping']);
});

test('what a widget lets you adjust is found, and says whose it is', () => {
  const opacity = { kind: 'choice', id: 'w1:opacity', label: 'Opacity' };
  const parts = { kind: 'checks', id: 'w1:parts', label: 'What it shows', groups: [{ id: 'g', label: 'Game', items: [{ kind: 'toggle', id: 'part-fps', label: 'FPS' }] }] };
  const sections = [{ id: 'overlay', rows: [{ kind: 'widget', id: 'w1', label: 'HUD', tune: [opacity, parts] }] }];
  const text = (x) => (Array.isArray(x) ? x.join(' ') : x || '');
  const found = find(sections, 'opacity', text);
  assert.deepEqual(found[0].rows.map((r) => [r.id, r.label]), [['w1:opacity', ['HUD', 'Opacity']]]);
  assert.deepEqual(find(sections, 'fps', text)[0].rows.map((r) => r.id), ['part-fps']);
  assert.deepEqual(find(sections, 'hud', text)[0].rows.map((r) => r.id), ['w1'], 'the name finds the widget, not each of its rows');
});

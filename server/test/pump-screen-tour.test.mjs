// tools/pump-screen-tour/tour.mjs: a person's tour of the pump screens on a throwaway engine.
// The tour itself needs a browser and an engine copy (run it by hand); here, what keeps it safe
// and what it walks through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowRequest, STEPS } from '../../tools/pump-screen-tour/tour.mjs';

const ORIGIN = 'http://127.0.0.1:3071';
const post = (pathname, body) => ({ method: 'POST', url: ORIGIN + pathname, body: body == null ? null : JSON.stringify(body) });

test('the tour talks only to its copy: reads, the pump routes, and pump actions', () => {
  assert.equal(allowRequest({ method: 'GET', url: ORIGIN + '/menu' }, ORIGIN), true);
  assert.equal(allowRequest({ method: 'GET', url: 'http://127.0.0.1:3030/menu' }, ORIGIN), false, 'never the real app');
  assert.equal(allowRequest({ method: 'GET', url: 'https://example.com/x.js' }, ORIGIN), false, 'never the network');
  assert.equal(allowRequest(post('/pump/picture'), ORIGIN), true);
  assert.equal(allowRequest(post('/xenon-menu/state'), ORIGIN), true);
  assert.equal(allowRequest(post('/actions/run', { type: 'pumpSet', screen: 'pump', patch: '{}' }), ORIGIN), true);
  assert.equal(allowRequest(post('/actions/run', { type: 'launchApp', path: 'x' }), ORIGIN), false, 'no other action');
  assert.equal(allowRequest(post('/actions/run', { type: 'pumped' }), ORIGIN), false);
  assert.equal(allowRequest(post('/actions/run', null), ORIGIN), false);
  assert.equal(allowRequest({ method: 'POST', url: ORIGIN + '/actions/run', body: '{not json' }, ORIGIN), false);
  assert.equal(allowRequest(post('/settings', {}), ORIGIN), false);
  assert.equal(allowRequest(post('/pumpkin'), ORIGIN), false);
  assert.equal(allowRequest({ method: 'DELETE', url: ORIGIN + '/pump' }, ORIGIN), false);
});

test('the tour walks what a person does first, and finds the rows it taps', () => {
  const names = STEPS.map((s) => s.name);
  for (const step of ['open-pump', 'open-rest', 'add-fps', 'setup-music', 'own-gif', 'add-night', 'now-game', 'now-auto', 'alerts', 'turned-90', 'ring-spin', 'style-gauge', 'ring-level', 'style-xenon']) {
    assert.ok(names.includes(step), step);
  }
  assert.equal(new Set(names).size, names.length, 'one picture name per step');
  // The rows it taps by id: a renamed row in the menu must rename it here too.
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const menu = ['../menu/menu-pump.js', '../menu/menu-pump-faces.js', '../menu/menu-pump-look.js', '../menu/menu-pump-face-look.js', '../menu/menu-pump-leds.js'].map(read).join('\n');
  for (const id of ["id: 'pump-ring-base'", "id + '-fx'", "id: 'pump-leds'", "id: 'leds'", "'-readings'", "id: 'pump-base'", "id: 'pump-add'", "'pump-rotate'", "id: 'pump-setup'", "value: n,"]) assert.ok(menu.includes(id), id);
  const style = read('../menu/menu-pump-style.js');
  for (const id of ["id: 'pump-style'", "id: 'pump-style-store'"]) assert.ok(style.includes(id), id);
  assert.ok(menu.includes("id: 'pump-leds-move'"), 'pump-leds-move');
  assert.ok(read('../js/pump/face-gauge.js').includes("'pf-g-dial'"), 'the dial the tour looks for');
  const draw = read('../js/menu/xenon-menu-pump-rows.js') + read('../js/menu/xenon-menu-pumps.js');
  for (const k of ["r.id + ':head'", "box.dataset.row = r.id;", '`${r.id}:face:${f.value}`', '`${r.id}:${o.value}`', '`${r.id}:${c.value}`', "'pump:auto'", "'xm-pumpown'"]) assert.ok(draw.includes(k), k);
});

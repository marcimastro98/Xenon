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
  for (const step of ['open-pump', 'add-fps', 'setup-music', 'own-gif', 'now-game', 'now-auto', 'moments', 'turned-90']) {
    assert.ok(names.includes(step), step);
  }
  assert.equal(new Set(names).size, names.length, 'one picture name per step');
  // The rows it taps by id: a renamed row in the menu must rename it here too.
  const menu = readFileSync(new URL('../menu/menu-pump.js', import.meta.url), 'utf8');
  for (const id of ["'-readings'", "'pump-now'", "'pump-rotate'", "id: 'pump-setup'"]) assert.ok(menu.includes(id), id);
});

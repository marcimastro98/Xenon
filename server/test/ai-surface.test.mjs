// Bit on the main screen in "widgets only" has no dashboard: the client
// actions only a dashboard can carry out must say so instead of "done".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { surfaceOf, clientActionRefusal, SCREEN_OK } = require('../ai-surface.js');

test('only the exact screen value marks a turn as dashboard-less', () => {
  assert.equal(surfaceOf({ surface: 'screen' }), 'screen');
  for (const bad of [{}, null, { surface: 'Screen' }, { surface: ['screen'] }, { surface: 'dashboard' }]) {
    assert.equal(surfaceOf(bad), '', JSON.stringify(bad));
  }
});

test('dashboard-only actions are refused on the screen, never on the dashboard', () => {
  for (const name of ['open_settings', 'change_theme', 'go_to_page', 'genesis_compose_page', 'configure_deck', 'switch_deck_profile']) {
    const r = clientActionRefusal(name, 'screen');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'needs_dashboard');
    assert.match(r.hint, /set_usage_mode/);
    assert.equal(clientActionRefusal(name, ''), null);
  }
  for (const name of SCREEN_OK) assert.equal(clientActionRefusal(name, 'screen'), null, name);
  const a = clientActionRefusal('open_settings', 'screen');
  a.ok = true;
  assert.equal(clientActionRefusal('open_settings', 'screen').ok, false, 'each answer is a fresh object');
});

test('every /api/ai tool call carries the surface, and the refusal runs before the action is queued', () => {
  const src = read('../server.js');
  assert.match(src, /const _aiSurface = aiSurface\.surfaceOf\(aiBody\);/);
  const calls = src.match(/pictures: _aiPictures,\n\s+surface: _aiSurface,/g) || [];
  assert.equal(calls.length, 5);
  const at = src.indexOf('if (CLIENT_ACTIONS.has(fnName)) {');
  const block = src.slice(at, at + 800);
  assert.ok(block.indexOf('clientActionRefusal(fnName, surface)') < block.indexOf('clientActions.push('));
  assert.match(read('../js/ai.js'), /\.\.\.\(window\.AiSurface === 'screen' \? \{ surface: 'screen' \} : \{\}\),/);
});

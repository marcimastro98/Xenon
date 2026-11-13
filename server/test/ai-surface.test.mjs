// Bit on the main screen in "widgets only" has no dashboard: the client
// actions only a dashboard can carry out must say so instead of "done".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { surfaceOf, clientActionRefusal, screenPerfChoice, SCREEN_OK, SHEET_OK } = require('../ai-surface.js');

test('only the exact screen value marks a turn as dashboard-less', () => {
  assert.equal(surfaceOf({ surface: 'screen' }), 'screen');
  for (const bad of [{}, null, { surface: 'Screen' }, { surface: ['screen'] }, { surface: 'dashboard' }]) {
    assert.equal(surfaceOf(bad), '', JSON.stringify(bad));
  }
});

test('dashboard-only actions are refused on the screen, never on the dashboard', () => {
  for (const name of ['open_settings', 'change_theme', 'go_to_page', 'genesis_compose_page', 'configure_deck', 'switch_deck_profile', 'style_tile']) {
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

test('the chat in the menu window is told apart by its address, never by what the body claims', () => {
  assert.equal(surfaceOf({}, 'http://127.0.0.1:3030/?panel=sheet'), 'sheet');
  assert.equal(surfaceOf({ surface: 'screen' }, 'http://127.0.0.1:3030/?panel=sheet'), 'screen');
  assert.equal(surfaceOf({ surface: 'sheet' }, 'http://127.0.0.1:3030/'), '');
  for (const bad of [undefined, '', 'not a url', 'http://127.0.0.1:3030/?panel=other']) {
    assert.equal(surfaceOf({}, bad), '', String(bad));
  }
});

test('the sheet carries out what changes settings and says so for what needs the tiles', () => {
  for (const name of SHEET_OK) assert.equal(clientActionRefusal(name, 'sheet'), null, name);
  for (const name of SCREEN_OK) assert.ok(SHEET_OK.has(name), name);
  const refused = clientActionRefusal('go_to_page', 'sheet');
  assert.equal(refused.error, 'needs_dashboard');
  assert.match(refused.hint, /menu/);
  assert.equal(clientActionRefusal('open_settings', 'screen').error, 'needs_dashboard', 'the screen still has no Settings');
});

test('Performance Mode goes to the driver from the sheet only where no dashboard runs it', () => {
  assert.notEqual(screenPerfChoice('optimize_performance', 'sheet', true), '');
  assert.equal(screenPerfChoice('optimize_performance', 'sheet', false), '');
  assert.equal(clientActionRefusal('optimize_performance', 'sheet', true), null);
});

test('every /api/ai tool call carries the surface, and the refusal runs before the action is queued', () => {
  const src = engineSource();
  assert.match(src, /const _aiSurface = aiSurface\.surfaceOf\(aiBody, req\.headers\.referer\);/);
  const calls = src.match(/pictures: _aiPictures,\n\s+surface: _aiSurface,/g) || [];
  assert.equal(calls.length, 6);
  const at = src.indexOf('if (CLIENT_ACTIONS.has(fnName)) {');
  const refusal = src.indexOf('clientActionRefusal(fnName, surface, widgetsOnly)', at);
  assert.ok(at < refusal && refusal < src.indexOf('clientActions.push(', at));
  assert.ok(src.indexOf("broadcastSSE('needs_dashboard', {});", refusal) < src.indexOf('clientActions.push(', at), 'the screen says it too');
  assert.match(read('../js/ai.js'), /\.\.\.\(window\.AiSurface === 'screen' \? \{ surface: 'screen' \} : \{\}\),/);
});

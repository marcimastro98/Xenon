// settings-ai.js: "togli i testi delle canzoni", "salvaschermo dopo 5 minuti".
// Pinned here: only allowlisted settings and values pass, an unchanged value writes
// nothing, nested fields keep their siblings, and the server writes under the lock
// with a rev bump so open dashboards reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SettingsAi = require('../settings-ai.js');

const SETTINGS = {
  mediaLyrics: true, lyricsTranslate: false, mediaVisualizer: 'off', hwTempUnit: 'auto',
  clockDateFormat: 'full', idleAnimationPause: true, bootSplash: true,
  ambientMode: { enabled: false, idleMinutes: 0, style: 'classic' },
};

test('no setting reads them all as words', () => {
  assert.deepEqual(SettingsAi.plan({}), { read: true });
  assert.deepEqual(SettingsAi.current(SETTINGS), {
    lyrics: 'on', lyrics_translate: 'off', visualizer: 'off', hardware_temp_unit: 'auto',
    date_format: 'full', pause_when_idle: 'on', startup_logo: 'on', ambient: 'off', ambient_after: '0',
  });
});

test('unknown settings and values are refused with the allowed list', () => {
  const bad = SettingsAi.plan({ setting: 'password', value: 'x' });
  assert.equal(bad.error, 'unknown_setting');
  assert.ok(bad.allowed.includes('lyrics'));
  const v = SettingsAi.plan({ setting: 'ambient_after', value: '7' });
  assert.deepEqual([v.error, v.allowed], ['bad_value', ['0', '1', '2', '5', '10', '15', '30']]);
  assert.equal(SettingsAi.plan({ setting: 'lyrics', value: true }).error, 'bad_value', 'a boolean is not on/off');
  assert.deepEqual(SettingsAi.plan({ setting: 'Visualizer', value: ' WAVE ' }), { name: 'visualizer', word: 'wave' });
});

test('apply: top-level and nested fields, siblings kept, unchanged = no patch', () => {
  assert.deepEqual(SettingsAi.apply(SETTINGS, { name: 'lyrics', word: 'off' }), { patch: { mediaLyrics: false }, before: 'on' });
  const amb = SettingsAi.apply(SETTINGS, { name: 'ambient_after', word: '5' });
  assert.deepEqual(amb.patch, { ambientMode: { enabled: false, idleMinutes: 5, style: 'classic' } });
  assert.deepEqual(SettingsAi.apply(SETTINGS, { name: 'date_format', word: 'full' }), { patch: null, before: 'full' });
  assert.deepEqual(SettingsAi.apply({}, { name: 'ambient', word: 'off' }).patch, { ambientMode: { enabled: false } });
  assert.equal(SettingsAi.apply({}, { name: 'ambient', word: 'on' }).patch, null, 'a missing switch reads as its default');
});

test('the switch defaults match DEFAULT_HUB_SETTINGS', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const DEFAULT_HUB_SETTINGS'));
  for (const name of SettingsAi.NAMES) {
    const pref = SettingsAi.PREFS[name];
    if (pref.def === undefined) continue;
    const [top, sub] = pref.path;
    const re = sub ? new RegExp(`\\n  ${top}: Object\\.freeze\\(\\{[^\\n]*\\b${sub}: ${pref.def}\\b`) : new RegExp(`\\n  ${top}: ${pref.def},`);
    assert.match(block, re, `${name} default`);
  }
});

test('every allowlisted path is a field the server normalizes', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const name of SettingsAi.NAMES) {
    const top = SettingsAi.PREFS[name].path[0];
    assert.match(src, new RegExp(`\\n    ${top}: `), `${top} normalized in normalizeHubSettings`);
  }
});

test('the server tool writes under the lock, bumps rev and broadcasts', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /\{ name: 'change_setting',/);
  assert.match(src, /fnName === 'change_setting'\) \{\n\s+fnResult = await changeSetting\(fnArgs\)/);
  const fn = src.slice(src.indexOf('async function changeSetting('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /withHubSettingsLock/);
  assert.match(body, /if \(!out\.patch\) return;/, 'no write when nothing changes');
  assert.match(body, /rev: nextSettingsRev\(cur\.rev\)/);
  assert.match(body, /broadcastSSE\('settings'/);
  assert.match(body, /refreshAudioLevelsWatch\(\)/);
});

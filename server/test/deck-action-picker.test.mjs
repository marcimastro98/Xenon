// The Deck's action picker: every action and every category has an icon, the
// list is searchable in any language, and the custom select's search matches
// the way people type (any order, no accents, no case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const da = require('../js/deck-actions.js');
const EDITOR = readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8');
const CS = readFileSync(new URL('../js/custom-select.js', import.meta.url), 'utf8');

// The keys of an object literal `const NAME = { key: ..., ... };` in the editor.
function literalKeys(name) {
  const at = EDITOR.indexOf(`const ${name} = {`);
  assert.ok(at > 0, `${name} is still where this test looks`);
  const end = EDITOR.indexOf('\n    };', at);
  const body = EDITOR.slice(at, end);
  return new Set([...body.matchAll(/^\s{6}([A-Za-z]\w*):/gm)].map((m) => m[1]));
}

const ACTION_ICON_KEYS = literalKeys('ACTION_ICONS');
const CATEGORY_ICON_KEYS = (() => {
  const at = EDITOR.indexOf('const CATEGORY_ICONS = {');
  const body = EDITOR.slice(at, EDITOR.indexOf('};', at));
  return new Set([...body.matchAll(/(\w+): ACTION_ICONS\./g)].map((m) => m[1]));
})();
const CATEGORY_GROUPS = [...EDITOR.matchAll(/\{ group: '(\w+)', labelKey: 'deck_cat_\w+' \}/g)].map((m) => m[1]);

test('every action shown in the picker has its own icon', () => {
  const missing = da.ACTION_CATALOG.filter((a) => !a.hidden && !ACTION_ICON_KEYS.has(a.type)).map((a) => a.type);
  assert.deepEqual(missing, []);
});

test('every category has an icon, and each one points at a real action icon', () => {
  assert.ok(CATEGORY_GROUPS.length >= 20);
  assert.deepEqual(CATEGORY_GROUPS.filter((g) => !CATEGORY_ICON_KEYS.has(g)), []);
  const at = EDITOR.indexOf('const CATEGORY_ICONS = {');
  const body = EDITOR.slice(at, EDITOR.indexOf('};', at));
  const refs = [...body.matchAll(/ACTION_ICONS\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(refs.filter((r) => !ACTION_ICON_KEYS.has(r)), []);
});

test('every visible action belongs to a category the picker lists', () => {
  const groups = new Set(CATEGORY_GROUPS);
  assert.deepEqual(da.ACTION_CATALOG.filter((a) => !a.hidden && !groups.has(a.group)).map((a) => a.type), []);
});

test('the picker turns on search, collapsible groups and its texts', () => {
  const at = EDITOR.indexOf('function actionSelect(value) {');
  const fn = EDITOR.slice(at, EDITOR.indexOf('\n    }\n', at));
  for (const attr of ['data-cs-search', 'data-cs-collapsible', 'data-cs-search-placeholder', 'data-cs-empty']) {
    assert.ok(fn.includes(`'${attr}'`), attr);
  }
  assert.match(fn, /csKeywords = \[englishLabel\(a\.labelKey\), a\.type, catEn\]/, 'English names and the type are searchable');
  assert.match(fn, /ready\.concat\(locked\)/, 'categories that need setting up go last');
  assert.match(fn, /data-cs-search-skip/, 'recently used does not repeat results while searching');
});

test('recently used survives broken storage and keeps at most 5, newest first', () => {
  const at = EDITOR.indexOf("const RECENT_ACTIONS_KEY = 'xenonDeckRecentActions';");
  const end = EDITOR.indexOf('    // English names searched too', at);
  const src = EDITOR.slice(at, end);
  const store = new Map();
  const ctx = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  vm.runInNewContext(src + '; this.recentActions = recentActions; this.rememberRecentAction = rememberRecentAction;', ctx);
  ['a', 'b', 'c', 'd', 'e', 'f', 'b'].forEach((t) => ctx.rememberRecentAction(t));
  assert.deepEqual([...ctx.recentActions()], ['b', 'f', 'e', 'd', 'c']);
  store.set('xenonDeckRecentActions', '{not json');
  assert.deepEqual([...ctx.recentActions()], []);
  store.set('xenonDeckRecentActions', JSON.stringify(['ok', 7, null]));
  assert.deepEqual([...ctx.recentActions()], ['ok']);
  const broken = { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } };
  vm.runInNewContext(src + '; this.recentActions = recentActions; this.rememberRecentAction = rememberRecentAction;', broken);
  assert.doesNotThrow(() => broken.rememberRecentAction('x'));
  assert.deepEqual([...broken.recentActions()], []);
});

// The search helpers, run as the browser runs them.
const csCtx = {};
vm.runInNewContext(CS.slice(0, CS.indexOf('/**')) + '; this._csFold = _csFold; this._csMatches = _csMatches;', csCtx);

test('search ignores case and accents', () => {
  assert.equal(csCtx._csFold('Écran Démarrer'), 'ecran demarrer');
  assert.ok(csCtx._csMatches(['Cattura schermo'], 'CATTURA'));
  assert.ok(csCtx._csMatches(['Écran'], 'ecran'));
});

test('every typed word must match, in any order, across label, keywords and group', () => {
  assert.ok(csCtx._csMatches(['Cambia scena', '', 'OBS'], 'obs scena'));
  assert.ok(csCtx._csMatches(['Cambia scena', '', 'OBS'], 'scena obs'));
  assert.ok(csCtx._csMatches(['Volume', 'Volume up volumeUp', 'Audio'], 'volume up'));
  assert.equal(csCtx._csMatches(['Cambia scena', '', 'OBS'], 'obs microfono'), false);
  assert.ok(csCtx._csMatches(['Anything'], '   '), 'an empty search matches everything');
  assert.ok(csCtx._csMatches([null, undefined, 'Spotify'], 'spot'), 'missing parts are skipped');
});

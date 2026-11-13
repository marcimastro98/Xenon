// What each Deck action does: every action in the picker has a short
// explanation in every app language, the picker's (i) button opens it in place
// without picking the action, and Bit reads the same text from its catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const da = require('../js/deck-actions.js');
const labels = require('../ai-creation-labels.js');
const I18N = appStringsSource();
const EDITOR = readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8');
const CS = readFileSync(new URL('../js/custom-select.js', import.meta.url), 'utf8');
const SERVER = engineSource();

const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
// The strings as the browser sees them (some blocks hold several keys a line,
// which the server-side line parser does not need to read).
const STRINGS = (() => {
  const ctx = {};
  vm.runInNewContext(I18N.slice(0, I18N.indexOf('\nfunction t(key)')) + '; this.i18n = i18n;', ctx);
  return ctx.i18n;
})();
const VISIBLE = da.ACTION_CATALOG.filter((a) => !a.hidden);
const CATEGORY_GROUPS = [...EDITOR.matchAll(/\{ group: '(\w+)', labelKey: '(deck_cat_\w+)' \}/g)].map((m) => ({ group: m[1], key: m[2] }));

test('every action in the picker says what it does, in all 11 languages', () => {
  const missing = [];
  for (const lang of LANGS) {
    for (const a of VISIBLE) if (!STRINGS[lang] || !STRINGS[lang]['deck_info_' + a.type]) missing.push(lang + ':' + a.type);
    if (!STRINGS[lang] || !STRINGS[lang].deck_info_btn) missing.push(lang + ':deck_info_btn');
  }
  assert.deepEqual(missing, []);
});

test('no explanation is left for an action that no longer exists', () => {
  const types = new Set(da.ACTION_CATALOG.map((a) => a.type));
  const stale = Object.keys(STRINGS.en).filter((k) => k.startsWith('deck_info_') && k !== 'deck_info_btn' && !types.has(k.slice(10)));
  assert.deepEqual(stale, []);
});

test('explanations are plain text: no em-dash, no markup', () => {
  const bad = [];
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(STRINGS[lang] || {})) {
      if (k.startsWith('deck_info_') && /[—<>]/.test(v)) bad.push(lang + ':' + k);
    }
  }
  assert.deepEqual(bad, []);
});

test('every picker category has a name in all 11 languages', () => {
  const missing = [];
  for (const lang of LANGS) for (const c of CATEGORY_GROUPS) if (!STRINGS[lang] || !STRINGS[lang][c.key]) missing.push(lang + ':' + c.key);
  assert.deepEqual(missing, []);
});

test('actions sit where people look for them', () => {
  const groupOf = (type) => da.actionSpec(type).group;
  for (const type of ['openApp', 'openFile', 'runScript', 'openUrl', 'launchSteamGame', 'webhook']) assert.equal(groupOf(type), 'launch', type);
  for (const type of ['hotkey', 'typeText', 'lockWorkstation', 'windowMove', 'powerMode', 'dnd']) assert.equal(groupOf(type), 'system', type);
  for (const type of ['phoneCall', 'phoneMessage']) assert.equal(groupOf(type), 'phone', type);
  for (const type of ['dashboardPage', 'deckState', 'xenonMenu', 'usageMode', 'layersToggle', 'desktopWallpaper']) assert.equal(groupOf(type), 'xenon', type);
  assert.ok(!CATEGORY_GROUPS.some((c) => c.group === 'window'), 'the old mixed "Windows" group is gone');
  assert.ok(!da.ACTION_CATALOG.some((a) => a.group === 'window'), 'no action is left in a group the picker does not list');
});

test('the editor gives each option its explanation and shows the chosen one under the select', () => {
  assert.match(EDITOR, /if \(info\) o\.dataset\.csInfo = info;/);
  assert.match(EDITOR, /'data-cs-info-label', t\('deck_info_btn'\)/);
  assert.match(EDITOR, /hint\.setAttribute\('data-i18n', 'deck_info_' \+ step\.type\); hint\.textContent = info;/);
});

// A tiny DOM: enough for the (i) button to be built and clicked as in the browser.
function fakeEl(tag) {
  const el = {
    tagName: tag, children: [], attrs: {}, listeners: {}, className: '', textContent: '', innerHTML: '', dataset: {},
    classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
    querySelector(sel) { const cls = sel.slice(1); return el.children.find((c) => c.className === cls) || null; },
  };
  return el;
}

test('the (i) button opens the explanation in place and does not pick the option', () => {
  const at = CS.indexOf('const addInfoButton = ');
  assert.ok(at > 0, 'addInfoButton is still where this test looks');
  const src = CS.slice(at, CS.indexOf('\n    };', at) + 7);
  const iconAt = CS.indexOf('const CS_INFO_ICON');
  const icon = CS.slice(iconAt, CS.indexOf('\n', iconAt));
  const ctx = { document: { createElement: fakeEl }, selectEl: { dataset: { csInfoLabel: 'A cosa serve' } } };
  vm.runInNewContext(icon + '\n' + src + '; this.addInfoButton = addInfoButton;', ctx);

  const li = fakeEl('li'); const txt = fakeEl('span');
  li.appendChild(txt);
  ctx.addInfoButton(li, txt, 'Apre un programma <b>di</b> questo PC.');
  const btn = li.children.find((c) => c.className === 'cs-option-info');
  assert.ok(btn, 'the row has an info button');
  assert.equal(btn.attrs.type, undefined, 'type is a property, set directly');
  assert.equal(btn.type, 'button', 'never a submit button');
  assert.equal(btn.attrs['aria-label'], 'A cosa serve', 'named in the user language');
  assert.equal(btn.attrs['aria-expanded'], 'false');

  let stopped = 0;
  btn.listeners.click({ stopPropagation: () => { stopped++; } });
  const body = txt.querySelector('.cs-option-infotext');
  assert.ok(body, 'the explanation opens under the name');
  assert.equal(body.textContent, 'Apre un programma <b>di</b> questo PC.', 'as plain text, never markup');
  assert.equal(body.innerHTML, '');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.ok(li.classList.contains('cs-info-open'));
  assert.equal(stopped, 1, 'the tap stays on the button: the row is not selected');

  btn.listeners.click({ stopPropagation() {} });
  assert.equal(txt.querySelector('.cs-option-infotext'), null, 'a second tap closes it');
  assert.equal(btn.attrs['aria-expanded'], 'false');
  assert.ok(!li.classList.contains('cs-info-open'));
});

test('the info button only appears for options that carry an explanation', () => {
  assert.match(CS, /if \(opt\.dataset && opt\.dataset\.csInfo\) addInfoButton\(li, txt, opt\.dataset\.csInfo\);/);
});

test('Bit reads what each action does from the same English text', async () => {
  labels._reset();
  const info = await labels.englishByPrefix('deck_info_');
  assert.equal(info.openApp, STRINGS.en.deck_info_openApp);
  assert.ok(!('btn' in info) || info.btn === STRINGS.en.deck_info_btn);
  for (const a of VISIBLE) assert.ok(info[a.type], a.type);
  assert.match(SERVER, /englishByPrefix\('deck_info_'\)/, 'deck_action_catalog includes it');
  assert.match(SERVER, /\.\.\.\(info\[a\.type\] \? \{ info: info\[a\.type\] \} : \{\}\)/);
});

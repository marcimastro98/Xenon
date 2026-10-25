// The top bar's look (Settings → Top bar): one set of rules in js/topbar-look.js,
// read by the dashboard and by the server's settings normalizer, and applied as
// :root attributes the stylesheet keys off.
//
// The promise that matters most to someone who never opens the page: with the
// default look, nothing is written to the document, so the bar is the bar they
// had before. Then that what a crafted settings file or share code carries comes
// back clean, and that every choice the model accepts has CSS that draws it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../js/topbar-look.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('../components/Topbar/TopbarLook.css');
const INDEX = read('../index.html');
const SETTINGS = read('../js/settings.js');
const SERVER = read('../server.js');
const MINIMAL = read('../js/topbar-minimal.js');
const TOAST = read('../js/toast.js');

const plain = (v) => JSON.parse(JSON.stringify(v));

test('the default look writes nothing: the bar stays as it was', () => {
  assert.deepEqual(plain(L.normalize(null)), plain(L.DEFAULTS));
  assert.deepEqual(plain(L.normalize({})), plain(L.DEFAULTS));
  const { attrs, vars } = L.tokens(L.DEFAULTS);
  assert.deepEqual(Object.values(attrs).filter((v) => v !== null), []);
  assert.deepEqual(Object.values(vars).filter((v) => v !== null), []);
});

test('a hand-edited or crafted look comes back clean', () => {
  const look = L.normalize({
    surface: 'neon', border: 'accent', size: 'huge', opacity: 400, blur: -5,
    color: '#ABC', accent: 'evil', shadow: 0, colonBlink: false, toastPlace: 'bottom-right',
    extra: 'dropped',
  });
  assert.equal(look.surface, 'theme');
  assert.equal(look.border, 'accent');
  assert.equal(look.size, 'normal');
  assert.equal(look.opacity, 100);
  assert.equal(look.blur, 0);
  assert.equal(look.color, '#aabbcc');
  assert.equal(look.accent, 'xenon');
  assert.equal(look.shadow, true, 'only an explicit false turns the shadow off');
  assert.equal(look.colonBlink, false);
  assert.equal(look.toastPlace, 'bottom-right');
  assert.equal('extra' in look, false);
  assert.equal(L.normalize({ color: 'red' }).color, '');
  assert.equal(L.normalize({ color: '#12345g' }).color, '');
  assert.equal(L.normalize({ accent: 'none' }).accent, 'none');
  assert.equal(L.normalize({ accent: 'search' }).accent, 'search');
  assert.deepEqual(plain(L.normalize([1, 2])), plain(L.DEFAULTS));
});

test('each button keeps only what it changes, as plain text and known ids', () => {
  const look = L.normalize({ buttons: {
    lock: { label: '  Blocca\u0007   ora  ', color: '#F00', labelMode: 'never', icon: 'lock' },
    xenon: { label: '', color: '' },                       // nothing changed: dropped
    'sdk:my-widget': { icon: 'bolt', bg: '#112233' },
    'sdk:X': { icon: 'bolt' },                             // not a package id
    favorites: { color: '#fff' },                          // a strip, not a button
    search: { icon: '<svg onload=x>', label: 'Cerca', labelMode: 'loud' },
    __proto__: { label: 'x' },
  } });
  assert.deepEqual(Object.keys(look.buttons).sort(), ['lock', 'sdk:my-widget', 'search']);
  assert.deepEqual(look.buttons.lock, { icon: 'lock', label: 'Blocca ora', labelMode: 'never', color: '#ff0000', bg: '' });
  assert.equal(look.buttons.search.icon, '', 'an icon is a library id, never markup');
  assert.equal(look.buttons.search.labelMode, 'auto');
  assert.equal(Object.getPrototypeOf(look.buttons), Object.prototype);
});

test('a label is capped by characters, not UTF-16 units', () => {
  assert.equal(L.normalizeLabel('é'.repeat(40)).length, L.LABEL_MAX);
  assert.equal(Array.from(L.normalizeLabel('🎵'.repeat(40))).length, L.LABEL_MAX);
  assert.equal(L.normalizeLabel(42), '');
});

test('at most 32 buttons are kept', () => {
  const many = {};
  for (let i = 0; i < 50; i++) many['sdk:pkg-' + i] = { label: 'x' };
  assert.equal(Object.keys(L.normalize({ buttons: many }).buttons).length, L.MAX_BUTTONS);
});

test('the dashboard and the server read the same rules', () => {
  assert.match(SETTINGS, /topbarLook: TopbarLook\.normalize\(value\.topbarLook\),/);
  assert.match(SETTINGS, /topbarLook: TopbarLook\.normalize\(null\),/);
  assert.match(SERVER, /const TopbarLook = require\('\.\/js\/topbar-look\.js'\);/);
  assert.match(SERVER, /topbarLook: TopbarLook\.normalize\(source\.topbarLook\),/);
  assert.match(SERVER, /topbarLook: TopbarLook\.DEFAULTS,/);
  // Loaded before settings.js, whose defaults are built at load time.
  assert.ok(INDEX.indexOf('src="js/topbar-look.js"') < INDEX.indexOf('src="js/settings.js"'));
  // After the Comic and Retro skins, so a chosen look wins over theirs.
  assert.ok(INDEX.indexOf('href="components/Topbar/TopbarLook.css"') > INDEX.indexOf('href="styles/themes-comic.css"'));
});

test('the restylable buttons are the ones the bar actually has', () => {
  for (const [id, sel] of Object.entries(L.BUTTON_SELECTORS)) {
    assert.match(MINIMAL, new RegExp(`\\b${id}: '${sel.replace(/[.#]/g, '\\$&')}'`), id);
  }
});

test('every choice the model accepts has CSS that draws it', () => {
  for (const [key, list] of Object.entries(L.CHOICES)) {
    for (const value of list) {
      if (value === L.DEFAULTS[key]) continue;
      const attr = L.attrName(key);
      const specific = CSS.includes(`[${attr}="${value}"]`);
      // "top" is the stack's own place, reached by the generic rule.
      const generic = key === 'toastPlace' && value === 'top' && CSS.includes(`:root[${attr}]`);
      assert.ok(specific || generic, `${attr}="${value}" has no rule`);
    }
  }
  for (const [key, value] of [['shadow', 'none'], ['colonBlink', 'off']]) {
    assert.ok(CSS.includes(`[${L.attrName(key)}="${value}"]`), key);
  }
  assert.ok(CSS.includes(':root[data-tb-accent]'));
  for (const v of ['--tb-color', '--tb-alpha', '--tb-blur', '--tb-btn-fg', '--tb-btn-bg']) assert.ok(CSS.includes(`var(${v}`), v);
});

// The other half of "the default look writes nothing": no rule in the file may
// apply without one of those attributes or a class apply() sets on a button.
// Measured in a browser too (94 bar elements, same computed style with and
// without the file), but this is the part that keeps holding as rules are added.
// Split a selector list on its own commas, not the ones inside :is()/:not().
function topLevel(sel) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  return [...parts, cur];
}

test('every rule waits for a chosen look before it applies', () => {
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').split('}');
  for (const rule of rules) {
    const sel = rule.split('{')[0].trim();
    if (!sel) continue;
    for (const part of topLevel(sel)) {
      assert.match(part, /data-tb-|\.tb-(accent|btn-fg|btn-bg|label-always|label-never|icon|icon-off)\b/, `ungated: ${part.trim()}`);
    }
  }
});

test('a fixed notification place keeps toasts out of the capsule', () => {
  assert.match(TOAST, /!document\.documentElement\.hasAttribute\('data-tb-toast-place'\)/);
  assert.equal(L.attrName('toastPlace'), 'data-tb-toast-place');
});

// ── apply() against a small stand-in for the document ───────────────────────

function fakeEl(tag, attrs = {}, children = []) {
  const a = new Map(Object.entries(attrs));
  const cls = new Set();
  const props = new Map();
  const el = {
    tagName: tag, children, textContent: '', hidden: false, className: attrs.class || '',
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    setAttribute: (k, v) => a.set(k, String(v)),
    removeAttribute: (k) => a.delete(k),
    hasAttribute: (k) => a.has(k),
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), get: (k) => props.get(k) },
    querySelector: () => null,
    insertBefore: () => {},
  };
  return el;
}

function fakeDoc() {
  const label = fakeEl('SPAN', { 'data-i18n': 'ui_lock' });
  label.textContent = 'Blocca';
  const lock = fakeEl('BUTTON', {}, [label]);
  const xenon = fakeEl('BUTTON');
  const root = fakeEl('HTML');
  const doc = {
    documentElement: root,
    querySelector: (sel) => ({ '.qbtn-lock': lock, '.topbtn-xenon': xenon })[sel] || null,
    querySelectorAll: () => [],
  };
  return { doc, root, lock, label, xenon };
}

test('apply sets only what differs and takes it all back on reset', () => {
  globalThis.window = { t: (k) => (k === 'ui_lock' ? 'Lock' : k) };
  try {
    const { doc, root, lock, label, xenon } = fakeDoc();
    L.apply({ surface: 'glass', color: '#102030', accent: 'lock', toastPlace: 'top-right',
      buttons: { lock: { label: 'Chiudi', color: '#ff0000' } } }, doc);
    assert.equal(root.getAttribute('data-tb-surface'), 'glass');
    assert.equal(root.getAttribute('data-tb-accent'), 'lock');
    assert.equal(root.getAttribute('data-tb-toast-place'), 'top-right');
    assert.equal(root.getAttribute('data-tb-size'), null);
    assert.equal(root.style.get('--tb-color'), '16, 32, 48');
    assert.equal(root.style.get('--tb-blur'), '10px');
    assert.equal(label.textContent, 'Chiudi');
    assert.equal(label.getAttribute('data-i18n'), null, 'a language change must not undo the label');
    assert.equal(lock.style.get('--tb-btn-fg'), '#ff0000');
    assert.equal(lock.classList.contains('tb-accent'), true);
    assert.equal(xenon.classList.contains('tb-accent'), false);

    L.apply(null, doc);
    for (const k of ['data-tb-surface', 'data-tb-accent', 'data-tb-toast-place']) assert.equal(root.getAttribute(k), null, k);
    assert.equal(root.style.get('--tb-color'), undefined);
    assert.equal(label.getAttribute('data-i18n'), 'ui_lock');
    assert.equal(label.textContent, 'Lock', 'the translated word comes back');
    assert.equal(lock.style.get('--tb-btn-fg'), undefined);
    assert.equal(lock.classList.contains('tb-accent'), false);
  } finally {
    delete globalThis.window;
  }
});

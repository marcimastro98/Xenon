// The search window's page (js/spotlight-page.js). It lives hidden for hours, so
// it reads the theme and the language again each time it shows, and it must take
// the keyboard at once: the shell calls window.__spotlightShown on every open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/spotlight-page.js');
const HTML = read('../spotlight.html');
const CSS = read('../components/Spotlight/Spotlight.css');
const settle = () => new Promise((r) => setTimeout(r, 0));
const beat = () => new Promise((r) => setTimeout(r, 10));

function page({ settings = { appearance: 'light', language: 'de' }, search = '?frameless=1', wrap = true } = {}) {
  const calls = { skin: [], palette: [], signals: [], open: 0, fresh: 0, reloads: 0 };
  const listeners = {};
  const docListeners = {};
  const box = { active: { tagName: 'BODY' } };
  const window = {
    addEventListener: (k, f) => { (listeners[k] ||= []).push(f); },
    location: { href: '' },
    __xenonSignal: (s) => { calls.signals.push(s); return s; },
    SpotlightChat: null,
    matchMedia: () => ({ matches: true }),
    ThemeTokens: {
      applySkin: (_el, hs) => { calls.skin.push(hs); return {}; },
      derivePalette: (hs) => ({ tone: hs.appearance }),
      applyPalette: (_el, p) => calls.palette.push(p),
      applyMaterial() {},
      applyFont() {},
    },
    Spotlight: {
      greet() {},
      open() { calls.open++; },
      fresh() { calls.fresh++; },
      isOpen: () => calls.open > 0,
      idle: () => Promise.resolve(),
      _setCloseNav(fn) { calls.closeNav = fn; },
    },
  };
  const ctx = vm.createContext({
    window,
    location: { search, reload() { calls.reloads++; } },
    document: {
      body: { classList: { add() {} } },
      documentElement: { lang: '', classList: { add() {} } },
      get activeElement() { return box.active; },
      querySelector: (sel) => (sel === '.spotlight.spot-expanded' && box.expanded ? {} : null),
      hasFocus: () => box.focused !== false,
      addEventListener: (k, f) => { (docListeners[k] ||= []).push(f); },
    },
    fetch: async () => ({ ok: true, json: async () => (wrap ? { settings } : settings) }),
    AbortController,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 1)),
    clearTimeout,
    normalizeLangCode: (l) => l,
    i18n: { en: {}, de: {}, it: {} },
  });
  vm.runInContext('let lang = "en";', ctx);
  vm.runInContext(SRC, ctx);
  const fire = (k, ev) => (listeners[k] || []).forEach((f) => f(ev));
  const boot = async () => {
    (docListeners.DOMContentLoaded || []).forEach((f) => f());
    await settle();
    await settle();
  };
  return { window, ctx, calls, fire, boot, box, get: (e) => vm.runInContext(e, ctx) };
}

test('the theme comes from the settings inside the reply, not from the reply itself', async () => {
  const p = page();
  await p.boot();
  assert.equal(p.calls.skin[0].appearance, 'light');
  assert.equal(p.calls.palette[0].tone, 'light');
  assert.equal(p.get('hubSettings.appearance'), 'light');
  assert.equal(p.get('lang'), 'de');
  assert.equal(p.calls.open, 1);
});

test('a reply without settings leaves the default look and still opens the bar', async () => {
  const p = page({ wrap: false, settings: null });
  await p.boot();
  assert.equal(p.calls.skin.length, 0);
  assert.equal(p.calls.open, 1);
});

test('every show reads the theme again, since the window stays hidden for hours', async () => {
  const p = page();
  await p.boot();
  p.window.__spotlightShown();
  await beat();
  assert.equal(p.calls.skin.length, 2);
});

test('a language changed while hidden reloads the page, so its words change too', async () => {
  const p = page();
  await p.boot();
  assert.equal(p.calls.reloads, 0);
  vm.runInContext('lang = "it"', p.ctx);
  p.window.__spotlightShown();
  await beat();
  assert.equal(p.calls.reloads, 1);
});

test('every show puts the keyboard in the bar and tries again if it did not land', async () => {
  const p = page();
  await p.boot();
  const before = p.calls.open;
  p.window.__spotlightShown();
  await beat();
  assert.ok(p.calls.open >= before + 2, 'first try and at least one more');
  const landed = p.calls.open;
  p.box.active = { tagName: 'INPUT' };
  p.window.__spotlightShown();
  await beat();
  assert.equal(p.calls.open, landed + 1, 'no more tries once it landed');
});

test('the window coming to the front on its own takes the keyboard too', async () => {
  const p = page();
  await p.boot();
  const before = p.calls.open;
  p.fire('focus');
  assert.ok(p.calls.open > before);
});

test('text left from a search abandoned by clicking away is cleared on the next show', async () => {
  const p = page();
  await p.boot();
  p.window.__spotlightShown();
  assert.equal(p.calls.fresh, 0, 'still in front: what is typed stays');
  p.fire('blur');
  p.window.__spotlightShown();
  assert.equal(p.calls.fresh, 1);
});

test('a bar never opened is opened fresh on show, so its recents size the window', async () => {
  const p = page();
  p.window.__spotlightShown();
  assert.equal(p.calls.fresh, 1);
});

test('shown again as it was, a bar with its list asks the shell for the tall window again', async () => {
  const p = page();
  await p.boot();
  p.box.expanded = true;
  const n = p.calls.signals.length;
  p.window.__spotlightShown();
  assert.equal(p.calls.fresh, 0);
  assert.deepEqual(p.calls.signals.slice(n), ['xenon-app:spotlight-expand']);
  p.box.expanded = false;
  p.window.__spotlightShown();
  assert.equal(p.calls.signals.length, n + 1, 'a compact bar asks for nothing');
});

test('a close never opens the bar again in the hidden window', async () => {
  const p = page();
  await p.boot();
  const opened = p.calls.open;
  p.box.focused = false;
  p.calls.closeNav();
  await beat();
  assert.equal(p.calls.open, opened, 'its recents would grow a window the shell then shrinks');
  assert.ok(p.calls.signals.includes('xenon-app:spotlight-close'));
  p.box.focused = true;
  p.calls.closeNav();
  await beat();
  assert.equal(p.calls.open, opened + 1, 'a window the shell did not hide gets its bar back');
});

test('the chat keeps its own field and its size', async () => {
  const p = page();
  await p.boot();
  let focused = 0;
  let asked = 0;
  p.window.SpotlightChat = { isOpen: () => true, focus() { focused++; }, takeAsked() { asked++; } };
  p.fire('blur');
  p.window.__spotlightShown();
  assert.equal(p.calls.fresh, 0);
  assert.ok(focused > 0);
  assert.equal(asked, 1, 'a question from a notification is asked for on every show');
  const n = p.calls.signals.length;
  p.fire('spotlight-expand', { detail: { expanded: false } });
  assert.equal(p.calls.signals.length, n, 'the search resetting behind the chat never shrinks the window');
});

test('the chat tells the shell when it opens and closes', async () => {
  const p = page();
  await p.boot();
  p.fire('spotlight-chat', { detail: { open: true } });
  p.fire('spotlight-chat', { detail: { open: false } });
  assert.deepEqual(p.calls.signals.slice(-2), ['xenon-app:spotlight-chat', 'xenon-app:spotlight-search']);
});

test('the page loads what a theme needs', () => {
  for (const f of ['styles/fonts.css', 'styles/themes-light.css', 'styles/theme-contract.css', 'styles/themes-retro.css', 'styles/themes-comic.css']) {
    assert.ok(HTML.includes(`href="${f}"`), f);
  }
  assert.ok(HTML.includes('src="js/theme-tokens.js"'));
  assert.ok(HTML.indexOf('src="js/spotlight-page.js"') > HTML.indexOf('src="js/spotlight.js"'));
});

test('light rules follow the attribute the theme really sets', () => {
  assert.ok(!CSS.includes('data-theme'));
  assert.ok(!HTML.includes('data-theme'));
  assert.ok(CSS.includes(':root[data-appearance="light"]'));
});

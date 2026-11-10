// The submit form's tag chips (docs/submit/tags.js): every site language carries every
// line, a typed word is cleaned to what the hub keeps, and the hidden #tags input the
// form sends holds the chips space-separated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'docs', 'submit');
const js = readFileSync(path.join(DIR, 'tags.js'), 'utf8');
const html = readFileSync(path.join(DIR, 'index.html'), 'utf8');

// Just enough DOM for tags.js: elements that keep listeners, children and attributes.
function fakeEl(tag = 'div') {
  const listeners = {};
  return {
    tag, value: '', disabled: false, placeholder: '', textContent: '', className: '', type: '', children: [], attrs: {},
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    fire(name, ev = {}) { for (const fn of listeners[name] || []) fn({ preventDefault() { ev.prevented = true; }, ...ev }); return ev; },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    focus() {},
  };
}

function load() {
  const win = {};
  vm.runInNewContext(js, { window: win, document: { createElement: fakeEl }, String });
  const els = { input: fakeEl('input'), hidden: fakeEl('input'), list: fakeEl('ul'), addBtn: fakeEl('button'), note: fakeEl('span') };
  return { tags: win.XenonSubmitTags, els };
}

function type(els, text) {
  els.input.value = text;
  els.input.fire('input');
}

test('every site language carries every tag line', () => {
  const start = js.indexOf('var WORDS = {');
  const end = js.indexOf('\n  };', start) + 5;
  const words = vm.runInNewContext(js.slice(start, end) + ' WORDS;', {});
  assert.deepEqual(Object.keys(words).sort(), ['en', 'es', 'fr', 'it', 'ja', 'ko', 'zh']);
  const keys = Object.keys(words.en).sort();
  for (const [l, d] of Object.entries(words)) {
    assert.deepEqual(Object.keys(d).sort(), keys, l);
    for (const k of keys) assert.ok(d[k].trim() && !d[k].includes('—'), l + '.' + k);
  }
});

test('a typed word is cleaned to what the hub keeps', () => {
  const { tags } = load();
  assert.equal(tags.clean('#Neon_Glow!'), 'neon-glow');
  assert.equal(tags.clean('Café'), 'cafe');
  assert.equal(tags.clean('--a--b--'), 'a-b');
  assert.equal(tags.clean('x'.repeat(30)).length, 20);
  assert.equal(tags.clean('!!!'), '');
});

test('a separator turns the word before it into a chip', () => {
  const { tags, els } = load();
  tags.mount({ ...els, lang: 'it' });
  type(els, 'neon');
  assert.equal(els.hidden.value, '', 'a word still being typed is not a tag yet');
  type(els, 'neon, dark min');
  assert.equal(els.hidden.value, 'neon dark');
  assert.equal(els.input.value, 'min');
  const ev = els.input.fire('keydown', { key: 'Enter' });
  assert.ok(ev.prevented, 'Enter must not send the form');
  assert.equal(els.hidden.value, 'neon dark min');
  assert.equal(els.list.children.length, 3);
  assert.equal(els.note.textContent, '3 di 6');
});

test('the + button, leaving the field and Send all keep a word still in the box', () => {
  const { tags, els } = load();
  tags.mount({ ...els, lang: 'en' });
  els.input.value = 'clock';
  els.addBtn.fire('click');
  els.input.value = 'weather';
  els.input.fire('blur');
  els.input.value = 'minimal';
  tags.commit();
  assert.equal(els.hidden.value, 'clock weather minimal');
});

test('duplicates are dropped, six is the limit, Backspace takes the last chip', () => {
  const { tags, els } = load();
  tags.mount({ ...els, lang: 'en' });
  type(els, 'a a b c d e f g ');
  assert.equal(els.hidden.value, 'a b c d e f');
  assert.ok(els.input.disabled && els.addBtn.disabled);
  assert.match(els.note.textContent, /remove one/);
  els.input.value = '';
  els.input.fire('keydown', { key: 'Backspace' });
  assert.equal(els.hidden.value, 'a b c d e');
  assert.ok(!els.input.disabled);
});

test('a chip is removed by its own button, named for screen readers', () => {
  const { tags, els } = load();
  tags.mount({ ...els, lang: 'en' });
  type(els, 'neon dark ');
  const x = els.list.children[0].children[1];
  assert.equal(x.attrs['aria-label'], 'Remove neon');
  x.fire('click');
  assert.equal(els.hidden.value, 'dark');
});

test('the page sends the chips and switches their language', () => {
  assert.match(html, /<script src="tags\.js"><\/script>/);
  assert.match(html, /<input type="hidden" id="tags">/);
  assert.match(html, /window\.XenonSubmitTags\.commit\(\);\s*var tags = document\.getElementById\('tags'\)\.value/);
  assert.match(html, /window\.XenonSubmitTags\.setLang\(lang\)/);
  assert.match(html, /window\.XenonSubmitTags\.mount\(\{/);
  // Every language's field line says how to add a tag.
  const lines = html.match(/f_tags: '(?:[^'\\]|\\.)*'/g);
  assert.equal(lines.length, 6);
  for (const line of lines) assert.match(line, /\+/, line);
});

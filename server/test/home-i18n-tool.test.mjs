// tools/home-i18n.mjs: one patch edits the seven inline dictionaries of the home page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchHomeI18n, validatePatch, LANGS } from '../../tools/home-i18n.mjs';

const dict = (l) => `  I18N.${l} = {\n    "a": "A ${l}",\n    "b": "B ${l}",\n  };\n`;
const SRC = `<script>\n${LANGS.map(dict).join('\n')}</script>\n`;
const all = (v) => Object.fromEntries(LANGS.map((l) => [l, `${v} ${l}`]));

test('sets a new key in every dictionary, before the closing brace', () => {
  const out = patchHomeI18n(SRC, { set: { c: all('C') } });
  for (const l of LANGS) assert.match(out, new RegExp(`"b": "B ${l}",\\n {4}"c": "C ${l}",\\n {2}\\};`));
});

test('replaces an existing key in place and drops keys', () => {
  const out = patchHomeI18n(SRC, { set: { a: all('New') }, drop: ['b'] });
  assert.match(out, /I18N\.it = \{\n {4}"a": "New it",\n {2}\};/);
  assert.ok(!out.includes('"b"'));
});

test('escapes closing tags and quotes, keeps LF', () => {
  const v = Object.fromEntries(LANGS.map((l) => [l, `<a href="/x">${l}</a>`]));
  const out = patchHomeI18n(SRC, { set: { h: v } });
  assert.ok(out.includes('"h": "<a href=\\"/x\\">en<\\/a>",'));
  assert.ok(!out.includes('\r'));
});

test('refuses a patch missing a language or with an em-dash', () => {
  const partial = all('X'); delete partial.ja;
  assert.deepEqual(validatePatch({ set: { x: partial } }), ['x: missing ja']);
  assert.throws(() => patchHomeI18n(SRC, { set: { x: { ...all('X'), fr: 'a \u2014 b' } } }), /em-dash/);
});

test('fails when a dictionary is missing from the page', () => {
  assert.throws(() => patchHomeI18n(SRC.replace('I18N.zh', 'I18N_zh'), { set: {} }), /zh/);
});

// Every AI prompt names the user's language from ONE map. The nine copies it
// replaced fell behind the app: Russian and Dutch chats got no language line,
// and Spanish, French, German, Portuguese, Russian and Dutch users got
// Performance Mode answers in English and voice clips sent with no language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AI_LANG_NAMES, aiLangName } = require('../ai/prompt-language.js');
const { SUPPORTED_LANGS } = require('../../packages/core/src/constants.js');
const { transcriptionPrompt } = require('../stt-voice-gate.js');
const lyrics = require('../lyrics-translate.js');

test('the map names every language the app speaks, and nothing else', () => {
  assert.deepEqual(Object.keys(AI_LANG_NAMES).sort(), [...SUPPORTED_LANGS].sort());
  for (const name of Object.values(AI_LANG_NAMES)) assert.match(name, /^[A-Z][a-z]+$/);
  assert.ok(Object.isFrozen(AI_LANG_NAMES));
});

test('codes and locales resolve, anything else gets the caller\'s fallback', () => {
  assert.equal(aiLangName('ru'), 'Russian');
  assert.equal(aiLangName('nl-BE'), 'Dutch');
  assert.equal(aiLangName('PT-br'), 'Portuguese');
  assert.equal(aiLangName('es', 'English'), 'Spanish');
  for (const odd of ['xx', '', undefined, null, '__proto__', 'constructor', 42, {}]) {
    assert.equal(aiLangName(odd), '', String(odd));
    assert.equal(aiLangName(odd, 'English'), 'English', String(odd));
  }
});

test('a voice clip from every app language goes out with that language named', () => {
  for (const code of SUPPORTED_LANGS) {
    assert.ok(transcriptionPrompt(aiLangName(code)).includes(`talks in ${AI_LANG_NAMES[code]}.`), code);
  }
  assert.ok(!/usually talks in/.test(transcriptionPrompt(aiLangName('xx'))), 'no guess for an unknown code');
});

test('lyrics translation uses the same names, with the Chinese script spelled out', () => {
  assert.deepEqual(Object.keys(lyrics.LANG_NAMES).sort(), [...SUPPORTED_LANGS].sort());
  assert.equal(lyrics.langName('zh'), 'Simplified Chinese');
  assert.equal(lyrics.langName('nl'), 'Dutch');
});

test('no server module keeps its own copy of the language names', () => {
  // A copy is how the gap happened: a language added to the app reached some
  // prompts and not others. Scans the shipped server modules, not the tests.
  const serverDir = new URL('../', import.meta.url);
  const files = [];
  for (const entry of readdirSync(serverDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(entry.name);
    if (entry.isDirectory() && ['ai', 'http', 'actions', 'capabilities'].includes(entry.name)) {
      for (const name of readdirSync(new URL(entry.name + '/', serverDir))) {
        if (name.endsWith('.js')) files.push(`${entry.name}/${name}`);
      }
    }
  }
  const copies = files.filter((file) => file !== 'ai/prompt-language.js'
    && /\bit:\s*'Italian'/.test(readFileSync(new URL(file, serverDir), 'utf8')));
  assert.deepEqual(copies, [], 'use aiLangName() from server/ai/prompt-language.js');
});

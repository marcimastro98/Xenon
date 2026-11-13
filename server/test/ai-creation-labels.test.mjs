import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../ai-creation-labels.js');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

test('the assistant gets the level names Settings shows, in every app language', async () => {
  L._reset();
  const en = await L.namesFor('en');
  assert.deepEqual(en.efforts, { low: 'Light', medium: 'Normal', high: 'Thorough' });
  assert.deepEqual(en.models, { haiku: 'Fast', sonnet: 'Smart', opus: 'Smartest' });
  assert.deepEqual((await L.namesFor('it')).efforts, { low: 'Essenziale', medium: 'Normale', high: 'Approfondito' });
  assert.equal((await L.namesFor('it')).reasoning, 'Ragionamento');
  for (const lang of LANGS) {
    const n = await L.namesFor(lang);
    for (const name of [...Object.values(n.efforts), ...Object.values(n.models), n.reasoning]) {
      assert.ok(name && !/[:：]/.test(name), lang + ': a bare name, not the whole label: ' + name);
    }
    if (lang !== 'en') assert.notDeepEqual(n.efforts, en.efforts, lang + ' has its own level names');
  }
  assert.deepEqual((await L.namesFor('xx')).efforts, en.efforts, 'an unknown language falls back to English');
});

test('a name is the label up to its colon, and what the caller gets is its own copy', async () => {
  assert.equal(L.nameOf('due: dettaglio'), 'due');
  assert.equal(L.nameOf('深入：积分'), '深入');
  L._reset();
  const first = await L.namesFor('it');
  first.efforts.low = 'changed';
  assert.equal((await L.namesFor('it')).efforts.low, 'Essenziale');
  const info = await L.englishByPrefix('settings_xenon_effort_');
  for (const level of ['low', 'medium', 'high']) assert.equal(typeof info[level], 'string', level);
  info.low = 'changed';
  assert.match((await L.englishByPrefix('settings_xenon_effort_')).low, /^Light/);
});

test('the names come from the language files, the same words a page shows', async () => {
  const Tables = require('../app-strings/tables.js');
  const [it, en] = await Promise.all([Tables.read('it'), Tables.read('en')]);
  L._reset();
  assert.equal((await L.namesFor('it')).efforts.high, L.nameOf(it.settings_xenon_effort_high));
  assert.equal((await L.namesFor('en')).models.opus, L.nameOf(en.settings_xenon_model_opus));
  assert.deepEqual(await L.namesFor('__proto__'), await L.namesFor('en'), 'a code that is not a language reads in English');
});

test('the creation-model tool answers with those names', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /names: await aiCreationLabels\.namesFor\(uiLang\),/);
});

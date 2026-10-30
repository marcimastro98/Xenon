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

test('the last definition of a key wins, as in the browser', () => {
  const src = "const i18n = {\n  it: {\n    a: 'uno',\n  },\n};\nObject.assign(i18n.it, {\n  a: \"due: dettaglio\",\n});\n";
  assert.equal(L.parseStrings(src).it.a, 'due: dettaglio');
  assert.equal(L.nameOf('深入：积分'), '深入');
});

test('the creation-model tool answers with those names', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /names: await aiCreationLabels\.namesFor\(uiLang\),/);
});

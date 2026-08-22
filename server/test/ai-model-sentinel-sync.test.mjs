import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The `auto` / `auto:<family>` sentinel is spelled FIVE times: once per provider
// module (sanitizeModel), once in the resolver (parseStored), and once in the
// browser (normalizeModelChoice in js/settings.js, which is what the Custom…
// field writes). They are not one function because each provider's copy also
// documents that provider's own id shape — but they must agree about what a
// stored value MEANS, and this file is what holds them level.
//
// The drift it was written for: the sentinel was case-SENSITIVE while the id
// pattern it falls through to is case-INSENSITIVE. So `AUTO` looked like a
// perfectly good model id and was stored as a deliberate pin. Nothing could
// repair it — no provider publishes a model called AUTO, so every request 404s,
// and markMissing() can only drop entries from the cached list, where an id
// nobody published never appeared. The Settings panel showed the value as
// chosen while every single turn paid a failed request.
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const gemini = require('../ai-gemini.js');
const openai = require('../ai-openai.js');
const anthropic = require('../ai-anthropic.js');
const models = require('../ai-models.js');

// The client copy cannot be required: js/settings.js is a browser script with a
// whole app behind it. Its declaration is extracted and evaluated on its own,
// the same way test/state-server-origin.test.mjs reads the real SERVER constant
// — so this asserts the shipped source, not a paraphrase of it.
//
// The `new Function` body is a slice of our OWN source file, read from disk in a
// unit test. Nothing user-supplied reaches it, and evaluating the real thing is
// the entire point: a copy of the regex written here would pass while the
// shipped one drifted, which is the failure this file exists to catch.
function clientNormalizer() {
  const src = fs.readFileSync(path.join(HERE, '..', 'js', 'settings.js'), 'utf8');
  const at = src.indexOf('function normalizeModelChoice(');
  assert.notEqual(at, -1, 'normalizeModelChoice was not found — did it move or get renamed?');
  const end = src.indexOf('\n}', at);
  assert.notEqual(end, -1, 'could not find the end of normalizeModelChoice');
  const body = src.slice(at, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return normalizeModelChoice;`)();
}

const SANITIZERS = [
  ['ai-gemini', (v) => gemini.sanitizeModel(v)],
  ['ai-openai', (v) => openai.sanitizeModel(v)],
  ['ai-anthropic', (v) => anthropic.sanitizeModel(v)],
  ['js/settings', clientNormalizer()],
];

// input → what every one of the four must return.
const TABLE = [
  ['auto', 'auto'],
  ['AUTO', 'auto'],
  ['Auto', 'auto'],
  ['  auto  ', 'auto'],
  ['auto:sonnet', 'auto:sonnet'],
  ['auto:SONNET', 'auto:sonnet'],
  ['AUTO:Sonnet', 'auto:sonnet'],
  ['', 'auto'],
  ['has space', 'auto'],
  ['a'.repeat(61), 'auto'],
];

test('every spelling of the sentinel folds case the same way', () => {
  for (const [name, fn] of SANITIZERS) {
    for (const [input, expected] of TABLE) {
      assert.equal(fn(input), expected, `${name}(${JSON.stringify(input)})`);
    }
  }
});

// The other half of the rule, and the reason the fold cannot simply be applied
// to the whole value: an id we do not recognise is a PIN, and a pin is the
// provider's string. Lower-casing it would hand the provider a name it never
// published, which is the same failure in the opposite direction.
test('a pinned id keeps the case the user typed', () => {
  for (const [name, fn] of SANITIZERS) {
    assert.equal(fn('gpt-4o'), 'gpt-4o', name);
    assert.equal(fn('GPT-4o'), 'GPT-4o', `${name} must not fold a pin`);
    assert.equal(fn('Claude-Sonnet-5'), 'Claude-Sonnet-5', name);
  }
});

// The resolver reads what the four above wrote, so it has to accept the same
// set. The family is captured from the FOLDED string: `auto:SONNET` has to
// produce `sonnet`, or pickLatest compares it against the lowercase `e.family`
// and matches nothing — an auto setting that silently resolves to no model.
test('parseStored agrees with the sanitizers, and folds the family', () => {
  for (const v of ['auto', 'AUTO', 'Auto', ' auto ']) {
    assert.deepEqual(models.parseStored(v), { auto: true, family: '', id: '' }, v);
  }
  for (const v of ['auto:sonnet', 'auto:SONNET', 'AUTO:Sonnet']) {
    assert.deepEqual(models.parseStored(v), { auto: true, family: 'sonnet', id: '' }, v);
  }
  // …and a pin still arrives at the provider exactly as stored.
  assert.deepEqual(models.parseStored('GPT-4o'), { auto: false, family: '', id: 'GPT-4o' });
});

// What the bug actually cost, stated as behaviour rather than as a regex: a
// value the user could type must never become a request for a model that cannot
// exist. `AUTO` was the one that did.
test('no spelling of auto can be stored as a pin', () => {
  for (const [name, fn] of SANITIZERS) {
    for (const v of ['AUTO', 'Auto', 'aUtO', 'AUTO:GPT']) {
      const out = fn(v);
      assert.ok(out.startsWith('auto'), `${name}(${v}) → ${out} would be sent to the provider verbatim`);
      assert.equal(models.parseStored(out).auto, true, `${name}(${v}) → ${out} did not resolve as auto`);
    }
  }
});

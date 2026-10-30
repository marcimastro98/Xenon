import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The README is the GitHub front page: its Support section says what the site's
// tiers say, prices with their currency, the Sparks every plan brings and the
// packs the app sells (xenon-credits.js PACKS).
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const support = readme.slice(readme.indexOf('## Support'), readme.indexOf('## A note on AI assistance'));

test('the README support section names every plan in USD, the 300 Sparks and the packs', () => {
  assert.ok(support.length > 0, 'section found');
  for (const plan of ['5 USD once', '25 USD once', '5 USD a month', '50 USD a year']) assert.ok(support.includes(plan), plan);
  assert.doesNotMatch(support, /\$\d/, 'no "$5": the currency is named');
  assert.match(support, /300 Sparks a month, Xenon's credits/);
  const src = readFileSync(new URL('../js/xenon-credits.js', import.meta.url), 'utf8');
  const packs = [...src.matchAll(/\{ credits: (\d+), usd: (\d+)/g)];
  assert.equal(packs.length, 3);
  for (const [, credits, usd] of packs) assert.ok(support.includes(credits) && support.includes(usd), `${credits} for ${usd}`);
  assert.ok(support.includes('https://www.buymeacoffee.com/marcimastro98/extras'));
  assert.match(support, /Settings → Support Xenon/);
});

test('the README calls the assistant Bit and lists every way it runs', () => {
  assert.doesNotMatch(readme, /\*\*Xenon AI\*\* —/, 'the old bullet name');
  assert.match(readme, /\*\*Bit, the assistant\*\*/);
  for (const p of ['Gemini', 'OpenAI', 'Anthropic', 'Ollama', 'Claude Code', 'Codex', "Sparks, Xenon's credits"]) assert.ok(readme.includes(p), p);
});

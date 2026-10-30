// Game Companion answers with the AI set for Bit (Sparks, the user's own key,
// a seeing Ollama model), not only with a Gemini key.
//
// The rules these tests hold:
//  - the screenshot rides as a picture on every provider that can see one;
//  - an AI that cannot see (a plan run through its program, Ollama without
//    eyes) is said plainly before a screenshot is taken;
//  - out of Sparks is named and offers the recharge; the browser never sends a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../ai-anthropic.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const S = read('../server.js');
const endpoint = () => {
  const i = S.indexOf("reqPath === '/api/companion/insight'");
  return S.slice(i, S.indexOf('} else if (reqPath', i + 10));
};

test('a Claude one-shot is the words alone, or the picture then the words', () => {
  assert.equal(A.userContent('hi'), 'hi');
  assert.deepEqual(A.userContent('tip?', { mimeType: 'image/jpeg', data: 'QUJD' }), [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
    { type: 'text', text: 'tip?' },
  ]);
});

test('ChatGPT one-shots carry the picture as an image part', () => {
  const src = read('../ai-openai.js');
  assert.match(src, /async function oneShot\(\{[^}]*image \}\)/);
  assert.match(src, /\{ type: 'image_url', image_url: \{ url: `data:\$\{image\.mimeType\};base64,\$\{image\.data\}` \} \}/);
});

test('the user AI helper passes the picture to every provider, and a plan program refuses it', () => {
  const i = S.indexOf('async function completeWithUserAi(');
  const fn = S.slice(i, S.indexOf('\n}\n', i));
  assert.match(fn, /image = null \}\)/);
  assert.match(fn, /const parts = image \? \[\{ text: user \}, \{ inlineData: image \}\] : \[\{ text: user \}\];/);
  assert.match(fn, /history: \[\{ role: 'user', parts \}\]/, 'Ollama');
  assert.match(fn, /if \(image\) \{ const e = new Error\('this AI cannot see pictures'\); e\.code = 'no_vision'; throw e; \}/, 'Claude Code / Codex');
  assert.match(fn, /onUsage, image,\n/, 'ChatGPT / Claude key');
  assert.match(fn, /aiXenon\.oneShot\(\{[^}]*onUsage, image \}\)/, 'Sparks');
  assert.equal((fn.match(/_geminiOneShot\(apiKey, parts,/g) || []).length, 2, 'Gemini, both tries');
});

test('the vision check names an AI that cannot see before any screenshot', () => {
  const i = S.indexOf('async function userAiVisionBlocker(');
  const fn = S.slice(i, S.indexOf('\n}\n', i));
  assert.match(fn, /const blocked = await userAiBlocker\(\);\n\s*if \(blocked\) return blocked;/);
  assert.match(fn, /if \(aiCli\.isCliProvider\(provider\)\) return 'no_vision';/);
  assert.match(fn, /aiLocal\.supportsVisionLive\(/);
  const ep = endpoint();
  assert.ok(ep.indexOf('userAiVisionBlocker()') < ep.indexOf('captureScreenshot('), 'checked before the capture');
  assert.match(ep, /completeWithUserAi\(\{[\s\S]*image: \{ mimeType: 'image\/jpeg', data: shot \}/);
  assert.match(ep, /e\.code === 'no_credits'\) \{ companionFail\(402, 'no_credits'\)/);
  assert.doesNotMatch(ep, /geminiKeyFor|_geminiOneShot/, 'no Gemini-only path left');
});

test('the card asks the AI set for Bit, sends no key, and explains each problem', () => {
  const js = read('../js/game-companion.js');
  assert.doesNotMatch(js, /geminiApiKey|geminiKeyReady|key: apiKey/);
  assert.match(js, /if \(typeof _aiHasKey === 'function' && !_aiHasKey\(\)\) \{\n\s*showProblem\(out, 'no_ai'\);/);
  assert.match(js, /const PROBLEM_TEXT = \{ no_ai: 'gc_need_key', no_vision: 'gc_no_vision', no_credits: 'gc_no_sparks' \};/);
  assert.match(js, /go\.addEventListener\('click', \(\) => \{ closeOverlay\(\); XenonCredits\.openShop\(\); \}\);/);
  // Untrusted answer text only ever goes in as text.
  assert.doesNotMatch(js, /out\.innerHTML/);
  const i18n = read('../js/i18n.js');
  for (const k of ['gc_need_key', 'gc_no_vision', 'gc_no_sparks', 'bit_model_topup']) {
    assert.equal((i18n.match(new RegExp(`^\\s+"?${k}"?: `, 'gm')) || []).length, 11, k);
  }
  assert.doesNotMatch(i18n, /gc_need_key: '[^']*Gemini/, 'the hint no longer asks for a Gemini key');
  assert.match(read('../components/GameCompanion/GameCompanion.css'), /\.gc-recharge \{[^}]*min-height: 44px;/);
});

test('a look on Sparks costs what the hub charged last, or a measured typical look until then', () => {
  const i = S.indexOf('function companionLookSparks(');
  const fn = S.slice(i, S.indexOf('\n}\n', i));
  assert.match(fn, /return Number\.isFinite\(_companionLastSparks\) \? _companionLastSparks : COMPANION_TYPICAL_SPARKS;/);
  assert.match(S, /const COMPANION_TYPICAL_SPARKS = 0\.3;/);
  const ep = endpoint();
  assert.match(ep, /if \(Number\.isFinite\(sparks\)\) _companionLastSparks = sparks;/);
  // The estimate route is a read: nothing changes, so it is no CSRF mutation.
  const j = S.indexOf("reqPath === '/api/companion/cost' && req.method === 'GET'");
  const cost = S.slice(j, S.indexOf('} else if (reqPath', j + 10));
  assert.match(cost, /json\(\{ ok: true, sparks: onSparks \? companionLookSparks\(\) : null \}\)/);
  assert.doesNotMatch(cost, /write|save|set\(/i);
});

test('the card says what a look costs before pressing, and what the last one cost after', async () => {
  const vm = await import('node:vm');
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: true, textContent: '', dataset: {}, disabled: false,
    classList: { add() {}, remove() {} }, append() {}, value: '' });
  let refreshed = 0;
  let reply = { text: 'Vai a destra.', sparks: 2.5 };
  const ctx = {
    document: { getElementById: el, addEventListener() {}, createElement: () => el('x') },
    requestAnimationFrame() {}, setInterval: () => 1, clearInterval() {}, setTimeout() {},
    t: (k) => k, aiFeatureEnabled: () => true, _aiHasKey: () => true, SERVER: '', lang: 'it',
    fetch: async (url) => ({
      ok: true,
      json: async () => (url === '/api/companion/cost' ? { ok: true, sparks: 0.05 } : url === '/network' ? {} : reply),
    }),
  };
  ctx.window = ctx;
  ctx.XenonCredits = { active: () => true, format: (n) => String(n), refresh: () => { refreshed++; } };
  vm.createContext(ctx);
  vm.runInContext(read('../js/game-companion.js'), ctx);
  ctx.GameCompanion.openOverlay();
  await new Promise((r) => setImmediate(r));
  assert.equal(els['gc-cost'].hidden, false);
  assert.equal(els['gc-cost'].textContent, 'gc_cost_under', 'less than one Spark is said so');
  await ctx.GameCompanion.analyze();
  assert.equal(els['gc-cost'].textContent, 'gc_cost', 'the charge of this look');
  assert.equal(refreshed, 1, 'the balance chip catches up');
  // Bit on the user's own key: nothing to pay here, the line goes away.
  ctx.XenonCredits.active = () => false;
  reply = { text: 'Ok.' };
  ctx.GameCompanion.closeOverlay();
  ctx.GameCompanion.openOverlay();
  await new Promise((r) => setImmediate(r));
  assert.equal(els['gc-cost'].hidden, true);
  const i18n = read('../js/i18n.js');
  for (const k of ['gc_cost', 'gc_cost_under']) {
    assert.equal((i18n.match(new RegExp(`^\\s+"?${k}"?: `, 'gm')) || []).length, 11, k);
  }
  assert.equal((i18n.match(/^\s+"?gc_cost"?: .*\{n\}/gm) || []).length, 11, 'every language keeps {n}');
});

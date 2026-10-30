// A widget's questions to the AI the user set for Bit (sdk-ai.js, POST /sdk/ai).
//
// Every question may cost the user Sparks, an API key's money or plan quota,
// so what is pinned here is the spending guard: bounded text, one question per
// widget at a time, a daily number per widget that survives a restart, and
// fixed error codes that never carry a provider's message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { createSdkAi, normalizeAsk, cleanDailyCap, PROMPT_MAX, SYSTEM_MAX, MAX_TOKENS_CAP } = require('../sdk-ai.js');
const sdk = require('../sdk-widgets.js');

const noBlock = async () => '';

function make(opts = {}) {
  const calls = [];
  const replies = opts.replies || [];
  const ai = createSdkAi({
    dataDir: opts.dataDir,
    now: opts.now,
    blocker: opts.blocker || noBlock,
    complete: async (req) => {
      calls.push(req);
      const next = replies.length ? replies.shift() : { text: 'ok' };
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(req);
      return next;
    },
  });
  return { ai, calls };
}

test('normalizeAsk bounds the question, the instructions and the answer length', () => {
  assert.deepEqual(normalizeAsk({}), { error: 'bad_prompt' });
  assert.deepEqual(normalizeAsk({ prompt: '   ' }), { error: 'bad_prompt' });
  assert.deepEqual(normalizeAsk({ prompt: 'x'.repeat(PROMPT_MAX + 1) }), { error: 'too_long' });
  assert.deepEqual(normalizeAsk({ prompt: 'hi', system: 'x'.repeat(SYSTEM_MAX + 1) }), { error: 'too_long' });
  assert.deepEqual(normalizeAsk({ prompt: 'hi', system: 42 }), { error: 'bad_prompt' });
  assert.equal(normalizeAsk({ prompt: 'hi', maxTokens: 1e9 }).maxTokens, MAX_TOKENS_CAP);
  assert.equal(normalizeAsk({ prompt: 'hi', maxTokens: 1 }).maxTokens, 16);
  assert.equal(normalizeAsk({ prompt: 'hi' }).maxTokens, 400);
  assert.equal(normalizeAsk({ prompt: 'hi', json: 'yes' }).json, false);
});

test('the widget instructions follow a fixed frame, and control characters go', () => {
  const q = normalizeAsk({ prompt: 'a\u0007b\nc', system: 'Be brief.' });
  assert.equal(q.prompt, 'a b\nc');
  assert.match(q.system, /^You answer a question from a widget/);
  assert.match(q.system, /Be brief\.$/);
  assert.match(normalizeAsk({ prompt: 'hi' }).system, /no tools/);
});

test('an unknown daily number is the default, never unlimited', () => {
  assert.equal(cleanDailyCap(20), 20);
  assert.equal(cleanDailyCap('200'), 200);
  assert.equal(cleanDailyCap(1e9), 50);
  assert.equal(cleanDailyCap(undefined), 50);
});

test('a question gets the answer and how many are left today', async () => {
  const { ai, calls } = make({ replies: [{ text: '  Rome  ' }] });
  assert.deepEqual(await ai.ask('quiz', { prompt: 'Capital of Italy?' }, 20), { ok: true, text: 'Rome', left: 19 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].user, 'Capital of Italy?');
});

test('the daily number stops a widget, other widgets keep theirs, a new day resets it', async () => {
  let now = new Date(2026, 9, 30, 10).getTime();
  const { ai, calls } = make({ now: () => now });
  for (let i = 0; i < 20; i++) assert.equal((await ai.ask('quiz', { prompt: 'q' }, 20)).ok, true);
  assert.deepEqual(await ai.ask('quiz', { prompt: 'q' }, 20), { ok: false, error: 'cap', cap: 20 });
  assert.equal(calls.length, 20);
  assert.equal((await ai.ask('other', { prompt: 'q' }, 20)).ok, true);
  now = new Date(2026, 9, 31, 0, 1).getTime();
  assert.equal((await ai.ask('quiz', { prompt: 'q' }, 20)).ok, true);
});

test('a restart does not hand a widget a fresh day', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-sdk-ai-'));
  const now = () => new Date(2026, 9, 30, 12).getTime();
  const first = make({ dataDir: dir, now });
  for (let i = 0; i < 20; i++) await first.ai.ask('quiz', { prompt: 'q' }, 20);
  const second = make({ dataDir: dir, now });
  assert.equal((await second.ai.ask('quiz', { prompt: 'q' }, 20)).error, 'cap');
  assert.equal(second.calls.length, 0);
  assert.deepEqual((await second.ai.usageToday()).counts, { quiz: 20 });
});

test('one question per widget at a time', async () => {
  let release;
  let started;
  const asked = new Promise((r) => { started = r; });
  const slow = () => new Promise((r) => { release = () => r({ text: 'done' }); started(); });
  const { ai } = make({ replies: [slow] });
  const first = ai.ask('quiz', { prompt: 'q' }, 20);
  assert.deepEqual(await ai.ask('quiz', { prompt: 'q' }, 20), { ok: false, error: 'busy' });
  await asked;
  release();
  assert.equal((await first).ok, true);
});

test('no AI set up costs nothing and says so', async () => {
  const { ai, calls } = make({ blocker: async () => 'no_ai' });
  assert.deepEqual(await ai.ask('quiz', { prompt: 'q' }, 20), { ok: false, error: 'no_ai' });
  assert.equal(calls.length, 0);
});

test('an empty Sparks balance is not counted; a broken provider is, with a fixed code', async () => {
  const empty = Object.assign(new Error('Xenon credits: no_credits'), { code: 'no_credits' });
  const broken = new Error('401 invalid key sk-live-abc for api.example.com');
  const { ai } = make({ replies: [empty, broken] });
  assert.deepEqual(await ai.ask('quiz', { prompt: 'q' }, 20), { ok: false, error: 'no_credits' });
  assert.deepEqual((await ai.usageToday()).counts, {});
  // The provider's message (a key, a host) never reaches the widget.
  assert.deepEqual(await ai.ask('quiz', { prompt: 'q' }, 20), { ok: false, error: 'failed' });
  assert.deepEqual((await ai.usageToday()).counts, { quiz: 1 });
});

test('a bad package id is refused before anything is asked', async () => {
  const { ai, calls } = make();
  assert.equal((await ai.ask('../x', { prompt: 'q' }, 20)).error, 'not_allowed');
  assert.equal(calls.length, 0);
});

test('the manifest flag is opt-in and exact', () => {
  const base = { api: 1, name: 'Quiz', entry: 'index.html' };
  const norm = (raw) => sdk.normalizeManifest(raw, 'quiz');
  assert.equal(norm({ ...base, ai: true }).manifest.ai, true);
  assert.equal(norm({ ...base, ai: 'yes' }).manifest.ai, false);
  assert.equal(norm(base).manifest.ai, false);
});

test('the route checks the grant, the manifest, and sits on the CSRF lists', () => {
  const server = read('server/server.js');
  const route = server.slice(server.indexOf("reqPath === '/sdk/ai'"), server.indexOf("reqPath === '/stream/youtube/search'"));
  assert.match(route, /sdkFeatureEnabled\(\)/);
  assert.match(route, /sdkGrantsFor\(pkgId\)\.ai/);
  assert.match(route, /pkg\.ai !== true/);
  assert.match(route, /readBody\(req, 64 \* 1024\)/);
  assert.match(server.slice(server.indexOf('const CSRF_MUTATION_PATHS')), /'\/sdk\/ai'/);
  assert.match(read('server/remote-access.js'), /'\/sdk\/ai'/);
  assert.match(server, /ai: !!\(g && g\.ai === true\)/);
});

test('the host bridges `ai` only for a granted package and always answers', () => {
  const cw = read('server/js/custom-widget.js');
  const fn = cw.slice(cw.indexOf('function onBridgeAi'), cw.indexOf('// ── Fullscreen tile'));
  assert.match(fn, /pkg\.ai !== true \|\| !grant\.ai/);
  assert.match(fn, /type: 'ai_result'/);
  assert.match(fn, /\.catch\(\(\) => reply\(\{ ok: false, error: 'failed' \}\)\)/);
  assert.match(cw, /\(pkg\.ai === true && !g\.ai\)/);
});

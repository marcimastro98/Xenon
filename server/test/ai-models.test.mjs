import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const gemini = require('../ai-gemini.js');
const openai = require('../ai-openai.js');
const anthropic = require('../ai-anthropic.js');
const models = require('../ai-models.js');

// The real answer from generativelanguage.googleapis.com/v1beta/models on a
// normal key (Aug 2026, 53 entries). Every classification rule below is a rule
// about data that actually comes back, so the fixture is the specification.
const GEMINI_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/gemini-models.json', import.meta.url), 'utf8'));

const geminiEntries = () => GEMINI_FIXTURE.models.map(gemini.classify).filter(Boolean);

// ── Gemini classification ────────────────────────────────────────────────────

test('gemini: only the models we can actually drive survive classification', () => {
  const entries = geminiEntries();
  const ids = entries.map(e => e.id);
  assert.ok(entries.length > 0 && entries.length < GEMINI_FIXTURE.models.length,
    'the list is filtered, not passed through');
  // Nothing that is not a gemini-* model at all.
  for (const bad of ['gemma-4-31b-it', 'imagen-4.0-generate-001', 'veo-3.1-generate-preview',
    'lyria-3-pro-preview', 'nano-banana-pro-preview', 'aqa', 'deep-research-preview-04-2026',
    'antigravity-preview-05-2026']) {
    assert.ok(!ids.includes(bad), `${bad} must not be offered`);
  }
  // gemini-* models that are not general-purpose for any of our four roles.
  for (const bad of ['gemini-embedding-2', 'gemini-3.1-flash-image', 'gemini-3-pro-image',
    'gemini-robotics-er-2-preview', 'gemini-2.5-computer-use-preview-10-2025',
    'gemini-3.1-pro-preview-customtools', 'gemini-3.5-live-translate-preview']) {
    assert.ok(!ids.includes(bad), `${bad} must not be offered`);
  }
  assert.deepEqual([...new Set(entries.map(e => e.kind))].sort(), ['chat', 'live', 'tts']);
});

test('gemini: family beats version parsing on the ids that look alike', () => {
  const by = Object.fromEntries(geminiEntries().map(e => [e.id, e]));
  assert.equal(by['gemini-3.7-flash'].family, 'flash');
  assert.equal(by['gemini-3.5-flash-lite'].family, 'flash-lite',
    'flash-lite must not read as flash, or auto:flash drops to the cheaper tier');
  assert.equal(by['gemini-2.5-pro'].family, 'pro');
  assert.equal(by['gemini-3.7-flash'].rank, 3.7);
  assert.equal(by['gemini-3-flash-preview'].rank, 3, 'a bare major version parses');
  assert.equal(by['gemini-3-flash-preview'].preview, true);
  assert.equal(by['gemini-flash-latest'].alias, true, 'a moving alias carries no version');
  assert.equal(by['gemini-flash-latest'].rank, null);
});

test('gemini: a TTS id is a TTS id whichever side the -tts sits on', () => {
  const by = Object.fromEntries(geminiEntries().map(e => [e.id, e]));
  assert.equal(by['gemini-3.1-flash-tts-preview'].kind, 'tts');
  assert.equal(by['gemini-2.5-flash-preview-tts'].kind, 'tts');
});

// ── Ranking ──────────────────────────────────────────────────────────────────

test('pickLatest picks the newest of the family, on the real list', () => {
  const e = geminiEntries();
  assert.equal(models.pickLatest(e, 'chat', 'flash', gemini), 'gemini-3.7-flash');
  assert.equal(models.pickLatest(e, 'chat', 'flash-lite', gemini), 'gemini-3.5-flash-lite');
  assert.equal(models.pickLatest(e, 'tts', 'flash', gemini), 'gemini-3.1-flash-tts-preview');
});

test('pickLatest never lands on a moving alias', () => {
  const e = geminiEntries();
  for (const kind of ['chat', 'tts', 'live']) {
    const picked = models.pickLatest(e, kind, '', gemini);
    assert.ok(!String(picked).endsWith('-latest'), `${kind} resolved to an alias: ${picked}`);
  }
});

test('pickLatest prefers a stable id over a preview of the SAME version', () => {
  const e = [
    { id: 'x-2.0-flash', kind: 'chat', family: 'flash', rank: 2, preview: false, alias: false, label: 'x' },
    { id: 'x-2.0-flash-preview', kind: 'chat', family: 'flash', rank: 2, preview: true, alias: false, label: 'x' },
  ].map(models.normalizeEntry);
  assert.equal(models.pickLatest(e, 'chat', 'flash'), 'x-2.0-flash');
  // …but a NEWER preview still wins: that is the documented rule, and it is what
  // makes auto:pro reach 3.1-pro-preview instead of sitting on 2.5-pro forever.
  assert.equal(models.pickLatest(geminiEntries(), 'chat', 'pro', gemini), 'gemini-3.1-pro-preview');
});

test('a Live model must be a conversational flash one, not merely bidi-capable', () => {
  const e = geminiEntries();
  assert.equal(models.pickLatest(e, 'live', 'flash', gemini), 'gemini-3.1-flash-live-preview');
  // The translate model is version 3.5 and would outrank it on version alone.
  assert.ok(!e.some(x => x.id.includes('translate')), 'the translate model is filtered earlier');
});

// ── The sentinel ─────────────────────────────────────────────────────────────

test('parseStored tells a pin from an auto, and reads the family', () => {
  assert.deepEqual(models.parseStored('auto'), { auto: true, family: '', id: '' });
  assert.deepEqual(models.parseStored('auto:flash-lite'), { auto: true, family: 'flash-lite', id: '' });
  assert.deepEqual(models.parseStored('gemini-3.5-flash'), { auto: false, family: '', id: 'gemini-3.5-flash' });
  assert.equal(models.parseStored('').auto, false);
});

test('every provider sanitizer accepts the sentinel — the colon is the trap', () => {
  // The id pattern in all three modules rejects ':', so without an explicit
  // branch each `auto:<family>` setting would silently collapse to the default
  // and the whole feature would be off for anyone who picked a family.
  for (const mod of [gemini, openai, anthropic]) {
    assert.equal(mod.sanitizeModel('auto'), 'auto');
    assert.equal(mod.sanitizeModel('auto:flash'), 'auto:flash');
    assert.equal(mod.sanitizeModel('auto:sonnet'), 'auto:sonnet');
    assert.notEqual(mod.sanitizeModel('auto:../../etc'), 'auto:../../etc');
    assert.notEqual(mod.sanitizeModel('a b'), 'a b');
  }
  assert.equal(gemini.sanitizeModel('gemini-3.7-flash'), 'gemini-3.7-flash');
  assert.equal(openai.sanitizeModel('gpt-4o'), 'gpt-4o');
  assert.equal(anthropic.sanitizeModel('claude-sonnet-5'), 'claude-sonnet-5');
});

test('an absent setting falls back to auto, never to a named model', () => {
  // The fallback used to be each module's chat model, which was invisible while
  // one field per provider used this and wrong the moment three did: an absent
  // openaiSttModel came back as `gpt-4o`, the client stored it as a deliberate
  // pin, and both speech rows in Settings showed a chat model.
  for (const mod of [gemini, openai, anthropic]) {
    assert.equal(mod.sanitizeModel(undefined), 'auto');
    assert.equal(mod.sanitizeModel(''), 'auto');
    assert.equal(mod.sanitizeModel('nope nope'), 'auto');
  }
});

test('a speech slot refuses a model that is not a speech model', () => {
  const s = openai.sanitizeSpeechModel;
  assert.equal(s('whisper-1', 'stt'), 'whisper-1');
  assert.equal(s('gpt-4o-transcribe', 'stt'), 'gpt-4o-transcribe');
  assert.equal(s('tts-1', 'tts'), 'tts-1');
  assert.equal(s('gpt-4o-mini-tts', 'tts'), 'gpt-4o-mini-tts');
  assert.equal(s('auto', 'tts'), 'auto');
  assert.equal(s('auto:gpt', 'stt'), 'auto:gpt');
  // The repair: a chat id that reached a speech field goes back to auto, so the
  // value already written to disk by the bug above heals on the next normalize.
  assert.equal(s('gpt-4o', 'tts'), 'auto');
  assert.equal(s('gpt-4o', 'stt'), 'auto');
  assert.equal(s('tts-1', 'stt'), 'auto', 'a speech model of the WRONG kind is refused too');
  assert.equal(s('whisper-1', 'tts'), 'auto');
  assert.equal(s('something-unclassifiable', 'tts'), 'auto');
});

// ── Resolution ───────────────────────────────────────────────────────────────

test('resolve: a pin is returned untouched, auto follows the list', () => {
  models._reset();
  models._setEntries('gemini', geminiEntries());
  assert.equal(models.resolve('gemini', 'chat', 'gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(models.resolve('gemini', 'chat', 'auto'), 'gemini-3.7-flash');
  assert.equal(models.resolve('gemini', 'chat', 'auto:flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(models.resolve('gemini', 'chatPro', 'auto'), 'gemini-3.1-pro-preview');
  assert.equal(models.resolve('gemini', 'live', 'auto'), 'gemini-3.1-flash-live-preview');
  models._reset();
});

test('resolve: a family that stopped existing falls back to the role, not to nothing', () => {
  models._reset();
  models._setEntries('gemini', geminiEntries());
  assert.equal(models.resolve('gemini', 'chat', 'auto:doesnotexist'), 'gemini-3.7-flash');
  models._reset();
});

test('resolve: a cold cache answers with the offline default, never empty', () => {
  models._reset();
  assert.equal(models.resolve('gemini', 'chat', 'auto'), gemini.DEFAULTS.chat);
  assert.equal(models.resolve('gemini', 'chatPro', 'auto'), gemini.DEFAULTS.chatPro);
  assert.equal(models.resolve('gemini', 'tts', 'auto'), gemini.DEFAULTS.tts);
  assert.equal(models.resolve('openai', 'chat', 'auto'), openai.DEFAULTS.chat);
  assert.equal(models.resolve('anthropic', 'chat', 'auto'), anthropic.DEFAULTS.chat);
  // The chat defaults are Google's own moving aliases on purpose: an offline
  // fallback that names a version is a fallback that eventually rots.
  assert.ok(gemini.DEFAULTS.chat.endsWith('-latest'));
  models._reset();
});

test('markMissing drops a dead id so the next turn picks the runner-up', () => {
  models._reset();
  models._setEntries('gemini', geminiEntries());
  assert.equal(models.resolve('gemini', 'chat', 'auto'), 'gemini-3.7-flash');
  models.markMissing('gemini', 'gemini-3.7-flash');
  assert.equal(models.resolve('gemini', 'chat', 'auto'), 'gemini-3.6-flash');
  models.markMissing('gemini', 'gemini-3.6-flash');
  assert.equal(models.resolve('gemini', 'chat', 'auto'), 'gemini-3.5-flash');
  models._reset();
});

test('catalog reports what the picker cannot compute: the resolved ids', () => {
  models._reset();
  models._setEntries('gemini', geminiEntries());
  const c = models.catalog('gemini', { chat: 'auto', chatPro: 'gemini-2.5-pro', tts: 'auto', live: 'auto' });
  assert.equal(c.resolved.chat, 'gemini-3.7-flash');
  assert.equal(c.resolved.chatPro, 'gemini-2.5-pro', 'a pin resolves to itself');
  assert.ok(c.families.includes('flash') && c.families.includes('pro'));
  assert.deepEqual(c.roles.chatPro, { kind: 'chat', family: 'pro' });
  models._reset();
});

// ── OpenAI / Anthropic classification ────────────────────────────────────────

test('openai: speech models are classified, not filtered out; chat noise is', () => {
  const list = [
    { id: 'gpt-4o', created: 100 }, { id: 'gpt-5.1-mini', created: 300 },
    { id: 'o3', created: 200 }, { id: 'whisper-1', created: 50 },
    { id: 'gpt-4o-transcribe', created: 250 }, { id: 'tts-1', created: 40 },
    { id: 'gpt-4o-mini-tts', created: 260 }, { id: 'text-embedding-3-large', created: 10 },
    { id: 'gpt-4o-realtime-preview', created: 270 }, { id: 'dall-e-3', created: 20 },
    { id: 'omni-moderation-latest', created: 30 },
  ];
  const out = list.map(openai.classify).filter(Boolean);
  const by = Object.fromEntries(out.map(e => [e.id, e]));
  assert.equal(by['gpt-4o'].kind, 'chat');
  assert.equal(by['gpt-4o'].family, 'gpt');
  assert.equal(by['gpt-5.1-mini'].family, 'mini');
  assert.equal(by['o3'].family, 'reasoning');
  assert.equal(by['whisper-1'].kind, 'stt');
  assert.equal(by['gpt-4o-transcribe'].kind, 'stt');
  assert.equal(by['tts-1'].kind, 'tts');
  assert.equal(by['gpt-4o-mini-tts'].kind, 'tts', 'a -tts id is speech even when it says mini');
  for (const bad of ['text-embedding-3-large', 'gpt-4o-realtime-preview', 'dall-e-3', 'omni-moderation-latest']) {
    assert.ok(!by[bad], `${bad} must not be offered`);
  }
  assert.equal(models.pickLatest(out.map(models.normalizeEntry), 'chat', 'gpt'), 'gpt-4o',
    'newest by created within the family');
});

// The one id where the two family rules collide, and the reason the o-series
// test has to run first. `o3-mini` is the cheap REASONING tier, not a cheap chat
// model. Classifying it on the 'mini' substring split the reasoning family in
// half and cost money in both directions: `auto:reasoning` could never land on
// the cheap reasoning model and always paid for the full o-series, while
// `auto:mini` mixed chat models with reasoning ones that bill for thinking
// tokens, so which you got came down to release dates.
test('openai: the o-mini line is the cheap REASONING tier, not the mini chat tier', () => {
  const list = [
    { id: 'o3-mini', created: 400 }, { id: 'o1-mini', created: 100 },
    { id: 'o4-mini', created: 500 }, { id: 'o3', created: 300 },
    { id: 'gpt-4o-mini', created: 450 }, { id: 'gpt-5.1-nano', created: 460 },
  ];
  const out = list.map(openai.classify).filter(Boolean);
  const by = Object.fromEntries(out.map(e => [e.id, e]));
  for (const id of ['o3-mini', 'o1-mini', 'o4-mini', 'o3']) {
    assert.equal(by[id].family, 'reasoning', `${id} is a reasoning model`);
  }
  for (const id of ['gpt-4o-mini', 'gpt-5.1-nano']) {
    assert.equal(by[id].family, 'mini', `${id} is a cheap CHAT model`);
  }
  const entries = out.map(models.normalizeEntry);
  assert.equal(models.pickLatest(entries, 'chat', 'reasoning'), 'o4-mini',
    'auto:reasoning must be able to reach the cheap reasoning tier');
  // The newest of the two cheap CHAT models, and the claim worth pinning is not
  // which of them wins on a timestamp — it is that no o-series id can be in this
  // pool at all, because those bill for thinking tokens nobody asked for.
  const mini = models.pickLatest(entries, 'chat', 'mini');
  assert.equal(mini, 'gpt-5.1-nano', 'newest within the cheap chat family');
  assert.doesNotMatch(mini, /^o\d/, 'auto:mini must never hand back a reasoning model');
});

test('anthropic: the family is the tier the user pays for, and auto stays inside it', () => {
  const list = [
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-05-01T00:00:00Z' },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-04-01T00:00:00Z' },
    { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-01T00:00:00Z' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
  ];
  const out = list.map(anthropic.classify).map(models.normalizeEntry);
  assert.equal(models.pickLatest(out, 'chat', 'sonnet'), 'claude-sonnet-5');
  assert.equal(models.pickLatest(out, 'chat', 'haiku'), 'claude-haiku-4-5');
  assert.equal(models.pickLatest(out, 'chat', ''), 'claude-opus-5', 'no family → simply the newest');
  assert.equal(out.find(e => e.id === 'claude-opus-5').label, 'Claude Opus 5');
});

test('anthropic: a missing created_at falls back to list order, not to zero', () => {
  const out = [{ id: 'claude-sonnet-9' }, { id: 'claude-sonnet-8' }]
    .map(anthropic.classify).map(models.normalizeEntry);
  assert.equal(models.pickLatest(out, 'chat', 'sonnet'), 'claude-sonnet-9',
    'the API returns newest first; that order must survive a missing stamp');
});

// …and the other half, which the test above cannot see because every entry in it
// is unstamped. pickLatest sorts ONE flat list descending, so the fallback has to
// live BELOW every real timestamp, not above it. It used to be
// `MAX_SAFE_INTEGER - index` (~9e15) against epoch ms (~1.7e12), so one beta
// shipped without a stamp would have outranked every dated model in its family
// and become the answer to `auto` — the exact stale-vs-current mismatch this
// resolver exists to prevent.
test('anthropic: an unstamped entry never outranks a dated one', () => {
  const out = [
    { id: 'claude-sonnet-9-beta' },
    { id: 'claude-sonnet-5', created_at: '2026-04-01T00:00:00Z' },
    { id: 'claude-sonnet-4-5', created_at: '2025-09-01T00:00:00Z' },
  ].map(anthropic.classify).map(models.normalizeEntry);
  assert.equal(models.pickLatest(out, 'chat', 'sonnet'), 'claude-sonnet-5',
    'a dated model must win, whatever position the unstamped one holds');
  // Position must not rescue it either: first in the list is the strongest case.
  const first = out.find(e => e.id === 'claude-sonnet-9-beta');
  const dated = out.find(e => e.id === 'claude-sonnet-4-5');
  assert.ok(first.rank < dated.rank, 'the fallback rank must sit below every stamp');
  // It stays selectable BY HAND — this is about what `auto` may land on, not
  // about hiding a model from the picker.
  assert.ok(Number.isFinite(first.rank), 'an unstamped entry must survive normalizeEntry');
});

// ── The Ollama download catalog (remote, therefore untrusted) ────────────────

test('the shipped catalog is valid against its own validator', () => {
  const shipped = JSON.parse(
    readFileSync(new URL('../../docs/community/ai-models.json', import.meta.url), 'utf8'));
  const out = models.normalizeCatalog(shipped);
  assert.equal(out.length, shipped.models.length, 'every shipped entry survives validation');
  for (const m of out) {
    assert.match(m.tag, /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$/);
    assert.ok(m.vramGB > 0 && m.ramGB > 0, `${m.tag} carries usable requirements`);
  }
});

test('a hostile catalog cannot smuggle a path, a capability or a zero requirement', () => {
  const out = models.normalizeCatalog({
    models: [
      { tag: '../../etc/passwd' },
      { tag: 'ok:1b', capabilities: ['tools', 'root', 'exec'], vramGB: 0, ramGB: 1e9 },
      { tag: 'ok:1b', label: 'duplicate' },
      null, 'nope', { label: 'no tag at all' },
      { tag: 'Fine:2B', label: 'x'.repeat(500) },
    ],
  });
  assert.equal(out.length, 2, 'traversal, junk and the duplicate are dropped');
  const ok = out.find(m => m.tag === 'ok:1b');
  assert.deepEqual(ok.capabilities, ['tools'], 'unknown capabilities are dropped, not passed through');
  assert.equal(ok.vramGB, 0, 'an out-of-range requirement becomes "unknown", never a low bar');
  assert.equal(ok.ramGB, 0);
  assert.equal(out[1].tag, 'fine:2b', 'tags are lowercased');
  assert.ok(out[1].label.length <= 60);
});

test('the catalog is capped, so a large answer cannot become a large list', () => {
  const many = { models: Array.from({ length: 400 }, (_, i) => ({ tag: `m${i}:1b` })) };
  assert.ok(models.normalizeCatalog(many).length <= 60);
});

test('an unreachable catalog keeps the previous list instead of emptying it', async () => {
  models._reset();
  models._setOllamaFetch(async () => ({ notModified: false, text: JSON.stringify({ models: [{ tag: 'qwen3:4b' }] }), etag: 'v1' }));
  await models.refreshOllamaCatalog({ force: true });
  assert.equal(models.ollamaCatalog().length, 1);
  models._setOllamaFetch(async () => { throw new Error('offline'); });
  await models.refreshOllamaCatalog({ force: true });
  assert.equal(models.ollamaCatalog().length, 1, 'a failed refresh must not clear the list');
  models._reset();
});

test('ollamaRequirements answers only for a model the catalog actually sized', async () => {
  models._reset();
  models._setOllamaFetch(async () => ({
    notModified: false,
    text: JSON.stringify({ models: [{ tag: 'big:70b', vramGB: 48, ramGB: 96 }, { tag: 'nosize:1b' }] }),
    etag: '',
  }));
  await models.refreshOllamaCatalog({ force: true });
  assert.deepEqual(models.ollamaRequirements('big:70b'), { minVramGB: 48, minRamGB: 96 });
  assert.equal(models.ollamaRequirements('nosize:1b'), null, 'no figures → unknown, not zero');
  assert.equal(models.ollamaRequirements('never-heard-of:1b'), null);
  models._reset();
});

test('the catalog is fetched from the site over HTTPS, never from a local copy', () => {
  // The community-catalog invariant: docs/ is export-ignored from the release
  // zip, so a disk read would work in a checkout and be missing for every user.
  assert.match(models.OLLAMA_CATALOG_URL, /^https:\/\//);
  assert.ok(models.OLLAMA_CATALOG_URL.endsWith('/ai-models.json'));
});

'use strict';

// ── Xenon AI — Gemini provider (model catalog) ────────────────────────────
// Gemini is the default provider and was the only one without a module: its
// four model ids lived as constants in server.js, so a model Google published
// after a release was unreachable until the next update, and a `-preview` id
// Google retired became a hard failure. This module is the symmetric twin of
// ai-openai.js / ai-anthropic.js for the one job they already do well — asking
// the provider what it currently offers — plus the classification the resolver
// in ai-models.js ranks over.
//
// The chat/vision/TTS/Live REQUESTS still live in server.js; nothing here calls
// generateContent. This module only answers "which model id should that request
// name", which is why it is pure apart from the one listModels() fetch.
//
// Measured against the real API (Aug 2026, 53 models on a normal key), because
// every rule below is a rule about data that actually comes back:
//   • Almost all non-chat noise (gemma, imagen, veo, lyria, aqa, nano-banana,
//     antigravity, deep-research) does NOT start with `gemini-`, so that prefix
//     alone is most of the filter. The rest is excluded by segment below.
//   • Google publishes moving aliases (`gemini-flash-latest`, `gemini-pro-latest`)
//     that carry no version in the id. They are offered as explicit pins and are
//     the OFFLINE defaults — an alias cannot rot the way a pinned version can —
//     but they are never the result of `auto`, because a resolved id the user
//     cannot read back is a setting that explains nothing.
//   • `gemini-3.5-pro`, the id server.js used for "advanced reasoning", is NOT in
//     the list at all. It had been silently falling back to the flash model on
//     every turn. That is the failure this module exists to make impossible.

const DEFAULTS = Object.freeze({
  // Offline / cold-cache fallbacks. Deliberately Google's own moving aliases for
  // chat: when we have no list to rank, the best answer is the pointer Google
  // maintains, not a version number frozen at whatever was current the day this
  // line was written. TTS and Live have no alias, so they name a concrete id.
  chat: 'gemini-flash-latest',
  chatPro: 'gemini-pro-latest',
  tts: 'gemini-3.1-flash-tts-preview',
  live: 'gemini-3.1-flash-live-preview',
});

// The four ROLES a Gemini id can be selected for, each mapping to the model
// `kind` that can fill it plus the family `auto` means when the user did not
// name one. Chat and advanced reasoning are the same kind on two families —
// which is exactly why a role is not a kind.
const ROLES = Object.freeze({
  chat:    { kind: 'chat', family: 'flash' },
  chatPro: { kind: 'chat', family: 'pro' },
  tts:     { kind: 'tts',  family: 'flash' },
  live:    { kind: 'live', family: 'flash' },
});

// Order matters: 'flash-lite' must be tested before 'flash', or every Lite model
// classifies as Flash and `auto:flash` starts resolving to the cheaper tier.
const FAMILIES = Object.freeze(['flash-lite', 'flash', 'pro']);

// `gemini-`-prefixed ids that are not general-purpose models for any of our four
// roles. Each is a real id from the live list, not a hypothetical.
const EXCLUDED_SEGMENTS = Object.freeze([
  'image',        // gemini-3.1-flash-image, gemini-3-pro-image…
  'embedding',    // gemini-embedding-2
  'robotics',     // gemini-robotics-er-2-preview
  'computer-use', // gemini-2.5-computer-use-preview-10-2025
  'translate',    // gemini-3.5-live-translate-preview — Live, but only translates
  'customtools',  // gemini-3.1-pro-preview-customtools — its own tool protocol
]);

const SENTINEL_RE = /^auto(?::[a-z0-9.-]{1,24})?$/;

// A stored model value is either a concrete id or the `auto` / `auto:<family>`
// sentinel that ai-models.js resolves. Anything else falls back to `auto`, which
// is the safe answer: it always resolves to something that exists.
//
// The sentinel is tested CASE-FOLDED, and the folded form is what gets stored, so
// there is one spelling of it on disk. Without the fold, `AUTO` fell through to
// the id pattern below — which is case-insensitive — and was kept as a literal
// pin on a model no provider has. See parseStored() in ai-models.js for the full
// account of why that could never repair itself.
function sanitizeModel(value) {
  const v = String(value || '').trim();
  const low = v.toLowerCase();
  if (SENTINEL_RE.test(low)) return low;
  if (v.length > 0 && v.length <= 60 && /^[a-z0-9._-]+$/i.test(v)) return v;
  return 'auto';
}

// Numeric version out of the id (`gemini-3.7-flash` → 3.7, `gemini-3-flash-preview`
// → 3). Null for the moving aliases and for ids that carry no version, which is
// what keeps them out of the ranking. NOT read from the `version` field: that is
// free-form ("001", "3.7-flash-08-2026", "Gemini Flash Latest") and comparing it
// across models means comparing three different formats.
function versionOf(id) {
  const m = /^gemini-(\d+(?:\.\d+)?)-/.exec(id);
  return m ? Number(m[1]) : null;
}

function familyOf(id) {
  for (const f of FAMILIES) if (id.includes('-' + f)) return f;
  return '';
}

// The role a model can play, from what the API says it supports plus the id. One
// kind per model: nothing in the live list is usable for two of our four roles.
function kindOf(id, methods) {
  const m = Array.isArray(methods) ? methods : [];
  if (m.includes('bidiGenerateContent')) return 'live';
  if (id.includes('-tts')) return 'tts';           // both -tts-preview and -preview-tts
  if (m.includes('embedContent')) return 'embed';
  if (!m.includes('generateContent')) return '';   // predict / predictLongRunning / generateAnswer
  return 'chat';
}

// Normalize one API entry into the shape ai-models.js ranks and the picker
// renders. `rank` is this provider's recency scalar (see the sibling modules:
// OpenAI uses `created`, Anthropic uses list order). Returns null for anything
// we will not offer for any role.
function classify(entry) {
  const raw = entry && typeof entry.name === 'string' ? entry.name : '';
  const id = raw.replace(/^models\//, '');
  if (!id || !id.startsWith('gemini-')) return null;
  if (EXCLUDED_SEGMENTS.some(seg => id.includes(seg))) return null;
  const kind = kindOf(id, entry.supportedGenerationMethods);
  if (!kind || kind === 'embed') return null;
  const version = versionOf(id);
  return {
    id,
    label: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : id,
    kind,
    family: familyOf(id),
    rank: version,                 // null → listed as a pin, never chosen by auto
    preview: /-(?:preview|exp)\b/.test(id),
    alias: version === null,
  };
}

// Live models are the one role where "newest in the family" is not enough on its
// own: the bidi list also carries specialised models (translation, robotics) that
// would outrank the assistant model on version alone. EXCLUDED_SEGMENTS removes
// them; this keeps the remaining requirement explicit — a Live model we drive
// must be a flash-family conversational one.
function usableForKind(entry, kind) {
  if (!entry || entry.kind !== kind) return false;
  if (kind === 'live') return entry.id.includes('flash');
  return true;
}

// ── Live list ────────────────────────────────────────────────────────────────

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function _httpError(status, bodyText) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j && j.error && j.error.message) || ''; } catch { /* not JSON */ }
  let err;
  if (status === 400 || status === 401 || status === 403) {
    err = new Error('Gemini: the API key is invalid or has no access. Check it in Settings → Xenon AI.');
    err.code = 'bad_key';
  } else if (status === 429) {
    err = new Error('Gemini: too many requests (rate limit).');
    err.code = 'rate_limited';
  } else {
    err = new Error('Gemini: HTTP error ' + status + (detail ? ' — ' + detail : ''));
    err.code = 'gemini_http';
  }
  return err;
}

// List the models this key can reach, classified. Paginated: the live list is
// already 53 entries and pageSize is capped, so a single page would silently
// truncate exactly the newest models at the end of it.
async function listModels({ apiKey, fetchImpl } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const doFetch = fetchImpl || fetch;
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const url = `${BASE}/models?pageSize=200&key=${encodeURIComponent(key)}`
      + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try { res = await doFetch(url, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!res.ok) throw _httpError(res.status, await res.text().catch(() => ''));
    const j = await res.json();
    for (const m of (Array.isArray(j && j.models) ? j.models : [])) {
      const c = classify(m);
      if (c) out.push(c);
    }
    pageToken = (j && typeof j.nextPageToken === 'string') ? j.nextPageToken : '';
    if (!pageToken) break;
  }
  return out;
}

module.exports = {
  DEFAULTS,
  ROLES,
  FAMILIES,
  sanitizeModel,
  classify,
  usableForKind,
  versionOf,
  familyOf,
  kindOf,
  listModels,
};

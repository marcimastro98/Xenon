'use strict';
// The models the user's OpenAI key can use, each sorted into what it is for.

const { OPENAI_BASE, _httpError } = require('./openai-http.js');

// Classify one /models entry into the shape ai-models.js ranks over. OpenAI's
// list is a flat set of ids with a `created` stamp and no capability metadata, so
// the role has to be read off the id — but only the SPEECH roles need pattern
// matching, since a transcription or speech model says so in its name
// (whisper-1, gpt-4o-transcribe, tts-1, gpt-4o-mini-tts). Returns null for
// everything we do not drive (embeddings, images, moderation, realtime, the
// audio-in-chat variants that speak a different request shape).
function classify(m) {
  const id = m && typeof m.id === 'string' ? m.id : '';
  if (!id) return null;
  const low = id.toLowerCase();
  const rank = Number(m.created) || 0;
  const preview = /preview/.test(low);
  const base = { id, label: id, rank, preview, alias: false };

  if (/whisper|transcribe/.test(low)) return { ...base, kind: 'stt', family: '' };
  if (/(^|-)tts(-|$)/.test(low)) return { ...base, kind: 'tts', family: '' };
  if (/(embedding|image|dall|moderation|realtime|audio|search|instruct|codex)/.test(low)) return null;
  if (!/^(gpt-|o\d|chatgpt)/.test(low)) return null;
  // Families a user would actually ask for: the flagship line, the cheap line,
  // and the reasoning line. A version number is not a family — it is what `auto`
  // is allowed to move across.
  //
  // The o-series test runs FIRST, and the order is the whole rule. `o3-mini` is
  // the cheap REASONING tier, not a cheap chat model, so matching the 'mini'
  // substring first put the entire o-mini line in `mini` and split the reasoning
  // family in half: `o1/o3/o4` in one place, `o1-mini/o3-mini/o4-mini` in
  // another. It cost twice over, and both costs are money. `auto:reasoning`
  // could never land on the cheap reasoning model and always paid for the full
  // o-series; `auto:mini` mixed chat models with reasoning ones that bill for
  // thinking tokens, so which of the two a user got came down to release dates.
  const family = /^o\d/.test(low) ? 'reasoning'
    : (/(mini|nano|small)/.test(low) ? 'mini' : 'gpt');
  return { ...base, kind: 'chat', family };
}

// List the models available to this key, classified. Powers the model picker so
// it always reflects what OpenAI currently offers — no hardcoded list to keep up
// to date — and feeds the `auto` resolution in ai-models.js.
async function listModels({ apiKey }) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(OPENAI_BASE + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw _httpError(res.status, await res.text().catch(() => ''));
  const j = await res.json();
  const data = Array.isArray(j && j.data) ? j.data : [];
  return data.map(classify).filter(Boolean).sort((a, b) => b.rank - a.rank);
}

module.exports = { classify, listModels };

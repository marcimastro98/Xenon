'use strict';
// The Claude models the user's Anthropic key can use, each sorted into its family.

const { ANTHROPIC_VERSION, _httpError } = require('./anthropic-http.js');

const FAMILIES = Object.freeze(['opus', 'sonnet', 'haiku']);

// Classify one /models entry. Anthropic hands back an explicit `created_at`, so
// recency needs no guessing from the id — only the family does, and that is the
// one part of a Claude id that has been stable across every generation.
function classify(m, index) {
  const id = m && typeof m.id === 'string' ? m.id : '';
  if (!id) return null;
  const low = id.toLowerCase();
  const family = FAMILIES.find(f => low.includes(f)) || '';
  // created_at is an ISO string; fall back to list position (the API returns
  // newest first) so a missing stamp still ranks in the right order among the
  // other unstamped entries.
  //
  // NEGATIVE, not `MAX_SAFE_INTEGER - index`. Both order the unstamped group the
  // same way, but pickLatest sorts ONE flat list descending, and ~9e15 beats
  // every epoch-ms stamp (~1.7e12) — so a single beta shipped without a stamp
  // would outrank every dated model in its family and become the answer to
  // `auto`, which is precisely the stale-vs-current mismatch this resolver
  // exists to prevent. Below zero, an unstamped entry ranks against its own kind
  // and loses to anything dated, which is the only claim list position supports.
  // Anthropic stamps every entry today, so this is a guard, not a repair.
  const stamp = Date.parse(m.created_at || '');
  const rank = Number.isFinite(stamp) ? stamp : -(index || 0);
  return {
    id,
    label: typeof m.display_name === 'string' && m.display_name ? m.display_name : id,
    kind: 'chat',
    family,
    rank,
    preview: /preview|beta/.test(low),
    alias: /latest$/.test(low),
  };
}

// List the models available to this key, classified. Powers the model picker so
// it always reflects what Anthropic currently offers, and feeds the `auto`
// resolution in ai-models.js.
async function listModels({ apiKey }) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }, signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw _httpError(res.status, await res.text().catch(() => ''));
  const j = await res.json();
  const data = Array.isArray(j && j.data) ? j.data : [];
  // The API already returns newest first; classify() keeps that order via rank.
  return data.map(classify).filter(Boolean);
}

module.exports = { FAMILIES, classify, listModels };

// Xenon AI app-knowledge base — makes the assistant an expert on Xenon ITSELF,
// not just an operator of its tools. Two grounding surfaces, both read-only:
//
//   lookup(query)          → curated topic cards (setup, features, troubleshooting)
//   getSdkReference(section) → the Widget SDK reference, parsed live from
//                              docs/WIDGET_SDK.md + the code-authoritative enums
//                              in sdk-widgets.js (so it can never drift from the
//                              real allowlists).
//
// Topic bodies are written in English on purpose: the system prompt already
// orders the model to answer in the user's language, and one language keeps the
// cards reviewable. Keep each body a compact paragraph — the card is grounding
// for the model, not text to be read aloud verbatim.

const fs = require('fs');
const path = require('path');

const SDK_DOC = path.join(__dirname, '..', 'docs', 'WIDGET_SDK.md');
const SECTION_MAX_CHARS = 12000;   // per-section cap when returning doc text
const RESULT_TOPICS_MAX = 2;       // lookup returns at most this many full cards

const { TOPICS } = require('./ai/knowledge-topics.js');

// ── Topic lookup ─────────────────────────────────────────────────────────────
// Lowercase + strip combining diacritics (u0300-u036f) so "perché" matches "perche".
const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function topicIndex() {
  return TOPICS.map((t) => ({ topic: t.id, title: t.title }));
}

// Score a topic against normalized query words: exact-id and keyword hits weigh
// most, then title words, then body words. Deterministic, no fuzzing.
function scoreTopic(topic, qWords) {
  let score = 0;
  const title = norm(topic.title);
  const body = norm(topic.body);
  for (const w of qWords) {
    if (w.length < 3) continue;
    if (topic.id === w) score += 10;
    if (topic.keywords.some((k) => k === w)) score += 6;
    else if (topic.keywords.some((k) => k.includes(w) || w.includes(k))) score += 3;
    if (title.includes(w)) score += 2;
    if (body.includes(w)) score += 1;
  }
  return score;
}

function lookup(query) {
  const q = norm(query).trim();
  // Bare call or unmatchable query → give the model the map so it can re-ask.
  if (!q) return { ok: true, topics: topicIndex(), note: 'Call again with a topic id or a more specific query to get the full card.' };
  const exact = TOPICS.find((t) => t.id === q);
  if (exact) return { ok: true, results: [{ topic: exact.id, title: exact.title, body: exact.body }] };
  const qWords = q.split(/[^a-z0-9]+/).filter(Boolean);
  const scored = TOPICS
    .map((t) => ({ t, score: scoreTopic(t, qWords) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, RESULT_TOPICS_MAX);
  if (!scored.length) {
    return { ok: true, results: [], topics: topicIndex(), note: 'No topic matched. Pick the closest topic id from the list, or answer from general knowledge and say when you are unsure.' };
  }
  return { ok: true, results: scored.map(({ t }) => ({ topic: t.id, title: t.title, body: t.body })) };
}

// ── Widget SDK reference (docs/WIDGET_SDK.md + code enums) ──────────────────
// The doc is the authority for prose/protocol, sdk-widgets.js for the enums —
// same split the sdk-docs-sync test already enforces, so nothing here can drift.
let _docCache = null; // { mtimeMs, sections: [{ id, title, level, text }] }

function parseSections(md) {
  // The doc may carry CRLF line endings — strip the \r or headings never match.
  const lines = md.split('\n').map((l) => l.replace(/\r$/, ''));
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      current = { title: m[2].trim(), level: m[1].length, text: '' };
      current.id = norm(current.title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      sections.push(current);
      continue;
    }
    if (current) current.text += line + '\n';
  }
  return sections;
}

async function readDocSections() {
  try {
    const st = await fs.promises.stat(SDK_DOC);
    if (_docCache && _docCache.mtimeMs === st.mtimeMs) return _docCache.sections;
    const md = await fs.promises.readFile(SDK_DOC, 'utf8');
    _docCache = { mtimeMs: st.mtimeMs, sections: parseSections(md) };
    return _docCache.sections;
  } catch {
    return null;
  }
}

async function getSdkReference(section) {
  // The enums come from the code so they are correct even if the doc is absent.
  const { SDK_STREAMS, SDK_ACTION_CATEGORIES } = require('./sdk-widgets.js');
  const base = { ok: true, streams: SDK_STREAMS, actionCategories: SDK_ACTION_CATEGORIES };
  const sections = await readDocSections();
  const want = norm(section).trim();
  if (!want) {
    return {
      ...base,
      sections: sections ? sections.map((s) => ({ id: s.id, title: s.title })) : [],
      note: 'Call again with a section id/title for the full text of that part of the SDK docs (protocol messages, manifest fields, storage, secrets, fetch proxy…).',
    };
  }
  if (!sections) return { ...base, error: 'docs_unavailable', note: 'docs/WIDGET_SDK.md is missing; the streams/actionCategories enums above are still authoritative.' };
  const hit = sections.find((s) => s.id === want)
    || sections.find((s) => norm(s.title).includes(want) || s.id.includes(want.replace(/[^a-z0-9]+/g, '-')));
  if (!hit) {
    return { ...base, error: 'section_not_found', sections: sections.map((s) => ({ id: s.id, title: s.title })) };
  }
  return { ...base, section: { id: hit.id, title: hit.title, text: hit.text.trim().slice(0, SECTION_MAX_CHARS) } };
}

module.exports = { TOPICS, lookup, topicIndex, getSdkReference, _parseSections: parseSections };

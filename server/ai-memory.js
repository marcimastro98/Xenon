'use strict';

// ── AI persistent memory — durable facts Xenon remembers about the user ──────
// A small, local, plain-text store of facts the user asked Xenon to remember
// (their name, hardware, preferences, favourite teams, habits…). It is injected
// into the AI system prompt every turn, so the assistant "knows" the user across
// sessions and page reloads — the single biggest thing the old in-RAM-only,
// 40-turn conversation history could never do.
//
// Fully local and private: the user can view and clear it in Settings → Funzioni
// AI, and disable the feature entirely. Written with the same temp-file +
// atomic-rename discipline as every other durable store — a crash mid-write must
// never truncate the file (the documented cause of past data loss).

const fs = require('fs');
const path = require('path');

const MAX_FACTS = 100;        // hard cap — the oldest fact is dropped past this
const MAX_FACT_LEN = 240;     // per-fact character cap
const MAX_PROMPT_FACTS = 60;  // most-recent N injected into the prompt each turn

function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FACT_LEN);
}

// A loose key for dedup: lowercased alphanumerics only, so "I have an RTX 4090"
// and "i have an  RTX-4090!" collapse to the same fact and are not stored twice.
function dedupKey(text) {
  return normalizeText(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function createAiMemory({ dataDir, now = Date.now }) {
  const FILE = path.join(dataDir, 'ai-memory.json');
  let facts = null;                 // lazy-loaded cache: [{ id, text, ts }]
  let idCounter = 0;
  let writing = Promise.resolve();  // serialize concurrent writers to FILE

  function genId() {
    idCounter += 1;
    return `f${now().toString(36)}${idCounter.toString(36)}`;
  }

  function load() {
    if (facts) return facts;
    try {
      const raw = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.facts) ? parsed.facts : []);
      facts = arr
        .map((f) => (f && typeof f === 'object')
          ? { id: String(f.id || ''), text: normalizeText(f.text), ts: Number(f.ts) || 0 }
          : { id: '', text: normalizeText(f), ts: 0 })
        .filter((f) => f.text)
        .map((f) => ({ id: f.id || genId(), text: f.text, ts: f.ts }))
        .slice(-MAX_FACTS);
    } catch {
      facts = []; // missing / corrupt file → start empty (never throw on load)
    }
    return facts;
  }

  function persist() {
    const snapshot = JSON.stringify({ facts: load() });
    writing = writing.then(async () => {
      const tmp = `${FILE}.${process.pid}.tmp`;
      try {
        await fs.promises.mkdir(dataDir, { recursive: true });
        await fs.promises.writeFile(tmp, snapshot, 'utf8');
        await fs.promises.rename(tmp, FILE);
      } catch {
        try { await fs.promises.unlink(tmp); } catch { /* nothing to clean up */ }
      }
    });
    return writing;
  }

  function list() {
    return load().map((f) => ({ id: f.id, text: f.text, ts: f.ts }));
  }

  function count() {
    return load().length;
  }

  // Store a new fact. Duplicates (by loose key) are not re-stored; instead the
  // existing fact is refreshed to the end so it survives the cap the longest.
  async function add(text) {
    const clean = normalizeText(text);
    if (!clean) return { ok: false, error: 'empty' };
    const store = load();
    const key = dedupKey(clean);
    const existingIdx = store.findIndex((f) => dedupKey(f.text) === key);
    if (existingIdx !== -1) {
      const [existing] = store.splice(existingIdx, 1);
      existing.ts = now();
      store.push(existing);
      await persist();
      return { ok: true, duplicate: true, id: existing.id, text: existing.text };
    }
    const fact = { id: genId(), text: clean, ts: now() };
    store.push(fact);
    while (store.length > MAX_FACTS) store.shift(); // drop the oldest
    await persist();
    return { ok: true, id: fact.id, text: fact.text };
  }

  // Remove by exact id, else by loose-key equality, else by substring match on
  // the fact text (so "forget my RTX" can drop "I have an RTX 4090").
  async function remove(query) {
    const store = load();
    const q = normalizeText(query);
    if (!q) return { ok: false, error: 'empty' };
    const key = dedupKey(q);
    let idx = store.findIndex((f) => f.id === query);
    if (idx === -1) idx = store.findIndex((f) => dedupKey(f.text) === key);
    if (idx === -1) idx = store.findIndex((f) => f.text.toLowerCase().includes(q.toLowerCase()));
    if (idx === -1) return { ok: false, error: 'not_found' };
    const [removed] = store.splice(idx, 1);
    await persist();
    return { ok: true, removed: removed.text };
  }

  async function clear() {
    load().length = 0;
    await persist();
    return { ok: true };
  }

  // The block injected into the AI system prompt. Empty string when there is
  // nothing remembered, so it adds zero tokens for a brand-new user.
  function formatForPrompt() {
    const store = load();
    if (!store.length) return '';
    const recent = store.slice(-MAX_PROMPT_FACTS);
    const lines = recent.map((f) => `- ${f.text}`).join('\n');
    return ' PERSISTENT MEMORY — things you already know about this user from earlier'
      + ' conversations (treat as true unless they correct you; use naturally, do NOT'
      + ` recite them unprompted):\n${lines}\n`
      + ' When the user tells you something durable worth remembering about them (their'
      + ' name, hardware, preferences, favourite teams, routines, how they like things),'
      + ' call remember_fact with a short third-person fact. When they ask you to forget'
      + ' something, call forget_fact. Do NOT store secrets, passwords, or one-off task'
      + ' details, and do NOT re-store something already listed above.';
  }

  // Prompt guidance for a user who has memory ON but nothing stored yet, so the
  // model still knows the capability exists and will start using it.
  function emptyPromptHint() {
    return ' PERSISTENT MEMORY is enabled but empty. When the user shares something'
      + ' durable about themselves (name, hardware, preferences, favourite teams,'
      + ' routines), call remember_fact with a short third-person fact so you recall it'
      + ' next time. Do NOT store secrets, passwords, or one-off task details.';
  }

  return { load, list, count, add, remove, clear, formatForPrompt, emptyPromptHint };
}

module.exports = { createAiMemory, normalizeText, dedupKey, MAX_FACTS, MAX_FACT_LEN };

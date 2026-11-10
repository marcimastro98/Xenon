'use strict';

// ── Widget SDK: questions to the user's AI ──────────────────────────────────
// A package granted `ai` may ask the AI the user set for Bit (Sparks, their own
// key, Ollama or their Claude/ChatGPT plan) one plain question at a time. Every
// question may cost the user money or plan quota, so this module keeps it small
// and visible:
//   • the question and the instructions are bounded, and so is the answer;
//   • one question per package at a time;
//   • a daily number of questions per package, chosen by the user
//     (sdkAiDailyCap), counted in DATA_DIR/sdk-ai-usage.json so a restart does
//     not hand a widget a fresh day.
// The caller (server.js) checks the grant and supplies `complete()` (the same
// one Lyrics translates with) and `blocker()`. No tools and no history: the
// model sees only what the widget sends.

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');

const USAGE_FILE = 'sdk-ai-usage.json';
const PROMPT_MAX = 8000;
const SYSTEM_MAX = 2000;
const ANSWER_MAX = 16000;
const DEFAULT_MAX_TOKENS = 400;
const MAX_TOKENS_CAP = 1024;
const MIN_TOKENS = 16;
const DAILY_CAPS = Object.freeze([20, 50, 100, 200]);
const DEFAULT_DAILY_CAP = 50;
const PKG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Rows kept in the usage file; the install cap is 32 packages.
const MAX_PACKAGES = 64;

// Ahead of the widget's own instructions, so every provider answers the same way.
const FRAME = 'You answer a question from a widget on the user\'s Xenon dashboard. Reply with the answer only, in plain text unless the instructions ask for JSON. You have no tools and no memory of earlier questions.';

// Control characters other than tab and line breaks.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g; // eslint-disable-line no-control-regex

function cleanDailyCap(v) {
  const n = Number(v);
  return DAILY_CAPS.includes(n) ? n : DEFAULT_DAILY_CAP;
}

const cleanText = (v) => v.replace(CONTROL, ' ').trim();

// The widget's message → what is sent, or { error }. Text over a limit is
// refused rather than cut: half a question gets a wrong answer the user pays for.
function normalizeAsk(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  if (typeof m.prompt !== 'string' || !m.prompt.trim()) return { error: 'bad_prompt' };
  if (m.prompt.length > PROMPT_MAX) return { error: 'too_long' };
  if (m.system != null && typeof m.system !== 'string') return { error: 'bad_prompt' };
  if (typeof m.system === 'string' && m.system.length > SYSTEM_MAX) return { error: 'too_long' };
  const n = Number(m.maxTokens);
  const maxTokens = m.maxTokens != null && Number.isFinite(n)
    ? Math.min(MAX_TOKENS_CAP, Math.max(MIN_TOKENS, Math.round(n)))
    : DEFAULT_MAX_TOKENS;
  const own = typeof m.system === 'string' ? cleanText(m.system) : '';
  return {
    prompt: cleanText(m.prompt),
    system: own ? FRAME + '\n\n' + own : FRAME,
    maxTokens,
    json: m.json === true,
  };
}

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The codes a widget can be told. Anything a provider throws becomes 'failed':
// its message can carry a key, a host or a model id.
function errorCode(e) {
  const code = e && e.code;
  return code === 'no_credits' || code === 'busy' || code === 'rate_limited' ? code : 'failed';
}

function createSdkAi({ dataDir, complete, blocker, now = Date.now, writeFile = writeFileAtomic, onError } = {}) {
  const usageFile = dataDir ? path.join(dataDir, USAGE_FILE) : '';
  const inflight = new Set();
  let usage = null;

  async function load() {
    if (usage) return usage;
    let raw = null;
    if (usageFile) {
      try { raw = JSON.parse(await fsp.readFile(usageFile, 'utf8')); } catch { /* absent: a fresh day */ }
    }
    const counts = {};
    const src = raw && raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts) ? raw.counts : {};
    for (const [id, n] of Object.entries(src).slice(0, MAX_PACKAGES)) {
      if (PKG_RE.test(id) && Number.isSafeInteger(n) && n > 0) counts[id] = n;
    }
    usage = { day: raw && typeof raw.day === 'string' ? raw.day.slice(0, 10) : dayOf(now()), counts };
    return usage;
  }

  async function today() {
    const u = await load();
    const day = dayOf(now());
    if (u.day !== day) Object.assign(u, { day, counts: {} });
    return u;
  }

  async function count(pkgId) {
    const u = await today();
    if (!(pkgId in u.counts) && Object.keys(u.counts).length >= MAX_PACKAGES) return;
    u.counts[pkgId] = (u.counts[pkgId] || 0) + 1;
    if (!usageFile) return;
    try { await writeFile(usageFile, JSON.stringify(u)); }
    catch { /* best effort: the count in memory still holds the cap this run */ }
  }

  // → { ok:true, text, left } or { ok:false, error }. `left` is how many
  // questions the package still has today.
  async function ask(pkgId, msg, cap) {
    if (typeof pkgId !== 'string' || !PKG_RE.test(pkgId)) return { ok: false, error: 'not_allowed' };
    const q = normalizeAsk(msg);
    if (q.error) return { ok: false, error: q.error };
    const blocked = await blocker();
    if (blocked) return { ok: false, error: blocked };
    if (inflight.has(pkgId)) return { ok: false, error: 'busy' };
    const limit = cleanDailyCap(cap);
    inflight.add(pkgId);
    try {
      const used = (await today()).counts[pkgId] || 0;
      if (used >= limit) return { ok: false, error: 'cap', cap: limit };
      let res = null;
      try {
        res = await complete({ system: q.system, user: q.prompt, maxTokens: q.maxTokens, json: q.json });
      } catch (e) {
        const code = errorCode(e);
        // A request that reached the provider counts even when it broke: it may
        // have been billed, and a widget retrying a broken provider in a loop
        // must still run into its day. An empty Sparks balance and a busy hub
        // charge nothing, so those are not counted.
        if (code === 'failed') {
          await count(pkgId);
          if (onError) onError(e);
        }
        return { ok: false, error: code };
      }
      await count(pkgId);
      const text = String((res && res.text) || '').trim().slice(0, ANSWER_MAX);
      if (!text) return { ok: false, error: 'failed' };
      return { ok: true, text, left: Math.max(0, limit - used - 1) };
    } finally {
      inflight.delete(pkgId);
    }
  }

  // Today's questions per package, for the Installed list.
  async function usageToday() {
    const u = await today();
    return { day: u.day, counts: { ...u.counts } };
  }

  return { ask, usageToday };
}

module.exports = {
  createSdkAi,
  normalizeAsk,
  cleanDailyCap,
  DAILY_CAPS,
  DEFAULT_DAILY_CAP,
  PROMPT_MAX,
  SYSTEM_MAX,
  MAX_TOKENS_CAP,
};

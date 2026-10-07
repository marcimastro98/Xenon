'use strict';

// ── "Ask ChatGPT" tile: conversations answered on the user's ChatGPT plan ────
// ChatGPT has no local or consumer API to read or continue its conversations.
// What the user's plan CAN be reached through, from a third-party app and with
// the provider's blessing, is OpenAI's own `codex` program signed in with that
// plan. So the tile asks through ai-cli.js's Codex path: the official program,
// run as published, read-only sandbox, ephemeral session, no user config, no
// tools of its own and none of Xenon's, API-key variables stripped. Answers do
// not appear in the user's ChatGPT history, and the tile says so.
//
// What lives here:
//   • the conversation store: DATA_DIR/chatgpt.json, written atomically and
//     bounded (MAX_CONVERSATIONS × MAX_MESSAGES, MAX_TEXT per message,
//     MAX_BYTES overall, oldest conversations dropped first). It is a CACHE of
//     the user's chats: a file that does not parse is moved aside and the store
//     starts empty instead of failing the tile. Never in settings.json (which
//     mirrors to every browser), never in a backup, never in the SDK.
//   • the runner: one turn per conversation at a time, answered off the request
//     path (the route returns at once and the answer arrives over SSE, so
//     nothing is held open for minutes across a LAN), cancellable (the child is
//     killed), and stopped in _gracefulShutdown.
//
// Every string is the user's or the model's text: the client renders the
// user's with textContent and the model's through the escaping markdown
// renderer, never as raw HTML.

const fs = require('fs');
const crypto = require('crypto');

const MAX_CONVERSATIONS = 40;
const MAX_MESSAGES = 60;
const MAX_TEXT = 24000;
const MAX_INPUT = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 80;
const HISTORY_MESSAGES = 24;   // what is sent back as context; ai-cli trims by size too
const ID_RE = /^c[0-9a-f]{16}$/;

const SYSTEM_TEXT = [
  'You are answering a person in a chat on their Xenon dashboard, through their own ChatGPT plan.',
  'Answer the question directly and in the language the person writes in.',
  'Use short paragraphs and Markdown lists or `code` where they help.',
  'You have no tools and no files here: do not offer to run commands or edit files.',
].join(' ');

function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}
function titleOf(text) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return line.length > MAX_TITLE ? line.slice(0, MAX_TITLE - 1) + '…' : line;
}
function newId() { return 'c' + crypto.randomBytes(8).toString('hex'); }
function isId(v) { return typeof v === 'string' && ID_RE.test(v); }

// ── the store ────────────────────────────────────────────────────────────────
function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : '';
  const text = clean(m.text, MAX_TEXT);
  if (!role || (!text && !m.error)) return null;
  const out = { role, text, at: Number.isFinite(m.at) ? m.at : 0 };
  if (role === 'assistant' && typeof m.error === 'string' && m.error) out.error = clean(m.error, 40);
  return out;
}
function normalizeConversation(c) {
  if (!c || typeof c !== 'object' || !isId(c.id)) return null;
  const messages = (Array.isArray(c.messages) ? c.messages : []).map(normalizeMessage).filter(Boolean).slice(-MAX_MESSAGES);
  if (!messages.length) return null;
  return {
    id: c.id,
    title: clean(c.title, MAX_TITLE) || titleOf(messages[0].text),
    createdAt: Number.isFinite(c.createdAt) ? c.createdAt : messages[0].at,
    updatedAt: Number.isFinite(c.updatedAt) ? c.updatedAt : messages[messages.length - 1].at,
    messages,
  };
}
// Newest first; then enforce the count and the byte budget, dropping the
// conversations touched longest ago.
function bound(list) {
  const sorted = list.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
  while (sorted.length > 1 && Buffer.byteLength(JSON.stringify(sorted)) > MAX_BYTES) sorted.pop();
  return sorted;
}

function createStore({ file, writeFileAtomic, now = Date.now }) {
  let convs = [];
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    let raw;
    try { raw = await fs.promises.readFile(file, 'utf8'); } catch { return; }
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j && j.conversations) ? j.conversations : [];
      convs = bound(list.map(normalizeConversation).filter(Boolean));
    } catch {
      // A cache that does not parse is set aside, not fatal and not silently lost.
      try { await fs.promises.rename(file, file + '.corrupt-' + now()); } catch { /* gone */ }
      convs = [];
    }
  }
  async function save() {
    convs = bound(convs);
    await writeFileAtomic(file, JSON.stringify({ version: 1, conversations: convs }));
  }
  function summary(c) {
    const last = c.messages[c.messages.length - 1];
    return { id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length, lastRole: last ? last.role : '' };
  }
  return {
    load,
    list() { return convs.map(summary); },
    get(id) { const c = convs.find((x) => x.id === id); return c ? JSON.parse(JSON.stringify(c)) : null; },
    has(id) { return convs.some((x) => x.id === id); },
    async start(text) {
      const t = now();
      const c = { id: newId(), title: titleOf(text), createdAt: t, updatedAt: t, messages: [{ role: 'user', text, at: t }] };
      convs.unshift(c);
      await save();
      return c.id;
    },
    async append(id, msg) {
      const c = convs.find((x) => x.id === id);
      if (!c) return false;
      const m = normalizeMessage(Object.assign({ at: now() }, msg));
      if (!m) return false;
      c.messages.push(m);
      if (c.messages.length > MAX_MESSAGES) c.messages = c.messages.slice(-MAX_MESSAGES);
      c.updatedAt = m.at;
      await save();
      return true;
    },
    async remove(id) {
      const before = convs.length;
      convs = convs.filter((x) => x.id !== id);
      if (convs.length !== before) await save();
      return convs.length !== before;
    },
    async clear() { convs = []; await save(); },
  };
}

// The conversation as ai-cli.js expects it (Gemini-style turns). Failed or
// cancelled replies are not context; the newest HISTORY_MESSAGES are.
function historyFor(conv) {
  return conv.messages
    .filter((m) => m.text && !m.error)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
}

// ── the runner ───────────────────────────────────────────────────────────────
// `chat(opts)` is ai-cli.js chat(); `model()` the user's pick ('default' lets
// Codex choose); `onChange(id)` repaints the tile.
function createAsker({ store, chat, model = () => 'default', onChange = () => {}, now = Date.now }) {
  const active = new Map();   // conversationId → { controller, startedAt }

  function emit(id) { try { onChange(id); } catch { /* listener */ } }

  async function ask({ conversationId, text }) {
    await store.load();
    const q = clean(text, MAX_INPUT);
    if (!q) return { ok: false, error: 'empty' };
    let id = conversationId;
    if (id != null && id !== '') {
      if (!isId(id) || !store.has(id)) return { ok: false, error: 'not_found' };
      if (active.has(id)) return { ok: false, error: 'busy' };
      await store.append(id, { role: 'user', text: q });
    } else {
      id = await store.start(q);
    }
    const controller = new AbortController();
    active.set(id, { controller, startedAt: now() });
    emit(id);
    run(id, controller).catch(() => {});
    return { ok: true, conversationId: id };
  }

  async function run(id, controller) {
    let reply;
    try {
      const conv = store.get(id);
      const r = await chat({ provider: 'codex', model: model(), systemText: SYSTEM_TEXT, history: historyFor(conv), signal: controller.signal });
      reply = { role: 'assistant', text: String(r && r.text || '') };
      if (!reply.text) reply = { role: 'assistant', text: '', error: 'cli_failed' };
    } catch (e) {
      const code = e && typeof e.code === 'string' ? e.code : 'cli_failed';
      reply = { role: 'assistant', text: '', error: code };
    }
    // The turn is over only once its reply is on disk, so a reload or another
    // screen never sees "not thinking" next to a conversation missing its answer.
    // A conversation deleted while it was answering stays deleted.
    try { if (store.has(id)) await store.append(id, reply); }
    finally { active.delete(id); emit(id); }
  }

  function cancel(id) {
    const a = active.get(id);
    if (!a) return false;
    a.controller.abort();
    return true;
  }
  async function remove(id) {
    cancel(id);
    await store.load();
    const ok = await store.remove(id);
    emit(id);
    return ok;
  }
  async function clear() {
    for (const id of active.keys()) cancel(id);
    await store.load();
    await store.clear();
    emit('');
  }
  function stopAll() { for (const a of active.values()) a.controller.abort(); }
  function snapshot() {
    const t = now();
    return Array.from(active.entries()).map(([id, a]) => ({ conversationId: id, forMs: t - a.startedAt }));
  }
  return { ask, cancel, remove, clear, stopAll, snapshot, get activeCount() { return active.size; } };
}

module.exports = {
  createStore, createAsker, historyFor, titleOf, isId,
  SYSTEM_TEXT, MAX_CONVERSATIONS, MAX_MESSAGES, MAX_TEXT, MAX_INPUT, MAX_BYTES,
};

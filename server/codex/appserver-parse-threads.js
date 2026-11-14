'use strict';
// Reads Codex's recent work: the list of threads with their state, and the messages of one
// thread with the text a person typed cleaned.

const path = require('node:path');
const { str } = require('./appserver-clamp.js');

const MAX_THREADS = 12;

function threadStatus(s) {
  const t = s && typeof s === 'object' ? s.type : '';
  if (t === 'active') {
    const flags = Array.isArray(s.activeFlags) ? s.activeFlags : [];
    return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'waiting' : 'active';
  }
  if (t === 'idle') return 'idle';
  if (t === 'systemError') return 'error';
  return 'saved';   // notLoaded: a conversation on disk, not open in this process
}
function threadSource(t) {
  const o = str(t.originator, 40).toLowerCase();
  if (/desktop|chatgpt/.test(o)) return 'app';
  const s = t.source;
  if (s === 'cli') return 'cli';
  if (s === 'vscode') return 'ide';
  if (s === 'exec') return 'exec';
  if (s && typeof s === 'object' && s.subAgent) return 'agent';
  return 'other';
}
// thread/list → the conversations Codex lists, most recently active first
// (asked by recency, and sorted again here: a copy that does not know the sort
// key lists by creation, which buried a busy old chat). Only the folder's
// last segment is kept: the full path is the user's disk layout and never needs
// to leave the PC to say "xenon". Ephemeral threads (Xenon AI's own one-shot
// turns among them) are not the user's work and are skipped.
function parseThreads(r) {
  const list = r && Array.isArray(r.data) ? r.data : [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || t.ephemeral === true) continue;
    const preview = cleanUserText(t.preview).text;
    const firstLine = str(preview.split(/\r?\n/).find((l) => l.trim()) || '', 120);
    const cwd = typeof t.cwd === 'string' ? t.cwd : '';
    const branch = t.gitInfo && typeof t.gitInfo === 'object' ? str(t.gitInfo.branch, 60) : '';
    const updated = Number.isFinite(t.recencyAt) ? t.recencyAt : t.updatedAt;
    out.push({
      id: str(t.id, 64),
      title: str(cleanUserText(t.name).text, 120) || firstLine,
      project: cwd ? str(path.basename(cwd.replace(/[\\/]+$/, '')), 60) : '',
      branch,
      model: str(t.model, 48),
      effort: str(t.reasoningEffort, 16),
      source: threadSource(t),
      status: threadStatus(t.status),
      updatedAt: Number.isFinite(updated) ? updated * 1000 : null,
    });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, MAX_THREADS);
}

// What a person typed, without what Codex wrapped around it. Two wrappers are
// measured on 0.160: an attachment block ("# Files mentioned by the user:" with
// one "## name: <absolute path>" per file, then "## My request for Codex:" and
// the request), and skill mentions written as markdown links to a local file
// ("[$xenon-creator](C:\\Users\\…\\SKILL.md)"). Both carry absolute paths, which
// stay on the PC: the request is kept, a link to anything that is not http(s)
// keeps only its label, and the attachments become a count.
function cleanUserText(raw) {
  let s = String(raw || '');
  let files = 0;
  const req = s.indexOf('## My request for Codex:');
  if (/^\s*# Files mentioned by the user:/.test(s)) {
    const head = req >= 0 ? s.slice(0, req) : s;
    files = (head.match(/^## [^\n]+$/gm) || []).length;
    s = req >= 0 ? s.slice(req + '## My request for Codex:'.length) : '';
  }
  // The target may contain spaces ("My Projects"): a local path is not a URL.
  s = s.replace(/\[([^\]\n]{1,120})\]\(([^)\n]{1,600})\)/g, (m, label, target) => (/^https?:\/\//i.test(target.trim()) ? m : label));
  return { text: s.trim(), files };
}

// thread/turns/list (itemsView "summary") → the conversation as a person reads
// it: each turn's request and Codex's final answer, oldest first. Tool calls,
// reasoning and command output are left out, the same choice the Claude tile's
// reader makes. Bounded per message and in count.
// A turn still running also shows Codex's interim notes ("commentary": what it
// is doing now) as `progress`; once the turn ends only its answer stays, the
// way Codex itself folds them away. The summary view has no commentary, so
// readThread swaps in the full items of a running turn.
const MAX_THREAD_MESSAGES = 30;
const MAX_MESSAGE_TEXT = 6000;
// Like str() but keeps line breaks: a message is paragraphs, a title is not.
function keepLines(v, n) {
  return String(v || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '').trim().slice(0, n);
}
function parseTurns(r) {
  const turns = r && Array.isArray(r.data) ? r.data.slice() : [];
  // Asked newest first so the limit keeps the recent end; shown oldest first.
  turns.sort((a, b) => (Number(a && a.startedAt) || 0) - (Number(b && b.startedAt) || 0));
  const out = [];
  for (const t of turns) {
    if (!t || !Array.isArray(t.items)) continue;
    const at = Number.isFinite(t.startedAt) ? t.startedAt * 1000 : null;
    for (const it of t.items) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'userMessage') {
        const parts = Array.isArray(it.content) ? it.content : [];
        let files = parts.filter((p) => p && (p.type === 'localImage' || p.type === 'image')).length;
        const text = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => {
          const c = cleanUserText(p.text);
          files = Math.max(files, c.files);
          return c.text;
        }).join('\n').trim();
        if (text || files) out.push({ role: 'user', text: keepLines(text, MAX_MESSAGE_TEXT), files, at });
      } else if (it.type === 'agentMessage' && typeof it.text === 'string' && it.text.trim()) {
        if (it.phase !== 'commentary') out.push({ role: 'assistant', text: keepLines(it.text, MAX_MESSAGE_TEXT), at });
        else if (t.status === 'inProgress') out.push({ role: 'progress', text: keepLines(it.text, MAX_MESSAGE_TEXT), at });
      }
    }
    if (t.status === 'failed' || t.status === 'interrupted') out.push({ role: 'note', text: t.status, at });
  }
  return out.slice(-MAX_THREAD_MESSAGES);
}

module.exports = {
  MAX_THREADS, threadStatus, threadSource, parseThreads, cleanUserText, MAX_THREAD_MESSAGES,
  MAX_MESSAGE_TEXT, keepLines, parseTurns,
};

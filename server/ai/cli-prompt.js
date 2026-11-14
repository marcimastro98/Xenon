'use strict';
// Turns the assistant's conversation into the one prompt a command-line provider takes, with
// the newest pictures in the form each program accepts.

const path = require('node:path');
const fsp = require('node:fs').promises;
const crypto = require('node:crypto');
const { MAX_PROMPT_CHARS } = require('./cli-limits.js');

// ── the conversation as one prompt ──────────────────────────────────────────
// Each turn is a fresh run of the program with nothing saved, so the thread so
// far travels in the prompt. Xenon's history is Gemini-shaped; only the words
// are carried, and an attachment is named rather than silently dropped.
function partText(p, forwarded) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.text === 'string') return p.text;
  if (forwarded && forwarded.has(p)) return '[an image is attached to this message]';
  if (p.inlineData) return /^image\//.test(String(p.inlineData.mimeType || '')) ? '[an image was attached, which this assistant cannot see]' : '[an attachment was included, which this assistant cannot read]';
  return '';
}
// Images of the message being answered travel to the program for real (Claude
// Code over its stream-json input, Codex as --image files); earlier turns keep
// the placeholder, as the history is only words. Capped so one paste cannot
// flood the child: type, count and size are checked here, where it enters.
const IMAGE_MIME_RE = /^image\/(?:png|jpeg|gif|webp)$/;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 10 * 1024 * 1024;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function latestImages(history) {
  const last = Array.isArray(history) ? history[history.length - 1] : null;
  if (!last || last.role === 'model' || !Array.isArray(last.parts)) return [];
  const out = [];
  for (const p of last.parts) {
    const d = p && p.inlineData;
    if (!d || !IMAGE_MIME_RE.test(String(d.mimeType || '')) || typeof d.data !== 'string') continue;
    if (!d.data || d.data.length > MAX_IMAGE_B64 || !B64_RE.test(d.data)) continue;
    out.push({ part: p, mimeType: d.mimeType, data: d.data });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}
function claudeImageInput(prompt, images) {
  const content = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } }));
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}
async function writeCodexImages(dir, images) {
  const base = path.join(dir, 'img-' + crypto.randomBytes(6).toString('hex'));
  const files = [];
  for (const [n, i] of images.entries()) {
    const f = base + '-' + n + '.' + (i.mimeType.split('/')[1] === 'jpeg' ? 'jpg' : i.mimeType.split('/')[1]);
    await fsp.writeFile(f, Buffer.from(i.data, 'base64'));
    files.push(f);
  }
  return files;
}
function buildPrompt(history, forwarded) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && Array.isArray(m.parts))
    .map((m) => ({ role: m.role === 'model' ? 'Assistant' : 'User', text: m.parts.map((p) => partText(p, forwarded)).filter(Boolean).join('\n').trim() }))
    .filter((t) => t.text);
  if (!turns.length) return '';
  const last = turns[turns.length - 1];
  const earlier = turns.slice(0, -1);
  if (!earlier.length) return last.text.slice(0, MAX_PROMPT_CHARS);
  const head = 'Earlier in this conversation (for context only):\n\n';
  const tail = '\n\n---\nThe user\'s new message:\n' + last.text;
  const budget = MAX_PROMPT_CHARS - head.length - tail.length;
  const lines = [];
  let used = 0;
  for (let i = earlier.length - 1; i >= 0; i--) {    // newest first, oldest dropped
    const line = earlier[i].role + ': ' + earlier[i].text;
    if (used + line.length + 2 > budget) break;
    lines.unshift(line); used += line.length + 2;
  }
  return lines.length ? head + lines.join('\n\n') + tail : last.text.slice(0, MAX_PROMPT_CHARS);
}

module.exports = {
  partText, IMAGE_MIME_RE, MAX_IMAGES, MAX_IMAGE_B64, B64_RE, latestImages, claudeImageInput,
  writeCodexImages, buildPrompt,
};

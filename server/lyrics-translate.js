'use strict';

// ── Lyrics translation: prompt and reply ─────────────────────────────────────
// Pure helpers, no I/O. The supporter Lyrics widget can show, under each line,
// a translation into the dashboard language and a Latin-letter reading for
// Japanese, Korean and Chinese. Both come from ONE request to the user's own AI
// provider per song (lyrics-translator.js), so the prompt is built to be cheap:
// only the distinct non-empty lines go out (a chorus sung four times is sent
// once) and the reply is a strict JSON shape that is validated line by line.

const MAX_UNIQUE_LINES = 300;
const MAX_INPUT_CHARS = 12000;
const MAX_OUT_CHARS = 400;

const LANG_NAMES = Object.freeze({
  it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Simplified Chinese',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', nl: 'Dutch',
});

// Kana, Hangul (syllables and jamo) and CJK ideographs: the scripts a reader
// may not be able to sound out.
const READING_RE = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ᄀ-ᇿ㄰-㆏가-힯]/;

function langName(lang) {
  return LANG_NAMES[lang] || '';
}

function needsReading(texts) {
  return Array.isArray(texts) && texts.some(t => typeof t === 'string' && READING_RE.test(t));
}

// The distinct non-empty lines, plus where each original line points into them
// (-1 for a pause line, which gets nothing under it).
function uniqueLines(texts) {
  const unique = [];
  const seen = new Map();
  const index = (Array.isArray(texts) ? texts : []).map((raw) => {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) return -1;
    if (!seen.has(t)) { seen.set(t, unique.length); unique.push(t); }
    return seen.get(t);
  });
  return { unique, index };
}

function fitsBudget(unique) {
  if (!unique.length || unique.length > MAX_UNIQUE_LINES) return false;
  return unique.reduce((n, t) => n + t.length, 0) <= MAX_INPUT_CHARS;
}

// Output budget: short lines, two short strings back per line at most.
function maxTokensFor(count, reading) {
  return Math.min(8192, 256 + count * (reading ? 90 : 50));
}

function buildPrompt(unique, lang, reading) {
  const target = langName(lang) || 'English';
  const fields = reading
    ? '"same": boolean, "tr": string[], "read": string[]'
    : '"same": boolean, "tr": string[]';
  const system = [
    `You translate song lyrics into ${target}, line by line, for on-screen captions.`,
    `Reply with ONLY a JSON object: {${fields}}.`,
    `"same" is true when the lyrics are already mostly in ${target}; then "tr" is an empty array.`,
    `Otherwise "tr" has exactly one natural ${target} translation per input line, in the same order.`,
    reading
      ? '"read" has exactly one entry per input line: its romanization (Hepburn for Japanese, Revised Romanization for Korean, Pinyin with tone marks for Chinese), or "" when the line has none of those scripts.'
      : '',
    'Keep each entry short, one line, no notes, no numbering.',
  ].filter(Boolean).join('\n');
  const user = JSON.stringify(unique);
  return { system, user };
}

function cleanOut(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_OUT_CHARS);
}

function cleanList(value, n) {
  if (!Array.isArray(value) || value.length !== n) return null;
  const out = value.map(cleanOut);
  return out.every(s => s !== null) ? out : null;
}

// The model's text → { same, tr, read } with arrays exactly `n` long, or null.
// Tolerates a ```json fence and prose around the object; nothing else.
function parseReply(text, n, reading) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const same = raw.same === true;
  const tr = same ? [] : cleanList(raw.tr, n);
  if (!tr) return null;
  let read = [];
  if (reading) {
    read = cleanList(raw.read, n);
    if (!read) return null;
  }
  return { same, tr, read };
}

// Unique-line answers back onto every original line ('' under a pause).
function expand(index, list) {
  if (!Array.isArray(list) || !list.length) return [];
  return index.map(i => (i >= 0 && typeof list[i] === 'string' ? list[i] : ''));
}

module.exports = {
  LANG_NAMES, MAX_UNIQUE_LINES, MAX_INPUT_CHARS, MAX_OUT_CHARS,
  langName, needsReading, uniqueLines, fitsBudget, maxTokensFor, buildPrompt, parseReply, expand,
};

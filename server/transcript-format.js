'use strict';
// The shapes of a recording's transcript (capture-transcripts.js), pure:
// whisper.cpp's JSON read into lines, the chapters Bit writes checked, and the
// text handed on (subtitle files, the AI's reading). Nothing here touches a
// file or a process.

const MAX_LINES = 5000;
const LINE_MAX_CHARS = 400;
const MAX_CHAPTERS = 30;
const TITLE_MAX_CHARS = 80;
const SUMMARY_MAX_CHARS = 800;
const AI_TEXT_MAX_CHARS = 12000;

const round2 = n => Math.round(n * 100) / 100;

// "1:05" or "1:02:05".
function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// whisper.cpp's -oj output → [{ start, end, text }] in seconds. `clean` drops
// what whisper writes over silence (ai-local.js cleanTranscript); a line left
// empty by it is dropped.
function linesFromWhisper(json, clean = s => String(s || '').trim()) {
  const list = json && Array.isArray(json.transcription) ? json.transcription : [];
  const out = [];
  for (const seg of list) {
    if (out.length === MAX_LINES) break;
    const from = Number(seg && seg.offsets && seg.offsets.from);
    const to = Number(seg && seg.offsets && seg.offsets.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) continue;
    const text = clean(seg.text).slice(0, LINE_MAX_CHARS);
    if (text) out.push({ start: round2(from / 1000), end: round2(to / 1000), text });
  }
  return out;
}

// "m:ss", "h:mm:ss" or plain seconds → seconds; NaN for anything else.
function parseClock(v) {
  if (typeof v === 'number') return v;
  const t = String(v || '').trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

// Chapters as Bit sends them: one per line, "1:05 Setting up the folder"
// (a dash or a colon after the time is fine; a time without ":" is a
// numbered list, not a time). Kept: inside the video, one per
// second, in order, at most MAX_CHAPTERS.
function chaptersFromText(text, seconds) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*[[(]?\s*(\d+(?::\d{1,2}){1,2})\s*[\])]?\s*[-–:.)]?\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const at = parseClock(m[1]);
    const title = m[2].replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, TITLE_MAX_CHARS);
    if (!Number.isFinite(at) || at < 0 || !title) continue;
    if (Number(seconds) > 0 && at >= seconds) continue;
    out.push({ at: Math.floor(at), title });
  }
  out.sort((a, b) => a.at - b.at);
  const unique = out.filter((c, i) => i === 0 || c.at !== out[i - 1].at);
  return unique.slice(0, MAX_CHAPTERS);
}

function cleanSummary(text) {
  return String(text || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS);
}

// A stored transcript, checked on the way in from disk.
function normalizeStored(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.lines)) return null;
  const lines = j.lines.filter(l => l && Number.isFinite(l.start) && Number.isFinite(l.end) && typeof l.text === 'string')
    .slice(0, MAX_LINES).map(l => ({ start: l.start, end: l.end, text: l.text.slice(0, LINE_MAX_CHARS) }));
  const chapters = Array.isArray(j.chapters)
    ? j.chapters.filter(c => c && Number.isInteger(c.at) && c.at >= 0 && typeof c.title === 'string')
      .slice(0, MAX_CHAPTERS).map(c => ({ at: c.at, title: c.title.slice(0, TITLE_MAX_CHARS) }))
    : [];
  return {
    lang: typeof j.lang === 'string' ? j.lang.slice(0, 8) : '',
    seconds: Number.isFinite(j.seconds) ? j.seconds : 0,
    cut: j.cut === true,
    lines, chapters, summary: cleanSummary(j.summary),
  };
}

function srtTime(s) {
  const ms = Math.round(Math.max(0, s) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

function toSrt(lines) {
  return lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n`).join('\n');
}

function toVtt(lines) {
  return 'WEBVTT\n\n' + lines.map(l => `${srtTime(l.start).replace(',', '.')} --> ${srtTime(l.end).replace(',', '.')}\n${l.text}\n`).join('\n');
}

// What the AI reads: "[1:05] text" per line, cut at AI_TEXT_MAX_CHARS.
function aiText(lines) {
  let text = '';
  for (const l of lines) {
    const row = `[${clock(l.start)}] ${l.text}\n`;
    if (text.length + row.length > AI_TEXT_MAX_CHARS) return { text: text.trimEnd(), cut: true };
    text += row;
  }
  return { text: text.trimEnd(), cut: false };
}

module.exports = {
  clock, linesFromWhisper, parseClock, chaptersFromText, cleanSummary, normalizeStored,
  toSrt, toVtt, aiText,
  MAX_LINES, MAX_CHAPTERS, TITLE_MAX_CHARS, SUMMARY_MAX_CHARS, AI_TEXT_MAX_CHARS,
};

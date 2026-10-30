'use strict';
// A recording's words for Bit (capture-transcripts.js): "what did I say in
// the last video?", "summarise it and split it into chapters". `read` makes
// the transcript first when there is none; the words themselves are added to
// the AI's result by server.js (the action's own result carries counts and
// the chapters only, as every Deck action result may reach a paired phone).
// `chapters` keeps the chapters and summary Bit wrote, shown in the gallery.
//
// deps.capture: store() → captures.js, transcripts() → capture-transcripts.js.

const F = require('../transcript-format');

// How long Bit's turn waits for a transcription; a longer one keeps going
// and the gallery shows when it is done.
const WAIT_MS = 120000;
const ERRORS = new Set(['no_file', 'no_audio', 'whisper_missing', 'too_long', 'not_found', 'not_video', 'busy',
  'unavailable', 'no_transcript', 'bad_chapters']);

function deps(d) {
  const c = d && d.capture;
  const store = c && typeof c.store === 'function' ? c.store() : null;
  const transcripts = c && typeof c.transcripts === 'function' ? c.transcripts() : null;
  return store && transcripts ? { store, transcripts } : null;
}

const fail = code => ({ ok: false, error: ERRORS.has(code) ? code : 'failed' });

// The video asked for: an id, a file name (the gallery's "Ask Bit" names
// it), or the newest recording or replay clip.
async function pick(store, action) {
  if (action.id) return store.get(String(action.id));
  const name = String(action.name || '').trim().toLowerCase();
  if (name) {
    // Bit often says the name without its extension ("Bands test" for "Bands test.mp4").
    const bare = n => n.replace(/\.[a-z0-9]{2,4}$/, '');
    const all = store.list({ kind: '', limit: 200 });
    const hit = all.find(e => e.name.toLowerCase() === name) || all.find(e => bare(e.name.toLowerCase()) === name);
    return hit ? store.get(hit.id) : null;
  }
  const [rec, rep] = [await store.last('recording'), await store.last('replay')];
  if (!rec || !rep) return rec || rep;
  return rec.createdAt >= rep.createdAt ? rec : rep;
}

function summaryOf(e, t) {
  return {
    ok: true, id: e.id, name: e.name, seconds: t.seconds, lang: t.lang, lines: t.lines.length,
    ...(t.cut ? { cut: true } : {}),
    chapters: t.chapters.map(c => `${F.clock(c.at)} ${c.title}`),
    ...(t.summary ? { summary: t.summary } : {}),
  };
}

const later = ms => new Promise(resolve => setTimeout(() => resolve(null), ms).unref?.());

async function read(d, action = {}) {
  const k = deps(d);
  if (!k) return fail('unavailable');
  const e = await pick(k.store, action);
  if (!e) return fail(action.id || action.name ? 'not_found' : 'no_file');
  const have = await k.transcripts.read(e.id);
  if (have) return summaryOf(e, have);
  const s = await k.transcripts.start(e.id);
  if (!s.ok) return fail(s.error);
  const r = await Promise.race([s.done, later(WAIT_MS)]);
  if (!r) return { ok: true, id: e.id, name: e.name, working: true };
  if (!r.ok) return fail(r.error);
  const t = await k.transcripts.read(e.id);
  return t ? summaryOf(e, t) : fail('failed');
}

async function chapters(d, action = {}) {
  const k = deps(d);
  if (!k) return fail('unavailable');
  const r = await k.transcripts.setChapters(String(action.id || ''), {
    chapters: action.chapters == null ? null : String(action.chapters),
    summary: action.summary == null ? null : String(action.summary),
  });
  return r.ok ? { ok: true, chapters: r.chapters } : fail(r.error);
}

module.exports = { read, chapters, pick, WAIT_MS };

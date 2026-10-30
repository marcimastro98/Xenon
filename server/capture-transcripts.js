'use strict';
// What is said in a recording, written down on this PC (the Loom kind of
// video, without the cloud): the capture engine decodes the video's first
// audio track to a 16 kHz WAV (apps/capture, speech.rs), whisper.cpp
// (server/whisper, the same one the voice uses) turns it into timed lines,
// and they are kept in DATA_DIR/capture-transcripts/<id>.json next to the
// chapters and summary Bit writes for it (capabilities/transcript.js).
//
// One transcription at a time, at below-normal priority so a game or a call
// keeps the CPU it needs; progress and the end go out through onState (SSE
// `transcript`, ids and numbers only). The words leave only to the gallery
// that asks for them and to the AI turn that reads them; never to a log.

const os = require('os');
const path = require('path');
const { createEngineJobs } = require('./capture-jobs');
const F = require('./transcript-format');

const ID_RE = /^[a-f0-9]{16}$/;
const VIDEO_KINDS = ['recording', 'replay'];
// speech.rs cuts the sound here too.
const MAX_SECONDS = 2 * 60 * 60;
// Decoding takes about a second per ten minutes; whisper about a fifth of
// the length on a recent CPU. Generous so a slow PC still finishes.
const SPEECH_TIMEOUT_MS = (secs) => 60000 + secs * 200;
const WHISPER_TIMEOUT_MS = (secs) => 120000 + secs * 3000;
const PROGRESS_STEP = 5;
const ERRORS = new Set(['no_audio', 'whisper_missing', 'too_long', 'not_found', 'not_video', 'busy', 'unavailable']);

function createCaptureTranscripts({
  host, store, dir, whisper, spawn, clean, speedArgs = () => [], lowPriority = () => {},
  readFile, writeFileAtomic, unlink, readdir, mkdir, stat,
  tmp = () => path.join(os.tmpdir(), `xenon-transcript-${Date.now()}-${Math.random().toString(16).slice(2)}`),
  onState = () => {}, timers = { setTimeout, clearTimeout },
}) {
  const { job } = createEngineJobs(host, ['speech_done'], timers);
  const have = new Set();
  let working = null; // { id, done: Promise, child }
  let seq = 0;

  const fileOf = id => path.join(dir, id + '.json');

  async function load() {
    try {
      for (const name of await readdir(dir)) {
        const id = name.replace(/\.json$/, '');
        if (name.endsWith('.json') && ID_RE.test(id)) have.add(id);
      }
    } catch { /* none yet */ }
  }

  async function read(id) {
    if (!ID_RE.test(String(id)) || !have.has(id)) return null;
    try { return F.normalizeStored(JSON.parse(await readFile(fileOf(id), 'utf8'))); } catch { return null; }
  }

  async function save(id, t) {
    await mkdir(dir);
    await writeFileAtomic(fileOf(id), JSON.stringify({ version: 1, ...t }));
    have.add(id);
  }

  // The video `id` can be transcribed, or the error to answer.
  async function check(id) {
    const e = store.get(id);
    if (!e) return { error: 'not_found' };
    if (!VIDEO_KINDS.includes(e.kind)) return { error: 'not_video' };
    if (!host.available()) return { error: 'unavailable' };
    if (!whisper()) return { error: 'whisper_missing' };
    if (Number(e.seconds) > MAX_SECONDS) return { error: 'too_long' };
    try { await stat(e.file); } catch { return { error: 'not_found' }; }
    return { e };
  }

  // whisper-cli on `wav`; resolves its -oj JSON. Progress from its stderr.
  function runWhisper(id, wav, base, secs, bytes) {
    const w = whisper();
    const args = ['-m', w.model, '-l', 'auto', '-f', wav, '-oj', '-of', base, '-pp', ...speedArgs(bytes)];
    return new Promise((resolve, reject) => {
      const child = spawn(w.exe, args);
      if (working) working.child = child;
      lowPriority(child.pid);
      let last = 0;
      let tail = '';
      const timer = timers.setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, WHISPER_TIMEOUT_MS(secs));
      const onText = (d) => {
        tail = (tail + d).slice(-200);
        const m = /progress\s*=\s*(\d+)%[^%]*$/.exec(tail);
        const pct = m ? Math.min(99, Number(m[1])) : 0;
        if (pct >= last + PROGRESS_STEP) { last = pct; onState({ id, state: 'working', progress: pct }); }
      };
      if (child.stderr) child.stderr.on('data', onText);
      if (child.stdout) child.stdout.on('data', () => { /* the lines come from the JSON */ });
      child.on('error', (err) => { timers.clearTimeout(timer); reject(err); });
      child.on('close', async (code) => {
        timers.clearTimeout(timer);
        if (code !== 0) { reject(new Error('whisper exited ' + code)); return; }
        try { resolve(JSON.parse(await readFile(base + '.json', 'utf8'))); } catch (err) { reject(err); }
      });
    });
  }

  async function work(e) {
    const base = tmp();
    const wav = base + '.wav';
    try {
      onState({ id: e.id, state: 'working', progress: 0 });
      const secs = Number(e.seconds) || 0;
      const sound = await job('speech', { src: e.file, out: wav }, `speech-${++seq}`, SPEECH_TIMEOUT_MS(secs));
      if (!sound || sound.error) return { ok: false, error: sound && sound.error === 'no_audio' ? 'no_audio' : 'failed' };
      let bytes = 0;
      try { bytes = (await stat(wav)).size; } catch { /* speedArgs falls back */ }
      const json = await runWhisper(e.id, wav, base, Number(sound.seconds) || secs, bytes);
      const lines = F.linesFromWhisper(json, clean);
      const old = await read(e.id);
      const t = {
        lang: String((json.result && json.result.language) || '').slice(0, 8),
        seconds: Number(sound.seconds) || secs, cut: sound.cut === true, lines,
        chapters: old ? old.chapters : [], summary: old ? old.summary : '',
      };
      await save(e.id, t);
      return { ok: true, lines: lines.length, lang: t.lang, cut: t.cut };
    } catch (err) {
      console.warn('[transcripts] failed:', err && err.code ? err.code : 'error');
      return { ok: false, error: 'failed' };
    } finally {
      for (const f of [wav, wav + '.part', base + '.json']) unlink(f).catch(() => {});
    }
  }

  // Starts transcribing video `id` (again, when it has a transcript); answers
  // at once. `done` resolves with the result.
  async function start(id) {
    if (working && working.id === id) return { ok: true, working: true, done: working.done };
    if (working) return { ok: false, error: 'busy' };
    const c = await check(id);
    if (c.error) return { ok: false, error: c.error };
    if (working) return { ok: false, error: 'busy' };
    const run = { id, child: null, done: null };
    working = run;
    run.done = work(c.e).then((r) => {
      if (working === run) working = null;
      onState(r.ok ? { id, state: 'done', lines: r.lines } : { id, state: 'failed', error: ERRORS.has(r.error) ? r.error : 'failed' });
      return r;
    });
    return { ok: true, working: true, done: run.done };
  }

  // The transcript of `id`, made first when there is none yet.
  async function ensure(id) {
    const t = await read(id);
    if (t) return { ok: true, transcript: t };
    const s = await start(id);
    if (!s.ok) return s;
    const r = await s.done;
    if (!r.ok) return r;
    const made = await read(id);
    return made ? { ok: true, transcript: made } : { ok: false, error: 'failed' };
  }

  // Bit's chapters (text lines "m:ss Title") and summary for `id`.
  async function setChapters(id, { chapters, summary }) {
    const t = await read(id);
    if (!t) return { ok: false, error: store.get(id) ? 'no_transcript' : 'not_found' };
    const list = chapters == null ? t.chapters : F.chaptersFromText(chapters, t.seconds);
    if (chapters != null && String(chapters).trim() && !list.length) return { ok: false, error: 'bad_chapters' };
    const next = { ...t, chapters: list, summary: summary == null ? t.summary : F.cleanSummary(summary) };
    await save(id, next);
    onState({ id, state: 'chapters', chapters: list.length });
    return { ok: true, chapters: list.length };
  }

  async function forget(id) {
    if (!have.delete(id)) return;
    try { await unlink(fileOf(id)); } catch { /* already gone */ }
  }

  function status() {
    return working ? { working: working.id } : {};
  }

  function stop() {
    if (working && working.child) { try { working.child.kill(); } catch { /* gone */ } }
  }

  return { load, read, start, ensure, setChapters, forget, has: id => have.has(id), status, stop };
}

module.exports = { createCaptureTranscripts, MAX_SECONDS, VIDEO_KINDS };

// capabilities/transcript.js: Bit reads a recording's words and keeps the
// chapters it writes. Pinned here: the video by id, by file name or the newest
// recording or replay; a saved transcript answers at once with counts and
// "m:ss Title" chapters (never the lines: server.js adds those to the AI turn
// only); a missing one is made first, and a long one answers "working"; the
// errors pass through; chapters are saved through capture-transcripts; the
// catalog, the AI functions and the runner line up; the words are in 11 languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const transcript = require('../capabilities/transcript.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

const REC = { id: 'aaaaaaaaaaaaaaaa', kind: 'recording', name: 'talk.mp4', createdAt: 100 };
const REP = { id: 'bbbbbbbbbbbbbbbb', kind: 'replay', name: 'Replay 1.mp4', createdAt: 200 };
const SAVED = {
  lang: 'it', seconds: 16.8, cut: false,
  lines: [{ start: 0, end: 3.6, text: 'Ciao' }, { start: 4.2, end: 7.8, text: 'Prima apro' }],
  chapters: [{ at: 0, title: 'Intro' }, { at: 65, title: 'Impostazioni' }], summary: 'Una prova.',
};

function deps({ have = {}, start, setChapters, last = { recording: REC, replay: REP } } = {}) {
  const log = { started: [], chapters: [] };
  const byId = new Map([REC, REP].map(e => [e.id, e]));
  const transcripts = {
    read: async (id) => have[id] || null,
    start: async (id) => { log.started.push(id); return start ? start(id) : { ok: true, working: true, done: Promise.resolve({ ok: true }) }; },
    setChapters: async (id, v) => { log.chapters.push({ id, ...v }); return setChapters || { ok: true, chapters: 2 }; },
  };
  const store = {
    get: (id) => byId.get(id) || null,
    last: async (kind) => last[kind] || null,
    list: () => [REC, REP],
  };
  return { d: { capture: { host: { available: () => true }, store: () => store, transcripts: () => transcripts } }, log, have };
}

test('a saved transcript: counts and chapters, never the lines', async () => {
  const { d, log } = deps({ have: { [REC.id]: SAVED } });
  const r = await transcript.read(d, { id: REC.id });
  assert.deepEqual(r, {
    ok: true, id: REC.id, name: 'talk.mp4', seconds: 16.8, lang: 'it', lines: 2,
    chapters: ['0:00 Intro', '1:05 Impostazioni'], summary: 'Una prova.',
  });
  assert.equal(JSON.stringify(r).includes('Ciao'), false);
  assert.deepEqual(log.started, []);
});

test('which video: by file name (any case), else the newest recording or replay', async () => {
  const { d } = deps({ have: { [REC.id]: SAVED, [REP.id]: SAVED } });
  assert.equal((await transcript.read(d, { name: 'TALK.mp4' })).id, REC.id);
  assert.equal((await transcript.read(d, { name: 'Talk' })).id, REC.id, 'the name without its extension');
  assert.equal((await transcript.read(d, {})).id, REP.id, 'the replay is newer');
  const older = deps({ have: { [REC.id]: SAVED }, last: { recording: REC } });
  assert.equal((await transcript.read(older.d, {})).id, REC.id);
  assert.deepEqual(await transcript.read(d, { name: 'nope.mp4' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await transcript.read(d, { id: 'ffffffffffffffff' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await transcript.read(deps({ last: {} }).d, {}), { ok: false, error: 'no_file' });
  assert.deepEqual(await transcript.read({}, {}), { ok: false, error: 'unavailable' });
});

test('none yet: made first, then answered; its errors pass through', async () => {
  const made = deps();
  made.d.capture.transcripts().start = async (id) => {
    made.log.started.push(id);
    made.have[id] = SAVED;
    return { ok: true, working: true, done: Promise.resolve({ ok: true }) };
  };
  const r = await transcript.read(made.d, { id: REC.id });
  assert.deepEqual(made.log.started, [REC.id]);
  assert.equal(r.lines, 2);
  for (const error of ['whisper_missing', 'not_video', 'busy', 'too_long', 'unavailable']) {
    const { d } = deps({ start: () => ({ ok: false, error }) });
    assert.deepEqual(await transcript.read(d, { id: REC.id }), { ok: false, error });
  }
  const silent = deps({ start: () => ({ ok: true, done: Promise.resolve({ ok: false, error: 'no_audio' }) }) });
  assert.deepEqual(await transcript.read(silent.d, { id: REC.id }), { ok: false, error: 'no_audio' });
  const odd = deps({ start: () => ({ ok: false, error: 'EACCES C:\\secret' }) });
  assert.deepEqual(await transcript.read(odd.d, { id: REC.id }), { ok: false, error: 'failed' });
});

test('a long video answers "working" when Bit\'s turn cannot wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d } = deps({ start: () => ({ ok: true, working: true, done: new Promise(() => {}) }) });
  const p = transcript.read(d, { id: REC.id });
  await new Promise(r => setImmediate(r));
  await Promise.resolve();
  t.mock.timers.tick(transcript.WAIT_MS);
  assert.deepEqual(await p, { ok: true, id: REC.id, name: 'talk.mp4', working: true });
});

test('chapters and summary go to capture-transcripts as text', async () => {
  const { d, log } = deps();
  assert.deepEqual(await transcript.chapters(d, { id: REC.id, chapters: '0:00 Intro', summary: 'S' }), { ok: true, chapters: 2 });
  assert.deepEqual(log.chapters[0], { id: REC.id, chapters: '0:00 Intro', summary: 'S' });
  await transcript.chapters(d, { id: REC.id, summary: 'Only' });
  assert.deepEqual(log.chapters[1], { id: REC.id, chapters: null, summary: 'Only' });
  const bad = deps({ setChapters: { ok: false, error: 'bad_chapters' } });
  assert.deepEqual(await transcript.chapters(bad.d, { id: REC.id, chapters: 'x' }), { ok: false, error: 'bad_chapters' });
});

test('the catalog, the AI functions and the runner line up', async () => {
  for (const [type, ai] of [['transcript', 'transcribe_recording'], ['transcriptChapters', 'save_recording_chapters']]) {
    const entry = CAPABILITIES.find(c => c.type === type);
    assert.equal(entry.group, 'capture');
    assert.equal(entry.hidden, true, 'voice and gallery only, no Deck key');
    assert.equal(entry.capability.risk, 'safe');
    assert.equal(entry.capability.requires, 'captureSpeech');
    assert.equal(entry.capability.sdk, undefined, 'a widget would read what the user says in their videos');
    assert.equal(entry.capability.ai.name, ai);
    assert.ok(aiFunctions({ capture: true }).some(f => f.name === ai));
    assert.ok(!aiFunctions({ captureSpeech: false }).some(f => f.name === ai));
  }
  assert.deepEqual(aiAction('transcribe_recording', { name: 'talk.mp4', extra: 1 }), { type: 'transcript', name: 'talk.mp4' });
  assert.deepEqual(aiAction('save_recording_chapters', { id: REC.id, chapters: '0:00 A' }), { type: 'transcriptChapters', id: REC.id, chapters: '0:00 A' });
  const { d } = deps({ have: { [REC.id]: SAVED } });
  const run = createCapabilities({ capture: d.capture });
  assert.equal((await run.run({ type: 'transcript', id: REC.id })).lines, 2);
  assert.equal((await run.run({ type: 'transcriptChapters', id: REC.id, chapters: '0:00 A' })).ok, true);
});

test('server.js adds the lines to the AI turn only, and wires the routes', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const hook = src.slice(src.indexOf("fnName === 'transcribe_recording'"), src.indexOf("fnName === 'deck_action_catalog'"));
  assert.match(hook, /TranscriptFormat\.aiText\(t\.lines\)/);
  assert.match(src, /reqPath === '\/captures\/transcript' && req\.method === 'GET'/);
  assert.match(src, /reqPath === '\/captures\/transcribe' && req\.method === 'POST'/);
  assert.match(src, /onState: \(ev\) => broadcastSSE\('transcript', ev\)/);
  assert.match(src, /_transcripts\.forget\(id\)/);
  assert.match(src, /_transcripts\.stop\(\)/);
});

test('the words are in all 11 languages', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const keys = ['deck_act_transcript', 'deck_act_transcriptChapters', 'capg_tx_button', 'capg_tx_working', 'capg_tx_empty',
    'capg_tx_chapters', 'capg_tx_ask_bit', 'capg_tx_bit_prompt', 'capg_tx_srt', 'capg_tx_err_whisper', 'capg_tx_err_no_audio',
    'capg_tx_err_busy', 'capg_tx_err_too_long'];
  for (const k of keys) {
    const n = (i18n.match(new RegExp(`\\n\\s+${k}: '`, 'g')) || []).length;
    assert.equal(n, 11, k);
  }
  assert.equal(/\u2014/.test(i18n.split('\n').filter(l => /capg_tx_|deck_act_transcript/.test(l)).join('\n')), false, 'no em-dashes');
});

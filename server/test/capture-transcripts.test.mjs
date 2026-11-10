// capture-transcripts.js: a recording's words, written down on this PC.
// Pinned here with a fake engine, whisper and disk: only videos, one at a time
// (a second video = busy, the same one = the same run), the reasons it cannot
// start, the engine's no_audio passed on, whisper run at below-normal priority
// with the model and the WAV, progress told every 5 %, the transcript saved
// with the old chapters kept, the temporary files removed, chapters checked,
// forget deletes the file, stop kills whisper, and onState never carries text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { createCaptureTranscripts, MAX_SECONDS } = require('../capture-transcripts.js');

const VID = { id: 'aaaaaaaaaaaaaaaa', kind: 'recording', name: 'talk.mp4', file: 'C:\\v\\talk.mp4', seconds: 17 };
const SHOT = { id: 'bbbbbbbbbbbbbbbb', kind: 'screenshot', name: 'a.png', file: 'C:\\p\\a.png' };
const LONG = { ...VID, id: 'cccccccccccccccc', seconds: MAX_SECONDS + 1 };
const OTHER = { ...VID, id: 'dddddddddddddddd' };
const WHISPER = {
  result: { language: 'it' },
  transcription: [
    { offsets: { from: 0, to: 3660 }, text: ' Ciao, questa è una prova.' },
    { offsets: { from: 4260, to: 7800 }, text: ' Prima apro le impostazioni.' },
  ],
};

function rig({ sound = { event: 'speech_done', seconds: 16.8, cut: false }, whisper = true, available = true, code = 0, autoClose = true } = {}) {
  const files = new Map();
  const log = { requests: [], spawned: [], priority: [], states: [], unlinked: [], children: [] };
  let onEvent = null;
  const host = {
    available: () => available,
    onEvent: (fn) => { onEvent = fn; },
    request: async (cmd, body) => {
      log.requests.push({ cmd, body });
      setImmediate(() => onEvent({ ...sound, token: body.token }));
      return { ok: true, queued: true };
    },
  };
  const byId = new Map([VID, SHOT, LONG, OTHER].map(e => [e.id, e]));
  const t = createCaptureTranscripts({
    host,
    store: { get: (id) => byId.get(id) || null },
    dir: 'D:\\data\\capture-transcripts',
    whisper: () => (whisper ? { exe: 'W:\\whisper-cli.exe', model: 'W:\\ggml-small.bin' } : null),
    spawn: (exe, args) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4242;
      child.kill = () => { child.killed = true; child.emit('close', 1); };
      log.spawned.push({ exe, args });
      log.children.push(child);
      if (autoClose) {
        setImmediate(() => {
          for (const p of [3, 5, 7, 12, 40, 99, 100]) child.stderr.emit('data', `whisper_print_progress_callback: progress = ${p}%\n`);
          const base = args[args.indexOf('-of') + 1];
          if (code === 0) files.set(base + '.json', JSON.stringify(WHISPER));
          child.emit('close', code);
        });
      }
      return child;
    },
    clean: s => String(s || '').trim(),
    speedArgs: (bytes) => ['-t', '8', '-bytes', String(bytes)],
    lowPriority: (pid) => log.priority.push(pid),
    readFile: async (p) => { if (!files.has(p)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileAtomic: async (p, data) => { files.set(p, data); },
    unlink: async (p) => { log.unlinked.push(p); if (!files.delete(p)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } },
    readdir: async () => [...files.keys()].filter(k => k.startsWith('D:\\data\\capture-transcripts')).map(k => k.split('\\').pop()),
    mkdir: async () => {},
    stat: async (p) => ({ size: p.endsWith('.wav') ? 537000 : 1 }),
    tmp: () => 'T:\\tmp\\xt-1',
    onState: (ev) => log.states.push(ev),
  });
  return { t, log, files };
}

test('a video is written down: engine speech, whisper at low priority, saved, temp files removed', async () => {
  const { t, log, files } = rig();
  const s = await t.start(VID.id);
  assert.equal(s.ok, true);
  assert.equal(s.working, true);
  const r = await s.done;
  assert.deepEqual(r, { ok: true, lines: 2, lang: 'it', cut: false });
  assert.equal(log.requests[0].cmd, 'speech');
  assert.equal(log.requests[0].body.src, VID.file);
  assert.equal(log.requests[0].body.out, 'T:\\tmp\\xt-1.wav');
  const { exe, args } = log.spawned[0];
  assert.equal(exe, 'W:\\whisper-cli.exe');
  for (const a of ['-m', 'W:\\ggml-small.bin', '-l', 'auto', '-f', 'T:\\tmp\\xt-1.wav', '-oj', '-of', 'T:\\tmp\\xt-1', '-pp', '-bytes', '537000']) assert.ok(args.includes(a), a);
  assert.deepEqual(log.priority, [4242]);
  const saved = JSON.parse(files.get('D:\\data\\capture-transcripts\\' + VID.id + '.json'));
  assert.equal(saved.version, 1);
  assert.equal(saved.lang, 'it');
  assert.equal(saved.seconds, 16.8);
  assert.deepEqual(saved.lines[1], { start: 4.26, end: 7.8, text: 'Prima apro le impostazioni.' });
  assert.ok(t.has(VID.id));
  for (const f of ['T:\\tmp\\xt-1.wav', 'T:\\tmp\\xt-1.wav.part', 'T:\\tmp\\xt-1.json']) assert.ok(log.unlinked.includes(f), f);
  assert.equal(files.has('T:\\tmp\\xt-1.json'), false);
  const read = await t.read(VID.id);
  assert.equal(read.lines.length, 2);
});

test('progress every 5 %, never 100 before the end; onState carries ids and numbers only', async () => {
  const { t, log } = rig();
  await (await t.start(VID.id)).done;
  const pct = log.states.filter(s => s.state === 'working').map(s => s.progress);
  assert.deepEqual(pct, [0, 5, 12, 40, 99]);
  assert.deepEqual(log.states.at(-1), { id: VID.id, state: 'done', lines: 2 });
  for (const s of log.states) {
    for (const v of Object.values(s)) assert.ok(typeof v === 'number' || /^[a-z_]+$|^[a-f0-9]{16}$/.test(v), JSON.stringify(s));
  }
});

test('the reasons it cannot start', async () => {
  assert.equal((await rig().t.start(SHOT.id)).error, 'not_video');
  assert.equal((await rig().t.start('ffffffffffffffff')).error, 'not_found');
  assert.equal((await rig().t.start(LONG.id)).error, 'too_long');
  assert.equal((await rig({ whisper: false }).t.start(VID.id)).error, 'whisper_missing');
  assert.equal((await rig({ available: false }).t.start(VID.id)).error, 'unavailable');
});

test('one at a time: another video is busy, the same one joins the run', async () => {
  const { t, log } = rig({ autoClose: false });
  const a = await t.start(VID.id);
  const again = await t.start(VID.id);
  assert.equal(again.done, a.done);
  assert.deepEqual(await t.start(OTHER.id), { ok: false, error: 'busy' });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(t.status(), { working: VID.id });
  t.stop();
  assert.equal(log.children[0].killed, true);
  const r = await a.done;
  assert.deepEqual(r, { ok: false, error: 'failed' });
  assert.deepEqual(log.states.at(-1), { id: VID.id, state: 'failed', error: 'failed' });
  assert.deepEqual(t.status(), {});
  const next = await t.start(OTHER.id);
  assert.equal(next.ok, true);
  await new Promise(r => setTimeout(r, 20));
  t.stop(); // its whisper timeout would keep the test alive
  await next.done;
});

test('a video without sound: no_audio, whisper never runs, nothing saved', async () => {
  const { t, log, files } = rig({ sound: { event: 'speech_done', error: 'no_audio' } });
  const r = await (await t.start(VID.id)).done;
  assert.deepEqual(r, { ok: false, error: 'no_audio' });
  assert.equal(log.spawned.length, 0);
  assert.equal(t.has(VID.id), false);
  assert.equal([...files.keys()].some(k => k.includes('capture-transcripts')), false);
  assert.deepEqual(log.states.at(-1), { id: VID.id, state: 'failed', error: 'no_audio' });
});

test('whisper failing = failed, nothing saved', async () => {
  const { t } = rig({ code: 3 });
  assert.deepEqual(await (await t.start(VID.id)).done, { ok: false, error: 'failed' });
  assert.equal(t.has(VID.id), false);
});

test('chapters: checked, kept across a new transcription, removed with an empty text', async () => {
  const { t, log } = rig();
  assert.deepEqual(await t.setChapters(VID.id, { chapters: '0:00 Intro' }), { ok: false, error: 'no_transcript' });
  assert.deepEqual(await t.setChapters('ffffffffffffffff', { chapters: '0:00 Intro' }), { ok: false, error: 'not_found' });
  await (await t.start(VID.id)).done;
  assert.deepEqual(await t.setChapters(VID.id, { chapters: 'no times here' }), { ok: false, error: 'bad_chapters' });
  assert.deepEqual(await t.setChapters(VID.id, { chapters: '0:00 Intro\n0:04 Impostazioni\n9:00 Past the end', summary: 'Una prova.' }), { ok: true, chapters: 2 });
  assert.deepEqual(log.states.at(-1), { id: VID.id, state: 'chapters', chapters: 2 });
  // The summary alone leaves the chapters as they were.
  await t.setChapters(VID.id, { chapters: null, summary: 'Due frasi.' });
  let read = await t.read(VID.id);
  assert.deepEqual(read.chapters, [{ at: 0, title: 'Intro' }, { at: 4, title: 'Impostazioni' }]);
  assert.equal(read.summary, 'Due frasi.');
  // Written down again: the words are new, the chapters stay.
  await (await t.start(VID.id)).done;
  read = await t.read(VID.id);
  assert.equal(read.chapters.length, 2);
  assert.equal(read.summary, 'Due frasi.');
  await t.setChapters(VID.id, { chapters: '' });
  assert.deepEqual((await t.read(VID.id)).chapters, []);
});

test('ensure makes one when missing; load finds saved ones; forget deletes the file', async () => {
  const { t, files } = rig();
  const made = await t.ensure(VID.id);
  assert.equal(made.ok, true);
  assert.equal(made.transcript.lines.length, 2);
  const again = createCaptureTranscripts({
    host: { available: () => true, onEvent: () => {}, request: async () => ({ ok: true }) },
    store: { get: () => null }, dir: 'D:\\data\\capture-transcripts', whisper: () => null, spawn: () => null,
    readFile: async (p) => files.get(p), writeFileAtomic: async () => {}, unlink: async () => {},
    readdir: async () => [VID.id + '.json', 'not-an-id.json', 'x.txt'], mkdir: async () => {}, stat: async () => ({}),
  });
  await again.load();
  assert.equal(again.has(VID.id), true);
  assert.equal(again.has('not-an-id'), false);
  assert.equal((await again.read(VID.id)).lang, 'it');
  await t.forget(VID.id);
  assert.equal(t.has(VID.id), false);
  assert.equal(files.has('D:\\data\\capture-transcripts\\' + VID.id + '.json'), false);
  assert.equal(await t.read(VID.id), null);
  assert.equal(await t.read('../../etc'), null);
});

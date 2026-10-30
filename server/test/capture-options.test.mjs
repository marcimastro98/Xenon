// Recording options (Settings → Recording, set_recording_options). Pinned here:
// the stored shape is always valid and a bad value is refused by name; the
// folders (recordings, screenshots, benchmarks) never leave the PC on the wire
// and a backup never brings another PC's; the folder dialog answers once even
// when asked twice, and a vanished folder falls back to the standard one; the
// voice reports only folder names and picks the folder it was asked for; the space limit deletes only the oldest indexed recordings, never the
// new one; the routes are closed to a paired phone and CSRF-listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CS = require('../capture-settings.js');
const { createCaptureFolder, PICK_TIMEOUT_MS } = require('../capture-folder.js');
const opts = require('../capabilities/record-options.js');
const { createCaptures } = require('../captures.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
const REMOTE = readFileSync(path.join(HERE, '..', 'remote-access.js'), 'utf8');

const FOLDER = path.join(os.tmpdir(), 'My Clips');
// The Instant Replay fields at their defaults.
const R = { replay: false, replaySeconds: 30, replayWhen: 'gaming', replayAudio: 'sound', replayKey: 'ctrl+shift+f10', replayClips: 'marks' };

test('normalize: anything stored comes back valid, the folder kept verbatim', () => {
  assert.deepEqual(CS.normalizeCaptureSettings(undefined), { ...CS.DEFAULTS });
  assert.deepEqual(CS.normalizeCaptureSettings({ fps: '30', height: 720, quality: 'small', badge: false, maxGB: '25', folder: FOLDER }),
    { fps: 30, height: 720, quality: 'small', badge: false, autoMarks: true, maxGB: 25, folder: FOLDER, shotFolder: '', benchFolder: '', bugFolder: '', bugLogs: '', ...R });
  assert.deepEqual(CS.normalizeCaptureSettings({ fps: 144, height: 4320, quality: '<b>', badge: 'no', maxGB: -1, folder: 42, shotFolder: {}, benchFolder: 7 }),
    { fps: 60, height: 0, quality: 'normal', badge: true, autoMarks: true, maxGB: 0, folder: '', shotFolder: '', benchFolder: '', bugFolder: '', bugLogs: '', ...R });
  for (const key of CS.FOLDER_KEYS) {
    assert.equal(CS.normalizeCaptureSettings({ [key]: 'x'.repeat(5000) })[key].length, 512, key);
    assert.equal(CS.normalizeCaptureSettings({ [key]: FOLDER })[key], FOLDER, key);
  }
  assert.deepEqual([...CS.FOLDER_KEYS], ['folder', 'shotFolder', 'benchFolder', 'bugFolder', 'bugLogs']);
});

test('a change takes the listed values, refuses others by name, never sets a folder', () => {
  const { next, bad } = CS.applyCaptureChange(CS.DEFAULTS, { fps: 30, height: '1080', quality: 'high', badge: false, maxGB: 50, folder: 'C:/evil', shotFolder: 'C:/evil', benchFolder: 'C:/evil' });
  assert.deepEqual(next, { fps: 30, height: 1080, quality: 'high', badge: false, autoMarks: true, maxGB: 50, folder: '', shotFolder: '', benchFolder: '', bugFolder: '', bugLogs: '', ...R });
  assert.deepEqual(bad, []);
  const r = CS.applyCaptureChange({ ...CS.DEFAULTS, fps: 30 }, { fps: 45, height: 999, quality: 'ultra', badge: 'yes', maxGB: 7 });
  assert.deepEqual(r.bad.sort(), ['badge', 'fps', 'height', 'maxGB', 'quality']);
  assert.equal(r.next.fps, 30, 'a refused value leaves the old one');
});

test('the folder is blanked on the wire and a backup keeps this PC folder', () => {
  const s = { theme: 'x', capture: { ...CS.DEFAULTS, folder: FOLDER } };
  const wire = CS.redactCaptureFolder(s);
  assert.equal(wire.capture.folder, '');
  assert.equal(wire.capture.folderSet, true);
  assert.equal(s.capture.folder, FOLDER, 'the stored copy is untouched');
  assert.equal(CS.redactCaptureFolder({ capture: { ...CS.DEFAULTS } }).capture.folderSet, false);
  assert.equal(CS.redactCaptureFolder(null), null);

  const imported = CS.preserveCaptureFolder({ capture: { ...CS.DEFAULTS, fps: 30, folder: 'Z:/other-pc' } }, { capture: { folder: FOLDER } });
  assert.equal(imported.capture.folder, FOLDER);
  assert.equal(imported.capture.fps, 30, 'the other options come from the backup');
  assert.equal(CS.preserveCaptureFolder({ capture: { folder: 'Z:/x' } }, {}).capture.folder, '');
});

test('every folder is blanked on the wire and kept from this PC on import', () => {
  const s = { capture: { ...CS.DEFAULTS, shotFolder: FOLDER, benchFolder: FOLDER } };
  const wire = CS.redactCaptureFolder(s);
  assert.deepEqual([wire.capture.folder, wire.capture.shotFolder, wire.capture.benchFolder], ['', '', '']);
  assert.deepEqual([wire.capture.folderSet, wire.capture.shotFolderSet, wire.capture.benchFolderSet], [false, true, true]);
  assert.ok(!JSON.stringify(wire).includes(os.tmpdir()), 'no path on the wire');
  const imported = CS.preserveCaptureFolder(
    { capture: { ...CS.DEFAULTS, shotFolder: 'Z:/other-pc', benchFolder: 'Z:/other-pc' } },
    { capture: { shotFolder: FOLDER } });
  assert.deepEqual([imported.capture.shotFolder, imported.capture.benchFolder], [FOLDER, '']);
});

function fakeHost({ reply = { ok: true } } = {}) {
  const listeners = new Set();
  const requests = [];
  return {
    requests,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (ev) => { for (const fn of [...listeners]) fn(ev); },
    listeners: () => listeners.size,
    request: async (cmd, body) => { requests.push({ cmd, body }); return typeof reply === 'function' ? reply() : reply; },
  };
}

test('pick: the dialog opens once, both callers get the same answer, the listener goes', async () => {
  const host = fakeHost();
  const f = createCaptureFolder({ host, validDir: async () => ({ ok: true }), title: () => 'Where' });
  const a = f.pick(FOLDER);
  const b = f.pick();
  assert.equal(f.picking(), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(host.requests, [{ cmd: 'pick_folder', body: { title: 'Where', start: FOLDER } }]);
  host.emit({ event: 'record_ended' });
  host.emit({ event: 'folder_picked', path: FOLDER });
  assert.deepEqual(await a, { ok: true, path: FOLDER });
  assert.equal(await b, await a);
  assert.equal(host.listeners(), 0);
  assert.equal(f.picking(), false);
  assert.ok(PICK_TIMEOUT_MS > 300000, 'waits past the engine own 300 s close');
});

test('pick: a title read from disk is awaited, a failing or odd one sends none', async () => {
  const sent = async (title) => {
    const host = fakeHost();
    const f = createCaptureFolder({ host, validDir: async () => ({ ok: true }), title });
    const p = f.pick();
    for (let i = 0; i < 5 && !host.requests.length; i++) await new Promise((r) => setImmediate(r));
    host.emit({ event: 'folder_picked', cancelled: true });
    await p;
    return host.requests[0].body.title;
  };
  assert.equal(await sent(async () => 'Dove salvare le registrazioni'), 'Dove salvare le registrazioni');
  assert.equal(await sent(async () => { throw new Error('i18n unreadable'); }), '');
  assert.equal(await sent(() => { throw new Error('sync'); }), '');
  assert.equal(await sent(() => ({ not: 'a string' })), '');
});

test('pick: cancel, a failure, an engine that dies, an engine that refuses', async () => {
  const run = async (ev, reply) => {
    const host = fakeHost({ reply });
    const f = createCaptureFolder({ host, validDir: async () => ({ ok: true }) });
    const p = f.pick();
    await new Promise((r) => setImmediate(r));
    if (ev) host.emit(ev);
    return p;
  };
  assert.deepEqual(await run({ event: 'folder_picked', cancelled: true }), { ok: true, cancelled: true });
  assert.deepEqual(await run({ event: 'folder_picked', error: 'failed' }), { ok: false, error: 'failed' });
  assert.deepEqual(await run({ event: 'engine_exited' }), { ok: false, error: 'failed' });
  assert.deepEqual(await run(null, { ok: false, error: 'unsupported' }), { ok: false, error: 'unsupported' });
  assert.deepEqual(await run(null, () => { throw new Error('gone'); }), { ok: false, error: 'failed' });
});

test('choose checks the folder like a typed one; resolve falls back when it is gone', async () => {
  const host = fakeHost();
  const f = createCaptureFolder({ host, validDir: async (p) => (p === FOLDER ? { ok: true } : { ok: false, error: 'inside_data' }) });
  const c = f.choose();
  await new Promise((r) => setImmediate(r));
  host.emit({ event: 'folder_picked', path: path.join(FOLDER, 'data') });
  assert.deepEqual(await c, { ok: false, error: 'inside_data' });

  assert.deepEqual(await f.resolve(''), { dir: '' });
  assert.deepEqual(await f.resolve(FOLDER), { dir: FOLDER });
  assert.deepEqual(await f.resolve('Q:/unplugged'), { dir: '', missing: true });
  const throws = createCaptureFolder({ host, validDir: async () => { throw new Error('io'); } });
  assert.deepEqual(await throws.resolve(FOLDER), { dir: '', missing: true });
});

function optDeps({ cur = { ...CS.DEFAULTS }, picked = { ok: true, path: FOLDER } } = {}) {
  const log = { set: [], picks: 0, kinds: [] };
  let now = { ...cur };
  const capture = {
    options: () => now,
    setOptions: async (change, folders) => {
      log.set.push({ change, folders });
      now = { ...CS.applyCaptureChange(now, change).next, ...(folders || {}) };
      return now;
    },
    pickFolder: async (kind) => { log.picks++; log.kinds.push(kind); return picked; },
  };
  return { d: { capture }, log };
}

test('voice: "keep" changes nothing, words become settings, only reading with no choice', async () => {
  const read = optDeps();
  const r0 = await opts.run(read.d, { fps: 'keep', size: 'keep', quality: 'keep', pill: 'keep', limit: 'keep', folder: 'keep' });
  assert.deepEqual(read.log.set, []);
  assert.deepEqual(r0, {
    ok: true, fps: 60, size: 'native', quality: 'normal', pill: 'show', limitGB: 'none', folder: 'Videos/Xenon (default)',
    screenshotFolder: 'Pictures/Xenon (default)', benchmarkFolder: 'Documents/Xenon/Benchmark (default)',
    bugReportFolder: 'Documents/Xenon/Bug reports (default)', bugLogFolder: 'none (no logs are added)',
  });
  assert.deepEqual(await opts.run(read.d, undefined), r0, 'no action at all only reads');

  const set = optDeps();
  const r = await opts.run(set.d, { fps: '30', size: '720', quality: 'small', pill: 'hide', limit: '25', folder: 'keep' });
  assert.deepEqual(set.log.set, [{ change: { fps: 30, height: 720, quality: 'small', badge: false, maxGB: 25 }, folders: {} }]);
  assert.equal(r.saved, true);
  assert.deepEqual([r.size, r.pill, r.limitGB], [720, 'hide', 25]);
  const back = await opts.run(set.d, { size: 'native', limit: 'none', folder: 'default' });
  assert.deepEqual(set.log.set[1], { change: { height: 0, maxGB: 0 }, folders: { folder: '' } });
  assert.equal(back.size, 'native');
});

test('voice: a picked folder is saved and named by its last part only', async () => {
  const { d, log } = optDeps();
  const r = await opts.run(d, { folder: 'pick' });
  assert.equal(log.picks, 1);
  assert.deepEqual(log.kinds, ['recording']);
  assert.deepEqual(log.set[0].folders, { folder: FOLDER });
  assert.equal(r.folder, 'My Clips (chosen by the user)');
  assert.ok(!JSON.stringify(r).includes(os.tmpdir()), 'no path in the answer');
});

test('voice: folderFor picks and resets the screenshot or benchmark folder, not the videos one', async () => {
  const shots = optDeps();
  const r = await opts.run(shots.d, { folder: 'pick', folderFor: 'screenshots' });
  assert.deepEqual(shots.log.kinds, ['screenshot']);
  assert.deepEqual(shots.log.set[0].folders, { shotFolder: FOLDER });
  assert.deepEqual([r.screenshotFolder, r.folder], ['My Clips (chosen by the user)', 'Videos/Xenon (default)']);

  const bench = optDeps({ cur: { ...CS.DEFAULTS, benchFolder: FOLDER } });
  const b = await opts.run(bench.d, { folder: 'default', folderFor: 'benchmarks' });
  assert.deepEqual(bench.log.set[0].folders, { benchFolder: '' });
  assert.equal(b.benchmarkFolder, 'Documents/Xenon/Benchmark (default)');

  // The bug report's two folders: where the zip goes, and where its logs come from.
  const bug = optDeps();
  const g = await opts.run(bug.d, { folder: 'pick', folderFor: 'bugLogs' });
  assert.deepEqual(bug.log.kinds, ['buglogs']);
  assert.deepEqual(bug.log.set[0].folders, { bugLogs: FOLDER });
  assert.deepEqual([g.bugLogFolder, g.bugReportFolder], ['My Clips (chosen by the user)', 'Documents/Xenon/Bug reports (default)']);

  const odd = optDeps();
  await opts.run(odd.d, { folder: 'pick', folderFor: 'C:/anything' });
  assert.deepEqual(odd.log.kinds, ['recording'], 'an unknown folderFor means recordings');
});

test('voice: a closed dialog keeps the folder but saves the other choices; a failure says so', async () => {
  const c = optDeps({ cur: { ...CS.DEFAULTS, folder: FOLDER }, picked: { ok: true, cancelled: true } });
  const r = await opts.run(c.d, { folder: 'pick', fps: '30' });
  assert.equal(r.cancelled, true);
  assert.deepEqual(c.log.set, [{ change: { fps: 30 }, folders: undefined }]);
  assert.equal(r.fps, 30);
  assert.equal(r.folder, 'My Clips (chosen by the user)');

  const f = optDeps({ picked: { ok: false, error: 'unsupported' } });
  assert.deepEqual(await opts.run(f.d, { folder: 'pick', fps: '30' }), { ok: false, error: 'unsupported' });
  assert.deepEqual(f.log.set, [], 'nothing saved when the dialog failed');
  assert.deepEqual(await opts.run({}, {}), { ok: false, error: 'unavailable' });
});

test('the Deck/AI entry: options match the stored lists, keep first, never a free path', () => {
  const e = CAPABILITIES.find((c) => c.type === 'recordingOptions');
  assert.ok(e && e.hidden === true);
  const p = Object.fromEntries(e.params.map((x) => [x.name, x]));
  for (const x of e.params) {
    assert.equal(x.kind, 'select', `${x.name} is a closed list`);
    if (x.name !== 'folderFor') assert.equal(x.options[0], 'keep', `${x.name}: a missing value means keep`);
  }
  assert.deepEqual(p.folderFor.options, ['recordings', 'screenshots', 'benchmarks', 'bugReports', 'bugLogs'], 'a missing folderFor means recordings');
  assert.deepEqual(p.fps.options.slice(1).map(Number), [...CS.FPS]);
  assert.deepEqual(p.size.options.slice(2).map(Number).sort(), CS.HEIGHTS.filter(Boolean).slice().sort());
  assert.deepEqual(p.quality.options.slice(1), [...CS.QUALITIES]);
  assert.deepEqual(p.limit.options.slice(2).map(Number), CS.LIMITS_GB.filter(Boolean));
  assert.deepEqual(p.folder.options, ['keep', 'pick', 'default']);
  assert.equal(e.capability.ai.name, 'set_recording_options');
});

function store(files) {
  const sizes = new Map(files.map((f) => [f.file, f.size]));
  const unlinked = [];
  let t = 1000;
  let n = 0;
  const s = createCaptures({
    file: path.join(os.tmpdir(), 'none', 'captures.json'),
    writeFileAtomic: async () => {},
    picturesDir: async () => os.tmpdir(),
    videosDir: async () => path.join(os.tmpdir(), 'Videos'),
    exists: async () => false,
    now: () => t++,
    randomId: () => (n++).toString(16).padStart(16, '0'),
    stat: async (p) => { if (!sizes.has(p)) throw new Error('ENOENT'); return { size: sizes.get(p) }; },
    unlink: async (p) => { if (p.endsWith('locked.mp4')) throw new Error('EBUSY'); unlinked.push(p); sizes.delete(p); },
  });
  return { s, unlinked };
}

const GB = 1024 ** 3;

test('a chosen root holds the game folder directly; a relative root is ignored', async () => {
  const { s } = store([]);
  const p = await s.plan({ kind: 'recording', game: 'Game.exe', root: FOLDER });
  assert.equal(p.dir, path.join(FOLDER, 'Game'));
  const q = await s.plan({ kind: 'recording', game: '', root: 'relative/dir' });
  assert.equal(q.dir, path.join(os.tmpdir(), 'Videos', 'Xenon', 'Desktop'));
});

test('usage counts indexed recordings still on disk; prune deletes the oldest until the rest fit', async () => {
  const dir = path.join(os.tmpdir(), 'rec');
  const f = (name) => path.join(dir, name);
  const { s, unlinked } = store([
    { file: f('1.mp4'), size: 4 * GB }, { file: f('2.mp4'), size: 4 * GB },
    { file: f('3.mp4'), size: 4 * GB }, { file: f('new.mp4'), size: 4 * GB },
  ]);
  const ids = [];
  for (const name of ['1.mp4', '2.mp4', 'gone.mp4', '3.mp4', 'new.mp4']) {
    const id = (ids.length + 100).toString(16).padStart(16, '0');
    ids.push(id);
    s.add({ id, kind: 'recording', file: f(name), seconds: 10 });
  }
  s.add({ id: 'ffffffffffffffff', kind: 'screenshot', file: f('shot.png'), width: 1, height: 1 });
  assert.equal(await s.usage('recording'), 16 * GB, 'a file deleted by hand does not count');

  assert.deepEqual(await s.prune({ kind: 'recording', maxBytes: 0, keep: ids[4] }), { removed: 0, freed: 0 });
  const r = await s.prune({ kind: 'recording', maxBytes: 10 * GB, keep: ids[4] });
  assert.deepEqual(r, { removed: 2, freed: 8 * GB });
  assert.deepEqual(unlinked, [f('1.mp4'), f('2.mp4')], 'oldest first, nothing else');
  assert.equal(s.list({ kind: 'recording' }).length, 3, 'deleted files leave the index');
  assert.equal(s.list({ kind: 'screenshot' }).length, 1, 'screenshots are never touched');

  const tight = await s.prune({ kind: 'recording', maxBytes: 1, keep: ids[4] });
  assert.equal(tight.removed, 1, 'the new recording stays even past the limit');
  assert.ok(!unlinked.includes(f('new.mp4')));
});

test('a file that cannot be deleted is skipped, not fatal', async () => {
  const dir = path.join(os.tmpdir(), 'rec');
  const { s } = store([{ file: path.join(dir, 'locked.mp4'), size: 5 * GB }, { file: path.join(dir, 'b.mp4'), size: 5 * GB }, { file: path.join(dir, 'c.mp4'), size: 5 * GB }]);
  s.add({ id: '00000000000000a1', kind: 'recording', file: path.join(dir, 'locked.mp4'), seconds: 1 });
  s.add({ id: '00000000000000a2', kind: 'recording', file: path.join(dir, 'b.mp4'), seconds: 1 });
  s.add({ id: '00000000000000a3', kind: 'recording', file: path.join(dir, 'c.mp4'), seconds: 1 });
  const r = await s.prune({ kind: 'recording', maxBytes: 6 * GB, keep: '00000000000000a3' });
  assert.deepEqual(r, { removed: 1, freed: 5 * GB });
  assert.equal(s.list({ kind: 'recording' }).length, 2);
});

test('the routes are closed to a paired phone, CSRF-listed, and the setting has its keep-prev guard', () => {
  for (const p of ['/capture/settings', '/capture/settings/pick']) {
    assert.ok(REMOTE.includes(`'${p}'`), `${p} in REMOTE_DENY`);
    const csrf = SERVER.slice(SERVER.indexOf('CSRF_MUTATION_PATHS'), SERVER.indexOf('CSRF_MUTATION_PATHS') + 20000);
    assert.ok(csrf.includes(`'${p}'`), `${p} in CSRF_MUTATION_PATHS`);
  }
  // One dialog for the three folders: the request names whose folder it is,
  // and each kind has its own title, translated everywhere.
  assert.ok(SERVER.includes('const key = CaptureSettings.FOLDERS[body && body.for] || CaptureSettings.FOLDERS.recording;'));
  assert.deepEqual(Object.keys(CS.FOLDERS), ['recording', 'screenshot', 'benchmark', 'bugreport', 'buglogs']);
  const i18n = readFileSync(path.join(HERE, '..', 'js', 'i18n.js'), 'utf8');
  for (const k of ['capture_folder_title', 'shot_folder_title', 'bench_folder_title', 'settings_folder_label', 'settings_shot_title',
    'settings_bench_title', 'settings_shot_reset', 'settings_bench_reset', 'settings_folder_busy',
    'shot_folder_missing', 'bench_folder_missing', 'bug_folder_title', 'bug_logs_title', 'bug_folder_missing']) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
    if (k.endsWith('_folder_title')) assert.ok(SERVER.includes(`'${k}'`), `${k} is a dialog title`);
  }
  // The old shared "Where to save" group is gone: each folder lives with what it saves.
  for (const k of ['settings_capture_folders', 'settings_folder_videos', 'settings_folder_shots', 'settings_folder_bench']) {
    assert.ok(!new RegExp(`\\b${k}:`).test(i18n), `${k} removed`);
  }
  assert.ok(SERVER.includes('incoming.capture = prev.capture;'));
  assert.ok(SERVER.includes('CaptureSettings.redactCaptureFolder('));
  assert.ok(SERVER.includes('CaptureSettings.preserveCaptureFolder('));
});

test('Instant Replay settings: off by default, any whole length in range, bad values refused by name', () => {
  const d = CS.normalizeCaptureSettings({});
  assert.equal(d.replay, false, 'a recording that never stops starts only when asked');
  assert.equal(d.replaySeconds, 30);
  assert.equal(d.replayWhen, 'gaming');
  assert.equal(d.replayAudio, 'sound');
  // Any whole number of seconds, not only the presets.
  assert.equal(CS.normalizeCaptureSettings({ replaySeconds: 437 }).replaySeconds, 437);
  for (const bad of [5, 14, 3601, 30.5, 'x', null]) {
    assert.equal(CS.normalizeCaptureSettings({ replaySeconds: bad }).replaySeconds, 30, String(bad));
  }
  assert.equal(CS.normalizeCaptureSettings({ replay: 'yes' }).replay, false);
  assert.equal(CS.normalizeCaptureSettings({ replayWhen: 'never' }).replayWhen, 'gaming');
  const { next, bad } = CS.applyCaptureChange({}, { replay: true, replaySeconds: 1200, replayWhen: 'always', replayAudio: 'sound_mic' });
  assert.deepEqual(bad, []);
  assert.deepEqual([next.replay, next.replaySeconds, next.replayWhen, next.replayAudio], [true, 1200, 'always', 'sound_mic']);
  const refused = CS.applyCaptureChange({}, { replay: 1, replaySeconds: 2, replayWhen: 'x', replayAudio: 'loud' });
  assert.deepEqual(refused.bad.sort(), ['replay', 'replayAudio', 'replaySeconds', 'replayWhen']);
  assert.equal(refused.next.replay, false);
});

test('replay clips are videos: saved under Videos, named as a replay, counted by the space limit', async () => {
  const dir = path.join(os.tmpdir(), `xc-replay-kind-${process.pid}`);
  const store = createCaptures({
    file: path.join(dir, 'captures.json'), writeFileAtomic: async () => {},
    picturesDir: async () => path.join(dir, 'P'), videosDir: async () => path.join(dir, 'V'), exists: async () => false,
    now: () => new Date(2026, 9, 27, 10, 5, 9).getTime(), stat: async () => ({ size: 10 }),
  });
  const p = await store.plan({ kind: 'replay', game: 'Game.exe' });
  assert.equal(p.file, path.join(dir, 'V', 'Xenon', 'Game', 'Game Replay 2026-10-27 10-05-09.mp4'));
  store.add({ id: p.id, kind: 'replay', file: p.file, game: 'Game.exe', seconds: 30.04 });
  const rec = await store.plan({ kind: 'recording', game: '' });
  store.add({ id: rec.id, kind: 'recording', file: rec.file, seconds: 5 });
  assert.equal(store.list({ kind: 'replay' })[0].seconds, 30.04);
  assert.equal(await store.usage(['recording', 'replay']), 20);
  assert.equal(await store.usage('replay'), 10);
});

test('the replay shortcut: the Deck key rules, off, back to the default, and who owns a refused one', () => {
  assert.equal(CS.DEFAULTS.replayKey, 'ctrl+shift+f10');
  assert.equal(CS.normalizeCaptureSettings({ replayKey: 'Shift+Alt+R' }).replayKey, 'alt+shift+r');
  assert.equal(CS.normalizeCaptureSettings({ replayKey: 'off' }).replayKey, 'off');
  // Stored junk, or a combo another program owns, falls back to the default.
  for (const v of ['alt+f10', 'ctrl+c', 'ctrl+alt+$(id)', 42, null]) {
    assert.equal(CS.normalizeCaptureSettings({ replayKey: v }).replayKey, 'ctrl+shift+f10', String(v));
  }
  assert.deepEqual(CS.applyCaptureChange(CS.DEFAULTS, { replayKey: 'ctrl+alt+shift+r' }).next.replayKey, 'ctrl+alt+shift+r');
  assert.equal(CS.applyCaptureChange(CS.DEFAULTS, { replayKey: 'none' }).next.replayKey, 'off');
  assert.equal(CS.applyCaptureChange({ ...CS.DEFAULTS, replayKey: 'off' }, { replayKey: '' }).next.replayKey, 'ctrl+shift+f10');
  const nv = CS.applyCaptureChange({ ...CS.DEFAULTS, replayKey: 'alt+shift+r' }, { replayKey: 'Alt+F10' });
  assert.deepEqual([nv.bad, nv.owner, nv.next.replayKey], [['replayKey'], 'nvidia', 'alt+shift+r']);
  const junk = CS.applyCaptureChange(CS.DEFAULTS, { replayKey: 'r' });
  assert.deepEqual([junk.bad, junk.owner], [['replayKey'], '']);
  assert.deepEqual(CS.applyCaptureChange(CS.DEFAULTS, { replayKey: 7 }).bad, ['replayKey']);
});

test('the POST route names who owns a refused shortcut', () => {
  const route = SERVER.slice(SERVER.indexOf("reqPath === '/capture/settings' && req.method === 'POST'"));
  assert.match(route.slice(0, 1200), /error: owner \? 'reserved' : 'bad_value', bad, \.\.\.\(owner \? \{ owner \} : \{\}\)/);
});

test('the client recorder keeps the same default as the server', () => {
  const SRC = readFileSync(path.join(HERE, '..', 'js', 'capture-replay-key.js'), 'utf8');
  assert.ok(SRC.includes(`const DEFAULT_KEY = '${CS.REPLAY_KEY}';`));
});

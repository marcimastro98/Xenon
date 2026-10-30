// bug-report.js: the package a developer needs, in one .zip. Pinned here: what
// goes in and what the README says is missing, the log folder rules (plain
// files only, newest first, limits, a big log keeps its tail), the window
// falling back to the screen, the temp folder always removed, one package at
// a time, nothing personal (no window title, no PC or user name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BR = require('../bug-report.js');
const { writeZip } = require('../zip-writer.js');

function unzipNames(file) {
  const buf = fs.readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const nlen = buf.readUInt16LE(at + 28);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nlen);
    const data = offset + 30 + buf.readUInt16LE(offset + 26);
    const body = buf.subarray(data, data + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    at += 46 + nlen;
  }
  return out;
}

function setup(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-br-'));
  const tmpRoot = path.join(root, 'tmp');
  const out = path.join(root, 'out');
  fs.mkdirSync(tmpRoot);
  const calls = [];
  const host = {
    available: () => true,
    request: async (cmd, body) => {
      calls.push({ cmd, body });
      if (over.shot) return over.shot(body, calls);
      fs.writeFileSync(body.path, Buffer.from('PNG'));
      return { ok: true, width: 10, height: 10, ...(over.exe ? { exe: over.exe } : {}) };
    },
  };
  const replay = over.replay === null ? () => null : () => ({
    saveTo: async (file, { seconds }) => {
      if (over.replayOff) return { ok: false, error: 'off' };
      if (over.replayError) return { ok: false, error: over.replayError };
      fs.writeFileSync(file, Buffer.alloc(1000, 1));
      return { ok: true, seconds };
    },
  });
  const saved = [];
  const shown = [];
  const br = BR.createBugReport({
    host, replay, tmpRoot, writeZip, fs: fs.promises,
    defaultDir: async () => out,
    logFolder: over.logFolder || (async () => ({ dir: '' })),
    system: async () => ({ xenon: '4.12.0', os: 'Windows_NT', osRelease: '10.0.26300', cpu: 'Test CPU', cores: 16, ramTotal: 34359738368, gpu: 'Test GPU' }),
    foreground: () => over.app ?? 'BuggyApp.exe',
    now: () => over.now ?? Date.UTC(2026, 9, 27, 12, 0, 0),
    reveal: f => shown.push(f),
    onSaved: e => saved.push(e),
    ...(over.remember ? { remember: over.remember } : {}),
  });
  return { root, tmpRoot, out, br, calls, saved, shown, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('two packages in the same second never overwrite each other', async () => {
  const s = setup();
  try {
    const a = await s.br.make({ seconds: 10 });
    const b = await s.br.make({ seconds: 10 });
    const c = await s.br.make({ seconds: 10 });
    assert.match(b.name, / \(2\)\.zip$/);
    assert.match(c.name, / \(3\)\.zip$/);
    assert.deepEqual(fs.readdirSync(s.out).sort(), [a.name, b.name, c.name].sort());
  } finally { s.done(); }
});

test('a package holds the window, the last seconds, the system and the README', async () => {
  const s = setup();
  try {
    const r = await s.br.make({ seconds: 10 });
    assert.equal(r.ok, true);
    assert.match(r.name, /^Bug report BuggyApp \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.zip$/);
    assert.equal(r.video, 10);
    assert.equal(r.screenshot, true);
    const z = unzipNames(path.join(s.out, r.name));
    assert.deepEqual(Object.keys(z).sort(), ['README.txt', 'screenshot.png', 'system.txt', 'video.mp4']);
    const sys = z['system.txt'].toString();
    assert.match(sys, /Xenon 4\.12\.0/);
    assert.match(sys, /CPU: Test CPU \(16 threads\)/);
    assert.match(sys, /RAM: 32\.0 GB/);
    assert.match(sys, /App in front: BuggyApp\.exe/);
    assert.doesNotMatch(sys, new RegExp(os.hostname(), 'i'));
    assert.match(z['README.txt'].toString(), /video\.mp4: the last 10 seconds/);
    assert.match(z['README.txt'].toString(), /Made: 2026-10-27 \d\d:\d\d:00 \(UTC/);
    assert.equal(s.calls[0].body.target, 'window');
    // Nothing of the temp folder stays, nothing goes to the gallery.
    assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
    assert.equal(s.saved.length, 1);
    assert.equal(s.saved[0].kind, 'bugreport');
    assert.equal(JSON.stringify(s.saved[0]).includes(s.out), false, 'no path in the notice');
  } finally { s.done(); }
});

test('the app is the one the engine captured, not a window that flashed past the probe', async () => {
  const s = setup({ exe: 'Buggy Game.exe', app: 'discord.exe' });
  try {
    const r = await s.br.make({});
    assert.equal(r.app, 'Buggy Game');
    assert.match(r.name, /^Bug report Buggy Game /);
    assert.match(unzipNames(path.join(s.out, r.name))['system.txt'].toString(), /App in front: Buggy Game\.exe/);
  } finally { s.done(); }
});

test('Instant Replay off: no video, and the README says how to get it next time', async () => {
  const s = setup({ replayOff: true });
  try {
    const r = await s.br.make({});
    assert.equal(r.ok, true);
    assert.equal(r.video, 0);
    assert.equal(r.noVideo, 'off');
    const z = unzipNames(path.join(s.out, r.name));
    assert.equal('video.mp4' in z, false);
    assert.match(z['README.txt'].toString(), /No video: Instant Replay is off\. Turn it on/);
  } finally { s.done(); }
});

test('Instant Replay on but waiting for a game, or saving: the README never says to turn it on', async () => {
  for (const [error, said] of [['not_running', /is on but was not recording/], ['saving', /busy saving a clip/], ['save_failed', /could not save the last seconds/]]) {
    const s = setup({ replayError: error });
    try {
      const r = await s.br.make({});
      assert.equal(r.noVideo, 'not_running');
      const readme = unzipNames(path.join(s.out, r.name))['README.txt'].toString();
      assert.match(readme, said);
      assert.doesNotMatch(readme, /Turn it on/);
    } finally { s.done(); }
  }
});

test('no window in front: the whole screen instead', async () => {
  const s = setup({
    shot: (body) => {
      if (body.target === 'window') return { ok: false, error: 'no_window' };
      fs.writeFileSync(body.path, 'PNG');
      return { ok: true };
    },
  });
  try {
    const r = await s.br.make({});
    assert.equal(r.screenshot, true);
    assert.deepEqual(s.calls.map(c => c.body.target), ['window', 'screen']);
  } finally { s.done(); }
});

test('a failed screenshot still gives a package, and says why', async () => {
  const s = setup({ shot: () => ({ ok: false, error: 'failed' }), app: '' });
  try {
    const r = await s.br.make({});
    assert.equal(r.ok, true);
    assert.equal(r.screenshot, false);
    assert.match(r.name, /^Bug report Desktop /);
    const z = unzipNames(path.join(s.out, r.name));
    assert.match(z['README.txt'].toString(), /No screenshot/);
    assert.match(z['system.txt'].toString(), /App in front: none/);
  } finally { s.done(); }
});

test('the log folder: plain files only, newest first, a link is never followed', async () => {
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-logs-'));
  fs.writeFileSync(path.join(logs, 'old.log'), 'old');
  fs.writeFileSync(path.join(logs, 'new.log'), 'new');
  fs.writeFileSync(path.join(logs, 'empty.log'), '');
  fs.mkdirSync(path.join(logs, 'sub'));
  fs.writeFileSync(path.join(logs, 'sub', 'inner.log'), 'inner');
  const t = Date.now() / 1000;
  fs.utimesSync(path.join(logs, 'old.log'), t - 3600, t - 3600);
  const s = setup({ logFolder: async () => ({ dir: logs }), now: Date.now() });
  try {
    const r = await s.br.make({});
    assert.equal(r.logs, 2);
    const z = unzipNames(path.join(s.out, r.name));
    assert.equal(z['logs/new.log'].toString(), 'new');
    assert.equal(z['logs/old.log'].toString(), 'old');
    assert.equal('logs/empty.log' in z, false);
    assert.equal(Object.keys(z).some(n => n.includes('inner')), false);
  } finally { s.done(); fs.rmSync(logs, { recursive: true, force: true }); }
});

test('a chosen log folder that is gone: the package says so', async () => {
  const s = setup({ logFolder: async () => ({ dir: '', missing: true }) });
  try {
    const r = await s.br.make({});
    assert.equal(r.logsMissing, true);
    assert.match(unzipNames(path.join(s.out, r.name))['README.txt'].toString(), /log folder chosen in Xenon is not there/);
  } finally { s.done(); }
});

test('log limits: 20 files, 50 MB, a week old at most, a big log keeps its newest 20 MB', () => {
  const now = 1e12;
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.log`, file: `x${i}`, size: 10, mtimeMs: now - i, isFile: true }));
  assert.equal(BR.pickLogs(many, now).length, BR.LOG_MAX_FILES);
  assert.equal(BR.pickLogs(many, now)[0].name, 'f0.log');
  const old = [{ name: 'a', file: 'a', size: 5, mtimeMs: now - BR.LOG_MAX_AGE_MS - 1, isFile: true }];
  assert.deepEqual(BR.pickLogs(old, now), []);
  const big = [{ name: 'big.log', file: 'b', size: 30 * 1024 * 1024, mtimeMs: now, isFile: true }];
  const [b] = BR.pickLogs(big, now);
  assert.equal(b.cut, true);
  assert.equal(b.start, 10 * 1024 * 1024);
  const heavy = Array.from({ length: 4 }, (_, i) => ({ name: `h${i}`, file: `h${i}`, size: 20 * 1024 * 1024, mtimeMs: now - i, isFile: true }));
  assert.equal(BR.pickLogs(heavy, now).length, 2, '50 MB in total');
  assert.deepEqual(BR.pickLogs([{ name: 'l', file: 'l', size: 9, mtimeMs: now, isFile: false }], now), []);
});

test('a big log goes in with its newest part only', async () => {
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-logs-'));
  const size = BR.LOG_MAX_FILE + 1000;
  const buf = Buffer.alloc(size, 0x61);
  buf.write('THE END', size - 7);
  fs.writeFileSync(path.join(logs, 'huge.log'), buf);
  const s = setup({ logFolder: async () => ({ dir: logs }), now: Date.now() });
  try {
    const r = await s.br.make({});
    const z = unzipNames(path.join(s.out, r.name));
    assert.equal(z['logs/huge.log'].length, BR.LOG_MAX_FILE);
    assert.equal(z['logs/huge.log'].toString('utf8', BR.LOG_MAX_FILE - 7), 'THE END');
    assert.match(z['README.txt'].toString(), /huge\.log \(its newest 20 MB\)/);
  } finally { s.done(); fs.rmSync(logs, { recursive: true, force: true }); }
});

test('one package at a time; no engine = unavailable; "show" needs a package', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.br.reveal(), { ok: false, error: 'no_file' });
    const a = s.br.make({});
    assert.deepEqual(await s.br.make({}), { ok: false, error: 'busy' });
    const r = await a;
    const shown = await s.br.reveal();
    assert.equal(shown.ok, true);
    assert.equal(shown.name, r.name);
    assert.equal(s.shown.length, 1);
  } finally { s.done(); }
  const off = BR.createBugReport({ host: { available: () => false }, fs: fs.promises, writeZip, tmpRoot: os.tmpdir(), defaultDir: async () => '' });
  assert.deepEqual(await off.make({}), { ok: false, error: 'unavailable' });
});

test('seconds: 10, 30 or 60, anything else is 30; app names fit a file name', () => {
  assert.equal(BR.secondsOf(60), 60);
  assert.equal(BR.secondsOf('10'), 10);
  assert.equal(BR.secondsOf(45), 30);
  assert.equal(BR.appName('My:App?.exe'), 'MyApp');
  assert.equal(BR.appName(''), 'Desktop');
});

test('the date in README and system.txt is one plain format, whatever the language', () => {
  assert.match(BR.whenOf(Date.UTC(2026, 9, 27, 12, 0, 5)), /^2026-10-27 \d\d:00:05 \(UTC[+-]\d\d:\d\d\)$/);
});

// "Show" after a restart: the last package is remembered (capture-last.js) and
// read back only when it is named like one this server writes.
test('the last package survives a restart, checked and only while it is on disk', async () => {
  const kept = [];
  const s = setup({ remember: { load: async () => null, save: (v) => kept.push(v) } });
  try {
    const r = await s.br.make({});
    assert.deepEqual(kept, [{ file: path.join(s.out, r.name), name: r.name }]);
    const after = setup({ remember: { load: async () => kept[0], save: () => {} } });
    try {
      const shown = await after.br.reveal();
      assert.equal(shown.ok, true);
      assert.deepEqual(after.shown, [kept[0].file]);
    } finally { after.done(); }
    fs.rmSync(kept[0].file);
    const gone = setup({ remember: { load: async () => kept[0], save: () => {} } });
    try { assert.deepEqual(await gone.br.reveal(), { ok: false, error: 'no_file' }); } finally { gone.done(); }
    for (const bad of [
      { file: 'C:\\Windows\\notepad.exe', name: 'notepad.exe' },
      { file: path.join(s.out, 'x.zip'), name: 'x.zip' },
      { file: 'Bug report a.zip', name: 'Bug report a.zip' },
      { file: path.join(s.out, r.name), name: 'Bug report other.zip' },
    ]) {
      const x = setup({ remember: { load: async () => bad, save: () => {} } });
      try {
        assert.deepEqual(await x.br.reveal(), { ok: false, error: 'no_file' }, JSON.stringify(bad));
        assert.equal(x.shown.length, 0);
      } finally { x.done(); }
    }
  } finally { s.done(); }
});

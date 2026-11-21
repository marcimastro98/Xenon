// The Xenon Pump widget for iCUE: the package the server builds (pump-screen/icue.js),
// the route that opens it with iCUE, and the widget's own script (icue-package/), run
// here with a stand-in page because iCUE itself only runs on a PC with a pump.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Icue = require('../pump-screen/icue.js');
const { createPumpActions } = require('../pump-screen/actions.js');
const { remoteMayRun } = require('../paired/remote-actions.js');

const SCRIPT = join(Icue.PACKAGE_DIR, 'scripts', 'pump.js');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-pump-icue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [relative(Icue.PACKAGE_DIR, full).replace(/\\/g, '/')];
  });
}

// name -> contents, read back from the zip's central directory.
function unzip(buf) {
  const out = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n -= 1) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const skip = nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    at += 46 + skip;
  }
  return out;
}

test('the package lists every file of its folder, and only those', () => {
  assert.deepEqual([...Icue.PACKAGE_FILES].sort(), filesUnder(Icue.PACKAGE_DIR).sort());
});

test('the built widget holds those files and asks iCUE for the pump screen and Xenon only', async (t) => {
  const file = await Icue.buildPackage(tempDir(t));
  assert.ok(file.endsWith(Icue.FILE_NAME));
  const entries = unzip(readFileSync(file));
  assert.deepEqual(Object.keys(entries).sort(), [...Icue.PACKAGE_FILES].sort());
  const manifest = JSON.parse(entries['manifest.json'].toString('utf8'));
  assert.equal(manifest.id, 'com.marcimastro98.xenonpump');
  assert.equal(manifest.interactive, false);
  assert.deepEqual(manifest.supported_devices, [{ type: 'pump_lcd' }]);
  assert.deepEqual(manifest.permissions, [
    { type: 'url', domain: '127.0.0.1', port: 3030 },
    { type: 'url', domain: 'localhost', port: 3030 },
  ]);
  assert.equal(entries['scripts/pump.js'].toString('utf8'), readFileSync(SCRIPT, 'utf8'));
});

test('every word of the widget is in each of iCUE\'s languages', () => {
  const tr = JSON.parse(readFileSync(join(Icue.PACKAGE_DIR, 'translation.json'), 'utf8'));
  const html = readFileSync(join(Icue.PACKAGE_DIR, 'index.html'), 'utf8');
  const script = readFileSync(SCRIPT, 'utf8');
  const asked = new Set([...html.matchAll(/tr\('([^']+)'\)/g), ...script.matchAll(/text\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(asked.size >= 8);
  for (const lang of ['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'zh_CN', 'zh_TW', 'uk']) {
    const words = tr[lang]?.translation;
    assert.ok(words, lang);
    for (const key of asked) assert.ok(typeof words[key] === 'string' && words[key].trim(), `${lang}: ${key}`);
  }
});

test('the widget script uses nothing iCUE\'s package check refuses', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  // icuewidget validate (CLI 0.2.3) reads ES2019: no ?. or ??, no catch without a binding.
  assert.doesNotMatch(src, /\?\.|\?\?|catch\s*\{/);
});

test('opening with iCUE: Windows only, a missing iCUE said, one build at a time', async (t) => {
  const dir = tempDir(t);
  const opened = [];
  const warned = [];
  const warn = (msg) => warned.push(msg);
  const off = await Icue.openInIcue({ platform: 'linux', dir, open: async (p) => opened.push(p), warn });
  assert.deepEqual(off, { ok: false, error: 'unavailable' });
  assert.equal(opened.length, 0);

  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const open = async (p) => { opened.push(p); await slow; return { ok: true }; };
  const first = Icue.openInIcue({ platform: 'win32', dir, open, warn });
  const second = Icue.openInIcue({ platform: 'win32', dir, open, warn });
  await new Promise((r) => setTimeout(r, 50));
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(opened, [join(dir, Icue.FILE_NAME)]);

  assert.deepEqual(await Icue.openInIcue({ platform: 'win32', dir, open: async () => ({ ok: false, error: 'x' }), warn }), { ok: false, error: 'no_icue' });
  assert.deepEqual(await Icue.openInIcue({ platform: 'win32', dir, open: async () => { throw new Error('spawn'); }, warn }), { ok: false, error: 'no_icue' });
  assert.equal(warned.length, 1);
});

test('the iCUE action answers what opening did, and a paired phone can never run it', async () => {
  const run = (opts) => createPumpActions({ store: {}, live: {}, change: async () => ({}), ...opts }).run({ type: 'pumpIcue' });
  assert.deepEqual(await run({}), { ok: false, error: 'unavailable' });
  assert.deepEqual(await run({ openIcue: async () => ({ ok: true }) }), { ok: true });
  assert.equal(remoteMayRun({ type: 'pumpIcue' }, {}).ok, false, 'it starts iCUE on the PC');
  assert.equal(remoteMayRun({ type: 'pumpFace', face: 'clock' }, {}).ok, true, "what the pump shows is the phone's too");
});

// ── The widget's script, in a stand-in page ─────────────────────────────────
function widget({ props = {}, preview = false } = {}) {
  // src counts its loads: a frame given the same address again reloads.
  const node = () => {
    let src = '';
    const el = {
      hidden: true, textContent: '', loads: 0, classes: new Set(), classList: null,
      removeAttribute(name) { if (name === 'src') src = ''; },
    };
    Object.defineProperty(el, 'src', { get: () => src, set(v) { src = v; el.loads += 1; } });
    return el;
  };
  const els = {};
  for (const id of ['face', 'closed', 'closed-time', 'closed-line']) {
    const el = node();
    el.classList = {
      toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)),
      remove: (c) => el.classes.delete(c),
    };
    els[id] = el;
  }
  const xenon = { up: true, pings: 0 };
  const win = { ...props };
  if (preview) {
    win.__icueChannel = { objects: { w1: { isPreview: true, iCUEGlobalObject: {}, isPreviewChanged: { connect() {} } } } };
  }
  const intervals = new Set();
  const timers = new Map();
  let nextId = 1;
  const document = {
    getElementById: (id) => els[id],
    head: { append() {} },
    createElement() {
      const script = { remove() {} };
      Object.defineProperty(script, 'src', {
        set(url) {
          xenon.pings += 1;
          xenon.lastPing = url;
          const cb = /cb=(\w+)/.exec(url)[1];
          queueMicrotask(() => (xenon.up ? win[cb]() : script.onerror()));
        },
      });
      return script;
    },
  };
  const context = vm.createContext({
    window: win, document, Intl, Date, Promise, queueMicrotask,
    setTimeout: (fn, ms) => { timers.set(nextId, { fn, ms }); return nextId++; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => { const id = {}; intervals.add(id); return id; },
    clearInterval: (id) => intervals.delete(id),
  });
  vm.runInContext(readFileSync(SCRIPT, 'utf8'), context);
  const settle = () => new Promise((r) => setImmediate(r));
  // Runs the widget's next scheduled look for Xenon (5 s closed, 15 s open).
  const nextCheck = async () => {
    const due = [...timers].filter(([, t]) => t.ms >= 5000);
    for (const [id, t] of due) { timers.delete(id); t.fn(); }
    await settle();
    return due.length;
  };
  return { els, win, xenon, intervals, settle, nextCheck, start: () => win.XenonPump.start() };
}

test('the widget frames the face page for its screen, with a clean name and a known shape', async () => {
  const w = widget({ props: { screenName: '  Desk Pump!! ', shape: 'round' } });
  w.start();
  await w.settle();
  assert.equal(w.xenon.lastPing.startsWith('http://127.0.0.1:3030/status?cb='), true);
  assert.equal(w.els.face.src, 'http://127.0.0.1:3030/pump-face?screen=desk-pump&via=icue&shape=round');
  assert.equal(w.els.face.hidden, false);
  assert.equal(w.els.closed.hidden, true);

  w.win.screenName = 'second';
  w.win.shape = 'x&y=1';
  w.win.XenonPump.settingsChanged();
  assert.equal(w.els.face.src, 'http://127.0.0.1:3030/pump-face?screen=second&via=icue');
});

test('Xenon closed: one missed look keeps the face, two show the clock; back again reloads the face', async () => {
  const w = widget();
  w.start();
  await w.settle();
  assert.equal(w.els.face.loads, 1);

  w.xenon.up = false;
  assert.equal(await w.nextCheck(), 1);
  assert.equal(w.els.face.hidden, false, 'one miss: Xenon may be restarting for an update');
  w.xenon.up = true;
  await w.nextCheck();
  assert.equal(w.els.face.loads, 2, 'a frame that loaded during the restart is reloaded');

  w.xenon.up = false;
  await w.nextCheck();
  await w.nextCheck();
  assert.equal(w.els.face.hidden, true);
  assert.equal(w.els.face.src, '', 'the face page stops retrying a server that is gone');
  assert.equal(w.els.closed.hidden, false);
  assert.equal(w.els['closed-line'].textContent, 'Xenon is not running');
  assert.match(w.els['closed-time'].textContent, /\d/);
  assert.equal(w.intervals.size, 1, 'the clock ticks');

  w.xenon.up = true;
  await w.nextCheck();
  assert.equal(w.els.face.hidden, false);
  assert.equal(w.els.closed.hidden, true);
  assert.equal(w.intervals.size, 0, 'the clock stops');
});

test('the widget names its screen the way Xenon does, so a Deck key or Bit finds it', async () => {
  const Model = require('../js/pump/pump-model.js');
  for (const name of ['Desk Pump', ' -Top_AIO 2 ', 'Pompa scrivania', 'ÉCRAN', 'a'.repeat(40), '!!!']) {
    const w = widget({ props: { screenName: name } });
    w.start();
    await w.settle();
    const sent = new URL(w.els.face.src).searchParams.get('screen');
    assert.equal(sent, Model.screenId(name) || 'pump', name);
  }
});

test('"stay dark" shows nothing while Xenon is closed, and iCUE\'s preview copy never frames Xenon', async () => {
  const dark = widget({ props: { whenClosed: 'dark' } });
  dark.xenon.up = false;
  dark.start();
  await dark.settle();
  assert.ok(dark.els.closed.classes.has('closed-dark'));
  assert.equal(dark.intervals.size, 0);

  const preview = widget({ preview: true });
  preview.start();
  await preview.settle();
  assert.equal(preview.xenon.pings, 0);
  assert.equal(preview.els.face.src, '');
  assert.equal(preview.els.closed.hidden, false);
});

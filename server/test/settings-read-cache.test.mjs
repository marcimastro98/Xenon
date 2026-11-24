// The settings read answered from memory while the file is unchanged (server/settings/read.js):
// with custom themes the file is about 1.5 MB, and some places read it every couple of seconds
// (24 Nov 2026). Every change must still be seen, and no caller may change another's copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, renameSync, rmSync, statSync, utimesSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createSettingsReader } = require('../settings/read.js');

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'xenon-settings-read-'));
  return { file: join(root, 'settings.json'), root, done: () => rmSync(root, { recursive: true, force: true }) };
}

// fs.promises with its reads of the file counted.
function counted() {
  const io = { reads: 0, stat: fsp.stat.bind(fsp), readFile: (/** @type {any[]} */ ...a) => { io.reads += 1; return fsp.readFile(...a); } };
  return io;
}

const settings = (rev, extra = {}) => JSON.stringify({ rev, storeId: 'a'.repeat(32), ...extra });

test('an unchanged file is read once; each caller gets a copy of its own', async () => {
  const d = folder();
  try {
    writeFileSync(d.file, settings(7, { sdkWidgets: { w: { size: 2 } } }));
    const io = counted();
    const reader = createSettingsReader(d.file, io);
    const a = await reader.read();
    const b = await reader.read();
    assert.equal(io.reads, 1);
    assert.equal(a.rev, 7);
    assert.notEqual(a, b);
    assert.notEqual(a.sdkWidgets, b.sdkWidgets, 'nested objects are copies too');
    assert.deepEqual(a, b);
    a.rev = 99;
    a.sdkWidgets.w.size = 9;
    a.gameIgnore.push('game.exe');
    const c = await reader.read();
    assert.equal(c.rev, 7, 'a change to one copy reaches nobody else');
    assert.equal(c.sdkWidgets.w.size, 2);
    assert.deepEqual(c.gameIgnore, [], 'lists are copies too');
  } finally { d.done(); }
});

test('a save put in place is seen, even with the same size and the old time', async () => {
  const d = folder();
  try {
    // Whole seconds, so the new file can carry exactly the old time.
    const then = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(d.file, settings(1));
    utimesSync(d.file, then, then);
    const reader = createSettingsReader(d.file);
    assert.equal((await reader.read()).rev, 1);
    writeFileSync(`${d.file}.tmp`, settings(2));
    utimesSync(`${d.file}.tmp`, then, then);
    const [was, now] = [statSync(d.file, { bigint: true }), statSync(`${d.file}.tmp`, { bigint: true })];
    assert.ok(was.size === now.size && was.mtimeNs === now.mtimeNs, 'same size and time');
    renameSync(`${d.file}.tmp`, d.file);
    assert.equal((await reader.read()).rev, 2);
  } finally { d.done(); }
});

test('a change written over the file is seen', async () => {
  const d = folder();
  try {
    writeFileSync(d.file, settings(1));
    const reader = createSettingsReader(d.file);
    assert.equal((await reader.read()).rev, 1);
    writeFileSync(d.file, settings(3));
    const later = new Date(Date.now() + 5000);
    utimesSync(d.file, later, later);
    assert.equal((await reader.read()).rev, 3);
  } finally { d.done(); }
});

test('forget reads the file again, for a disk whose times do not move', async () => {
  const d = folder();
  try {
    writeFileSync(d.file, settings(1));
    const io = counted();
    const same = await fsp.stat(d.file, { bigint: true });
    io.stat = async () => same;
    const reader = createSettingsReader(d.file, io);
    await reader.read();
    writeFileSync(d.file, settings(2));
    assert.equal((await reader.read()).rev, 1, 'the look sees nothing new');
    reader.forget();
    assert.equal((await reader.read()).rev, 2);
    assert.equal(io.reads, 2);
  } finally { d.done(); }
});

test('no file is null, and a file made later is read', async () => {
  const d = folder();
  try {
    const reader = createSettingsReader(d.file);
    assert.equal(await reader.read(), null);
    writeFileSync(d.file, settings(4));
    assert.equal((await reader.read()).rev, 4);
    rmSync(d.file);
    assert.equal(await reader.read(), null, 'gone again');
  } finally { d.done(); }
});

test('a broken file fails every read, never the copy kept before it', async () => {
  const d = folder();
  try {
    writeFileSync(d.file, settings(5));
    const reader = createSettingsReader(d.file);
    await reader.read();
    writeFileSync(d.file, '{ "rev": ');
    const later = new Date(Date.now() + 5000);
    utimesSync(d.file, later, later);
    await assert.rejects(reader.read(), SyntaxError);
    await assert.rejects(reader.read(), SyntaxError, 'still broken');
    writeFileSync(d.file, settings(6));
    utimesSync(d.file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    assert.equal((await reader.read()).rev, 6);
  } finally { d.done(); }
});

test('a file another program holds for a moment is read once it lets go', async () => {
  const d = folder();
  try {
    writeFileSync(d.file, settings(8));
    let refusals = 2;
    const io = { stat: async (/** @type {any[]} */ ...a) => { if (refusals-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fsp.stat(...a); }, readFile: fsp.readFile.bind(fsp) };
    const reader = createSettingsReader(d.file, io);
    assert.equal((await reader.read()).rev, 8);
  } finally { d.done(); }
});

test('a key named __proto__ stays a key in the copy and never becomes its prototype', async () => {
  const d = folder();
  try {
    writeFileSync(d.file, '{"rev":1,"sdkWidgets":{"__proto__":{"polluted":true}}}');
    const reader = createSettingsReader(d.file);
    const fresh = await reader.read();
    const copy = await reader.read();
    assert.deepEqual(copy, fresh);
    assert.equal(Object.getPrototypeOf(copy.sdkWidgets), Object.prototype);
    assert.equal(copy.sdkWidgets.polluted, undefined);
    assert.ok(Object.keys(copy.sdkWidgets).includes('__proto__'));
  } finally { d.done(); }
});

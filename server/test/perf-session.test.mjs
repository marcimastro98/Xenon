// The pieces under Performance Mode with no PowerShell in the path (server/perf-session/):
// the process table of each OS, the power plan, the priority boost, the fence that moves
// apps aside, and the record that puts them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindowsProcessTable, parseProcessTable, ENTRY } = require('../perf-session/process-table-windows.js');
const { createPowerPlan, HIGH, ULTIMATE } = require('../perf-session/power-plan.js');
const { createPriority } = require('../perf-session/priority.js');
const { processKey, isProtected, leftAlone } = require('../perf-session/process-names.js');
const { pickFence } = require('../perf-session/fence-pick.js');
const { createWindowsFence, parseCpuSets } = require('../perf-session/fence-windows.js');
const { createLinuxFence, parseCpuInfo, parseCpuList } = require('../perf-session/fence-linux.js');
const { createDarwinFence } = require('../perf-session/fence-darwin.js');
const { createLedger, normalizeRecord } = require('../perf-session/ledger.js');
const { shieldWish } = require('../perf-session/shield-wish.js');
const { createPerfSession } = require('../perf-session/index.js');
const linux = require('../linux-collectors.js');
const darwin = require('../darwin-collectors.js');

const { PRIORITY_NORMAL: NORMAL, PRIORITY_BELOW_NORMAL: BELOW, PRIORITY_ABOVE_NORMAL: ABOVE, PRIORITY_HIGH: HIGH_LEVEL } = os.constants.priority;

// ── the Windows process table ────────────────────────────────────────────────

const BASE = 0x7000_0000n;
const ENTRY_BYTES = 256;
const NAME_AT = 200;

function writeEntry(buffer, at, { pid, ppid = 1, name = 'app.exe', cpu100ns = 0n, kernel100ns = 0n, memory = 0n, created = 0n, session = 1, last = false, pointer }) {
  buffer.writeUInt32LE(last ? 0 : ENTRY_BYTES, at + ENTRY.next);
  buffer.writeBigInt64LE(created, at + ENTRY.createTime);
  buffer.writeBigInt64LE(cpu100ns, at + ENTRY.userTime);
  buffer.writeBigInt64LE(kernel100ns, at + ENTRY.kernelTime);
  const bytes = Buffer.from(name, 'utf16le');
  bytes.copy(buffer, at + NAME_AT);
  buffer.writeUInt16LE(bytes.length, at + ENTRY.nameLength);
  buffer.writeBigUInt64LE(pointer === undefined ? BASE + BigInt(at + NAME_AT) : pointer, at + ENTRY.namePointer);
  buffer.writeBigUInt64LE(BigInt(pid), at + ENTRY.pid);
  buffer.writeBigUInt64LE(BigInt(ppid), at + ENTRY.parentPid);
  buffer.writeUInt32LE(session, at + ENTRY.session);
  buffer.writeBigUInt64LE(memory, at + ENTRY.workingSet);
}

function tableBuffer(entries) {
  const buffer = Buffer.alloc(entries.length * ENTRY_BYTES);
  entries.forEach((e, i) => writeEntry(buffer, i * ENTRY_BYTES, { ...e, last: i === entries.length - 1 }));
  return buffer;
}

test('a row of the table carries what the rest of the mode needs', () => {
  const buffer = tableBuffer([{ pid: 4242, ppid: 11, name: 'Game.EXE', cpu100ns: 20_000n, kernel100ns: 10_000n, memory: 1_048_576n, created: 50_000n, session: 2 }]);
  assert.deepEqual(parseProcessTable(buffer, buffer.length, BASE), [
    { pid: 4242, ppid: 11, name: 'game', cpuMs: 3, memBytes: 1_048_576, startedAt: 5, owner: 2 },
  ]);
});

test('the idle process and the kernel are not apps, and the list ends where the kernel says', () => {
  const buffer = tableBuffer([{ pid: 0, name: '' }, { pid: 4, name: 'System' }, { pid: 8, name: 'a.exe' }, { pid: 9, name: 'b.exe' }]);
  assert.deepEqual(parseProcessTable(buffer, buffer.length, BASE).map((r) => r.pid), [8, 9]);
  buffer.writeUInt32LE(0, 2 * ENTRY_BYTES + ENTRY.next);
  assert.deepEqual(parseProcessTable(buffer, buffer.length, BASE).map((r) => r.pid), [8]);
});

test('a name outside the buffer is no name, not a read of somebody else\'s memory', () => {
  // Each one starts or ends a little past the edge, where a clamped read would still return text.
  const buffer = tableBuffer([{ pid: 8, pointer: BASE + BigInt(2 * ENTRY_BYTES - 2) }, { pid: 9, pointer: BASE - 2n }]);
  assert.deepEqual(parseProcessTable(buffer, buffer.length, BASE).map((r) => r.name), ['', '']);
});

const fakeQuery = (answer) => {
  const query = () => { throw new Error('sync call'); };
  query.async = (...args) => { const done = args.pop(); answer(done, ...args); };
  return query;
};

test('the table grows when the kernel asks for more room', async () => {
  const sizes = [];
  const entries = tableBuffer([{ pid: 8 }]);
  const query = fakeQuery((done, _cls, buffer, size, needed) => {
    sizes.push(size);
    if (sizes.length === 1) { needed[0] = 3 << 20; return done(null, 0xC0000004 | 0); }
    entries.copy(buffer);
    needed[0] = entries.length;
    return done(null, 0);
  });
  const table = createWindowsProcessTable({ load: () => ({ query, address: () => BASE }) });
  assert.deepEqual((await table.read()).map((r) => r.pid), [8]);
  assert.ok(sizes[1] >= 3 << 20, 'with some room on top of what it asked for');
});

test('a table that never fits, or a failed call, is nobody answering', async () => {
  const noRoom = fakeQuery((done, _cls, _buffer, size, needed) => { needed[0] = size; done(null, 0xC0000004 | 0); });
  assert.equal(await createWindowsProcessTable({ load: () => ({ query: noRoom, address: () => BASE }) }).read(), null);
  const denied = fakeQuery((done) => done(null, 0xC0000022 | 0));
  assert.equal(await createWindowsProcessTable({ load: () => ({ query: denied, address: () => BASE }) }).read(), null);
  const thrown = fakeQuery((done) => done(new Error('boom')));
  assert.equal(await createWindowsProcessTable({ load: () => ({ query: thrown, address: () => BASE }) }).read(), null);
});

test('without the native library it says so, and loads it once', async () => {
  let loads = 0;
  const table = createWindowsProcessTable({ load: () => { loads += 1; throw new Error('no koffi'); } });
  assert.equal(table.available(), false);
  assert.equal(await table.read(), null);
  assert.equal(loads, 1);
});

// ── the rows of Linux and macOS ──────────────────────────────────────────────

test('Linux rows know their parent and when they started', () => {
  const after = ['S', '321', '0', '0', '0', '0', '0', '0', '0', '0', '0', '150', '50', '0', '0', '20', '0', '1', '0', '98765', '0', '2500'];
  const row = linux.parseProcStat('4242 (Web Content) ' + after.join(' '));
  assert.equal(row.ppid, 321);
  assert.equal(row.startTicks, 98765);
  assert.equal(row.rssPages, 2500);
});

test('macOS rows read every column of ps', () => {
  const text = [
    '  101     1   501   2048   0:01.50 Sat Nov  7 18:00:00 2026 /Applications/Handbrake.app/Contents/MacOS/HandBrake',
    '  102   101     0    512   0:00.10 Sat Nov  7 18:00:05 2026 /usr/libexec/some tool',
    'not a row',
  ].join('\n');
  const rows = darwin.parsePsTable(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 101, ppid: 1, name: 'handbrake', cpuMs: 1500, memBytes: 2048 * 1024, startedAt: Date.parse('Sat Nov  7 18:00:00 2026'), owner: 501 });
  assert.equal(rows[1].name, 'some tool');
  assert.equal(rows[1].owner, 0);
});

test('each OS answers with the same table function', () => {
  assert.equal(typeof linux.processTable, 'function');
  assert.equal(typeof darwin.processTable, 'function');
});

// ── names ────────────────────────────────────────────────────────────────────

test('names are compared bare and lowercase', () => {
  assert.equal(processKey('  Game.EXE '), 'game');
  assert.equal(processKey(null), '');
});

test('what keeps the system, the sound and the picture going is left alone', () => {
  for (const name of ['dwm', 'audiodg', 'explorer', 'discord', 'voicemeeter8x64', 'nvcontainer', 'gameoverlayui64', 'pipewire', 'wineserver', 'xorg', 'windowserver', 'xenon', 'xenon-helper', 'xenon-capture']) {
    assert.ok(leftAlone(name), name);
  }
  assert.ok(!leftAlone('handbrake'));
  assert.ok(!leftAlone('chrome'));
  assert.ok(isProtected('lsass'));
  assert.ok(!isProtected('discord'), 'protected is the priority rule: a user may still boost Discord');
});

// ── the power plan ───────────────────────────────────────────────────────────

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const answer = (guid) => 'Power Scheme GUID: ' + guid + '  (some plan)\n';

function fakePowercfg(start) {
  const s = { active: start, calls: [] };
  s.run = async (args) => {
    s.calls.push(args);
    if (args[0] === '/getactivescheme') return answer(s.active);
    if (args[0] === '/setactive') s.active = args[1];
    return '';
  };
  return s;
}

test('the plan answers in any language: only the GUID is read', async () => {
  const p = fakePowercfg(BALANCED);
  p.run = async () => 'GUID combinazione risparmio energia: ' + BALANCED.toUpperCase() + '  (Bilanciato)\n';
  assert.deepEqual(await createPowerPlan({ run: p.run }).get(), { ok: true, guid: BALANCED });
});

test('a plan nobody can read is an error, not a guess', async () => {
  assert.equal((await createPowerPlan({ run: async () => 'nothing here' }).get()).ok, false);
  assert.equal((await createPowerPlan({ run: async () => { throw new Error('nope'); } }).get()).error, 'nope');
});

test('switching says what it did and checks it took', async () => {
  const p = fakePowercfg(BALANCED);
  assert.deepEqual(await createPowerPlan({ run: p.run }).set('high'), { ok: true, guid: HIGH });
  assert.equal(p.active, HIGH);
  const stuck = fakePowercfg(BALANCED);
  const run = async (args) => (args[0] === '/setactive' ? '' : answer(BALANCED));
  assert.deepEqual(await createPowerPlan({ run }).set('high'), { ok: false, error: 'scheme not applied' });
  assert.equal(stuck.calls.length, 0);
});

test('a plan already on changes nothing and says so', async () => {
  const p = fakePowercfg(HIGH);
  assert.deepEqual(await createPowerPlan({ run: p.run }).set('high'), { ok: true, guid: HIGH, unchanged: true });
  assert.ok(!p.calls.some((c) => c[0] === '/setactive'));
});

test('a saved plan comes back by its GUID, and nothing else gets through', async () => {
  const p = fakePowercfg(HIGH);
  assert.equal((await createPowerPlan({ run: p.run }).set(BALANCED.toUpperCase())).guid, BALANCED);
  for (const bad of ['', null, 'scheme_max', '; del', BALANCED + 'x']) {
    assert.deepEqual(await createPowerPlan({ run: p.run }).set(bad), { ok: false, error: 'bad_value' });
  }
});

test('Ultimate keeps one plan: the copy is named after the original', async () => {
  const p = fakePowercfg(BALANCED);
  await createPowerPlan({ run: p.run }).set('ultimate');
  assert.deepEqual(p.calls.find((c) => c[0] === '/duplicatescheme'), ['/duplicatescheme', ULTIMATE, ULTIMATE]);
  const already = fakePowercfg(ULTIMATE);
  await createPowerPlan({ run: already.run }).set('ultimate');
  assert.ok(!already.calls.some((c) => c[0] === '/duplicatescheme'), 'a session on Ultimate adds nothing');
});

test('Ultimate that cannot be copied still tries to switch', async () => {
  const p = fakePowercfg(BALANCED);
  const run = async (args) => { if (args[0] === '/duplicatescheme') throw new Error('exists'); return p.run(args); };
  assert.equal((await createPowerPlan({ run }).set('ultimate')).ok, true);
});

// ── the priority boost ───────────────────────────────────────────────────────

function fakeSystem(levels) {
  return {
    levels,
    getPriority: (pid) => { if (!(pid in levels)) throw new Error('gone'); return levels[pid]; },
    setPriority: (pid, level) => { if (levels[pid] === 'denied') throw new Error('EPERM'); levels[pid] = level; },
  };
}
const tableOf = (rows) => ({ read: async () => rows });
const proc = (pid, name, startedAt = 1) => ({ pid, name, startedAt });

test('a boost raises to AboveNormal and the restore gives back the level it found', async () => {
  const system = fakeSystem({ 1: NORMAL, 2: BELOW });
  const p = createPriority({ table: tableOf([proc(1, 'game'), proc(2, 'game')]), system });
  assert.deepEqual(await p.set('Game.exe', 'high'), { ok: true, count: 2 });
  assert.deepEqual([system.levels[1], system.levels[2]], [ABOVE, ABOVE]);
  await p.set('game', 'normal');
  assert.deepEqual([system.levels[1], system.levels[2]], [NORMAL, BELOW]);
});

test('a game already above that is never lowered, and keeps its level at the end', async () => {
  const system = fakeSystem({ 1: HIGH_LEVEL });
  const p = createPriority({ table: tableOf([proc(1, 'game')]), system });
  await p.set('game', 'high');
  assert.equal(system.levels[1], HIGH_LEVEL);
  await p.set('game', 'normal');
  assert.equal(system.levels[1], HIGH_LEVEL);
});

test('after a server restart only the level says what the session did', async () => {
  const system = fakeSystem({ 1: ABOVE, 2: HIGH_LEVEL, 3: NORMAL });
  const p = createPriority({ table: tableOf([proc(1, 'game'), proc(2, 'game'), proc(3, 'game')]), system });
  await p.set('game', 'normal');
  assert.deepEqual([system.levels[1], system.levels[2], system.levels[3]], [NORMAL, HIGH_LEVEL, NORMAL]);
});

test('a pid reused by another process does not get the saved level', async () => {
  const system = fakeSystem({ 1: NORMAL });
  const rows = [proc(1, 'game', 1)];
  const p = createPriority({ table: { read: async () => rows }, system });
  await p.set('game', 'high');
  rows[0] = proc(1, 'game', 2);
  system.levels[1] = HIGH_LEVEL;
  await p.set('game', 'normal');
  assert.equal(system.levels[1], HIGH_LEVEL);
});

test('it refuses what the system needs, before looking anything up', async () => {
  let reads = 0;
  const p = createPriority({ table: { read: async () => { reads += 1; return []; } }, system: fakeSystem({}) });
  for (const name of ['lsass', 'csrss.exe', 'DWM', '']) assert.deepEqual(await p.set(name, 'high'), { ok: false, error: 'protected' });
  assert.equal(reads, 0);
});

test('four answers that mean four different things', async () => {
  const none = createPriority({ table: tableOf([]), system: fakeSystem({}) });
  assert.deepEqual(await none.set('game', 'high'), { ok: false, error: 'not_found' });
  const blind = createPriority({ table: { read: async () => null }, system: fakeSystem({}) });
  assert.deepEqual(await blind.set('game', 'high'), { ok: false, error: 'unavailable' });
  const locked = createPriority({ table: tableOf([proc(1, 'game')]), system: { getPriority: () => { throw new Error('EPERM'); } } });
  assert.deepEqual(await locked.set('game', 'high'), { ok: false, error: 'denied' });
});

test('is it running: yes, no, or nobody could say', async () => {
  const p = createPriority({ table: tableOf([proc(1, 'game')]), system: fakeSystem({}) });
  assert.deepEqual(await p.isRunning('Game.exe'), { ok: true, running: true });
  assert.deepEqual(await p.isRunning('other'), { ok: true, running: false });
  const blind = createPriority({ table: { read: async () => null }, system: fakeSystem({}) });
  assert.deepEqual(await blind.isRunning('game'), { ok: false, error: 'unavailable' });
});

// ── which cores ──────────────────────────────────────────────────────────────

const cpus = (cores, threads = 2, efficiency = () => 0) => Array.from({ length: cores * threads }, (_, id) => {
  const core = Math.floor(id / threads);
  return { id, core, efficiency: efficiency(core) };
});

test('a quarter of the cores, the last ones, with both their threads', () => {
  assert.deepEqual(pickFence(cpus(8)), { ids: [14, 15, 12, 13], cores: 2 });
});

test('a hybrid chip gives its E-cores: the lowest efficiency class wins', () => {
  // Cores 0-7 are E-cores here, numbered first, as Windows may.
  const units = cpus(16, 1, (core) => (core < 8 ? 0 : 1));
  assert.deepEqual(pickFence(units), { ids: [7, 6, 5, 4], cores: 4 });
});

test('too few cores to give any away means no fence', () => {
  assert.equal(pickFence(cpus(3)), null);
  assert.equal(pickFence([]), null);
  assert.equal(pickFence(cpus(4)).cores, 1);
});

// ── the fence on Windows ─────────────────────────────────────────────────────

const CPU_SET_ROW = 32;
function cpuSetBuffer(units) {
  const buffer = Buffer.alloc(units.length * CPU_SET_ROW);
  units.forEach((u, i) => {
    const at = i * CPU_SET_ROW;
    buffer.writeUInt32LE(CPU_SET_ROW, at);
    buffer.writeUInt32LE(u.id, at + 8);
    buffer.writeUInt16LE(u.group || 0, at + 12);
    buffer[at + 15] = u.core;
    buffer[at + 18] = u.efficiency;
  });
  return buffer;
}

test('CPU sets are read by each row\'s own size', () => {
  const buffer = cpuSetBuffer([{ id: 256, core: 0, efficiency: 1 }, { id: 257, core: 3, efficiency: 0, group: 1 }]);
  assert.deepEqual(parseCpuSets(buffer, buffer.length), [
    { id: 256, core: 0, efficiency: 1 },
    { id: 257, core: 259, efficiency: 0 },
  ]);
});

function windowsRig({ levels = {}, refuses = false, units = cpus(8) } = {}) {
  const calls = { open: [], set: [], closed: 0 };
  const system = fakeSystem(levels);
  const buffer = cpuSetBuffer(units);
  const load = () => ({
    open: (access, _inherit, pid) => { calls.open.push({ access, pid }); return refuses ? null : { pid }; },
    close: () => { calls.closed += 1; return 1; },
    cpuSets: (out, _size, needed) => { needed[0] = buffer.length; if (out) buffer.copy(out); return out ? 1 : 0; },
    setDefault: (handle, ids, count) => { calls.set.push({ pid: handle.pid, ids: ids ? [...ids] : null, count }); return 1; },
  });
  return { fence: createWindowsFence({ load, system }), calls, system };
}

test('an app moves with the least access Windows has for it, and the handle is closed', async () => {
  const r = windowsRig({ levels: { 7: NORMAL } });
  assert.deepEqual(await r.fence.ready(), { cores: 2 });
  assert.deepEqual(await r.fence.apply({ pid: 7 }, null), { priority: NORMAL });
  assert.deepEqual(r.calls.open, [{ access: 0x2000, pid: 7 }]);
  assert.deepEqual(r.calls.set, [{ pid: 7, ids: [14, 15, 12, 13], count: 4 }]);
  assert.equal(r.calls.closed, 1);
  assert.equal(r.system.levels[7], BELOW);
});

test('only an app at the normal level is lowered', async () => {
  const r = windowsRig({ levels: { 7: ABOVE, 8: BELOW } });
  assert.deepEqual(await r.fence.apply({ pid: 7 }, null), { priority: undefined });
  assert.equal(r.system.levels[7], ABOVE);
  assert.deepEqual(await r.fence.apply({ pid: 8 }, null), { priority: undefined }, 'already low on its own: it stays that way');
});

test('a child that took its parent\'s low level goes back to what the parent had', async () => {
  const r = windowsRig({ levels: { 8: BELOW } });
  assert.deepEqual(await r.fence.apply({ pid: 8 }, { priority: NORMAL }), { priority: NORMAL });
  await r.fence.clear({ pid: 8, priority: NORMAL });
  assert.equal(r.system.levels[8], NORMAL);
});

test('a process that refuses is not recorded as moved', async () => {
  const r = windowsRig({ levels: { 7: NORMAL }, refuses: true });
  assert.equal(await r.fence.apply({ pid: 7 }, null), null);
  assert.equal(r.system.levels[7], NORMAL, 'and is not lowered either');
});

test('cores with no level change still count: the cores alone help', async () => {
  const r = windowsRig({});
  assert.deepEqual(await r.fence.apply({ pid: 7 }, null), { priority: undefined });
});

test('going back clears the cores and restores the level, unless someone moved it since', async () => {
  const r = windowsRig({ levels: { 7: BELOW, 8: HIGH_LEVEL } });
  assert.equal(await r.fence.clear({ pid: 7, priority: NORMAL }), true);
  assert.deepEqual(r.calls.set[0], { pid: 7, ids: null, count: 0 });
  assert.equal(r.system.levels[7], NORMAL);
  await r.fence.clear({ pid: 8, priority: NORMAL });
  assert.equal(r.system.levels[8], HIGH_LEVEL, 'moved by hand in the meantime: that choice stands');
});

test('a PC with too few cores, or no native library, has no fence on Windows', async () => {
  assert.equal(await windowsRig({ units: cpus(2) }).fence.ready(), null);
  assert.equal(await createWindowsFence({ load: () => { throw new Error('no koffi'); } }).ready(), null);
  assert.equal(await createWindowsFence({ load: () => { throw new Error('no koffi'); } }).apply({ pid: 1 }, null), null);
});

// ── the fence on Linux ───────────────────────────────────────────────────────

test('CPU lists read the way the kernel writes them', () => {
  assert.deepEqual(parseCpuList('0-3,8,10-11\n'), [0, 1, 2, 3, 8, 10, 11]);
  assert.deepEqual(parseCpuList(''), []);
});

const INTEL_BLOCK = (id, core, physical = 0) => `processor\t: ${id}\nphysical id\t: ${physical}\ncore id\t\t: ${core}\n`;

test('cpuinfo becomes cores, E-cores apart, and a kernel with no core id still counts', () => {
  const text = [INTEL_BLOCK(0, 0), INTEL_BLOCK(1, 0), INTEL_BLOCK(2, 1), INTEL_BLOCK(3, 0, 1)].join('\n');
  assert.deepEqual(parseCpuInfo(text, [2]), [
    { id: 0, core: 0, efficiency: 1 },
    { id: 1, core: 0, efficiency: 1 },
    { id: 2, core: 1, efficiency: 0 },
    { id: 3, core: 4096, efficiency: 1 },
  ]);
  assert.deepEqual(parseCpuInfo('processor\t: 0\n\nprocessor\t: 1\n', []).map((u) => u.core), [0, 1]);
});

function linuxRig({ missing = false } = {}) {
  const calls = [];
  const cpuinfo = Array.from({ length: 8 }, (_, i) => INTEL_BLOCK(i, i)).join('\n');
  const run = async (args) => { calls.push(args); if (missing) throw new Error('ENOENT'); return ''; };
  const read = async (file) => {
    if (file === '/proc/cpuinfo') return cpuinfo;
    if (file === '/proc/7/status') return 'Name:\tx\nCpus_allowed_list:\t0-7\n';
    throw new Error('no ' + file);
  };
  return { fence: createLinuxFence({ run, read }), calls };
}

test('an app moves with its threads and goes back to the list it had', async () => {
  const r = linuxRig();
  assert.deepEqual(await r.fence.ready(), { cores: 2 });
  assert.deepEqual(await r.fence.apply({ pid: 7 }, null), { cpus: '0-7' });
  assert.deepEqual(r.calls.at(-1), ['-a', '-c', '-p', '7,6', '7']);
  assert.equal(await r.fence.clear({ pid: 7, cpus: '0-7' }), true);
  assert.deepEqual(r.calls.at(-1), ['-a', '-c', '-p', '0-7', '7']);
  const calls = r.calls.length;
  assert.equal(await r.fence.clear({ pid: 7 }), false, 'a record with no list has nothing to give back');
  assert.equal(r.calls.length, calls);
});

test('a child on its parent\'s fence goes back to the parent\'s old list', async () => {
  const r = linuxRig();
  assert.deepEqual(await r.fence.apply({ pid: 9 }, { cpus: '0-7' }), { cpus: '0-7' });
});

test('a process that is gone or unreadable is not recorded as moved', async () => {
  const r = linuxRig();
  assert.equal(await r.fence.apply({ pid: 404 }, null), null);
});

test('with no taskset there is no fence, and it asks once', async () => {
  const r = linuxRig({ missing: true });
  assert.equal(await r.fence.ready(), null);
  assert.equal(await r.fence.ready(), null);
  assert.equal(r.calls.length, 1);
});

// ── the fence on macOS ───────────────────────────────────────────────────────

test('on macOS an app is marked background and the mark comes off', async () => {
  const calls = [];
  const fence = createDarwinFence({ run: async (args) => { calls.push(args); }, exists: async () => {} });
  assert.deepEqual(await fence.ready(), { cores: 0 });
  assert.deepEqual(await fence.apply({ pid: 7 }), {});
  assert.equal(await fence.clear({ pid: 7 }), true);
  assert.deepEqual(calls, [['-b', '-p', '7'], ['-B', '-p', '7']]);
});

test('a Mac without the tool has no fence, and a refusal is not a move', async () => {
  const none = createDarwinFence({ run: async () => {}, exists: async () => { throw new Error('ENOENT'); } });
  assert.equal(await none.ready(), null);
  const refused = createDarwinFence({ run: async () => { throw new Error('EPERM'); }, exists: async () => {} });
  assert.equal(await refused.apply({ pid: 7 }), null);
  assert.equal(await refused.clear({ pid: 7 }), false);
});

// ── the record ───────────────────────────────────────────────────────────────

test('the record survives a write and a read, and an empty one is no file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shield-'));
  const ledger = createLedger({ dataDir: dir });
  assert.deepEqual(await ledger.read(), []);
  await ledger.save([{ pid: 7, startedAt: 5, name: 'app', priority: 0 }, { pid: 8, startedAt: 6, name: 'b', cpus: '0-7' }]);
  assert.deepEqual(await ledger.read(), [{ pid: 7, startedAt: 5, name: 'app', priority: 0 }, { pid: 8, startedAt: 6, name: 'b', cpus: '0-7' }]);
  await ledger.save([]);
  assert.equal(existsSync(join(dir, 'core-shield.json')), false);
  await ledger.save([]);
});

test('a broken or tampered record is read as what it can prove', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shield-'));
  const file = join(dir, 'core-shield.json');
  const ledger = createLedger({ dataDir: dir });
  writeFileSync(file, '{ not json');
  assert.deepEqual(await ledger.read(), []);
  writeFileSync(file, JSON.stringify({ records: 'x' }));
  assert.deepEqual(await ledger.read(), []);
  writeFileSync(file, JSON.stringify({ records: [
    { pid: 7, startedAt: 5, name: 'a', priority: 999, cpus: '0-3; rm -rf /' },
    { pid: -1, startedAt: 5 }, { pid: 'x', startedAt: 5 }, { pid: 7 }, null,
  ] }));
  assert.deepEqual(await ledger.read(), [{ pid: 7, startedAt: 5, name: 'a' }]);
  assert.ok(readFileSync(file, 'utf8').length > 0);
});

test('a record keeps a level and a CPU list only when they are valid', () => {
  assert.deepEqual(normalizeRecord({ pid: 1, startedAt: 2, priority: 10, cpus: '0-3,8' }), { pid: 1, startedAt: 2, name: '', priority: 10, cpus: '0-3,8' });
  assert.equal(normalizeRecord({ pid: 1.5, startedAt: 2 }), null);
});

// ── what the tick asks for ───────────────────────────────────────────────────

const game = { running: true, pid: 20, name: 'game', foregroundPid: 20 };

test('no session, nothing wanted', () => {
  assert.deepEqual(shieldWish(undefined, game), { session: false, on: false });
  assert.deepEqual(shieldWish({ active: false, applied: { shield: true } }, game), { session: false, on: false });
});

test('it runs only in a session that chose it, while the game runs', () => {
  assert.equal(shieldWish({ active: true, applied: { shield: true } }, game).on, true);
  assert.equal(shieldWish({ active: true, applied: { shield: false } }, game).on, false);
  const over = shieldWish({ active: true, applied: { shield: true } }, { ...game, running: false });
  assert.equal(over.on, false);
  assert.equal(over.session, true, 'the session outlives the game, so its report does');
});

test('streaming and meeting apps stay, with the user\'s own list', () => {
  const keep = shieldWish({ active: true, applied: { shield: true }, activityApps: { streaming: { add: ['mystream'], remove: ['obs64'] } } }, game).keep;
  assert.ok(keep.has('mystream'));
  assert.ok(!keep.has('obs64'));
  assert.ok(keep.has('zoom'));
});

test('streaming and meeting apps are known by their macOS and Linux names too', () => {
  const keep = shieldWish({ active: true, applied: { shield: true } }, game).keep;
  for (const name of ['obs', 'zoom.us', 'msteams']) assert.ok(keep.has(name), name);
});

// ── put together ─────────────────────────────────────────────────────────────

test('a PC with no table and no fence still answers, with nothing', async () => {
  const session = createPerfSession({ collectors: null, dataDir: tmpdir(), platform: 'freebsd' });
  assert.equal(session.plan, null);
  assert.equal(session.table.available(), false);
  assert.equal(await session.stats(), null);
  assert.deepEqual(await session.shield.status(), { available: false, cores: 0, moved: [] });
  assert.deepEqual(await session.priority.isRunning('game'), { ok: false, error: 'unavailable' });
});

test('the numbers for the sheet have the shape the PowerShell ones had', async () => {
  const first = [{ pid: 1, ppid: 0, name: 'big', cpuMs: 0, memBytes: 500 * 1024 * 1024, startedAt: 1, owner: 1 }];
  const second = [{ ...first[0], cpuMs: 100 }];
  let reads = 0;
  const collectors = { processTable: async () => { reads += 1; return reads === 1 ? first : second; } };
  const session = createPerfSession({ collectors, dataDir: tmpdir(), platform: 'linux' });
  const stats = await session.stats();
  assert.equal(stats.ok, true);
  assert.ok(stats.totalMB > 0 && stats.freeMB >= 0);
  assert.equal(stats.apps.length, 1);
  assert.equal(stats.apps[0].proc, 'big');
  assert.equal(stats.apps[0].memMB, 500);
  assert.ok(stats.apps[0].cpuPct > 0);
});

test('starting the server loads no native library', () => {
  let loaded = 0;
  const windowsOnly = createPerfSession({ collectors: { processTable: async () => [] }, dataDir: tmpdir(), platform: 'linux' });
  assert.equal(loaded, 0);
  assert.equal(typeof windowsOnly.shield.recover, 'function');
  assert.doesNotMatch(readFileSync(new URL('../perf-session/index.js', import.meta.url), 'utf8'), /available\(\)\s*&&\s*makeFence/);
});

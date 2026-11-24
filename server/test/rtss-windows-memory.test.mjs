// The real Windows path: a named memory made here, laid out the way RTSS lays it out,
// read and written through windows-memory.js. Windows only; the name is this test's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const skip = process.platform !== 'win32' && 'RivaTuner runs on Windows only';

const ENTRY = 512 + 4096 + 262144;
const ARR_OFFSET = 0x100;
const SLOTS = 8;
const BYTES = ARR_OFFSET + SLOTS * ENTRY;
const PAGE_READWRITE = 0x04;
const FILE_MAP_ALL_ACCESS = 0x000f001f;

// A named memory as RTSS would make it; `close()` takes it away, as RTSS exiting does.
function makeRtssMemory(name, { slots = SLOTS } = {}) {
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const create = k32.func('void * __stdcall CreateFileMappingW(intptr, void *, uint32, uint32, uint32, str16)');
  const map = k32.func('void * __stdcall MapViewOfFile(void *, uint32, uint32, uint32, size_t)');
  const unmap = k32.func('int __stdcall UnmapViewOfFile(void *)');
  const close = k32.func('int __stdcall CloseHandle(void *)');
  const handle = create(-1, null, PAGE_READWRITE, 0, BYTES, name);
  assert.ok(handle, 'the test memory could not be made');
  const ptr = map(handle, FILE_MAP_ALL_ACCESS, 0, 0, BYTES);
  const buf = Buffer.from(koffi.view(ptr, BYTES));
  buf.writeUInt32LE(0x52545353, 0);
  buf.writeUInt32LE(0x0002000e, 4);
  buf.writeUInt32LE(ENTRY, 20);
  buf.writeUInt32LE(ARR_OFFSET, 24);
  buf.writeUInt32LE(slots, 28);
  return {
    owner: (i) => buf.toString('latin1', ARR_OFFSET + i * ENTRY + 256, buf.indexOf(0, ARR_OFFSET + i * ENTRY + 256)),
    text: (i) => buf.toString('latin1', ARR_OFFSET + i * ENTRY + 512, buf.indexOf(0, ARR_OFFSET + i * ENTRY + 512)),
    frame: () => buf.readUInt32LE(32),
    busy: () => buf.readInt32LE(36),
    close: () => { unmap(ptr); close(handle); },
  };
}

test('writes into the named memory, gives it back, and sees RivaTuner come and go', { skip }, () => {
  const { createWindowsMemory } = require('../rtss/windows-memory.js');
  const name = `XenonTestRtss-${process.pid}-a`;
  const memory = createWindowsMemory({ name });
  assert.equal(memory.running(), false, 'no memory yet: RTSS is not running');
  assert.equal(memory.write('Xenon', 'x'), 'closed');
  const rtss = makeRtssMemory(name);
  try {
    assert.equal(memory.running(), true);
    assert.equal(memory.write('Xenon', '144 FPS\nCPU 42%'), 'written');
    assert.equal(rtss.owner(1), 'Xenon');
    assert.equal(rtss.text(1), '144 FPS\nCPU 42%');
    assert.equal(rtss.frame(), 1);
    assert.equal(rtss.busy(), 0, 'the lock is given back');
    assert.equal(memory.release('Xenon'), 1);
    assert.equal(rtss.owner(1), '');
  } finally { rtss.close(); }
  assert.equal(memory.running(), false, 'RTSS closed: its memory went with it, nothing of ours kept it');
});

test('a header that claims more slots than the memory has maps nothing', { skip }, () => {
  const { createWindowsMemory } = require('../rtss/windows-memory.js');
  const name = `XenonTestRtss-${process.pid}-b`;
  const rtss = makeRtssMemory(name, { slots: SLOTS + 4 });
  try {
    const memory = createWindowsMemory({ name });
    assert.equal(memory.write('Xenon', 'x'), 'closed', 'Windows refuses the larger view');
    assert.equal(memory.running(), false);
  } finally { rtss.close(); }
});

test('without koffi it says RivaTuner is not there, and never throws', () => {
  const { createWindowsMemory } = require('../rtss/windows-memory.js');
  const memory = createWindowsMemory({ load: () => { throw new Error('no native module'); } });
  assert.equal(memory.running(), false);
  assert.equal(memory.write('Xenon', 'x'), 'closed');
  assert.equal(memory.release('Xenon'), 0);
});

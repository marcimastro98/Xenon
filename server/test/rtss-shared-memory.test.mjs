import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Osd = require('../rtss/shared-memory.js');

const ENTRY_EX = 512 + 4096 + 262144;   // RTSS 7.x: szOSD, owner, szOSDEx, buffer
const ENTRY_OLD = 512;                  // before v2.7: szOSD and owner only
const ARR_OFFSET = 0x100;

// A memory laid out the way RTSS lays it out, `slots` OSD entries after a header.
function fakeMemory({ version = 0x0002000e, slots = 8, entrySize = version >= Osd.V2_TEXT_EX ? ENTRY_EX : ENTRY_OLD, signature = Osd.SIGNATURE } = {}) {
  const ab = new ArrayBuffer(ARR_OFFSET + slots * entrySize);
  const buf = Buffer.from(ab);
  buf.writeUInt32LE(signature, 0);
  buf.writeUInt32LE(version, 4);
  buf.writeUInt32LE(entrySize, 20);
  buf.writeUInt32LE(ARR_OFFSET, 24);
  buf.writeUInt32LE(slots, 28);
  return { buf, lock: new Int32Array(ab, 0, 10), entrySize };
}

const slotAt = (mem, i) => ARR_OFFSET + i * mem.entrySize;
const str = (buf, at, max) => { const end = buf.indexOf(0, at); return buf.toString('latin1', at, Math.min(end < 0 ? at + max : end, at + max)); };
const owner = (mem, i) => str(mem.buf, slotAt(mem, i) + 256, 256);
const textEx = (mem, i) => str(mem.buf, slotAt(mem, i) + 512, 4096);
const frame = (mem) => mem.buf.readUInt32LE(32);

test('the first write takes the first free slot after the primary client and wakes RTSS', () => {
  const mem = fakeMemory();
  assert.equal(Osd.writeOsd(mem, 'Xenon', '144 FPS'), 'written');
  assert.equal(owner(mem, 0), '', 'slot 0 is left to MSI Afterburner');
  assert.equal(owner(mem, 1), 'Xenon');
  assert.equal(textEx(mem, 1), '144 FPS');
  assert.equal(frame(mem), 1, 'RTSS redraws when the frame counter moves');
});

test('a slot left by an engine that crashed is taken again, not a second one', () => {
  const mem = fakeMemory();
  mem.buf.write('Xenon', slotAt(mem, 3) + 256, 'latin1');
  Osd.writeOsd(mem, 'Xenon', 'back');
  assert.equal(textEx(mem, 3), 'back');
  assert.equal(owner(mem, 1), '');
});

test('the same slot is written again, and other programs keep theirs', () => {
  const mem = fakeMemory();
  mem.buf.write('Other', slotAt(mem, 1) + 256, 'latin1');
  Osd.writeOsd(mem, 'Xenon', 'one');
  Osd.writeOsd(mem, 'Xenon', 'two');
  assert.equal(owner(mem, 1), 'Other');
  assert.equal(owner(mem, 2), 'Xenon');
  assert.equal(textEx(mem, 2), 'two');
  assert.equal(owner(mem, 3), '', 'no second slot taken');
  assert.equal(frame(mem), 2);
});

test('a shorter text leaves nothing of the longer one behind', () => {
  const mem = fakeMemory();
  Osd.writeOsd(mem, 'Xenon', '144 FPS  1% 98');
  Osd.writeOsd(mem, 'Xenon', '60 FPS');
  assert.equal(textEx(mem, 1), '60 FPS');
});

test('every slot taken: nothing is written and nothing is overwritten', () => {
  const mem = fakeMemory({ slots: 3 });
  mem.buf.write('A', slotAt(mem, 1) + 256, 'latin1');
  mem.buf.write('B', slotAt(mem, 2) + 256, 'latin1');
  assert.equal(Osd.writeOsd(mem, 'Xenon', 'x'), 'full');
  assert.equal(owner(mem, 1), 'A');
  assert.equal(owner(mem, 2), 'B');
  assert.equal(frame(mem), 0);
});

test('while RTSS reads (busy bit set) nothing is written and the bit stays its', () => {
  const mem = fakeMemory();
  Atomics.store(mem.lock, 9, 1);
  assert.equal(Osd.writeOsd(mem, 'Xenon', 'x'), 'busy');
  assert.equal(Atomics.load(mem.lock, 9), 1, 'the lock is not ours to clear');
  assert.equal(textEx(mem, 1), '');
  assert.equal(frame(mem), 0);
  Atomics.store(mem.lock, 9, 0);
  assert.equal(Osd.writeOsd(mem, 'Xenon', 'x'), 'written');
  assert.equal(Atomics.load(mem.lock, 9), 0, 'the lock is always given back');
});

test('the text is cut to what the slot holds, always ending in a zero', () => {
  const mem = fakeMemory();
  Osd.writeOsd(mem, 'Xenon', 'x'.repeat(5000));
  assert.equal(textEx(mem, 1).length, 4095);
  assert.equal(mem.buf[slotAt(mem, 1) + 512 + 4095], 0);
});

test('an RTSS older than 2.7 gets the short text field, without the busy lock', () => {
  const mem = fakeMemory({ version: 0x00020006 });
  assert.equal(Osd.writeOsd(mem, 'Xenon', 'y'.repeat(400)), 'written');
  const text = str(mem.buf, slotAt(mem, 1), 256);
  assert.equal(text.length, 255);
  assert.equal(owner(mem, 1), 'Xenon');
});

test('memory that is not ready or not believable is left alone', () => {
  assert.equal(Osd.writeOsd(fakeMemory({ signature: 0xdead }), 'Xenon', 'x'), 'closed', 'RTSS is closing');
  assert.equal(Osd.writeOsd(fakeMemory({ version: 0x00010005 }), 'Xenon', 'x'), 'closed', 'v1 has another layout');
  assert.equal(Osd.writeOsd(fakeMemory({ version: 0x00030000 }), 'Xenon', 'x'), 'closed', 'an unknown major');
  const lying = fakeMemory();
  lying.buf.writeUInt32LE(9, 28);
  assert.equal(Osd.writeOsd(lying, 'Xenon', 'x'), 'closed', 'slots past the end of the view');
  const small = fakeMemory();
  small.buf.writeUInt32LE(600, 20);
  assert.equal(Osd.writeOsd(small, 'Xenon', 'x'), 'closed', 'an entry too small for the text it says it has');
  assert.equal(Osd.writeOsd(null, 'Xenon', 'x'), 'closed');
  assert.equal(Osd.writeOsd({ buf: Buffer.alloc(8) }, 'Xenon', 'x'), 'closed');
});

test('the view size comes from the header, and is 0 when RTSS is not ready', () => {
  const mem = fakeMemory({ slots: 8 });
  assert.equal(Osd.viewBytes(mem.buf.subarray(0, Osd.HEADER_BYTES)), ARR_OFFSET + 8 * ENTRY_EX);
  assert.equal(Osd.viewBytes(fakeMemory({ signature: 0 }).buf), 0);
  const many = fakeMemory({ slots: 2 });
  many.buf.writeUInt32LE(1000, 28);
  assert.equal(Osd.viewBytes(many.buf.subarray(0, Osd.HEADER_BYTES)), 0, 'no RTSS has a thousand slots');
});

test('giving back empties every slot of ours, and only ours', () => {
  const mem = fakeMemory();
  mem.buf.write('Other', slotAt(mem, 1) + 256, 'latin1');
  Osd.writeOsd(mem, 'Xenon', 'live');
  mem.buf.write('Xenon', slotAt(mem, 4) + 256, 'latin1');   // a second one, as a crash could leave
  const before = frame(mem);
  assert.equal(Osd.releaseOsd(mem, 'Xenon'), 2);
  assert.equal(owner(mem, 1), 'Other');
  assert.equal(owner(mem, 2), '');
  assert.equal(textEx(mem, 2), '');
  assert.equal(owner(mem, 4), '');
  assert.equal(frame(mem), before + 1);
  assert.equal(Osd.releaseOsd(mem, 'Xenon'), 0);
  assert.equal(frame(mem), before + 1, 'nothing to give back: RTSS is not woken');
});

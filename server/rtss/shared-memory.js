'use strict';
// RivaTuner Statistics Server's shared memory ("RTSSSharedMemoryV2"), read and written
// the way its SDK tells a third-party program to: the readings go into an OSD slot that
// RTSS draws inside the game. Xenon never enters a game; RTSS does that part, which is
// how text shows over a game in exclusive full screen, where no window can.
//
// Pure: everything works on a Buffer over the memory, so the tests build one by hand.
// windows-memory.js hands the real mapping in.
//
// The layout (RTSSSharedMemory.h, v2.x): a header of DWORDs, then the OSD slots at
// `osdArrOffset`, each `osdEntrySize` bytes: szOSD[256], szOSDOwner[256], and from
// v2.7 szOSDEx[4096]. Sizes and offsets are read from the header, never assumed.

const SIGNATURE = 0x52545353;   // 'RTSS' as a DWORD: the memory is up and valid
const HEADER = Object.freeze({ signature: 0, version: 4, osdEntrySize: 20, osdArrOffset: 24, osdArrSize: 28, osdFrame: 32, busy: 36 });
const HEADER_BYTES = 40;
const ENTRY = Object.freeze({ text: 0, owner: 256, textEx: 512 });
const TEXT_BYTES = 256;
const OWNER_BYTES = 256;
const TEXT_EX_BYTES = 4096;
const V2 = 0x00020000;
const V2_TEXT_EX = 0x00020007;   // the 4096-byte text
const V2_BUSY = 0x0002000e;      // bit 0 of `busy` held while anyone writes
// Slot 0 is left to the primary client (MSI Afterburner), as the SDK asks.
const FIRST_SLOT = 1;
// More than RTSS has ever had (8), so a header that says otherwise is not believed.
const MAX_SLOTS = 64;
const MAX_VIEW_BYTES = 64 * 1024 * 1024;

const u32 = (buf, at) => buf.readUInt32LE(at);

// The header, when it describes live memory with slots that fit in `length` bytes
// (or in the bytes it says it needs, when `length` is not known yet); otherwise null.
function readHeader(buf, length = Infinity) {
  if (!buf || buf.length < HEADER_BYTES) return null;
  const h = {
    version: u32(buf, HEADER.version),
    entrySize: u32(buf, HEADER.osdEntrySize),
    arrOffset: u32(buf, HEADER.osdArrOffset),
    arrSize: u32(buf, HEADER.osdArrSize),
  };
  if (u32(buf, HEADER.signature) !== SIGNATURE || h.version < V2 || (h.version >>> 16) !== 2) return null;
  const textEnd = h.version >= V2_TEXT_EX ? ENTRY.textEx + TEXT_EX_BYTES : ENTRY.owner + OWNER_BYTES;
  if (h.entrySize < textEnd || h.arrSize <= FIRST_SLOT || h.arrSize > MAX_SLOTS || h.arrOffset < HEADER_BYTES) return null;
  h.viewBytes = h.arrOffset + h.arrSize * h.entrySize;
  if (h.viewBytes > MAX_VIEW_BYTES || h.viewBytes > length) return null;
  return h;
}

// The bytes a view must map to reach every slot, or 0 when RTSS is not ready.
function viewBytes(headerBuf) {
  const h = readHeader(headerBuf);
  return h ? h.viewBytes : 0;
}

function cString(buf, at, max) {
  const end = buf.indexOf(0, at);
  return buf.toString('latin1', at, end < 0 || end > at + max ? at + max : end);
}

function putString(buf, at, max, text) {
  const bytes = Buffer.from(String(text), 'latin1').subarray(0, max - 1);
  bytes.copy(buf, at);
  buf[at + bytes.length] = 0;
}

// The slot `owner` already holds, else the first free one, taken.
function slotOf(buf, h, owner) {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = FIRST_SLOT; i < h.arrSize; i++) {
      const at = h.arrOffset + i * h.entrySize;
      const name = cString(buf, at + ENTRY.owner, OWNER_BYTES);
      if (name === owner) return at;
      if (pass === 1 && name === '') {
        putString(buf, at + ENTRY.owner, OWNER_BYTES, owner);
        return at;
      }
    }
  }
  return -1;
}

// RTSS 7.x holds bit 0 of `busy` while it reads the text: a set bit means "not now",
// and the next second tries again. The SDK takes it with an atomic bit set, and so
// does this (Atomics on the same memory). Always given back, or RTSS stops drawing.
function withLock(mem, h, fn) {
  if (h.version < V2_BUSY || !mem.lock) { fn(); return true; }
  const word = HEADER.busy / 4;
  if (Atomics.or(mem.lock, word, 1) & 1) return false;
  try { fn(); } finally { Atomics.store(mem.lock, word, 0); }
  return true;
}

// mem: { buf: Buffer over the memory, lock?: Int32Array over its first words }
// → 'written' | 'busy' (try again) | 'full' (every slot taken) | 'closed' (RTSS not ready)
function writeOsd(mem, owner, text) {
  const h = readHeader(mem?.buf, mem?.buf?.length ?? 0);
  if (!h) return 'closed';
  const at = slotOf(mem.buf, h, owner);
  if (at < 0) return 'full';
  const ex = h.version >= V2_TEXT_EX;
  const wrote = withLock(mem, h, () => putString(mem.buf, at + (ex ? ENTRY.textEx : ENTRY.text), ex ? TEXT_EX_BYTES : TEXT_BYTES, text));
  if (!wrote) return 'busy';
  mem.buf.writeUInt32LE((u32(mem.buf, HEADER.osdFrame) + 1) >>> 0, HEADER.osdFrame);
  return 'written';
}

// Every slot `owner` holds goes back empty, as the SDK's own release does.
// → how many were given back
function releaseOsd(mem, owner) {
  const h = readHeader(mem?.buf, mem?.buf?.length ?? 0);
  if (!h) return 0;
  let freed = 0;
  for (let i = FIRST_SLOT; i < h.arrSize; i++) {
    const at = h.arrOffset + i * h.entrySize;
    if (cString(mem.buf, at + ENTRY.owner, OWNER_BYTES) !== owner) continue;
    mem.buf.fill(0, at, at + h.entrySize);
    freed++;
  }
  if (freed) mem.buf.writeUInt32LE((u32(mem.buf, HEADER.osdFrame) + 1) >>> 0, HEADER.osdFrame);
  return freed;
}

module.exports = {
  writeOsd, releaseOsd, readHeader, viewBytes,
  SIGNATURE, HEADER, HEADER_BYTES, ENTRY, V2, V2_TEXT_EX, V2_BUSY, TEXT_EX_BYTES, FIRST_SLOT,
};

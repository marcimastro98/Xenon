'use strict';
// HID input and output reports on Windows, for devices that answer on the interrupt
// pipe instead of feature reports. A device's collections share one link: a request
// goes out on the collection its size fits, and the reply can come back on any.
//
// The handles are overlapped, so ReadFile returns at once and only the wait runs on
// koffi's worker thread: a silent device costs a timeout, never a stuck thread.

const { boundedCall: call } = require('./bounded-call');

const GENERIC_READ_WRITE = 0xC0000000;
const FILE_SHARE_READ_WRITE = 0x03;   // G HUB and the like keep working while we ask
const OPEN_EXISTING = 3;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const INVALID_HANDLE = -1;
const WAIT_OBJECT_0 = 0;
const OVERLAPPED_BYTES = 32;          // 64-bit layout
const OVERLAPPED_EVENT_OFFSET = 24;
const POINTER_BYTES = 8;
const MAX_WAIT_MS = 1000;             // under bounded-call's ceiling
const WRITE_WAIT_MS = 500;
const CANCEL_WAIT_MS = 200;

let api = null;
// The driver writes into these until it gives them back: one it never does stays here,
// so the garbage collector cannot hand that memory to something else.
const heldByDriver = new Set();

// BOOL is declared as int: it is four bytes, and koffi's one-byte bool left the other
// three undefined, so WaitForMultipleObjects sometimes waited for every event at once.
function load() {
  if (api) return api;
  const kernel32 = require('koffi').load('kernel32.dll');
  api = {
    createFile: kernel32.func('intptr __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)'),
    closeHandle: kernel32.func('int __stdcall CloseHandle(intptr)'),
    createEvent: kernel32.func('intptr __stdcall CreateEventW(void *, int, int, void *)'),
    readFile: kernel32.func('int __stdcall ReadFile(intptr, void *, uint32, void *, void *)'),
    writeFile: kernel32.func('int __stdcall WriteFile(intptr, void *, uint32, void *, void *)'),
    waitOne: kernel32.func('uint32 __stdcall WaitForSingleObject(intptr, uint32)'),
    waitAny: kernel32.func('uint32 __stdcall WaitForMultipleObjects(uint32, void *, int, uint32)'),
    overlappedResult: kernel32.func('int __stdcall GetOverlappedResult(intptr, void *, _Out_ uint32 *, int)'),
    cancelIo: kernel32.func('int __stdcall CancelIoEx(intptr, void *)'),
  };
  return api;
}

async function overlappedFor(a) {
  const event = await call(a.createEvent, null, 1, 0, null);
  if (!event) throw new Error('could not create an event');
  const overlapped = Buffer.alloc(OVERLAPPED_BYTES);
  overlapped.writeBigInt64LE(BigInt(event), OVERLAPPED_EVENT_OFFSET);
  return { event, overlapped };
}

async function openCollection(a, info) {
  const handle = await call(a.createFile, info.path, GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, null);
  if (handle === INVALID_HANDLE) throw new Error('could not open the device');
  const collection = { handle, inputLength: info.inputLength, outputLength: info.outputLength, input: null };
  if (info.inputLength > 0) {
    collection.input = { ...(await overlappedFor(a)), buffer: Buffer.alloc(info.inputLength) };
    await armRead(a, collection);
  }
  return collection;
}

// A read that fails outright never signals its event, and read() then times out.
async function armRead(a, { handle, inputLength, input }) {
  input.overlapped.fill(0, 0, OVERLAPPED_EVENT_OFFSET);
  await call(a.readFile, handle, input.buffer, inputLength, null, input.overlapped);
}

// The driver owns the buffer until the read ends, so it is cancelled and waited for.
async function closeCollection(a, { handle, input }) {
  if (input) {
    await call(a.cancelIo, handle, null).catch(() => {});
    const ended = await call(a.waitOne, input.event, CANCEL_WAIT_MS).catch(() => null);
    if (ended !== WAIT_OBJECT_0) heldByDriver.add(input);
    await call(a.closeHandle, input.event).catch(() => {});
  }
  await call(a.closeHandle, handle).catch(() => {});
}

async function writeReport(a, collection, bytes) {
  const { event, overlapped } = await overlappedFor(a);
  try {
    const buffer = Buffer.from(bytes);
    await call(a.writeFile, collection.handle, buffer, buffer.length, null, overlapped);
    if ((await call(a.waitOne, event, WRITE_WAIT_MS)) !== WAIT_OBJECT_0) {
      await call(a.cancelIo, collection.handle, overlapped).catch(() => {});
      const ended = await call(a.waitOne, event, CANCEL_WAIT_MS).catch(() => null);
      if (ended !== WAIT_OBJECT_0) heldByDriver.add({ buffer, overlapped });
      throw new Error('the device did not take the report');
    }
    const written = [0];
    if (!(await call(a.overlappedResult, collection.handle, overlapped, written, 0))) throw new Error('the device refused the report');
  } finally {
    await call(a.closeHandle, event).catch(() => {});
  }
}

// interfaces: entries of hid-windows.js list(), the collections of one device.
async function openReports(interfaces) {
  const a = load();
  const collections = [];
  try {
    for (const info of interfaces) collections.push(await openCollection(a, info));
  } catch (e) {
    for (const c of collections) await closeCollection(a, c);
    throw e;
  }
  const readable = collections.filter((c) => c.input);
  const events = Buffer.alloc(readable.length * POINTER_BYTES);
  readable.forEach((c, i) => events.writeBigInt64LE(BigInt(c.input.event), i * POINTER_BYTES));
  let closed = false;

  return {
    async write(bytes) {
      if (closed) throw new Error('device closed');
      const target = collections.find((c) => c.outputLength === bytes.length);
      if (!target) throw new Error('no collection takes a report of this size');
      await writeReport(a, target, bytes);
    },
    // One input report with its report id first, or null when none came in time.
    async read(timeoutMs) {
      if (closed) throw new Error('device closed');
      if (!readable.length) return null;
      const wait = Math.min(Math.max(Math.ceil(timeoutMs), 1), MAX_WAIT_MS);
      const fired = await call(a.waitAny, readable.length, events, 0, wait);
      const collection = readable[fired - WAIT_OBJECT_0];
      if (!collection) return null;
      const got = [0];
      const ok = await call(a.overlappedResult, collection.handle, collection.input.overlapped, got, 0);
      const report = ok ? Buffer.from(collection.input.buffer.subarray(0, got[0])) : null;
      await armRead(a, collection);
      return report;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const c of collections) await closeCollection(a, c);
    },
  };
}

module.exports = { openReports };

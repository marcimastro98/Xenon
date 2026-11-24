'use strict';
// RivaTuner's shared memory on Windows, opened for one write and closed again, the way
// the SDK's own sample does it: holding it open would keep the named memory alive after
// RTSS exits. Two views per write: the header alone, to learn how far the slots reach,
// then exactly that much. Windows refuses a view larger than the memory, so a header
// that lies cannot send a read past the end (which would take the whole engine down).
//
// RTSS creates the memory in the signed-in session, open to the unelevated games its
// hooks run inside, so this process reaches it elevated or not.

const Osd = require('./shared-memory.js');

const NAME = 'RTSSSharedMemoryV2';
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_READ = 0x0004;
const ACCESS = FILE_MAP_READ | FILE_MAP_WRITE;
const LOCK_WORDS = Osd.HEADER_BYTES / 4;

function loadNative() {
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  return {
    koffi,
    open: kernel32.func('void * __stdcall OpenFileMappingW(uint32, int, str16)'),
    map: kernel32.func('void * __stdcall MapViewOfFile(void *, uint32, uint32, uint32, size_t)'),
    unmap: kernel32.func('int __stdcall UnmapViewOfFile(void *)'),
    close: kernel32.func('int __stdcall CloseHandle(void *)'),
  };
}

// deps: { name?, load? } — the tests name a memory of their own.
function createWindowsMemory({ name = NAME, load = loadNative } = {}) {
  let api = null;
  let failed = false;

  function native() {
    if (!api && !failed) {
      try { api = load(); } catch { failed = true; }
    }
    return api;
  }

  // fn runs on { buf, lock } over `bytes` of the memory, then the view goes. Nothing of
  // it may be kept: past the unmap the same addresses are no longer ours.
  function withView(handle, bytes, fn) {
    const ptr = api.map(handle, ACCESS, 0, 0, bytes);
    if (!ptr) return undefined;
    try {
      const view = api.koffi.view(ptr, bytes);
      return fn({ buf: Buffer.from(view), lock: new Int32Array(view, 0, LOCK_WORDS) });
    } finally { api.unmap(ptr); }
  }

  // fn(mem) with the whole slot area mapped; undefined when RTSS is not running.
  function use(fn) {
    if (!native()) return undefined;
    const handle = api.open(ACCESS, 0, name);
    if (!handle) return undefined;
    try {
      const bytes = withView(handle, Osd.HEADER_BYTES, (mem) => Osd.viewBytes(mem.buf));
      return bytes ? withView(handle, bytes, fn) : undefined;
    } finally { api.close(handle); }
  }

  return {
    // Whether RTSS is running and its memory ready.
    running: () => use(() => true) === true,
    write: (owner, text) => use((mem) => Osd.writeOsd(mem, owner, text)) || 'closed',
    release: (owner) => use((mem) => Osd.releaseOsd(mem, owner)) || 0,
  };
}

module.exports = { createWindowsMemory, NAME };

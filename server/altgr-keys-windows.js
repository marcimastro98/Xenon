'use strict';
// Which letters and digits type a character with AltGr on THIS PC's keyboards.
// Windows reads Ctrl+Alt as AltGr, so Ctrl+Alt+E on an Italian keyboard is €:
// a global shortcut there would take the character away. A key that no
// installed layout types anything with stays free for Ctrl+Alt (an Italian or
// US keyboard: Ctrl+Alt+R). js/deck-shortcuts.js useAltGrKeys() takes the list.
// Read through user32 (koffi), no window, no key sent; null when it cannot be
// read, and then every Ctrl+Alt letter stays refused.

const KEYS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const MAX_LAYOUTS = 32;
const MAPVK_VK_TO_VSC = 0;
const TOUNICODE_NO_STATE_CHANGE = 0x4;   // Windows 10 1607+: dead keys stay as they were
const DOWN = 0x80;
// AltGr as Windows sees it: Ctrl and Alt, the left Ctrl and the right Alt.
const ALTGR_VKS = Object.freeze([0x11, 0x12, 0xA2, 0xA5]);
const CACHE_MS = 60 * 1000;

let api = null;
let cached = null;
let readAt = 0;

function load() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  api = {
    list: user32.func('int __stdcall GetKeyboardLayoutList(int, _Out_ void **)'),
    scan: user32.func('uint32 __stdcall MapVirtualKeyExW(uint32, uint32, void *)'),
    type: user32.func('int __stdcall ToUnicodeEx(uint32, uint32, const uint8 *, _Out_ uint16 *, int, uint32, void *)'),
  };
  return api;
}

// The virtual key of a letter or digit is its upper-case character code.
const vkOf = (key) => key.toUpperCase().charCodeAt(0);

// A key types with AltGr when ToUnicodeEx gives a character or a dead key.
function typedKeys(f) {
  const layouts = new Array(MAX_LAYOUTS).fill(null);
  const n = f.list(MAX_LAYOUTS, layouts);
  if (!(n > 0)) return null;
  const state = new Uint8Array(256);
  for (const vk of ALTGR_VKS) state[vk] = DOWN;
  const out = new Set();
  for (const hkl of layouts.slice(0, n)) {
    for (const key of KEYS) {
      const vk = vkOf(key);
      const buf = new Uint16Array(8);
      if (f.type(vk, f.scan(vk, MAPVK_VK_TO_VSC, hkl), state, buf, buf.length, TOUNICODE_NO_STATE_CHANGE, hkl) !== 0) out.add(key);
    }
  }
  return [...out];
}

// The list, read again at most once a minute (a keyboard added in Settings).
function altGrKeys(now = Date.now()) {
  if (process.platform !== 'win32') return null;
  if (cached && now - readAt < CACHE_MS) return cached;
  try {
    cached = typedKeys(load());
  } catch {
    cached = null;
  }
  readAt = now;
  return cached;
}

module.exports = { altGrKeys, typedKeys, KEYS };

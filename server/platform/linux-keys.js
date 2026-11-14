'use strict';
// Turns a key combination into the arguments ydotool takes on Linux.

// evdev keycodes (linux/input-event-codes.h). ydotool's `key` takes
// `CODE:STATE` pairs only — it has no name parser — so the table is written
// out. Only the tokens the action registry already accepts are here; anything
// else has been rejected long before it reaches this function.
const YDOTOOL_CODES = {
  ctrl: 29, control: 29, shift: 42, alt: 56, win: 125, cmd: 125, meta: 125, super: 125,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38, m: 50,
  n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
  enter: 28, return: 28, esc: 1, escape: 1, tab: 15, space: 57, backspace: 14,
  delete: 111, del: 111, home: 102, end: 107, pageup: 104, pagedown: 109,
  up: 103, down: 108, left: 105, right: 106, insert: 110,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  f11: 87, f12: 88,
};

// "ctrl+shift+s" → the press/release sequence ydotool wants, modifiers held
// around the key and released in reverse order. Returns '' when any token has
// no code, so a combo is either sent whole or not at all.
const YDOTOOL_MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'win', 'cmd', 'meta', 'super']);

function ydotoolArgs(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  // Exactly one non-modifier, like the action registry's own normalizeKeys.
  // Without this "ctrl+" produced a press/release of Ctrl alone: harmless by
  // luck here because the release is emitted too, but it is a combo that was
  // asked for and not delivered, reported as success. A combo is sent whole or
  // refused.
  const mainKeys = parts.filter(p => !YDOTOOL_MODIFIERS.has(p));
  if (mainKeys.length !== 1) return null;
  const codes = [];
  for (const p of parts) {
    const code = YDOTOOL_CODES[p];
    if (code === undefined) return null;
    codes.push(code);
  }
  const down = codes.map(c => `${c}:1`);
  const up = codes.slice().reverse().map(c => `${c}:0`);
  return down.concat(up);
}

module.exports = { YDOTOOL_CODES, YDOTOOL_MODIFIERS, ydotoolArgs };

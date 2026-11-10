'use strict';
// The colour picker and the ruler: the engine (capture-host.js) freezes the
// screens, the user clicks a pixel or drags an area, and the colour ("#1E90FF",
// "rgb(...)", "hsl(...)") or the size ("333 × 177") goes on the clipboard.
// Nothing is saved.
//
// A colour or a size is not screen content: one pixel's value or two numbers,
// picked by the user's own click. The Deck key and the AI get them back (Bit
// answers "what colour is this?"); a widget gets only ok or an error code (the
// SDK bridge forwards nothing else).
//
// deps.capture (injected, as for the screenshot capability):
//   host        available(), request(cmd, body, opts)
//   inspectHint (mode) → Promise<string>, the line over the picker
//   onInspect   ({ mode, text, copied }) → told to every dashboard (the toast)

const pickerLock = require('./picker-lock.js');

const FORMATS = Object.freeze(['hex', 'rgb', 'hsl']);
const PASS_THROUGH = new Set(['unavailable', 'unsupported', 'no_monitor', 'no_gpu', 'engine_failing']);
// The engine closes an unanswered picker after 120 s.
const PICK_TIMEOUT_MS = 150000;
const HEX_RE = /^#[0-9A-F]{6}$/;

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

const byte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
const side = (v) => Number.isInteger(v) && v > 0 && v <= 100000;

// What the engine answered, checked before it reaches a toast or the AI.
function result(mode, reply) {
  const copied = reply.copied === true;
  const text = typeof reply.text === 'string' ? reply.text.slice(0, 40) : '';
  if (mode === 'colour') {
    const rgb = Array.isArray(reply.rgb) && reply.rgb.length === 3 && reply.rgb.every(byte) ? reply.rgb.slice() : null;
    if (!rgb || !HEX_RE.test(String(reply.hex))) return null;
    return { ok: true, hex: reply.hex, rgb, text, copied };
  }
  if (!side(reply.width) || !side(reply.height)) return null;
  return { ok: true, width: reply.width, height: reply.height, text, copied };
}

async function pick(c, mode, format) {
  let hint = '';
  if (typeof c.inspectHint === 'function') {
    try { hint = String(await c.inspectHint(mode) || ''); } catch { /* the picker works without its hint line */ }
  }
  const body = mode === 'colour' ? { mode, format, hint } : { mode, hint };
  const reply = await c.host.request('inspect', body, { timeoutMs: PICK_TIMEOUT_MS });
  if (reply && reply.ok === true && reply.cancelled === true) return { ok: true, cancelled: true };
  if (!reply || reply.ok !== true) {
    const code = reply && reply.error;
    return { ok: false, error: PASS_THROUGH.has(code) ? code : 'failed' };
  }
  const r = result(mode, reply);
  if (!r) return { ok: false, error: 'failed' };
  try { if (typeof c.onInspect === 'function') c.onInspect({ mode, text: r.text, copied: r.copied }); } catch { /* copied either way */ }
  return r;
}

function run(d, mode, action) {
  const c = d && d.capture;
  if (!available(c)) return { ok: false, error: 'unavailable' };
  if (pickerLock.held()) return { ok: true, picking: true };
  const format = FORMATS.includes(action && action.format) ? action.format : 'hex';
  return pickerLock.hold(() => pick(c, mode, format));
}

const color = (d, action) => run(d, 'colour', action);
const measure = (d, action) => run(d, 'measure', action);

module.exports = { FORMATS, available, color, measure };

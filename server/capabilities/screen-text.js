'use strict';
// Text from the screen: the engine (capture-host.js) reads an area the user
// picks, the window in front or the monitor in use with the OS's own OCR and
// puts the text on the clipboard. Nothing is saved.
//
// The text never travels in the action's result: a Deck key can be pressed
// from a paired phone, and /actions/run answers whoever pressed it. The result
// says how many lines were copied; the text itself is kept here for one AI
// turn (takeText), the only caller that reads it, because the user asked Bit
// for it.
//
// deps.capture (injected, as for the screenshot capability):
//   host      available(), request(cmd, body, opts)
//   textHint  () → Promise<string>, the line over the area picker
//   onText    ({ lines, copied }) → told to every dashboard (the toast)

const pickerLock = require('./picker-lock.js');

const TARGETS = Object.freeze(['region', 'window', 'screen']);
const PASS_THROUGH = new Set(['unavailable', 'unsupported', 'no_window', 'no_monitor', 'no_gpu',
  'engine_failing', 'no_ocr_language', 'too_large']);
// The engine closes an unanswered area picker after 120 s.
const REGION_TIMEOUT_MS = 150000;
// What an AI turn may read back; longer text is cut and says so.
const AI_TEXT_MAX = 6000;
// The AI reads it in the same turn; anything older is dropped.
const KEEP_MS = 30000;

let kept = null;

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

// The text of the last read, once, for the AI call that asked for it.
function takeText(now = Date.now()) {
  const k = kept;
  kept = null;
  if (!k || now - k.at > KEEP_MS) return null;
  if (k.text.length <= AI_TEXT_MAX) return { text: k.text, cut: false };
  return { text: k.text.slice(0, AI_TEXT_MAX), cut: true };
}

async function read(c, target) {
  let hint = '';
  if (target === 'region' && typeof c.textHint === 'function') {
    try { hint = String(await c.textHint() || ''); } catch { /* the picker works without its hint line */ }
  }
  const body = target === 'region' ? { target, hint } : { target };
  const reply = await c.host.request('ocr', body, target === 'region' ? { timeoutMs: REGION_TIMEOUT_MS } : undefined);
  if (reply && reply.ok === true && reply.cancelled === true) return { ok: true, cancelled: true };
  if (!reply || reply.ok !== true) {
    const code = reply && reply.error;
    return { ok: false, error: PASS_THROUGH.has(code) ? code : 'failed' };
  }
  const text = typeof reply.text === 'string' ? reply.text : '';
  const lines = text ? text.split('\n').length : 0;
  const copied = reply.copied === true;
  kept = { text, at: Date.now() };
  try { if (typeof c.onText === 'function') c.onText({ lines, copied }); } catch { /* the text is copied either way */ }
  return { ok: true, lines, chars: text.length, copied, ...(text ? {} : { empty: true }) };
}

async function run(d, action) {
  const c = d && d.capture;
  if (!available(c)) return { ok: false, error: 'unavailable' };
  if (pickerLock.held()) return { ok: true, picking: true };
  const target = TARGETS.includes(action.target) ? action.target : 'region';
  if (target !== 'region') return read(c, target);
  return pickerLock.hold(() => read(c, target));
}

module.exports = { TARGETS, AI_TEXT_MAX, KEEP_MS, available, run, takeText };

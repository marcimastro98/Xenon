'use strict';
// Drawing on the screen: the engine (capture-host.js) lays a see-through sheet
// over the monitor under the pointer, with a small bar at its top for the
// colour, the tool, undo, clear and close. Strokes show in screenshots and
// recordings (that is the point, for a lesson or a demo); the bar never does.
// Esc, the bar's x or a second press of the key closes it. Nothing is saved,
// nothing is read from the screen.
//
// deps.capture (injected, as for the screenshot capability):
//   host      available(), has(feature), request(cmd, body, opts)
//   drawHint  () → Promise<string>, the line under the bar for a few seconds
// deps.drawShell (screen-draw-shell.js): where the engine has no sheet (macOS,
// Linux), the native shell opens one as a page instead. Same modes, same answer.

const MODES = Object.freeze(['toggle', 'start', 'stop']);
const PASS_THROUGH = new Set(['unavailable', 'unsupported', 'engine_failing']);

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

// The engine draws when it says so (Windows); a host without `has` can do it all.
function engineDraws(capture) {
  if (!available(capture)) return false;
  return typeof capture.host.has !== 'function' || capture.host.has('draw');
}

function shellDraws(shell) {
  return !!(shell && typeof shell.available === 'function' && shell.available());
}

// The Deck, Bit and the SDK see one feature, whoever draws it.
function canDraw(d) {
  return engineDraws(d && d.capture) || shellDraws(d && d.drawShell);
}

function runShell(shell, mode) {
  const next = mode === 'toggle' ? !shell.get() : mode === 'start';
  return { ok: true, drawing: shell.set(next) };
}

async function hintFor(c, mode) {
  if (mode === 'stop' || typeof c.drawHint !== 'function') return '';
  try { return String(await c.drawHint() || ''); } catch { return ''; /* the drawing works without its hint */ }
}

async function run(d, action) {
  const c = d && d.capture;
  const mode = MODES.includes(action && action.mode) ? action.mode : 'toggle';
  if (!engineDraws(c)) {
    return shellDraws(d && d.drawShell) ? runShell(d.drawShell, mode) : { ok: false, error: 'unavailable' };
  }
  const reply = await c.host.request('draw', { action: mode, hint: await hintFor(c, mode) });
  if (!reply || reply.ok !== true) {
    const code = reply && reply.error;
    return { ok: false, error: PASS_THROUGH.has(code) ? code : 'failed' };
  }
  return { ok: true, drawing: reply.drawing === true };
}

module.exports = { MODES, available, canDraw, run };

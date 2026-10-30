'use strict';
// The steps recorder (server/steps-recorder.js): every click becomes a step
// with a picture, and the steps become a document in Documents/Xenon/Steps.
// "open" shows the last document, "reveal" its folder; neither takes a path.
// Each step's sentence is kept here for one AI turn (takeSteps, as
// screen-text.js does): the action's result can reach a paired phone, and the
// sentences name what the user clicked. The SSE and the logs never carry them.
//
// deps.capture (injected, shared with screenshot.js):
//   host   the capture host: available()
//   steps  () → the steps recorder

const MODES = Object.freeze(['toggle', 'start', 'stop', 'open', 'reveal']);
const KEEP_MS = 30000;

let kept = null;

// The result without its sentences; the sentences wait for Bit's turn.
function keep(result, now = Date.now()) {
  if (!result || !Array.isArray(result.steps)) return result;
  const { steps, ...rest } = result;
  kept = { steps, at: now };
  return rest;
}

function takeSteps(now = Date.now()) {
  const k = kept;
  kept = null;
  return k && now - k.at <= KEEP_MS ? k.steps : null;
}

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

async function run(d, action) {
  const c = d && d.capture;
  const s = c && typeof c.steps === 'function' ? c.steps() : null;
  if (!available(c) || !s) return { ok: false, error: 'unavailable' };
  const mode = MODES.includes(action && action.mode) ? action.mode : 'toggle';
  if (mode === 'open') return s.open();
  if (mode === 'reveal') return s.reveal();
  if (mode === 'start') return s.start();
  if (mode === 'stop') return keep(await s.stop());
  return keep(await s.toggle());
}

module.exports = { MODES, available, run, takeSteps };

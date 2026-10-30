'use strict';
// The bug report package (server/bug-report.js): "make" builds the .zip,
// "reveal" shows the last one in its folder. Neither takes a path; the result
// names the file and counts what is inside.
//
// deps.capture (injected, shared with screenshot.js):
//   host       the capture host: available()
//   bugReport  () → the bug report maker

const MODES = Object.freeze(['make', 'reveal']);

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

async function run(d, action) {
  const c = d && d.capture;
  const b = c && typeof c.bugReport === 'function' ? c.bugReport() : null;
  if (!available(c) || !b) return { ok: false, error: 'unavailable' };
  const a = action || {};
  if (a.mode === 'reveal') return b.reveal();
  return b.make({ seconds: a.seconds });
}

module.exports = { MODES, available, run };

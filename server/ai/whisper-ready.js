// Whether the speech-to-text program and its model are on this computer, asked at most every
// ten seconds.

const fs = require('node:fs');
const path = require('node:path');
const aiLocal = require('./ai-local.js');
const { whisperState } = require('./whisper-ready-state.js');
const { whisperProbe } = require('./whisper-probe.js');
const SERVER_DIR = path.join(__dirname, '..');

function _whisperReady() {
  // Cached: this runs on the SSE connect/close path, which must never do sync
  // FS. A positive result is sticky (whisper doesn't uninstall itself); a
  // negative probe is cached for 10 s (and reset by the install handler).
  if (whisperState.ready) return true;
  const now = Date.now();
  if (now - whisperProbe.lastAt < 10000) return false;
  whisperProbe.lastAt = now;
  try { whisperState.ready = !!aiLocal.whisperExe(SERVER_DIR) && fs.existsSync(aiLocal.whisperPaths(SERVER_DIR).model); }
  catch { whisperState.ready = false; }
  return whisperState.ready;
}

module.exports = { _whisperReady };

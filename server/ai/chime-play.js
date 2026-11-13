// Plays a short chime on this machine's speakers, and not twice when two requests for the same
// one come together.

const fs = require('node:fs');
const { privateTmpFile } = require('../private-tmp.js');
const { _spawnWavPlayer } = require('../wav/player.js');
const { chimeCache } = require('./chime-cache.js');
const { chimeKind, _buildChimeWav, CHIME_COALESCE_MS } = require('../time/chime-sound.js');

const _lastChimeAt = {};
function chimeRequested(kind, now = Date.now()) {
  const k = chimeKind(kind);
  if (now - (_lastChimeAt[k] || 0) < CHIME_COALESCE_MS) return false;
  _lastChimeAt[k] = now;
  playChimeOnServer(k);
  return true;
}

function playChimeOnServer(kind) {
  const k = chimeKind(kind);
  if (!chimeCache.sounds[k]) {
    try { chimeCache.sounds[k] = _buildChimeWav(k); } catch { return; }
  }
  const wavPath = privateTmpFile(`xenon-chime-${k}-`, '.wav');
  fs.promises.writeFile(wavPath, chimeCache.sounds[k]).then(() => {
    const proc = _spawnWavPlayer(wavPath);
    proc.on('error', () => {});
    // On Windows the player one-liner removes the file itself; afplay/aplay do
    // not, and this is the one caller that never unlinks (_playWavFile does).
    if (process.platform !== 'win32') {
      proc.on('exit', () => { fs.promises.unlink(wavPath).catch(() => {}); });
    }
  }).catch(() => {});
}

module.exports = { _lastChimeAt, chimeRequested, playChimeOnServer };

// Turns a recorded clip into the 16 kHz mono WAV the speech models read.

const { spawn } = require('node:child_process');
const { getFfmpegPath } = require('../ffmpeg-install/ffmpeg-path.js');

// Any clip the browser or a paired phone recorded → 16 kHz mono WAV.
function _audioToWav16k(inBuf) {
  return new Promise((resolve, reject) => {
    // -protocol_whitelist pipe: the input is whatever the browser (or a
    // paired phone) sent, and ffmpeg guesses its format; a playlist
    // format could otherwise make it open files or URLs.
    const ff = spawn(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { windowsHide: true });
    const out = [];
    const errBuf = [];
    ff.stdout.on('data', c => out.push(c));
    ff.stderr.on('data', c => errBuf.push(c));
    ff.on('error', reject);
    ff.on('close', code => {
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error('ffmpeg wav transcode failed: ' + Buffer.concat(errBuf).toString().slice(0, 200)));
    });
    ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
    ff.stdin.write(inBuf);
    ff.stdin.end();
  });
}

module.exports = { _audioToWav16k };

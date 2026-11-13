// Asks ffmpeg what it can record from: the microphones macOS lists, and whether an input format
// is known.

const { spawn } = require('node:child_process');

// ffmpeg prints avfoundation's inventory to stderr, video block first:
//   [AVFoundation indev @ 0x…] AVFoundation audio devices:
//   [AVFoundation indev @ 0x…] [0] MacBook Pro Microphone
// Only the audio block is ours — the video one carries its own [0].
function _parseAvfAudioDevices(stderr) {
  const devices = [];
  let inAudio = false;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (/AVFoundation video devices:/i.test(line)) { inAudio = false; continue; }
    if (/AVFoundation audio devices:/i.test(line)) { inAudio = true; continue; }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) devices.push({ index: m[1], name: m[2] });
  }
  return devices;
}

// Does this ffmpeg build know an input format? Listing always "fails" (there is
// no device to open), so the exit code says nothing — the refusal to recognise
// the format does, and it is the only cheap way to tell a build with pulse
// support from one without.
function _ffmpegKnowsFormat(ffmpeg, fmt) {
  return new Promise((resolve) => {
    let stderr = '';
    let p;
    try {
      p = spawn(ffmpeg, ['-hide_banner', '-f', fmt, '-list_devices', 'true', '-i', 'dummy'], { windowsHide: true });
    } catch { resolve(false); return; }
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', () => resolve(!/Unknown input format/i.test(stderr)));
    p.on('error', () => resolve(false));
    setTimeout(() => { try { p.kill(); } catch {} resolve(!/Unknown input format/i.test(stderr)); }, 4000);
  });
}

module.exports = { _parseAvfAudioDevices, _ffmpegKnowsFormat };

// Finds the microphone ffmpeg records dictation from.

const { spawn } = require('node:child_process');
const { _parseAvfAudioDevices, _ffmpegKnowsFormat } = require('./stt-device-probe.js');
const { audioCache } = require('../audio/device-cache.js');
const { sttDevice } = require('./stt-device-state.js');
const { _sttDeviceWaiters } = require('./stt-pending.js');
const { getFfmpegPath } = require('../ffmpeg-install/ffmpeg-path.js');

// Enumerate DirectShow audio devices via ffmpeg. Returns an array of friendly device name strings.
async function _enumSttDevice() {
  const ffmpeg = getFfmpegPath();
  let stderr = '';
  try {
    await new Promise(resolve => {
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', resolve);
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 5000);
    });
  } catch {}

  const names = [];
  let inAudioSection = false; // for ffmpeg <7 (section-based format)

  for (const line of stderr.split('\n')) {
    if (/Alternative name/i.test(line)) continue;

    // ffmpeg 7+ format: [in#0 @ ...] "Device Name" (audio)
    const newFmt = line.match(/"([^"]+)"\s*\(audio\)/i);
    if (newFmt && !newFmt[1].startsWith('@device_')) { names.push(newFmt[1]); continue; }

    // ffmpeg <7 format: section header + [dshow @ ...] "Device Name"
    if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
    if (inAudioSection) {
      const oldFmt = line.match(/"([^@][^"]+)"/);
      if (oldFmt) names.push(oldFmt[1]);
    }
  }
  return names;
}

async function _initSttDevice() {
  const ffmpeg = getFfmpegPath();

  if (process.platform === 'darwin') {
    try {
      const stderr = await new Promise(resolve => {
        let buf = '';
        // Listing always "fails" (there is no input to open), so the exit code
        // is meaningless here — the inventory it printed on the way out is not.
        const p = spawn(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { windowsHide: true });
        p.stderr.setEncoding('utf8');
        p.stderr.on('data', d => { buf += d; });
        p.on('exit', () => resolve(buf));
        p.on('error', () => resolve(''));
        setTimeout(() => { try { p.kill(); } catch {} resolve(buf); }, 4000);
      });
      const devices = _parseAvfAudioDevices(stderr);
      if (devices.length) {
        // Prefer the device the mixer says is the default input, so the wake
        // word and the recorder follow the mic the user actually picked.
        let chosen = null;
        if (audioCache.micLabel) {
          const lbl = audioCache.micLabel.toLowerCase();
          chosen = devices.find(d => d.name.toLowerCase().includes(lbl));
        }
        sttDevice.avfIndex = (chosen || devices[0]).index;
        process.stdout.write(`[STT] avfoundation input [${sttDevice.avfIndex}] "${(chosen || devices[0]).name}"\n`);
      } else {
        process.stdout.write('[STT] No avfoundation audio input found (ffmpeg missing, or Microphone permission not granted)\n');
      }
    } catch (e) {
      process.stdout.write('[STT] Device init error: ' + e.message + '\n');
    }
    sttDevice.ready = true;
    sttDevice.micLabel = audioCache.micLabel || (sttDevice.avfIndex !== null ? `__avf_${sttDevice.avfIndex}__` : null);
    _sttDeviceWaiters.splice(0).forEach(cb => cb());
    return;
  }

  if (process.platform === 'linux') {
    // pulse before alsa, deliberately. PipeWire and PulseAudio both expose the
    // pulse API, `default` follows the input the user actually picked in the
    // mixer, and it captures while the sound server holds the device — a raw
    // alsa grab usually cannot, because the card is already open.
    try {
      if (await _ffmpegKnowsFormat(ffmpeg, 'pulse')) sttDevice.linuxFormat = 'pulse';
      else if (await _ffmpegKnowsFormat(ffmpeg, 'alsa')) sttDevice.linuxFormat = 'alsa';
      if (sttDevice.linuxFormat) process.stdout.write(`[STT] ${sttDevice.linuxFormat} input "default"\n`);
      else process.stdout.write('[STT] ffmpeg knows neither pulse nor alsa: voice input is unavailable\n');
    } catch (e) {
      process.stdout.write('[STT] Device init error: ' + e.message + '\n');
    }
    sttDevice.ready = true;
    sttDevice.micLabel = audioCache.micLabel || (sttDevice.linuxFormat ? `__${sttDevice.linuxFormat}__` : null);
    _sttDeviceWaiters.splice(0).forEach(cb => cb());
    return;
  }

  // Probe WASAPI support — if ffmpeg knows the format, use it (fast init ~200ms)
  let wasapiOk = false;
  try {
    await new Promise(resolve => {
      let stderr = '';
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'wasapi', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', () => { wasapiOk = !/Unknown input format/i.test(stderr); resolve(); });
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 4000);
    });
  } catch {}

  if (wasapiOk) {
    sttDevice.useWasapi = true;
    process.stdout.write('[STT] WASAPI available: fast init\n');
  } else {
    // WASAPI not supported — enumerate DirectShow devices as fallback
    try {
      const names = await _enumSttDevice();
      if (names.length > 0) {
        let chosen = null;
        if (audioCache.micLabel) {
          const lbl = audioCache.micLabel.toLowerCase();
          chosen = names.find(d => d.toLowerCase().includes(lbl));
        }
        sttDevice.dshowDevice = chosen || names[0];
        process.stdout.write(`[STT] WASAPI unavailable, dshow: "${sttDevice.dshowDevice}"\n`);
      } else {
        process.stdout.write('[STT] No audio input method found\n');
      }
    } catch (e) {
      process.stdout.write('[STT] Device init error: ' + e.message + '\n');
    }
  }

  sttDevice.ready = true;
  sttDevice.micLabel = audioCache.micLabel || sttDevice.dshowDevice || (wasapiOk ? '__wasapi_default__' : null);
  _sttDeviceWaiters.splice(0).forEach(cb => cb());
}

module.exports = { _enumSttDevice, _initSttDevice };

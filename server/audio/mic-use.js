'use strict';
// Whether another app has the microphone: the closest thing to "in a call" that every
// app shares, and no app has to tell us. Null when this machine cannot say.
//   Windows  the privacy store behind the tray's microphone icon, no permission
//   Linux    the recording streams of PulseAudio or PipeWire's pulse layer
//   macOS    the default input's "running somewhere"; it cannot name the app, so our
//            own wake word counts and the caller says when that is on
const { execFile } = require('node:child_process');

const STORE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const OWN_RE = /xenon|msedgewebview2|ffmpeg/i;
// An app that crashed mid-call stays "in use" in the store for ever (seen: 21 days).
const STALE_MS = 12 * 3600 * 1000;
const FILETIME_TO_UNIX_MS = 11644473600000;
const RUN_MS = 4000;

const fileTimeMs = (hex) => Number(BigInt(hex) / 10000n) - FILETIME_TO_UNIX_MS;

function parseConsentStore(text, now = Date.now()) {
  for (const block of String(text || '').split(/\r?\n(?=HKEY_)/)) {
    const stop = /LastUsedTimeStop\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(block);
    const start = /LastUsedTimeStart\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(block);
    if (!stop || !start || BigInt(stop[1]) !== 0n || BigInt(start[1]) === 0n) continue;
    if (OWN_RE.test(block.split(/\r?\n/, 1)[0])) continue;
    if (now - fileTimeMs(start[1]) < STALE_MS) return true;
  }
  return false;
}

// "pactl list short sources": the ids that record what the PC plays, not a microphone.
function parseMonitorSources(text) {
  const ids = new Set();
  for (const line of String(text || '').split('\n')) {
    const [id, name] = line.trim().split('\t');
    if (id && String(name || '').endsWith('.monitor')) ids.add(id);
  }
  return ids;
}

// OBS capturing the desktop's sound holds a stream on a monitor source: not a call.
function parsePulseOutputs(text, monitors = new Set()) {
  return String(text || '').split(/\r?\n(?=Source Output #)/).some((block) => {
    if (!/^Source Output #/.test(block) || /Corked:\s*yes/i.test(block)) return false;
    const source = /^\s*Source:\s*(\d+)/m.exec(block);
    if (source && monitors.has(source[1])) return false;
    const who = /application\.(?:process\.binary|name)\s*=\s*"([^"]*)"/.exec(block);
    return !(who && OWN_RE.test(who[1]));
  });
}

// pactl translates its headings, and the parser reads them: always the C locale.
function run(cmd, args) {
  const env = { ...process.env, LC_ALL: 'C' };
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: RUN_MS, windowsHide: true, maxBuffer: 1 << 20, env }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

let readDefaultInput = null;
function coreAudio() {
  if (readDefaultInput) return readDefaultInput;
  const koffi = require('koffi');
  const lib = koffi.load('/System/Library/Frameworks/CoreAudio.framework/CoreAudio');
  const address = koffi.struct('XN_AUDIO_ADDRESS', { selector: 'uint32', scope: 'uint32', element: 'uint32' });
  const get = lib.func('AudioObjectGetPropertyData', 'int32', ['uint32', koffi.pointer(address), 'uint32', 'void *', koffi.inout(koffi.pointer('uint32')), koffi.out(koffi.pointer('uint32'))]);
  const code = (s) => Buffer.from(s, 'latin1').readUInt32BE(0);
  const value = (object, selector) => {
    const out = [0];
    const failed = get(object, { selector: code(selector), scope: code('glob'), element: 0 }, 0, null, [4], out);
    return failed ? null : out[0];
  };
  readDefaultInput = () => {
    const device = value(1, 'dIn ');
    if (!device) return null;
    const running = value(device, 'gone');
    return running == null ? null : running !== 0;
  };
  return readDefaultInput;
}

const BACKENDS = {
  win32: async () => parseConsentStore(await run('reg', ['query', STORE, '/s'])),
  linux: async () => {
    const [outputs, sources] = await Promise.all([run('pactl', ['list', 'source-outputs']), run('pactl', ['list', 'short', 'sources'])]);
    return parsePulseOutputs(outputs, parseMonitorSources(sources));
  },
  darwin: async ({ ownMic }) => (ownMic ? false : coreAudio()()),
};

let readable;
// ownMic: our wake word is listening (only macOS needs to know).
async function read({ ownMic = false } = {}) {
  const backend = BACKENDS[process.platform];
  try {
    const answer = backend ? await backend({ ownMic }) : null;
    readable = answer != null;
    return answer;
  } catch {
    readable = false;
    return null;
  }
}

// A first look is taken on the first question; until it answers the choice stays offered.
function available() {
  if (readable === undefined) read().catch(() => {});
  return readable !== false;
}

module.exports = { read, available, parseConsentStore, parsePulseOutputs, parseMonitorSources };

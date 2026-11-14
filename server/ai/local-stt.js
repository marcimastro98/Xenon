'use strict';
// Speech to text on this PC with whisper.cpp: where its program and model are, how a recording
// is prepared, and the cleaned transcript.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// Binary names for the whisper.cpp CLI, newest naming first. The modern release
// calls it "whisper-cli"; "main"/"whisper" are the legacy names.
const WHISPER_BIN_NAMES = process.platform === 'win32'
  ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
  : ['whisper-cli', 'whisper', 'main'];

// Where a system-wide whisper.cpp lives off Windows. Homebrew's `whisper-cpp`
// formula is the supported macOS install (it is built with Metal, so an Apple
// Silicon Mac transcribes on the GPU), and neither prefix is on the PATH of the
// LaunchAgent that runs this server.
const WHISPER_SYSTEM_DIRS = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

// Only the unambiguous name is looked for in a shared bin directory. `whisper`
// there is far more likely to be the OpenAI Python CLI, which takes completely
// different arguments — picking it up would report Whisper as ready, skip the
// brew install and then fail every transcription. `main` is whisper.cpp's old
// name and much too generic to claim from /usr/bin. Both stay accepted inside
// server/whisper/, where the user put the binary on purpose.
const WHISPER_SYSTEM_BIN_NAMES = ['whisper-cli'];

// Resolve the expected whisper.cpp locations under server/whisper/. The model is
// always ours: Homebrew ships the binary but no ggml weights, so the download
// below owns the model on every platform.
function whisperPaths(serverDir) {
  const dir = path.join(serverDir, 'whisper');
  return { dir, exe: path.join(dir, WHISPER_BIN_NAMES[0]), model: path.join(dir, 'ggml-small.bin') };
}

// Return the first existing whisper executable, or null if none present. The
// bundled copy wins over a system one, so a user who drops a specific build into
// server/whisper/ keeps using it.
function whisperExe(serverDir) {
  const dir = path.join(serverDir, 'whisper');
  for (const name of WHISPER_BIN_NAMES) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  for (const sysDir of WHISPER_SYSTEM_DIRS) {
    for (const name of WHISPER_SYSTEM_BIN_NAMES) {
      const p = path.join(sysDir, name);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return null;
}

// whisper.cpp's decoding flags for a spoken request. A voice turn waits on this,
// so speed matters as much as accuracy: more threads (whisper defaults to 4),
// greedy decoding instead of a 5-wide beam search, and an encoder window sized
// to the clip instead of a fixed 30 s (50 frames per second, with headroom).
// Measured on a 4 s Italian request with ggml-small: 3.2 s -> 1.0 s, same text.
// Non-speech tokens ("[Musica]") are suppressed at the source.
const WAV_BYTES_PER_SEC = 16000 * 2;
function whisperSpeedArgs(wavBytes, cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length) {
  const threads = Math.min(8, Math.max(4, Math.floor(cpus / 2)));
  const seconds = Math.max(0, (Number(wavBytes) || 0) - 44) / WAV_BYTES_PER_SEC;
  const audioCtx = Math.min(1500, Math.max(384, Math.ceil(seconds * 60) + 64));
  return ['-t', String(threads), '-bs', '1', '-bo', '1', '-ac', String(audioCtx), '-sns'];
}

// What whisper writes when it heard no words: bracketed or parenthesised
// annotations ("[BLANK_AUDIO]", "(musica)") and the sign-off lines it learned
// from subtitled video and invents over near-silence. Sent on, any of these
// becomes a request nobody made, so a transcript made only of them is empty.
const STT_NOISE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;
const STT_HALLUCINATIONS = [
  /amara\.org/gi,
  /sottotitoli (creati|a cura|e revisione)[^.]*\.?/gi,
  /grazie (a tutti )?per (la visione|l'attenzione|aver guardato)[.!]?/gi,
  /thanks? (you )?for watching[.!]?/gi,
  /subtitles by[^.]*\.?/gi,
];
function cleanTranscript(text) {
  let out = String(text || '').replace(STT_NOISE, ' ');
  for (const re of STT_HALLUCINATIONS) out = out.replace(re, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

// Silence put in front of a clip before whisper hears it. A recording that
// starts right on the first syllable loses it: whisper reads "che ore sono" as
// "e ora sono". Only 16-bit PCM WAV is padded; anything else passes unchanged.
const STT_LEAD_MS = 400;
function padWavStart(wav, ms = STT_LEAD_MS) {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav || []);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
  let fmt = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && size >= 16) {
      fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) return buf;
      const lead = Math.round(fmt.rate * ms / 1000) * fmt.channels * 2;
      // ffmpeg writing to a pipe leaves the sizes at 0 or 0xFFFFFFFF: use what is there.
      const rest = buf.length - at - 8;
      const dataLen = size > 0 && size <= rest ? size : rest;
      const out = Buffer.concat([buf.subarray(0, at + 8), Buffer.alloc(lead), buf.subarray(at + 8, at + 8 + dataLen)]);
      out.writeUInt32LE(dataLen + lead, at + 4);
      out.writeUInt32LE(out.length - 8, 4);
      return out;
    }
    at += 8 + size + (size % 2);
  }
  return buf;
}

// Transcribe a WAV buffer with whisper.cpp. `serverDir` locates the binary and
// model. Writes the WAV to a temp file, runs whisper, reads the .txt output,
// then cleans up. Rejects with a clear message when the binary/model is missing.
function localStt(wavBuffer, lang, serverDir) {
  return new Promise((resolve, reject) => {
    const exe = whisperExe(serverDir);
    const { model } = whisperPaths(serverDir);
    if (!exe) return reject(new Error('whisper_not_installed'));
    if (!fs.existsSync(model)) return reject(new Error('whisper_model_missing'));

    const base = path.join(os.tmpdir(), `xenon-whisper-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const wavPath = base + '.wav';
    const outBase = base;             // whisper appends .txt
    const txtPath = base + '.txt';
    const safeLang = String(lang || 'auto').toLowerCase().slice(0, 5).replace(/[^a-z-]/g, '') || 'auto';

    const cleanup = () => { for (const f of [wavPath, txtPath]) fs.promises.unlink(f).catch(() => {}); };

    const clip = padWavStart(wavBuffer);
    fs.promises.writeFile(wavPath, clip).then(() => {
      const args = ['-m', model, '-l', safeLang, '-f', wavPath, '-otxt', '-of', outBase, '-nt', ...whisperSpeedArgs(clip.length)];
      execFile(exe, args, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, async (err) => {
        if (err) { cleanup(); return reject(new Error('whisper failed: ' + err.message)); }
        try {
          const text = await fs.promises.readFile(txtPath, 'utf8');
          cleanup();
          resolve(cleanTranscript(text));
        } catch (readErr) { cleanup(); reject(new Error('whisper produced no output')); }
      });
    }).catch(e => { cleanup(); reject(e); });
  });
}

module.exports = {
  WHISPER_BIN_NAMES, WHISPER_SYSTEM_DIRS, WHISPER_SYSTEM_BIN_NAMES, whisperPaths, whisperExe,
  WAV_BYTES_PER_SEC, whisperSpeedArgs, STT_NOISE, STT_HALLUCINATIONS, cleanTranscript, STT_LEAD_MS,
  padWavStart, localStt,
};

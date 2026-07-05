'use strict';

// ── Xenon AI — Local provider (Ollama + Whisper.cpp + msedge-tts) ──────────
// Mirror of the Gemini path but fully local/free. server.js routes to this
// module when the request's provider is 'ollama'. The Gemini path is untouched.

const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

// Curated models that are verified to support tool calling. The custom option
// lets power users pass any installed model (with a tool-calling caveat in UI).
const MODEL_WHITELIST = Object.freeze({
  'auto':        { label: 'Auto',        download: null /* chosen by scanHardware */ },
  'qwen2.5:3b':  { label: 'Leggero',     download: 'qwen2.5:3b' },
  'qwen2.5:7b':  { label: 'Bilanciato',  download: 'qwen2.5:7b' },
  'llama3.1:8b': { label: 'Potente',     download: 'llama3.1:8b' },
  'gemma4:12b':  { label: 'Avanzato',    download: 'gemma4:12b' },
});

// Models known to support image input via Ollama's OpenAI-compatible API.
const VISION_MODELS = new Set([
  'gemma4:12b', 'gemma4:e2b', 'gemma4:e4b', 'gemma4:26b',
  'llava', 'llava:7b', 'llava:13b', 'llava:34b',
  'bakllava', 'bakllava:latest',
  'minicpm-v', 'moondream', 'moondream2',
]);

// Per-language neural voices for msedge-tts. Language-agnostic fallback: it-IT.
const EDGE_VOICES = Object.freeze({
  it: 'it-IT-ElsaNeural',
  en: 'en-US-AriaNeural',
  ko: 'ko-KR-SunHiNeural',
  ja: 'ja-JP-NanamiNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
});
const EDGE_VOICE_FALLBACK = 'it-IT-ElsaNeural';

function voiceForLang(lang) {
  const code = String(lang || '').toLowerCase().slice(0, 2);
  return EDGE_VOICES[code] || EDGE_VOICE_FALLBACK;
}

function sanitizeProvider(value) {
  return value === 'ollama' ? 'ollama' : 'gemini';
}

// Whitelist keys OR a custom model tag: lowercase letters/digits . _ : - , max 60.
function sanitizeModel(value) {
  const v = String(value || '').trim();
  if (Object.prototype.hasOwnProperty.call(MODEL_WHITELIST, v)) return v;
  if (v.length > 0 && v.length <= 60 && /^[a-z0-9._:-]+$/.test(v)) return v;
  return 'auto';
}

function sanitizeOllamaUrl(value) {
  const v = String(value || '').trim();
  try {
    const u = new URL(v);
    if ((u.protocol === 'http:' || u.protocol === 'https:') &&
        (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return v.replace(/\/+$/, '');
    }
  } catch { /* fall through */ }
  return DEFAULT_OLLAMA_URL;
}

// Pure tier calculation from rounded GB figures. Mirrors the thresholds in the
// design spec §4.1. Returns { tier, recommended }.
function computeTier({ ramGB = 0, vramGB = 0, cores = 0 } = {}) {
  if (vramGB >= 10) return { tier: 'optimal',     recommended: 'gemma4:12b' };
  if (ramGB >= 16 || vramGB >= 6) return { tier: 'recommended', recommended: 'qwen2.5:7b' };
  if (ramGB >= 8 || vramGB >= 4) return { tier: 'minimum',     recommended: 'qwen2.5:3b' };
  return { tier: 'incompatible', recommended: 'auto' };
}

// True when the resolved Ollama model accepts image input via the OpenAI API.
// Matches exact whitelist entries and prefix patterns (e.g. "gemma4:12b-q4_0").
function modelSupportsVision(model) {
  if (!model || model === 'auto') return false;
  const m = String(model).toLowerCase();
  if (VISION_MODELS.has(m)) return true;
  return m.startsWith('gemma4') || m.startsWith('llava') || m.startsWith('bakllava') ||
         m.startsWith('minicpm-v') || m.startsWith('moondream') || m.includes(':vision');
}

// Best-effort GPU VRAM in GB via WMI AdapterRAM (32-bit, capped at 4 GB) with a
// registry fallback for cards >4 GB (HardwareInformation.qwMemorySize). Returns
// 0 when no dedicated GPU info is available — the scan then relies on RAM only.
function _readGpuVramGB(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const ps = [
      '$ErrorActionPreference="SilentlyContinue";',
      '$best=0;',
      // Registry holds true VRAM for modern GPUs (qwMemorySize, 64-bit).
      '$keys=Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -EA SilentlyContinue;',
      'foreach($k in $keys){ $v=(Get-ItemProperty $k.PSPath -Name "HardwareInformation.qwMemorySize" -EA SilentlyContinue)."HardwareInformation.qwMemorySize"; if($v -and $v -gt $best){$best=$v} }',
      'if($best -le 0){ $g=Get-CimInstance Win32_VideoController -EA SilentlyContinue | Sort-Object AdapterRAM -Descending | Select-Object -First 1; if($g){$best=$g.AdapterRAM} }',
      'Write-Output $best',
    ].join(' ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(0);
        const bytes = Number(String(stdout).trim()) || 0;
        resolve(bytes > 0 ? Math.round(bytes / (1024 ** 3)) : 0);
      });
  });
}

// Full hardware probe: RAM from os, cores from os, VRAM from PowerShell. Returns
// { ram, vram, cores, tier, recommended } with GB rounded down for RAM (so a
// "16 GB" stick reading 15.9 still counts as 16 via Math.round).
async function scanHardware() {
  const ramGB = Math.round(os.totalmem() / (1024 ** 3));
  const cores = os.cpus() ? os.cpus().length : 0;
  const vramGB = await _readGpuVramGB();
  const { tier, recommended } = computeTier({ ramGB, vramGB, cores });
  return { ram: ramGB, vram: vramGB, cores, tier, recommended };
}

const _TYPE_MAP = { OBJECT: 'object', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array' };

function _convertSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = {};
  if (schema.type) out.type = _TYPE_MAP[schema.type] || String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      out.properties[key] = _convertSchema(val);
    }
  }
  if (Array.isArray(schema.required)) out.required = schema.required.slice();
  if (schema.items) out.items = _convertSchema(schema.items);
  // An OpenAI object schema must always have a properties map.
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// Convert the Gemini functionDeclarations array into OpenAI tools[] for Ollama.
function geminiToolsToOpenAI(geminiFns) {
  if (!Array.isArray(geminiFns)) return [];
  return geminiFns.map(fn => ({
    type: 'function',
    function: {
      name: fn.name,
      description: fn.description || '',
      parameters: _convertSchema(fn.parameters),
    },
  }));
}

// Map Gemini chat history to OpenAI messages for Ollama.
// Vision-capable models (gemma4, llava…): inline images are forwarded as
// OpenAI image_url content parts so the model can actually analyse them.
// Text-only models: images fall back to a "[immagine]" placeholder.
function geminiHistoryToOpenAI(history, { supportsVision = false } = {}) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const msg of history) {
    if (!msg || !Array.isArray(msg.parts)) continue;
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const hasImages = msg.parts.some(p => p && p.inlineData && p.inlineData.data);

    if (supportsVision && hasImages) {
      // Build an OpenAI multipart content array: text first, then images.
      const content = [];
      const textPieces = [];
      for (const p of msg.parts) {
        if (p && typeof p.text === 'string' && p.text.trim()) {
          textPieces.push(p.text.trim());
        } else if (p && p.inlineData && p.inlineData.data && p.inlineData.mimeType) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
          });
        }
      }
      if (textPieces.length) content.unshift({ type: 'text', text: textPieces.join(' ').trim() });
      if (content.length) out.push({ role, content });
    } else {
      // Text-only path: images degrade to a placeholder tag.
      const pieces = [];
      for (const p of msg.parts) {
        if (p && typeof p.text === 'string' && p.text.trim()) pieces.push(p.text.trim());
        else if (p && p.inlineData) pieces.push('[immagine]');
      }
      const content = pieces.join(' ').trim();
      if (content) out.push({ role, content });
    }
  }
  return out;
}

// Map Gemini chat history to Ollama NATIVE (/api/chat) messages. The native API
// differs from the OpenAI one: images ride on a separate `images: [base64]`
// array on the message (raw base64, NO "data:" prefix), and content stays a
// plain string. Text-only models get a "[immagine]" placeholder instead.
function geminiHistoryToNative(history, { supportsVision = false } = {}) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const msg of history) {
    if (!msg || !Array.isArray(msg.parts)) continue;
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const textPieces = [];
    const images = [];
    for (const p of msg.parts) {
      if (p && typeof p.text === 'string' && p.text.trim()) {
        textPieces.push(p.text.trim());
      } else if (p && p.inlineData && p.inlineData.data) {
        if (supportsVision) images.push(p.inlineData.data); // raw base64, no prefix
        else textPieces.push('[immagine]');
      }
    }
    const content = textPieces.join(' ').trim();
    if (!content && images.length === 0) continue;
    const m = { role, content };
    if (images.length) m.images = images;
    out.push(m);
  }
  return out;
}

// Normalize an Ollama NATIVE (/api/chat) response into { text, functionCall,
// raw }. Native puts the message at resp.message and tool-call arguments are
// already a plain object (not a JSON string).
function parseOllamaNativeResponse(resp) {
  const msg = resp && resp.message;
  if (!msg) return { text: '', functionCall: null, raw: null };
  const textContent = typeof msg.content === 'string' ? msg.content : '';
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  // A tool call without a usable name (malformed response) degrades to text-only.
  if (calls.length > 0 && calls[0].function && typeof calls[0].function.name === 'string' && calls[0].function.name) {
    const fn = calls[0].function;
    let args = {};
    if (fn.arguments && typeof fn.arguments === 'object') args = fn.arguments;
    else if (typeof fn.arguments === 'string') { try { args = JSON.parse(fn.arguments); } catch { args = {}; } }
    return { text: textContent, functionCall: { name: fn.name, args }, raw: msg };
  }
  return { text: textContent, functionCall: null, raw: msg };
}

// Normalize an Ollama OpenAI-style response into { text, functionCall, raw }.
// functionCall.args is always a plain object (parsed from the JSON string).
// Handles both string content (text-only models) and array content (multimodal
// models like gemma4 that return [{type:"text",text:"..."},...]).
function parseOllamaResponse(resp) {
  const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
  if (!msg) return { text: '', functionCall: null, raw: null };

  // Extract text from either a plain string or a multimodal content array.
  let textContent = '';
  if (typeof msg.content === 'string') {
    textContent = msg.content;
  } else if (Array.isArray(msg.content)) {
    textContent = msg.content
      .filter(p => p && p.type === 'text')
      .map(p => String(p.text || ''))
      .join('');
  }

  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  // A tool call without a usable name (malformed response) degrades to text-only.
  if (calls.length > 0 && calls[0].function && typeof calls[0].function.name === 'string' && calls[0].function.name) {
    const fn = calls[0].function;
    let args = {};
    if (fn.arguments && typeof fn.arguments === 'object') args = fn.arguments;
    else if (typeof fn.arguments === 'string') { try { args = JSON.parse(fn.arguments); } catch { args = {}; } }
    return { text: textContent, functionCall: { name: fn.name, args, id: calls[0].id || 'call_0' }, raw: msg };
  }
  return { text: textContent, functionCall: null, raw: msg };
}

// POST to Ollama's OpenAI-compatible chat endpoint. Resolves the parsed JSON
// body. Rejects on non-2xx, timeout, or connection refused (Ollama not running).
function _callOllama(baseUrl, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL('/v1/chat/completions', baseUrl); }
    catch { return reject(new Error('invalid ollama url')); }
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname, port: u.port || 11434, path: u.pathname, method: 'POST', family: 4,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`ollama http ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('ollama: invalid JSON response')); }
      });
    });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') reject(new Error('Ollama non in esecuzione su ' + baseUrl));
      else reject(e);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ollama request timed out')); });
    req.write(body);
    req.end();
  });
}

// POST to Ollama's NATIVE chat endpoint (/api/chat). Unlike the OpenAI-compatible
// layer, this one honours `options.num_ctx`, so it's the only way to lift the
// per-request context window above the model's 4096-token default. Same resolve/
// reject contract as _callOllama.
function _callOllamaNative(baseUrl, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL('/api/chat', baseUrl); }
    catch { return reject(new Error('invalid ollama url')); }
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: u.hostname, port: u.port || 11434, path: u.pathname, method: 'POST', family: 4,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`ollama http ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('ollama: invalid JSON response')); }
      });
    });
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') reject(new Error('Ollama non in esecuzione su ' + baseUrl));
      else reject(e);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ollama request timed out')); });
    req.write(body);
    req.end();
  });
}

// Local chat turn via Ollama. Mirrors the Gemini /api/ai flow:
//  - converts tools + history to Ollama's native /api/chat format
//  - runs a function-calling loop (max 4 iterations) using the injected
//    executeTool(fnName, fnArgs) → { fnResult, clientActions }
// Uses the NATIVE endpoint (not the OpenAI-compatible one) so we can set
// options.num_ctx — the OpenAI layer silently ignores it, capping the context
// at the model's 4096-token default and rejecting our prompt + tools schema.
// Returns { text, clientActions, newContent } in the SAME shape the client
// already expects from /api/ai (newContent is a Gemini-style model message so
// the client history stays consistent across providers).
async function localChat({ baseUrl, model, geminiTools, history, systemText, executeTool }) {
  const tools = geminiToolsToOpenAI(geminiTools); // native tools share the OpenAI shape
  const supportsVision = modelSupportsVision(model);
  const messages = [{ role: 'system', content: systemText }, ...geminiHistoryToNative(history, { supportsVision })];
  const clientActions = [];
  let finalText = '';

  // Large models (≥10B) need time to load from disk into VRAM on the first call.
  // Use a generous timeout so the first inference doesn't time out mid-load.
  const modelTag = String(model || '').toLowerCase();
  const isLargeModel = /:\d{2}b|:12b|:13b|:14b|:27b|:30b|:34b|:70b/.test(modelTag) || modelTag.startsWith('gemma4');
  const inferenceTimeout = isLargeModel ? 180000 : 90000;

  // gemma4 and other models default to 4096-token context in Ollama — too small
  // for our system prompt + tools schema. Always request a comfortable window.
  const numCtx = isLargeModel ? 16384 : 8192;

  // Raised from 4 to 6 to match the server (Gemini) side, so a multi-step local
  // request (chain of dashboard actions) isn't cut off early. Local inference is
  // slower, so we stay a little below the cloud cap of 8.
  const MAX_ITERS = 6;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const resp = await _callOllamaNative(baseUrl, { model, messages, tools, stream: false, options: { num_ctx: numCtx } }, inferenceTimeout);
    const parsed = parseOllamaNativeResponse(resp);

    if (!parsed.functionCall) { finalText = parsed.text; break; }

    // Record the assistant tool call so Ollama keeps context across the loop.
    // Native tool_calls carry the arguments as a plain object (no JSON string).
    messages.push({
      role: 'assistant',
      content: parsed.text || '',
      tool_calls: [{ function: { name: parsed.functionCall.name, arguments: parsed.functionCall.args } }],
    });

    const { fnResult, clientActions: acts } = await executeTool(parsed.functionCall.name, parsed.functionCall.args);
    for (const a of (acts || [])) clientActions.push(a);

    messages.push({ role: 'tool', content: JSON.stringify(fnResult) });

    if (iter === MAX_ITERS - 1) {
      // Final guard: ask once more for a closing text answer.
      const last = await _callOllamaNative(baseUrl, { model, messages, stream: false, options: { num_ctx: numCtx } }, inferenceTimeout);
      finalText = parseOllamaNativeResponse(last).text;
    }
  }

  // Safety net: some models can return empty content when passed a large tools
  // schema. Re-try once without tools to guarantee a plain-text reply.
  if (!finalText) {
    const fallback = await _callOllamaNative(baseUrl, { model, messages, stream: false, options: { num_ctx: numCtx } }, inferenceTimeout);
    finalText = parseOllamaNativeResponse(fallback).text;
  }

  const newContent = { role: 'model', parts: [{ text: finalText }] };
  return { text: finalText, clientActions, newContent };
}

// Turn the stored model setting into a concrete Ollama tag. 'auto' uses the
// hardware-scan recommendation, falling back to the lightest usable model.
function resolveModel(model, hardwareScan) {
  if (model && model !== 'auto') return model;
  const rec = hardwareScan && hardwareScan.recommended;
  if (rec && rec !== 'auto') return rec;
  return 'qwen2.5:3b';
}

// Resolve the expected whisper.cpp locations under server/whisper/. The exe name
// matches the modern whisper.cpp release ("whisper-cli.exe"); a legacy
// "main.exe"/"whisper.exe" is accepted as a fallback by whisperExe().
function whisperPaths(serverDir) {
  const dir = path.join(serverDir, 'whisper');
  return { dir, exe: path.join(dir, 'whisper-cli.exe'), model: path.join(dir, 'ggml-small.bin') };
}

// Return the first existing whisper executable, or null if none present.
function whisperExe(serverDir) {
  const dir = path.join(serverDir, 'whisper');
  for (const name of ['whisper-cli.exe', 'whisper.exe', 'main.exe']) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
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

    fs.promises.writeFile(wavPath, wavBuffer).then(() => {
      const args = ['-m', model, '-l', safeLang, '-f', wavPath, '-otxt', '-of', outBase, '-nt'];
      execFile(exe, args, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, async (err) => {
        if (err) { cleanup(); return reject(new Error('whisper failed: ' + err.message)); }
        try {
          const text = await fs.promises.readFile(txtPath, 'utf8');
          cleanup();
          resolve(text.trim());
        } catch (readErr) { cleanup(); reject(new Error('whisper produced no output')); }
      });
    }).catch(e => { cleanup(); reject(e); });
  });
}

// Synthesize `text` to a WAV Buffer using msedge-tts, transcoding the MP3 stream
// to WAV via ffmpeg. `ffmpegPath` is injected by server.js (getFfmpegPath()).
async function localTts(text, lang, ffmpegPath) {
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) return Buffer.alloc(0);

  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceForLang(lang), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(clean);

  const mp3 = await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error('edge-tts timeout')), 20000);
    audioStream.on('data', c => chunks.push(c));
    audioStream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    audioStream.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    audioStream.on('error', e => { clearTimeout(timer); reject(e); });
  });
  if (!mp3 || mp3.length === 0) throw new Error('edge-tts produced no audio');

  // Transcode MP3 → WAV (pcm_s16le) via ffmpeg. We write to a temp FILE rather
  // than a stdout pipe: on a non-seekable pipe ffmpeg cannot backfill the RIFF
  // and `data` chunk sizes, leaving them as 0xFFFFFFFF placeholders, and
  // System.Media.SoundPlayer (the server-side player) then plays no audio. A
  // real file is seekable, so the header gets correct sizes.
  const outPath = path.join(os.tmpdir(), `xenon-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    return await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', outPath], { windowsHide: true });
      const errBuf = [];
      ff.stderr.on('data', c => errBuf.push(c));
      ff.on('error', reject);
      ff.on('close', async code => {
        if (code !== 0) return reject(new Error('ffmpeg wav transcode failed: ' + Buffer.concat(errBuf).toString().slice(0, 200)));
        try {
          const wav = await fs.promises.readFile(outPath);
          if (!wav.length) return reject(new Error('ffmpeg produced empty wav'));
          resolve(wav);
        } catch (e) { reject(e); }
      });
      ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
      ff.stdin.write(mp3);
      ff.stdin.end();
    });
  } finally {
    fs.promises.unlink(outPath).catch(() => {});
  }
}

// Health of the three local components. Ollama is reported with both `installed`
// (the binary exists on disk/PATH) and `running` (the HTTP API answers), so the
// UI can offer a "start" button when it's installed but not yet serving.
async function localStatus(baseUrl, serverDir) {
  const running = await _ollamaReachable(baseUrl);
  const installed = running || !!findOllamaExe();
  const whisper = !!whisperExe(serverDir) && fs.existsSync(whisperPaths(serverDir).model);
  let edgeTts = false;
  try { require.resolve('msedge-tts'); edgeTts = true; } catch { edgeTts = false; }
  return { ollama: { installed, running }, whisper, edgeTts };
}

// Locate the Ollama executable on Windows. Checks the default install location
// and common PATH-derived spots. Returns the full path or null.
function findOllamaExe() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

// Start the Ollama server (`ollama serve`) detached, then poll until the HTTP API
// answers. Resolves { ok, running }. If already running, resolves immediately.
async function startOllama(baseUrl, timeoutMs = 12000) {
  if (await _ollamaReachable(baseUrl)) return { ok: true, running: true };
  const exe = findOllamaExe();
  if (!exe) return { ok: false, running: false, error: 'ollama_not_installed' };
  try {
    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    return { ok: false, running: false, error: e.message };
  }
  // Poll for readiness (Ollama takes a moment to bind the port).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 600));
    if (await _ollamaReachable(baseUrl)) return { ok: true, running: true };
  }
  return { ok: false, running: false, error: 'ollama_start_timeout' };
}

// Read/write a per-user "run Ollama at login" entry in the registry Run key.
// Uses reg.exe so no extra dependency is needed. Value name: XenonEdgeOllama.
const _OLLAMA_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const _OLLAMA_RUN_VALUE = 'XenonEdgeOllama';

function getOllamaAutostart() {
  return new Promise((resolve) => {
    execFile('reg', ['query', _OLLAMA_RUN_KEY, '/v', _OLLAMA_RUN_VALUE], { windowsHide: true },
      (err, stdout) => resolve(!err && /XenonEdgeOllama/i.test(String(stdout))));
  });
}

function setOllamaAutostart(enabled) {
  return new Promise((resolve) => {
    if (enabled) {
      // Prefer the GUI app (it starts the tray + server); fall back to `serve`.
      const exe = findOllamaExe();
      if (!exe) return resolve({ ok: false, error: 'ollama_not_installed' });
      const appExe = path.join(path.dirname(exe), 'ollama app.exe');
      const target = fs.existsSync(appExe) ? `"${appExe}"` : `"${exe}" serve`;
      execFile('reg', ['add', _OLLAMA_RUN_KEY, '/v', _OLLAMA_RUN_VALUE, '/t', 'REG_SZ', '/d', target, '/f'],
        { windowsHide: true }, (err) => resolve({ ok: !err, error: err && err.message }));
    } else {
      execFile('reg', ['delete', _OLLAMA_RUN_KEY, '/v', _OLLAMA_RUN_VALUE, '/f'],
        { windowsHide: true }, () => resolve({ ok: true })); // ignore "not found"
    }
  });
}

function _ollamaReachable(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/tags', baseUrl); } catch { return resolve(false); }
    // family: 4 forces IPv4 — on Windows, Node resolves "localhost" to ::1 (IPv6)
    // first, but Ollama listens on 127.0.0.1 only, so without this the health
    // check fails with ECONNREFUSED even when Ollama is running.
    const req = http.request({ hostname: u.hostname, port: u.port || 11434, path: u.pathname, method: 'GET', family: 4 },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// List the models currently installed in Ollama. GET /api/tags over IPv4 (same
// reason as _ollamaReachable: localhost resolves to ::1 first on Windows, but
// Ollama listens on 127.0.0.1). Resolves to an array of name strings (e.g.
// ["qwen2.5:7b","llama3.1:latest"]). Never rejects — returns [] on any failure.
function listOllamaModels(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/tags', baseUrl); } catch { return resolve([]); }
    const req = http.request({ hostname: u.hostname, port: u.port || 11434, path: u.pathname, method: 'GET', family: 4 },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve([]); }
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = Array.isArray(parsed && parsed.models) ? parsed.models : [];
            resolve(models.map(m => m && typeof m.name === 'string' ? m.name : '').filter(Boolean));
          } catch { resolve([]); }
        });
      });
    req.on('error', () => resolve([]));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

// Stream `ollama pull` progress. Calls onProgress({status,total,completed}) for
// each NDJSON line. Resolves on completion, rejects on connection/HTTP errors.
function pullModel(baseUrl, model, onProgress) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL('/api/pull', baseUrl); } catch { return reject(new Error('invalid ollama url')); }
    const body = JSON.stringify({ name: model, stream: true });
    const req = http.request({
      hostname: u.hostname, port: u.port || 11434, path: u.pathname, method: 'POST', family: 4,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); return reject(new Error('ollama pull http ' + res.statusCode));
      }
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { onProgress(JSON.parse(line)); } catch { /* skip partial */ }
        }
      });
      res.on('end', () => resolve());
    });
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error('Ollama non in esecuzione') : e));
    req.setTimeout(30 * 60 * 1000, () => { req.destroy(); reject(new Error('ollama pull timed out')); });
    req.write(body); req.end();
  });
}

// ── Free local web search (DuckDuckGo) ────────────────────────────────────
// The local provider must stay key-free and offline-friendly, so web_search is
// served by DuckDuckGo instead of Gemini grounding. Strategy: try the Instant
// Answer JSON API first (clean, structured), then fall back to scraping the
// lite HTML endpoint for organic result snippets. Returns the SAME shape the
// Gemini search returns — { answer, sources:[{title,url}] } or { error } — so
// executeAiTool can branch on the provider without changing its result schema.

// HTTPS GET returning the response body as text, following 30x redirects.
function _httpsGetText(url, timeoutMs = 8000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/json',
      },
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(_httpsGetText(next, timeoutMs, _redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('http ' + code)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('search request timed out')); });
  });
}

// Strip HTML tags and decode the handful of entities DuckDuckGo emits.
function _stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// DuckDuckGo result links are redirect URLs (//duckduckgo.com/l/?uddg=<enc>).
// Extract and decode the real destination, or return the href unchanged.
function _ddgRealUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : 'https:' + href;
  } catch { return href; }
}

// Parse organic results from the DuckDuckGo lite/html SERP.
function _parseDdgHtml(html, limit = 4) {
  const sources = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && sources.length < limit) {
    const url = _ddgRealUrl(m[1]);
    const title = _stripHtml(m[2]);
    if (title && url) sources.push({ title, url });
  }
  const snippets = [];
  const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html)) && snippets.length < limit) {
    const text = _stripHtml(m[1]);
    if (text) snippets.push(text);
  }
  return { sources, snippets };
}

// Public web search for the local provider. `query` is the model's search query.
async function localWebSearch(query, timeoutMs = 8000) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { error: 'empty query' };
  const enc = encodeURIComponent(q);

  // 1) Instant Answer API — best for definitions, facts, direct answers.
  try {
    const raw = await _httpsGetText(
      `https://api.duckduckgo.com/?q=${enc}&format=json&no_html=1&no_redirect=1&skip_disambig=1`, timeoutMs);
    const j = JSON.parse(raw);
    const direct = _stripHtml(j.AbstractText || j.Answer || j.Definition || '');
    const sources = [];
    if (j.AbstractURL) sources.push({ title: _stripHtml(j.Heading || q), url: j.AbstractURL });
    const related = Array.isArray(j.RelatedTopics) ? j.RelatedTopics : [];
    for (const r of related) {
      if (sources.length >= 4) break;
      if (r && r.FirstURL && r.Text) sources.push({ title: _stripHtml(r.Text), url: r.FirstURL });
    }
    if (direct) return { query: q, answer: direct, sources };
  } catch { /* fall through to HTML scrape */ }

  // 2) HTML SERP scrape — general queries (news, prices, "X today").
  try {
    const html = await _httpsGetText(`https://html.duckduckgo.com/html/?q=${enc}`, timeoutMs);
    const { sources, snippets } = _parseDdgHtml(html);
    if (snippets.length || sources.length) {
      const answer = snippets.slice(0, 3).join(' ').slice(0, 1200) ||
        sources.slice(0, 3).map(s => s.title).join(' · ');
      return { query: q, answer, sources };
    }
  } catch (e) {
    return { error: 'web search unavailable: ' + (e && e.message || e) };
  }
  return { error: 'no results' };
}

// ── On-demand Whisper.cpp install ─────────────────────────────────────────
// The installer no longer bundles Whisper.cpp/Ollama (too slow for everyone).
// Instead the user downloads Whisper from Settings → Xenon AI when switching to
// the local provider. These helpers fetch the latest whisper.cpp Windows x64
// build + the ggml-small model, streaming progress back to the UI over SSE.

// HTTPS GET to a file, following 30x redirects (GitHub asset and HuggingFace
// URLs both redirect to a CDN). Streams to destPath and reports received/total
// bytes from content-length. Rejects on non-200 (after redirects) or timeout.
function _downloadToFile(url, destPath, onProgress, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'XenonEdgeHub' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(_downloadToFile(next, destPath, onProgress, _redirects + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('download http ' + code + ' for ' + url));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const file = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (typeof onProgress === 'function') { try { onProgress(received, total); } catch { /* ignore */ } }
      });
      res.on('error', (e) => { file.close(); fs.promises.unlink(destPath).catch(() => {}); reject(e); });
      file.on('error', (e) => { res.destroy(); fs.promises.unlink(destPath).catch(() => {}); reject(e); });
      file.on('finish', () => file.close(() => resolve()));
      res.pipe(file);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('download timed out: ' + url)); });
  });
}

// HTTPS GET returning parsed JSON, following redirects. Used for the GitHub
// releases API (sends the recommended Accept + User-Agent headers).
function _httpsJson(url, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'XenonEdgeHub', 'Accept': 'application/vnd.github+json' },
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(_httpsJson(next, _redirects + 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('http ' + code + ' for ' + url));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON from ' + url)); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('request timed out: ' + url)); });
  });
}

// Extract a zip via the .NET ZipFile API. We deliberately AVOID Expand-Archive:
// that pure-PowerShell cmdlet is 10–50× slower and streams no progress, so a
// large extraction looked frozen. ZipFile::ExtractToDirectory is the fast native
// path. The caller passes a FRESH (non-existent) destDir, so the plain 2-arg
// overload is enough — the overwrite (3-arg) overload is missing on Windows
// PowerShell 5.1 / .NET Framework, so we never rely on it. Single quotes in paths
// are doubled so the PowerShell single-quoted literals stay intact.
function _unzipWindows(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const z = zipPath.replace(/'/g, "''");
    const d = destDir.replace(/'/g, "''");
    const ps =
      `Unblock-File -LiteralPath '${z}' -ErrorAction SilentlyContinue; ` +
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${z}','${d}')`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 120000 },
      (err) => err ? reject(new Error('unzip failed: ' + err.message)) : resolve());
  });
}

// Recursively locate a whisper executable under `dir`. Returns the full path or
// null. Used after unzip to find where the release placed the binary.
function _findWhisperExeRecursive(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const names = ['whisper-cli.exe', 'main.exe', 'whisper.exe'];
  for (const ent of entries) {
    if (ent.isFile() && names.includes(ent.name.toLowerCase())) return path.join(dir, ent.name);
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const found = _findWhisperExeRecursive(path.join(dir, ent.name));
      if (found) return found;
    }
  }
  return null;
}

// Download + set up Whisper.cpp on demand. onProgress({ status, percent }).
//  1. Ensure the whisper dir exists.
//  2. If no exe: fetch latest whisper.cpp release, pick the Windows x64 zip,
//     download (0→40%), unzip, delete the zip, then flatten so the exe sits in
//     the dir root next to its ggml*.dll siblings.
//  3. If the ggml-small model is missing: download it (45→100%).
// Returns { ok } reflecting whether both the exe and model are now present.
async function installWhisper(serverDir, onProgress) {
  const report = (status, percent) => {
    if (typeof onProgress === 'function') { try { onProgress({ status, percent }); } catch { /* ignore */ } }
  };
  const { dir, model } = whisperPaths(serverDir);
  await fs.promises.mkdir(dir, { recursive: true });

  if (!whisperExe(serverDir)) {
    report('Download Whisper…', 0);
    const release = await _httpsJson('https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest');
    const assets = Array.isArray(release && release.assets) ? release.assets : [];
    // Prefer the small CPU build (`whisper-bin-x64.zip`, ~4 MB). The accelerated
    // variants (cuBLAS/CUDA can be ~450 MB) need a matching GPU runtime and are far
    // slower to download AND extract — that heavyweight zip is exactly what made the
    // install look frozen. Never auto-pick them; STT on the CPU build is plenty fast.
    const heavy = /cublas|cuda|clblast|hipblas|hip|vulkan|openblas|blas|arm64/i;
    const isCpuX64 = (n) => /x64.*\.zip$/i.test(n) && !/win32/i.test(n) && !heavy.test(n);
    const pick = (pred) => assets.find(a => a && typeof a.name === 'string' && a.browser_download_url && pred(a.name));
    const asset =
      pick(n => /^whisper-bin-x64\.zip$/i.test(n)) ||                 // canonical CPU build (smallest)
      pick(isCpuX64) ||                                              // any plain (non-accelerated) x64 zip
      pick(n => /x64.*\.zip$/i.test(n) && !/win32/i.test(n));        // last resort: an accelerated x64 build
    if (!asset) {
      throw new Error('No Windows x64 whisper.cpp release asset found');
    }
    const zipPath = path.join(dir, 'whisper.zip');
    await _downloadToFile(asset.browser_download_url, zipPath, (received, total) => {
      const frac = total > 0 ? received / total : 0;
      report('Download Whisper…', Math.round(frac * 40));
    });
    report('Estrazione Whisper…', 42);
    // Extract into a FRESH subfolder (removed first in case a prior attempt left
    // it behind), so the plain ZipFile overload never hits an "already exists"
    // conflict — then flatten the exe + its sibling DLLs up into `dir`.
    const unpackDir = path.join(dir, '_unpack');
    await fs.promises.rm(unpackDir, { recursive: true, force: true }).catch(() => {});
    await _unzipWindows(zipPath, unpackDir);
    await fs.promises.unlink(zipPath).catch(() => {});

    const exePath = _findWhisperExeRecursive(unpackDir);
    if (exePath) {
      const exeDir = path.dirname(exePath);
      const files = await fs.promises.readdir(exeDir);
      // Copy only what STT actually needs: the CLI exe and its runtime DLLs.
      // The release zip also ships ~8.5 MB of demo tools (talk-llama, wchess,
      // stream, bench, …) plus SDL2.dll, which only those demos use — skip them.
      const KEEP_EXES = new Set(['whisper-cli.exe', 'whisper.exe', 'main.exe']);
      const isNeeded = (name) => {
        const n = name.toLowerCase();
        if (KEEP_EXES.has(n)) return true;
        return n.endsWith('.dll') && n !== 'sdl2.dll';
      };
      for (const f of files) {
        if (!isNeeded(f)) continue;
        await fs.promises.copyFile(path.join(exeDir, f), path.join(dir, f)).catch(() => {});
      }
    }
    await fs.promises.rm(unpackDir, { recursive: true, force: true }).catch(() => {});
  }

  if (!fs.existsSync(model)) {
    report('Download modello vocale…', 45);
    await _downloadToFile('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', model,
      (received, total) => {
        const frac = total > 0 ? received / total : 0;
        report('Download modello vocale…', 45 + Math.round(frac * 55));
      });
  }

  report('success', 100);
  if (typeof onProgress === 'function') { try { onProgress({ status: 'success', percent: 100, done: true }); } catch { /* ignore */ } }
  return { ok: !!whisperExe(serverDir) && fs.existsSync(model) };
}

module.exports = {
  DEFAULT_OLLAMA_URL,
  MODEL_WHITELIST,
  VISION_MODELS,
  EDGE_VOICES,
  EDGE_VOICE_FALLBACK,
  voiceForLang,
  sanitizeProvider,
  sanitizeModel,
  sanitizeOllamaUrl,
  computeTier,
  _readGpuVramGB,
  scanHardware,
  modelSupportsVision,
  geminiToolsToOpenAI,
  geminiHistoryToOpenAI,
  geminiHistoryToNative,
  parseOllamaResponse,
  parseOllamaNativeResponse,
  _callOllama,
  _callOllamaNative,
  localChat,
  resolveModel,
  whisperPaths,
  whisperExe,
  installWhisper,
  localStt,
  localTts,
  localStatus,
  _ollamaReachable,
  listOllamaModels,
  localWebSearch,
  _stripHtml,
  _ddgRealUrl,
  _parseDdgHtml,
  pullModel,
  findOllamaExe,
  startOllama,
  getOllamaAutostart,
  setOllamaAutostart,
};

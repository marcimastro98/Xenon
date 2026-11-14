'use strict';
const { createPace } = require('./search-pace');
require('./net-guard');

// ── Xenon AI — Local provider (Ollama + Whisper.cpp + msedge-tts) ──────────
// Mirror of the Gemini path but fully local/free. server.js routes to this
// module when the request's provider is 'ollama'. The Gemini path is untouched.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
require('./ai-tool-groups');

const {
  DEFAULT_OLLAMA_URL, MODEL_WHITELIST, VISION_MODELS, EDGE_VOICES, EDGE_VOICE_FALLBACK,
  voiceForLang, AI_PROVIDERS, sanitizeProvider, sanitizeModel, sanitizeOllamaUrl,
  modelSupportsVision,
} = require('./ai/local-choices.js');



const {
  MODEL_REQUIREMENTS, computeTier, modelSafety, _readGpuVramGB, scanHardware,
} = require('./ai/local-hardware.js');

const {
  geminiToolsToOpenAI, geminiHistoryToOpenAI, geminiHistoryToNative, parseOllamaNativeResponse,
  parseOllamaResponse,
} = require('./ai/local-ollama-shapes.js');

const {
  _callOllama, _callOllamaNative, _ollamaReachable, listOllamaModels, showModelCapabilities,
  capabilitiesFor, supportsVisionLive, pullModel,
} = require('./ai/local-ollama-calls.js');

const { localChat, resolveModel } = require('./ai/local-chat.js');

const {
  whisperPaths, whisperExe, whisperSpeedArgs, cleanTranscript, padWavStart, localStt,
} = require('./ai/local-stt.js');




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
      // -protocol_whitelist pipe (an input option: the output file is not
      // affected): the input is untrusted audio whose format ffmpeg guesses,
      // and a playlist format must not reach local files or URLs.
      const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', outPath], { windowsHide: true });
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

const {
  findOllamaExe, startOllama, ollamaAutostartSupported, getOllamaAutostart, setOllamaAutostart,
} = require('./ai/local-ollama-start.js');



// ── Free local web search (DuckDuckGo) ────────────────────────────────────
// The local provider must stay key-free and offline-friendly, so web_search is
// served by DuckDuckGo instead of Gemini grounding. Strategy: try the Instant
// Answer JSON API first (clean, structured), then fall back to scraping the
// lite HTML endpoint for organic result snippets. Returns the SAME shape the
// Gemini search returns — { answer, sources:[{title,url}] } or { error } — so
// executeAiTool can branch on the provider without changing its result schema.

const {
  _httpsGetText, _stripHtml, _ddgRealUrl, _parseDdgHtml,
} = require('./ai/local-search-page.js');

// DuckDuckGo's results page answers 202 with nothing in it to a search too soon after
// the last one. Measured 4 Nov 2026: 12 s apart all passed, 8 s apart the second
// failed, and Bit often searches twice in a turn. The instant answers have no such limit.
const DDG_PAGE_GAP_MS = 12000;
const ddgPagePace = createPace(DDG_PAGE_GAP_MS);

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
  const wait = ddgPagePace(Date.now());
  if (wait === null) return { error: 'web search busy' };
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
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
// the local provider. These helpers fetch a PINNED whisper.cpp Windows x64
// build + the ggml-small model, streaming progress back to the UI over SSE.

const {
  WHISPER_VERSION, WHISPER_ZIP_SHA256, WHISPER_ZIP_URL, installWhisper,
} = require('./ai/local-whisper-install.js');

module.exports = {
  AI_PROVIDERS,
  DEFAULT_OLLAMA_URL,
  MODEL_WHITELIST,
  MODEL_REQUIREMENTS,
  modelSafety,
  showModelCapabilities,
  capabilitiesFor,
  supportsVisionLive,
  VISION_MODELS,
  EDGE_VOICES,
  EDGE_VOICE_FALLBACK,
  voiceForLang,
  padWavStart,
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
  WHISPER_VERSION,
  WHISPER_ZIP_SHA256,
  WHISPER_ZIP_URL,
  localStt,
  whisperSpeedArgs,
  cleanTranscript,
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
  ollamaAutostartSupported,
  getOllamaAutostart,
  setOllamaAutostart,
};

'use strict';

// ── Gemini Live (BidiGenerateContent) protocol wrapper ────────────────────────
//
// Server-side client for the Gemini Live realtime API — the full-duplex "Voce
// Live (beta)" mode. It is mediated by the server (never browser↔Gemini direct)
// because on the Xeneon Edge WebView getUserMedia never resolves, so the mic is
// captured server-side via ffmpeg; keeping the Live socket here also lets every
// function call run through the same allowlisted executeAiTool the turn-based
// path uses, and keeps the API key off the wire.
//
// This module is deliberately split into PURE framing/parsing helpers (fully
// unit-tested with no socket) and a thin createLiveSession() that wires them to
// an injectable WebSocket implementation (the real `ws` in production, a fake in
// tests). Nothing here spawns processes or touches the filesystem.
//
// Protocol (verified against ai.google.dev/gemini-api/docs/live-api):
//   • Endpoint  wss://…/BidiGenerateContent?key=KEY
//   • Setup     { setup: { model, generationConfig, systemInstruction, tools,
//                          inputAudioTranscription:{}, outputAudioTranscription:{} } }
//   • Mic in    { realtimeInput: { audio: { data:<b64 PCM16>, mimeType:'audio/pcm;rate=16000' } } }
//   • Audio out serverContent.modelTurn.parts[].inlineData.data  (b64 PCM 24 kHz)
//   • Tools     toolCall.functionCalls[] → { toolResponse:{ functionResponses:[…] } }
//   • Barge-in  serverContent.interrupted === true  (native VAD, nothing to write)

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

// Audio formats fixed by the Live API. Input is 16 kHz mono 16-bit PCM; a 100 ms
// frame is the recommended send cadence → 16000 * 2 bytes * 0.1 s = 3200 bytes.
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const INPUT_MIME = `audio/pcm;rate=${INPUT_SAMPLE_RATE}`;
const CHUNK_MS = 100;
const INPUT_CHUNK_BYTES = Math.round(INPUT_SAMPLE_RATE * 2 * (CHUNK_MS / 1000)); // 3200

function liveWsUrl(apiKey) {
  // The key is a query param per the BidiGenerateContent spec; it never leaves
  // the server (the socket is opened here, not in the browser).
  const base = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  return `${base}?key=${encodeURIComponent(String(apiKey || ''))}`;
}

// Build the one-time setup frame. Voice replies (AUDIO), plus input+output
// transcription so the UI can show what was heard and what is being said.
function buildSetupMessage({ model, systemInstruction, tools, voiceName } = {}) {
  const generationConfig = { responseModalities: ['AUDIO'] };
  if (voiceName) {
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: String(voiceName) } },
    };
  }
  const setup = {
    model: `models/${String(model || LIVE_MODEL).replace(/^models\//, '')}`,
    generationConfig,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  const sysText = typeof systemInstruction === 'string' ? systemInstruction.trim() : '';
  if (sysText) setup.systemInstruction = { parts: [{ text: sysText }] };
  if (Array.isArray(tools) && tools.length) {
    setup.tools = [{ functionDeclarations: tools }];
  }
  return { setup };
}

function encodeAudioChunk(pcmBuf) {
  const b64 = Buffer.isBuffer(pcmBuf) ? pcmBuf.toString('base64') : Buffer.from(pcmBuf || []).toString('base64');
  return { realtimeInput: { audio: { data: b64, mimeType: INPUT_MIME } } };
}

// Signal the model that the user's audio stream has ended for this turn (used
// on a manual stop so Gemini finalises promptly rather than waiting on its VAD).
function encodeAudioStreamEnd() {
  return { realtimeInput: { audioStreamEnd: true } };
}

function encodeToolResponse(functionResponses) {
  const list = (Array.isArray(functionResponses) ? functionResponses : [])
    .map((r) => ({
      ...(r && r.id != null ? { id: r.id } : {}),
      name: String((r && r.name) || ''),
      response: (r && typeof r.response === 'object' && r.response) ? r.response : { output: '' },
    }))
    .filter((r) => r.name);
  return { toolResponse: { functionResponses: list } };
}

// Split a PCM buffer into fixed-size frames. A trailing partial frame is kept
// (the caller carries it forward, so no audio is dropped at buffer boundaries).
function chunkPcm(buf, chunkBytes = INPUT_CHUNK_BYTES) {
  const out = [];
  if (!buf || !buf.length) return out;
  const size = Math.max(2, chunkBytes - (chunkBytes % 2));
  let off = 0;
  for (; off + size <= buf.length; off += size) out.push(buf.slice(off, off + size));
  const rest = off < buf.length ? buf.slice(off) : null;
  return rest && rest.length ? out.concat([rest]) : out;
}

// Normalise one inbound server frame (already JSON-parsed) into a flat, stable
// shape the caller reacts to — insulating server.js from the raw proto wire form
// and from field-placement drift across preview revisions.
function parseServerMessage(msg) {
  const out = {
    setupComplete: false,
    audioChunks: [],   // base64 PCM 24 kHz strings, in order
    inputText: '',     // transcription of what the USER said
    outputText: '',    // transcription of what the ASSISTANT is saying
    toolCalls: [],      // { id, name, args }
    cancelledToolIds: [],
    interrupted: false,
    turnComplete: false,
    generationComplete: false,
    goAway: false,
    error: null,
  };
  if (!msg || typeof msg !== 'object') return out;

  if (msg.setupComplete) out.setupComplete = true;
  if (msg.goAway) out.goAway = true;
  if (msg.error) out.error = typeof msg.error === 'string' ? msg.error : (msg.error.message || 'live error');

  const sc = msg.serverContent;
  if (sc && typeof sc === 'object') {
    if (sc.interrupted) out.interrupted = true;
    if (sc.turnComplete) out.turnComplete = true;
    if (sc.generationComplete) out.generationComplete = true;
    if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') out.inputText = sc.inputTranscription.text;
    if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') out.outputText = sc.outputTranscription.text;
    const parts = sc.modelTurn && Array.isArray(sc.modelTurn.parts) ? sc.modelTurn.parts : [];
    for (const p of parts) {
      if (p && p.inlineData && typeof p.inlineData.data === 'string' && p.inlineData.data) {
        const mime = String(p.inlineData.mimeType || '');
        // Live model turns carry audio; ignore any non-audio inline part defensively.
        if (!mime || /^audio\//i.test(mime)) out.audioChunks.push(p.inlineData.data);
      }
    }
  }

  const tc = msg.toolCall;
  if (tc && Array.isArray(tc.functionCalls)) {
    for (const fc of tc.functionCalls) {
      if (!fc || !fc.name) continue;
      out.toolCalls.push({ id: fc.id != null ? fc.id : null, name: String(fc.name), args: (fc.args && typeof fc.args === 'object') ? fc.args : {} });
    }
  }
  const tcc = msg.toolCallCancellation;
  if (tcc && Array.isArray(tcc.ids)) out.cancelledToolIds = tcc.ids.slice();

  return out;
}

// Thin session over an injectable WebSocket constructor. The real caller passes
// the `ws` package's WebSocket; tests pass a fake that records sent frames and
// lets them push inbound messages. This class holds no timers and spawns no
// processes — lifecycle (ffmpeg capture, ducking, teardown) lives in server.js.
function createLiveSession(opts) {
  const {
    apiKey,
    model = LIVE_MODEL,
    systemInstruction = '',
    tools = [],
    voiceName = '',
    WebSocketImpl,
    onOpen = () => {},
    onSetupComplete = () => {},
    onAudio = () => {},         // (base64Pcm24k)
    onInputText = () => {},     // (text)
    onOutputText = () => {},    // (text)
    onToolCall = () => {},      // ([{id,name,args}])
    onInterrupted = () => {},
    onTurnComplete = () => {},
    onError = () => {},
    onClose = () => {},
  } = opts || {};

  if (typeof WebSocketImpl !== 'function') throw new Error('createLiveSession: WebSocketImpl is required');

  const ws = new WebSocketImpl(liveWsUrl(apiKey));
  let closed = false;

  const sendRaw = (obj) => {
    if (closed) return false;
    try {
      if (ws.readyState !== undefined && ws.readyState !== 1 /* OPEN */) return false;
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) { return false; }
  };

  ws.onopen = () => {
    onOpen();
    sendRaw(buildSetupMessage({ model, systemInstruction, tools, voiceName }));
  };
  ws.onmessage = (ev) => {
    let data = ev && ev.data !== undefined ? ev.data : ev;
    if (Buffer.isBuffer(data)) data = data.toString('utf8');
    else if (data instanceof ArrayBuffer) data = Buffer.from(data).toString('utf8');
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    const p = parseServerMessage(msg);
    if (p.setupComplete) onSetupComplete();
    for (const a of p.audioChunks) onAudio(a);
    if (p.inputText) onInputText(p.inputText);
    if (p.outputText) onOutputText(p.outputText);
    if (p.interrupted) onInterrupted();
    if (p.toolCalls.length) onToolCall(p.toolCalls);
    if (p.turnComplete) onTurnComplete();
    if (p.error) onError(new Error(p.error));
    if (p.goAway) close();
  };
  ws.onerror = (e) => {
    const err = (e && e.error) || (e instanceof Error ? e : new Error((e && e.message) || 'live socket error'));
    onError(err);
  };
  ws.onclose = (e) => {
    // Surface the Gemini close code + reason — the single most useful signal when
    // a session dies on connect (e.g. 1007/1008 for a bad model or setup, 1011 for
    // a server error). Forwarded to the client and logged.
    const info = { code: (e && e.code) || 0, reason: String((e && e.reason) || '') };
    if (!closed) { closed = true; onClose(info); }
  };

  function sendAudio(pcmBuf) { return sendRaw(encodeAudioChunk(pcmBuf)); }
  function endAudioTurn() { return sendRaw(encodeAudioStreamEnd()); }
  function sendToolResponse(functionResponses) { return sendRaw(encodeToolResponse(functionResponses)); }
  function close() {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch (e) { /* already gone */ }
    onClose({ code: 0, reason: 'local' });
  }

  return {
    sendAudio,
    endAudioTurn,
    sendToolResponse,
    close,
    get closed() { return closed; },
    _ws: ws, // exposed for tests only
  };
}

module.exports = {
  LIVE_MODEL,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  INPUT_MIME,
  INPUT_CHUNK_BYTES,
  liveWsUrl,
  buildSetupMessage,
  encodeAudioChunk,
  encodeAudioStreamEnd,
  encodeToolResponse,
  chunkPcm,
  parseServerMessage,
  createLiveSession,
};

'use strict';
// The calls to a running Ollama: a chat turn on either of its endpoints, whether it answers,
// the installed models, what a model can do, and a model download.

const http = require('node:http');
const { modelSupportsVision } = require('./local-choices.js');

// POST to Ollama's OpenAI-compatible chat endpoint. Resolves the parsed JSON
// body. Rejects on non-2xx, timeout, or connection refused (Ollama not running).
// Turn an Ollama HTTP error body into something a user can act on. The raw body
// (e.g. a CUDA "illegal memory access") is meaningless to them and looks like the
// dashboard broke; map the common runtime failures to a plain explanation + a fix.
function _ollamaHttpError(statusCode, data) {
  const low = String(data || '').toLowerCase();
  let err;
  if (low.includes('cuda') || low.includes('illegal memory access') || low.includes('device-side assert') || low.includes('ggml_cuda')) {
    err = new Error('AI locale: il modello è andato in crash sulla GPU (errore CUDA). '
      + 'Non è un limite del tuo hardware: è un bug noto tra Ollama, il driver NVIDIA e alcuni modelli. '
      + 'Prova così: aggiorna il driver NVIDIA e Ollama all’ultima versione, poi riavvia Ollama (o il PC). '
      + 'Se si ripresenta, passa temporaneamente a un modello più piccolo dalle impostazioni Xenon AI.');
    err.code = 'gpu_crash';
  } else if (low.includes('out of memory') || low.includes('unable to allocate') || low.includes('cudamalloc') || low.includes('insufficient memory')) {
    err = new Error('AI locale: memoria video (VRAM) insufficiente per questo modello. '
      + 'Scegli un modello più piccolo nelle impostazioni Xenon AI, o chiudi le app che stanno usando la GPU.');
    err.code = 'oom';
  } else if (low.includes('exceeds the available context size') || low.includes('exceeds context length')) {
    // The PROMPT alone did not fit the requested window — nothing was generated.
    // _localChatOnce grows num_ctx and retries on this code, so this message is
    // only ever seen when even the largest window we ask for is too small.
    err = new Error('AI locale: la richiesta è troppo lunga per la finestra di contesto del modello. '
      + 'Avvia una nuova chat (pulsante ↺) per liberare la cronologia, allega un\'immagine più piccola, '
      + 'oppure scegli un modello con una finestra più ampia nelle impostazioni Xenon AI.');
    err.code = 'context_exceeded';
  } else if (low.includes('not found') || low.includes('no such model') || low.includes('try pulling') || low.includes('model requires more')) {
    err = new Error('AI locale: il modello non è installato o non è disponibile. '
      + 'Scaricalo dalle impostazioni Xenon AI (provider locale).');
    err.code = 'model_missing';
  } else {
    err = new Error(`AI locale: Ollama ha risposto con un errore (HTTP ${statusCode}). ${String(data || '').slice(0, 160)}`);
    err.code = 'ollama_http';
  }
  return err;
}

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
          return reject(_ollamaHttpError(res.statusCode, data));
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
          return reject(_ollamaHttpError(res.statusCode, data));
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

// What an INSTALLED model can actually do, from Ollama itself. POST /api/show
// returns a `capabilities` array (e.g. ["completion","tools","vision"]) computed
// from the model's own template and architecture, which is the only non-guess
// answer available: VISION_MODELS above is a hand-maintained list of name
// patterns and it silently misses every model published after it was written.
// Never rejects — an empty array means "Ollama did not say", and callers fall
// back to the pattern list rather than declaring a capability absent.
function showModelCapabilities(baseUrl, model, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/show', baseUrl); } catch { return resolve([]); }
    const payload = JSON.stringify({ model: String(model || '') });
    const req = http.request({
      hostname: u.hostname, port: u.port || 11434, path: u.pathname, method: 'POST', family: 4,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve([]); }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const caps = Array.isArray(parsed && parsed.capabilities) ? parsed.capabilities : [];
          resolve(caps.filter(c => typeof c === 'string').map(c => c.toLowerCase()));
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve([]); });
    req.write(payload);
    req.end();
  });
}

// Capabilities are a property of an installed tag, so they are cached per model.
// Bounded (never an unbounded Map) and small: a machine has a handful of models.
const _capsCache = new Map();
const CAPS_CACHE_MAX = 32;

async function capabilitiesFor(baseUrl, model) {
  const key = String(model || '');
  if (!key) return [];
  if (_capsCache.has(key)) return _capsCache.get(key);
  const caps = await showModelCapabilities(baseUrl, key);
  if (caps.length) {
    if (_capsCache.size >= CAPS_CACHE_MAX) _capsCache.delete(_capsCache.keys().next().value);
    _capsCache.set(key, caps);
  }
  return caps;
}

// Does this model accept images? Ask Ollama first; fall back to the name-pattern
// list only when it does not answer. The order matters: a model published after
// VISION_MODELS was last edited is invisible to the pattern list, and silently
// dropping the screenshot is the "looks alive, does nothing" failure — the user
// asks about what is on screen and gets an answer about nothing.
async function supportsVisionLive(baseUrl, model) {
  const caps = await capabilitiesFor(baseUrl, model);
  if (caps.length) return caps.includes('vision');
  return modelSupportsVision(model);
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

module.exports = {
  _ollamaHttpError, _callOllama, _callOllamaNative, _ollamaReachable, listOllamaModels,
  showModelCapabilities, _capsCache, CAPS_CACHE_MAX, capabilitiesFor, supportsVisionLive, pullModel,
};

'use strict';

// Bit on a server the user runs on this PC: LM Studio, llama.cpp, vLLM, Jan and
// anything else that speaks the OpenAI chat-completions API. Ollama keeps its own
// provider (ai-local.js), which also downloads and starts models; here Xenon only
// talks to what is already running, so there is nothing to install or scan.
//
// Three things keep this safe, and each is load-bearing:
//   - the address is this machine only (sanitizeUrl), and it comes from the
//     settings, never from a request
//   - redirects are not followed (plain http.request), so a key and a prompt
//     cannot be walked off the machine by whatever answers on that port
//   - the key, when the server wants one, is a server-only secret
//     (ai-provider-creds.js)
//
// Failures are reason codes (`localserver_*`): the chat says them in the user's
// language (_aiFormatApiError in js/ai.js).

const http = require('http');
const https = require('https');
const { toolLoop } = require('./ai-openai');
const { DEFAULT_URL, sanitizeUrl, sanitizeModel } = require('./js/local-server-fields.js');

const MAX_MODELS = 100;
const MAX_DETAIL = 200;
const MAX_REPLY_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_ROUNDS = 6;
// A server that reports no models (llama.cpp ignores the name anyway) still needs
// something in the required `model` field.
const UNNAMED_MODEL = 'default';
// Generous on purpose: the first request can load the model from disk, and on a
// CPU the prompt alone takes minutes. It also must not be a fetch, whose own
// five-minute limit on the first byte cannot be raised without a dependency.
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 4000;
// Where these programs listen unless told otherwise. Ollama's port is left out on
// purpose: its /v1 cuts the prompt at 4096 tokens without saying so, and it has
// its own provider.
const USUAL_PORTS = [1234, 8080, 1337, 8000];
const FIND_TIMEOUT_MS = 800;
// A small task names a tight limit for a cloud model that pays by the token. A
// thinking model spends that limit reasoning and answers nothing, and here a
// longer reply costs nothing, so a small task never gets less than this.
const MIN_REPLY_TOKENS = 2048;
// Without tools a model will still happily say it set the timer.
const NO_TOOLS_NOTE = '\n\nNo tools are available for the rest of this reply: never say you did something you have not already done.';

function configFrom(settings) {
  const s = settings || {};
  return {
    baseUrl: sanitizeUrl(s.localApiUrl),
    apiKey: String(s.localApiKey || '').trim(),
    model: sanitizeModel(s.localApiModel),
    vision: s.localApiVision === true,
  };
}

function failure(reason, detail) {
  const err = new Error('localserver_' + reason);
  err.code = reason;
  if (detail) err.detail = String(detail).slice(0, MAX_DETAIL + 20);
  return err;
}

function stopped() {
  const err = new Error('turn_stopped');
  err.code = 'turn_stopped';
  return err;
}

// One request → { status, text }. Refusals to connect and timeouts are the only
// throws here; what an answer means is up to the caller.
function request(config, method, pathname, body, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(stopped()); return; }
    const url = new URL(pathname, config.baseUrl);
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
    let cutFor = 'offline';
    const finish = (fn, value) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onStop); fn(value); };
    const failed = () => finish(reject, signal && signal.aborted ? stopped() : failure(cutFor));
    const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) { cutFor = 'not_compatible'; req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      // Once a reply has begun, a cut connection is reported here and not on req.
      res.on('close', () => { if (!res.complete) failed(); });
    });
    const onStop = () => req.destroy();
    const timer = setTimeout(() => { cutFor = 'timeout'; req.destroy(); }, timeoutMs);
    if (signal) signal.addEventListener('abort', onStop, { once: true });
    req.on('error', failed);
    if (data) req.write(data);
    req.end();
  });
}

function errorDetail(text) {
  let detail = '';
  try {
    const j = JSON.parse(text);
    const e = j && j.error;
    detail = (e && typeof e === 'object' ? e.message : e) || (j && j.message) || '';
  } catch { /* not JSON: a web page, not an API */ }
  return String(detail).slice(0, MAX_DETAIL);
}

const overflows = (detail) => /context|too long|too many tokens/i.test(detail);

function httpFailure(status, text) {
  const detail = errorDetail(text);
  if (status === 401 || status === 403) return failure('bad_key');
  if (overflows(detail)) return failure('context', detail);
  if (/model/i.test(detail) && /not found|not loaded|no models?|does not exist|no such/i.test(detail)) return failure('no_model', detail);
  if (status === 404 || (status >= 300 && status < 400)) return failure('not_compatible');
  return failure('failed', 'HTTP ' + status + (detail ? ': ' + detail : ''));
}

// Why a server would not take the tools, if that is what it said: refused outright,
// or too big to fit, since Xenon's tools alone need more context than some servers
// start with.
function toolsProblem(status, text) {
  if (status < 400) return '';
  const detail = errorDetail(text);
  if (overflows(detail)) return 'context';
  return /\btools?\b|jinja|function.?call/i.test(detail) ? 'refused' : '';
}

async function complete(config, payload, { signal, timeoutMs = CHAT_TIMEOUT_MS } = {}) {
  const { status, text } = await request(config, 'POST', '/v1/chat/completions', payload, { timeoutMs, signal });
  if (status < 200 || status >= 300) {
    const problem = payload.tools ? toolsProblem(status, text) : '';
    if (problem) { const e = failure('tools_refused'); e.problem = problem; throw e; }
    throw httpFailure(status, text);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.choices)) return parsed;
  } catch { /* falls through */ }
  throw failure('not_compatible');
}

const firstMessage = (resp) => resp && resp.choices && resp.choices[0] && resp.choices[0].message;

// Local thinking models write their reasoning into the reply itself. An
// unfinished block is what a model that ran out of room leaves behind.
function replyText(msg) {
  const raw = msg && typeof msg.content === 'string' ? msg.content : '';
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

// → { state, models }. `state` is 'ok', or why there is no list; 'no_list' means
// the server is up but does not offer one, and chat may still work.
async function listModels(config, signal, timeoutMs = LIST_TIMEOUT_MS) {
  let res;
  try {
    res = await request(config, 'GET', '/v1/models', null, { timeoutMs, signal });
  } catch (e) {
    if (e.code === 'turn_stopped') throw e;
    return { state: 'offline', models: [] };
  }
  if (res.status === 401 || res.status === 403) return { state: 'bad_key', models: [] };
  if (res.status < 200 || res.status >= 300) return { state: 'no_list', models: [] };
  let data;
  try { data = JSON.parse(res.text).data; } catch { return { state: 'not_compatible', models: [] }; }
  if (!Array.isArray(data)) return { state: 'not_compatible', models: [] };
  const models = data
    .map((m) => (m && typeof m.id === 'string' ? sanitizeModel(m.id) : 'auto'))
    .filter((id) => id !== 'auto')
    .slice(0, MAX_MODELS);
  return { state: models.length ? 'ok' : 'no_models', models };
}

// The first model that can chat: LM Studio lists its embedding models too.
const pickModel = (models) => models.find((id) => !/embed/i.test(id)) || '';

async function resolveModel(config, signal) {
  if (config.model !== 'auto') return config.model;
  const { models } = await listModels(config, signal);
  return pickModel(models) || UNNAMED_MODEL;
}

// Another usual address that answers with models, or ''. The key stays out of it:
// it was given to one server, not to whatever else is listening here.
async function findServer(skipUrl, ports = USUAL_PORTS) {
  const urls = ports.map((port) => 'http://127.0.0.1:' + port).filter((url) => url !== skipUrl);
  const answers = await Promise.all(urls.map((baseUrl) => listModels({ baseUrl, apiKey: '' }, undefined, FIND_TIMEOUT_MS)));
  return urls[answers.findIndex((a) => a.state === 'ok')] || '';
}

// What /api/ai/models hands the settings panel. `found` is where a server does
// answer, when the saved address does not.
async function catalog(config, ports) {
  const { state, models } = await listModels(config);
  const auto = pickModel(models);
  const found = state === 'offline' ? await findServer(config.baseUrl, ports) : '';
  return { state, found, models: models.map((id) => ({ id, kind: 'chat' })), resolved: auto ? { chat: auto } : {}, families: [] };
}

function withoutTools(payload) {
  const { tools: _tools, tool_choice: _choice, messages, ...rest } = payload;
  const told = (m, i) => (i === 0 && m.role === 'system' ? { ...m, content: m.content + NO_TOOLS_NOTE } : m);
  return { ...rest, messages: messages.map(told) };
}

// A chat turn, with tools when the server takes them. Many do not, or only when
// started with a flag or a larger context: the answer then comes without tools,
// for the whole turn, rather than not at all.
async function chat({ config, geminiTools, history, systemText, executeTool, signal }) {
  const model = await resolveModel(config, signal);
  const options = { signal };
  let toolsOff = '';
  const send = async (payload) => {
    if (toolsOff) return complete(config, withoutTools(payload), options);
    try {
      return await complete(config, payload, options);
    } catch (e) {
      if (e.code !== 'tools_refused') throw e;
      toolsOff = e.problem;
      return complete(config, withoutTools(payload), options);
    }
  };
  const result = await toolLoop({
    send, model, geminiTools, history, systemText, executeTool,
    supportsVision: config.vision, maxIters: MAX_TOOL_ROUNDS, readText: replyText,
    // Some models answer nothing when handed a large tools schema.
    onEmpty: async (messages) => replyText(firstMessage(await complete(config, withoutTools({ model, messages }), options))),
  });
  if (!result.text && !result.clientActions.length) throw failure('empty');
  return { ...result, toolsOff };
}

// One request with no tools → plain text. `onUsage(total, { input, output })`
// hears what it took, when the server counts; `image` is { mimeType, data }.
async function oneShot({ config, systemText, userText, maxTokens, onUsage, image, signal, timeoutMs }) {
  if (image && !config.vision) { const e = new Error('this AI cannot see pictures'); e.code = 'no_vision'; throw e; }
  const messages = [];
  if (systemText) messages.push({ role: 'system', content: systemText });
  const text = String(userText || '');
  messages.push({
    role: 'user',
    content: image
      ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }]
      : text,
  });
  const model = await resolveModel(config, signal);
  const resp = await complete(config, { model, messages, max_tokens: Math.max(Number(maxTokens) || 0, MIN_REPLY_TOKENS) }, { signal, timeoutMs });
  const used = Number(resp.usage && resp.usage.total_tokens);
  if (typeof onUsage === 'function' && Number.isSafeInteger(used)) {
    onUsage(used, { input: Number(resp.usage.prompt_tokens), output: Number(resp.usage.completion_tokens) });
  }
  return replyText(firstMessage(resp));
}

module.exports = { DEFAULT_URL, sanitizeUrl, sanitizeModel, configFrom, catalog, chat, oneShot };

'use strict';
// One chat turn of the assistant on a local Ollama model, with its tool calls, and a second try
// on a smaller model when the first one crashes the graphics card.

const { follow } = require('../ai-tool-groups.js');
const {
  geminiToolsToOpenAI, geminiHistoryToNative, parseOllamaNativeResponse,
} = require('./local-ollama-shapes.js');
const {
  _callOllamaNative, listOllamaModels, supportsVisionLive,
} = require('./local-ollama-calls.js');

// A smaller, tool-calling-capable model to retry with after a GPU crash / OOM —
// but only one that's actually INSTALLED (pulling mid-chat would hang the reply).
// Safest (smallest) first; skips the model that just crashed. null → none to try.
async function _pickCrashFallback(baseUrl, current) {
  const installed = await listOllamaModels(baseUrl);
  if (!installed.length) return null;
  const cur = String(current || '').toLowerCase();
  for (const pref of ['qwen2.5:3b', 'qwen2.5:7b', 'llama3.1:8b']) {
    if (pref === cur) continue;
    const hit = installed.find(m => { const l = m.toLowerCase(); return l === pref || l.startsWith(pref + '-'); });
    if (hit) return hit;
  }
  return null;
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
// Public entry: run the local chat, and if the model crashes the GPU (CUDA) or
// runs out of VRAM BEFORE any tool ran, transparently retry once on a smaller
// installed model and prepend a short note. The "before any tool ran" guard is
// load-bearing: retrying after a dashboard action executed would run it twice.
async function localChat(opts) {
  const progress = { toolsRan: false };
  try {
    return await _localChatOnce(opts, progress);
  } catch (e) {
    const crashed = e && (e.code === 'gpu_crash' || e.code === 'oom');
    if (!crashed || opts._fellBack || progress.toolsRan) throw e;
    const fb = await _pickCrashFallback(opts.baseUrl, opts.model);
    if (!fb) throw e;
    const res = await _localChatOnce({ ...opts, model: fb, _fellBack: true }, { toolsRan: false });
    const why = e.code === 'oom' ? 'per memoria video insufficiente' : 'per un crash sulla GPU (CUDA)';
    const note = `⚠️ Il modello «${opts.model}» ha fallito ${why}; ho risposto con «${fb}».\n\n`;
    const text = note + (res.text || '');
    return { ...res, text, newContent: { role: 'model', parts: [{ text }] } };
  }
}

async function _localChatOnce({ baseUrl, model, geminiTools, history, systemText, executeTool }, progress) {
  // Native tools share the OpenAI shape; read each round, since use_tools can
  // add a group mid-turn (ai-tool-groups.js).
  const toolsNow = follow(geminiTools, geminiToolsToOpenAI);
  const supportsVision = await supportsVisionLive(baseUrl, model);
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
  //
  // This is a STARTING window, not a fixed one: the tools schema alone measures
  // ~8.8k tokens (72 declared functions), so the system prompt, an attached image
  // and a few turns of history can reach the 16k ceiling on their own. When that
  // happens Ollama rejects the request outright ("request exceeds the available
  // context size"), and a turn that merely fits leaves too few tokens to answer
  // in — a thinking model then burns the remainder reasoning and returns empty
  // content. Grow on demand instead of paying the VRAM for a big window on every
  // turn: only the turns that need the room ask for it. If the larger window does
  // not fit the GPU, Ollama reports OOM and localChat's smaller-model fallback
  // takes over, which is the same path a too-big model already used.
  let numCtx = isLargeModel ? 16384 : 8192;
  const CTX_MAX = 32768;
  const callModel = async (payload) => {
    for (;;) {
      try {
        return await _callOllamaNative(baseUrl, { ...payload, options: { num_ctx: numCtx } }, inferenceTimeout);
      } catch (e) {
        if (e.code !== 'context_exceeded' || numCtx >= CTX_MAX) throw e;
        numCtx = Math.min(numCtx * 2, CTX_MAX); // keep the wider window for the rest of the turn
      }
    }
  };

  // Raised from 4 to 6 to match the server (Gemini) side, so a multi-step local
  // request (chain of dashboard actions) isn't cut off early. Local inference is
  // slower, so we stay a little below the cloud cap of 8.
  const MAX_ITERS = 6;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const resp = await callModel({ model, messages, tools: toolsNow(), stream: false });
    const parsed = parseOllamaNativeResponse(resp);

    if (!parsed.functionCall) { finalText = parsed.text; break; }

    // Record the assistant tool call so Ollama keeps context across the loop.
    // Native tool_calls carry the arguments as a plain object (no JSON string).
    messages.push({
      role: 'assistant',
      content: parsed.text || '',
      tool_calls: [{ function: { name: parsed.functionCall.name, arguments: parsed.functionCall.args } }],
    });

    // From here a dashboard action may have run — a crash after this point must
    // NOT trigger the smaller-model retry (it would execute the action twice).
    if (progress) progress.toolsRan = true;
    const { fnResult, clientActions: acts } = await executeTool(parsed.functionCall.name, parsed.functionCall.args);
    for (const a of (acts || [])) clientActions.push(a);

    messages.push({ role: 'tool', content: JSON.stringify(fnResult) });

    if (iter === MAX_ITERS - 1) {
      // Final guard: ask once more for a closing text answer.
      const last = await callModel({ model, messages, stream: false });
      finalText = parseOllamaNativeResponse(last).text;
    }
  }

  // Safety net: some models can return empty content when passed a large tools
  // schema. Re-try once without tools to guarantee a plain-text reply.
  //
  // `think: false` is the other half. Thinking models (gemma4, qwen3.5…) split
  // the reply into `thinking` and `content`, and both are drawn from the SAME
  // generation budget: a turn that reasons until the context window runs out
  // stops with done_reason 'length' while `content` is still empty. The parser
  // reads `content`, so the whole turn arrives as an empty answer after minutes
  // of real GPU work — the reported "dots, then nothing". A big pasted image
  // makes it likely, since the picture, the system prompt and the tools schema
  // leave little of num_ctx to answer in. Retrying with thinking off spends what
  // is left on the answer itself.
  if (!finalText) {
    const fallback = await callModel({ model, messages, stream: false, think: false });
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

module.exports = { _pickCrashFallback, localChat, _localChatOnce, resolveModel };

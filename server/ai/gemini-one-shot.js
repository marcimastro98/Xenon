// One question to Gemini and its answer: the request itself, and the step that tries another
// model when the pinned one is closed to the user's key.

const https = require('node:https');
const aiGemini = require('../ai-gemini.js');
const { withThinking, applyThinking } = require('../ai-gemini-thinking.js');
const aiModels = require('../ai-models.js');

// A pinned model can be closed to the user's key. The chat has its own, longer
// fallback; everything else that asks Gemini once comes through here.
function _withGeminiModel(model, apiKey, send) {
  const alternatives = () => [aiModels.resolve('gemini', 'chat', 'auto', apiKey), aiModels.resolve('gemini', 'chat', 'auto:flash-lite', apiKey)];
  return aiGemini.withFallbackModel(model, alternatives, (id) => withThinking(id, (thinking) => send(id, thinking)));
}

function _geminiOneShotOnce(apiKey, parts, systemText, maxTokens, opts, model, thinking) {
  return new Promise((resolve, reject) => {
    const generationConfig = applyThinking({
      temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.7,
      maxOutputTokens: maxTokens, candidateCount: 1,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    }, thinking);
    const payload = JSON.stringify({
      ...(systemText ? { system_instruction: { parts: [{ text: String(systemText) }] } } : {}),
      contents: [{ role: 'user', parts }],
      generationConfig,
    });
    const gReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (gRes) => {
      let d = '';
      gRes.on('data', c => { d += c; });
      gRes.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini error'));
          const meta = parsed?.usageMetadata;
          const used = Number(meta?.totalTokenCount);
          if (typeof opts.onUsage === 'function' && Number.isSafeInteger(used)) {
            // Thinking is billed at the output price.
            opts.onUsage(used, {
              input: Number(meta.promptTokenCount),
              output: (Number(meta.candidatesTokenCount) || 0) + (Number(meta.thoughtsTokenCount) || 0),
            });
          }
          const text = (parsed?.candidates?.[0]?.content?.parts || [])
            .filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
          if (!text) return reject(new Error('empty response'));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    gReq.on('error', reject);
    gReq.setTimeout(30000, () => { gReq.destroy(); reject(new Error('gemini timeout')); });
    gReq.write(payload);
    gReq.end();
  });
}

module.exports = { _withGeminiModel, _geminiOneShotOnce };

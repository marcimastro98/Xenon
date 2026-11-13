// Two requests to Gemini that come back as data: a web search with its sources, and an answer
// that has to be JSON.

const https = require('node:https');
const { applyThinking } = require('../ai-gemini-thinking.js');

function _geminiWebSearchOnce(q, apiKey, model, thinking) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: q }] }],
      tools: [{ google_search: {} }],
      generationConfig: applyThinking({ temperature: 0.2, maxOutputTokens: 700, candidateCount: 1 }, thinking),
    });
    const t0 = Date.now();
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (r) => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => {
        process.stdout.write(`[WebSearch] Gemini HTTP ${r.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'search error'));
          const cand = parsed?.candidates?.[0];
          const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
          // Collect grounding source URLs/titles when present
          const chunks = cand?.groundingMetadata?.groundingChunks || [];
          const sources = chunks
            .map(c => c.web && { title: c.web.title || '', uri: c.web.uri || '' })
            .filter(Boolean).slice(0, 5);
          if (!text) return resolve({ error: 'no result' });
          resolve({ answer: text, sources });
        } catch { reject(new Error('invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('search timeout')); });
    req.write(payload);
    req.end();
  });
}

function _geminiGenerateJSONOnce(prompt, apiKey, timeoutMs, model, thinking) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: applyThinking({ temperature: 0.2, maxOutputTokens: 500, candidateCount: 1, responseMimeType: 'application/json' }, thinking),
    });
    const r = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (resp) => {
      let d = '';
      resp.on('data', c => { d += c; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini error'));
          resolve((parsed?.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || null);
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => { r.destroy(); reject(new Error('gemini timeout')); });
    r.write(payload);
    r.end();
  });
}

module.exports = { _geminiWebSearchOnce, _geminiGenerateJSONOnce };

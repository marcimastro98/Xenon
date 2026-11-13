// The request that turns a recorded voice clip into text with Gemini, and how long it may take.

const https = require('node:https');
const { applyThinking } = require('../ai-gemini-thinking.js');
const { geminiTranscript } = require('../stt-voice-gate.js');

// Thinking models took over 15 s on a short clip (Flash, 3.1 Pro), the same as the chat allows.
const STT_GEMINI_TIMEOUT_MS = 30000;

function _transcribeAudioOnce(sttPrompt, safeMime, audioB64, apiKey, model, thinking) {
  const payload = JSON.stringify({
    contents: [{ parts: [
      { text: sttPrompt },
      { inline_data: { mime_type: safeMime, data: audioB64 } },
    ] }],
    generationConfig: applyThinking({ temperature: 0, maxOutputTokens: 256, candidateCount: 1 }, thinking),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (geminiRes) => {
      let d = '';
      geminiRes.on('data', c => { d += c; });
      geminiRes.on('end', () => {
        process.stdout.write(`[STT] Gemini status=${geminiRes.statusCode}\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          resolve(geminiTranscript(parsed));
        } catch (e) { reject(e instanceof SyntaxError ? new Error('Gemini invalid JSON') : e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(STT_GEMINI_TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}


module.exports = { STT_GEMINI_TIMEOUT_MS, _transcribeAudioOnce };

// Reading a text aloud on the PC with Gemini's voice: the sound is made and played by the
// engine, so it is heard whatever window is in front.

const fs = require('node:fs');
const https = require('node:https');
const { privateTmpFile } = require('../private-tmp.js');
const aiLocal = require('../ai-local.js');
const aiOpenai = require('./ai-openai.js');
const aiCli = require('../ai-cli.js');
const aiModels = require('./ai-models.js');
const { splitSentences } = require('./tts-chunks.js');
const { AI_MODELS } = require('./models.js');
const { readHubSettings } = require('../settings/read.js');
const { speakState } = require('./speak-state.js');
const { _restoreSpeakerVolume } = require('../audio/speaker-duck.js');
const { stopServerSpeak, _playWavFile } = require('./speak-play.js');
const { getFfmpegPath } = require('../ffmpeg-install/ffmpeg-path.js');
const { providerModelFor } = require('./provider-models.js');
const { pcmToWav } = require('../wav/pcm-to-wav.js');

// Gemini native TTS (prebuilt neural voice). Returns a Promise<Buffer> with WAV
// audio, or rejects on error (quota, offline, no audio). Voice names are
// language-agnostic — the model speaks whatever language the text is in.
function _geminiTtsToWav(text, apiKey, voice = 'Charon') {
  return new Promise((resolve, reject) => {
    const safeVoice = String(voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: String(text || '').slice(0, 1000) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice } } },
      },
    });
    const t0 = Date.now();
    const ttsReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${AI_MODELS.tts}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (ttsRes) => {
      let d = '';
      ttsRes.on('data', c => { d += c; });
      ttsRes.on('end', () => {
        process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini tts error'));
          const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (!part || !part.data) return reject(new Error('no audio data'));
          const pcmBytes = Buffer.from(part.data, 'base64');
          const rateMatch = String(part.mimeType || '').match(/rate=(\d+)/);
          const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
          resolve(pcmToWav(pcmBytes, sampleRate));
        } catch (e) { reject(e); }
      });
    });
    ttsReq.on('error', reject);
    ttsReq.setTimeout(20000, () => { ttsReq.destroy(); reject(new Error('gemini tts timeout')); });
    ttsReq.write(payload);
    ttsReq.end();
  });
}

// Speak text server-side using Gemini neural TTS (voice: Charon).
// Playback is server-side so it works regardless of window focus or WebView quirks.
// Resolves when speech finishes (or is stopped). Silently resolves on TTS error.
function speakOnServer(text, langPrefix, apiKey, provider) {
  return new Promise(async (resolve) => {
    stopServerSpeak();
    const myToken = speakState.genToken;
    const clean = String(text || '').slice(0, 2000);
    if (!clean) return resolve();

    // Voice output per provider: Ollama, a local server and Claude (no speech API) use the free
    // local Edge neural TTS; ChatGPT uses OpenAI TTS (its server-only key comes
    // from settings); Gemini uses Gemini TTS with the request's key.
    // Claude Code / Codex bring no speech of their own either, so they share it.
    const useLocal = provider === 'ollama' || provider === 'localapi' || provider === 'anthropic' || provider === 'xenon' || aiCli.isCliProvider(provider);
    const useOpenai = provider === 'openai';
    let openaiKey = '';
    if (useOpenai) { const s = await readHubSettings().catch(() => null); openaiKey = String((s && s.openaiApiKey) || '').trim(); }
    const key = String(apiKey || '').trim();
    if (useOpenai && !openaiKey) return resolve();
    if (!useLocal && !useOpenai && !key) return resolve();
    // The Gemini branch degrades to the local Edge voice rather than failing: it
    // runs on a preview model, and both callers below treat a synth error as
    // "say nothing", so a retired model would take the assistant's voice away
    // with the only trace in the log. See the same fallback on /api/tts.
    const synth = async (t) => {
      if (useLocal) return aiLocal.localTts(t, langPrefix, getFfmpegPath());
      if (useOpenai) return aiOpenai.tts({ apiKey: openaiKey, text: t, model: providerModelFor('openai', 'tts') });
      try {
        return await _geminiTtsToWav(t, key, 'Charon');
      } catch (e) {
        process.stdout.write(`[TTS] Gemini failed (${e.message}): falling back to the local voice\n`);
        if (/not found|not supported|NOT_FOUND|404/i.test(String(e.message || ''))) {
          aiModels.markMissing('gemini', AI_MODELS.tts);
        }
        return aiLocal.localTts(t, langPrefix, getFfmpegPath());
      }
    };

    const chunks = splitSentences(clean);

    // Single sentence → the original one-shot path (no pipelining overhead).
    if (chunks.length <= 1) {
      const gWavPath = privateTmpFile('xenon-gtts-', '.wav');
      try {
        const wavBuf = await synth(clean);
        if (speakState.genToken !== myToken) return resolve();
        if (!wavBuf || wavBuf.length === 0) return resolve();
        await fs.promises.writeFile(gWavPath, wavBuf);
        if (speakState.genToken !== myToken) { fs.promises.unlink(gWavPath).catch(() => {}); return resolve(); }
        await _playWavFile(gWavPath, myToken);
      } catch (e) {
        process.stdout.write(`[TTS] ${useLocal ? 'Edge' : 'Gemini'} failed (${e.message})\n`);
        fs.promises.unlink(gWavPath).catch(() => {});
      }
      return resolve();
    }

    // Multi-sentence → synth the NEXT sentence while the current one plays, so
    // the user hears the first sentence after one synth, not after the whole
    // reply. speak_start + ducking fire on the first played chunk; the media
    // volume is restored once, after the last (or on a barge-in cancel).
    const writeChunk = async (t, idx) => {
      const buf = await synth(t);
      if (speakState.genToken !== myToken || !buf || !buf.length) return null;
      const p = privateTmpFile(`xenon-gtts-${idx}-`, '.wav');
      await fs.promises.writeFile(p, buf);
      return p;
    };
    let started = false;
    let nextPath = null;
    try {
      nextPath = await writeChunk(chunks[0], 0).catch(() => null);
      for (let i = 0; i < chunks.length; i++) {
        if (speakState.genToken !== myToken) break;
        const curPath = nextPath;
        nextPath = null; // consumed below (played wavs are unlinked by _playWavFile)
        // Kick off the next sentence's synth BEFORE playing the current one.
        const prefetch = (i + 1 < chunks.length)
          ? writeChunk(chunks[i + 1], i + 1).catch(() => null)
          : Promise.resolve(null);
        if (curPath) {
          await _playWavFile(curPath, myToken, { duck: !started, broadcast: !started, restore: false });
          started = true;
        }
        nextPath = await prefetch;
      }
    } catch (e) {
      process.stdout.write(`[TTS] ${useLocal ? 'Edge' : 'Gemini'} chunked failed (${e.message})\n`);
    } finally {
      // A prefetched-but-never-played chunk (loop broke on barge-in) would leak.
      if (nextPath) fs.promises.unlink(nextPath).catch(() => {});
      if (started) _restoreSpeakerVolume(); // restore once, after the last chunk
    }
    resolve();
  });
}

module.exports = { _geminiTtsToWav, speakOnServer };

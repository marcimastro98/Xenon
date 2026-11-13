import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appStringsSource } from './i18n-source.mjs';
const require = createRequire(import.meta.url);
const { hasVoice, wavPcm, transcriptionPrompt, cleanTranscript, geminiTranscript, VOICE_BLOCKED } = require('../stt-voice-gate.js');

const RATE = 16000;
const pcmOf = (samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2));
  return b;
};

// Seeded, so a run can never fail on an unlucky draw.
function random(seed = 7) {
  let x = seed;
  return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 * 2 - 1; };
}
const silence = (sec) => new Array(Math.round(sec * RATE)).fill(0);
const noise = (sec, rms, rnd = random()) => Array.from({ length: Math.round(sec * RATE) }, () => rnd() * rms * 1.73);
const hum = (sec, amp) => Array.from({ length: Math.round(sec * RATE) }, (_, i) => amp * Math.sin(2 * Math.PI * 50 * i / RATE));

// A syllable: harmonics of a pitch under a rise-and-fall envelope.
function syllable(ms, amp) {
  const n = Math.round(ms / 1000 * RATE);
  return Array.from({ length: n }, (_, i) => {
    const t = i / RATE;
    const env = Math.sin(Math.PI * i / n);
    return amp * env * (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * Math.sin(2 * Math.PI * 420 * t));
  });
}
const over = (background, voice, atSec) => {
  const out = [...background];
  const at = Math.round(atSec * RATE);
  voice.forEach((v, i) => { out[at + i] += v; });
  return out;
};

test('clips with no voice in them are dropped', () => {
  assert.equal(hasVoice(pcmOf(silence(0.5))), false, 'digital silence, a muted mic');
  assert.equal(hasVoice(pcmOf(silence(3))), false);
  assert.equal(hasVoice(pcmOf(noise(3, 40))), false, 'quiet hiss');
  assert.equal(hasVoice(pcmOf(noise(3, 200))), false, 'room noise');
  assert.equal(hasVoice(pcmOf(noise(3, 1500))), false, 'a mic turned all the way up');
  assert.equal(hasVoice(pcmOf(hum(3, 300))), false, 'mains hum');
});

test('key clicks are too short to be a word', () => {
  let clip = noise(3, 20);
  const rnd = random(11);
  for (let t = 0.3; t < 2.9; t += 0.45) {
    clip = over(clip, Array.from({ length: 300 }, (_, i) => rnd() * 5000 * Math.exp(-i / 60)), t);
  }
  assert.equal(hasVoice(pcmOf(clip)), false);
});

test('an empty or tiny clip holds no voice and does not throw', () => {
  assert.equal(hasVoice(Buffer.alloc(0)), false);
  assert.equal(hasVoice(Buffer.alloc(10)), false);
});

test('a short word is heard, in silence and over room noise', () => {
  assert.equal(hasVoice(pcmOf(over(silence(2), syllable(220, 3000), 0.8))), true);
  assert.equal(hasVoice(pcmOf(over(noise(2, 200), syllable(220, 3000), 0.8))), true);
});

test('a quiet, far voice is heard', () => {
  assert.equal(hasVoice(pcmOf(over(noise(2, 30), syllable(300, 200), 0.8))), true);
});

test('a voice close to the noise is still let through', () => {
  assert.equal(hasVoice(pcmOf(over(noise(2, 800), syllable(300, 1500), 0.8))), true);
});

test('a clip that is talking from start to end is heard', () => {
  let clip = [];
  for (let i = 0; i < 8; i++) clip = clip.concat(syllable(180, 2500), silence(0.03));
  assert.equal(hasVoice(pcmOf(clip)), true);
});

test('the samples are found after any chunk ffmpeg puts before them', () => {
  const samples = Buffer.from([1, 0, 2, 0]);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
  const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.alloc(20), list, Buffer.from('data'), Buffer.from([4, 0, 0, 0]), samples]);
  assert.deepEqual([...wavPcm(wav)], [...samples]);
  assert.equal(wavPcm(Buffer.from('not a wav file at all')).length, 0);
});

test('the prompt names no sample command the model could hand back', () => {
  const prompt = transcriptionPrompt('Italian');
  assert.doesNotMatch(prompt, /apri|Steam|Spotify|Discord|open /i);
  assert.match(prompt, /NO_SPEECH/);
  assert.match(prompt, /usually talks in Italian/);
  assert.doesNotMatch(transcriptionPrompt(undefined), /usually talks/);
});

test('the no-speech word never reaches the assistant as a request', () => {
  for (const said of ['NO_SPEECH', 'no_speech', ' NO_SPEECH. ', 'NO SPEECH', '"NO_SPEECH"']) assert.equal(cleanTranscript(said), '', said);
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript(null), '');
  assert.equal(cleanTranscript(' apri Spotify '), 'apri Spotify');
});

test('a clip Gemini refused is an error, not silence', () => {
  assert.throws(() => geminiTranscript({ promptFeedback: { blockReason: 'OTHER' } }), new RegExp(VOICE_BLOCKED));
  assert.equal(geminiTranscript({ candidates: [] }), '', 'no block reason: nothing was heard');
  assert.equal(geminiTranscript({}), '');
});

test('the answer leaves out thoughts and honours the no-speech word', () => {
  const answer = (...parts) => ({ candidates: [{ content: { parts } }] });
  assert.equal(geminiTranscript(answer({ text: 'pensiero', thought: true }, { text: ' apri Steam ' })), 'apri Steam');
  assert.equal(geminiTranscript(answer({ text: 'NO_SPEECH' })), '');
});

test('a refused clip reaches the chat in the language of the user', () => {
  const ai = readFileSync(new URL('../js/ai.js', import.meta.url), 'utf8');
  const i18n = appStringsSource();
  assert.ok(ai.includes(`msg === '${VOICE_BLOCKED}'`));
  assert.equal((i18n.match(/ai_voice_blocked/g) || []).length, 11, 'every app language');
});

test('the browser mic names the language, without which Gemini refuses far more clips', () => {
  const ai = readFileSync(new URL('../js/ai.js', import.meta.url), 'utf8');
  const call = ai.slice(ai.indexOf("fetch('/api/transcribe'"), ai.indexOf('const { text, error } = await transcribeRes.json()'));
  assert.ok(call.includes('lang:'));
});

test('every way voice reaches an AI goes through the gate', () => {
  const S = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const stop = S.slice(S.indexOf("reqPath === '/api/stt/stop'"), S.indexOf("reqPath === '/api/ai/cli/mcp'"));
  assert.match(stop, /if \(!_sttLooksLikeSpeech\(clipStats\) \|\| !hasVoice\(wavPcm\(wavData\)\)\) \{/,
    'the gate comes before the audio mode and every provider, and digital silence does not skip it');
  assert.ok(stop.indexOf('hasVoice(') < stop.indexOf('if (audioMode) {'));
  const transcribe = S.slice(S.indexOf("reqPath === '/api/transcribe'"), S.indexOf("reqPath === '/api/tts'"));
  assert.ok(transcribe.indexOf('hasVoice(') > 0 && transcribe.indexOf('hasVoice(') < transcribe.indexOf("tProvider === 'ollama'"), 'before any provider');
  assert.match(transcribe, /_transcribeAudio\(audioB64, rawMime, apiKey, safeLang\)/, 'one Gemini transcription, with its thinking setting');
  assert.equal((S.match(/Transcribe this audio/g) || []).length, 0, 'no second prompt to drift');
});

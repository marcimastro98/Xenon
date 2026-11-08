'use strict';

// ── Voice input: is anyone speaking? ──────────────────────────────────────
// Speech models do not answer "nothing" to a clip with no voice in it: asked to
// transcribe silence, Gemini wrote commands nobody gave ("chiudi tutto", "apri
// Steam", "disattiva le luci"), and the text goes straight to the assistant, which
// runs them. Measured 4 Nov 2026 on Flash-Lite, Flash and Pro. Telling it to return
// an empty string did not help, in 12 clips out of 12. Two defences, in this order:
// a clip with no voice never leaves the PC, and what gets through is answered with
// a word the model can say, because a model that must say something says something.

const FRAME_MS = 20;
// Below this a frame holds nothing, whatever the rest of the clip does (-58 dBFS).
const MIN_LEVEL = 40;
// A voice stands out from the clip's own background; hum and hiss do not. Set low
// on purpose: dropping a real word is worse than asking the model about a noise.
const OVER_BACKGROUND = 1.6;
const BACKGROUND_PERCENTILE = 0.2;
// Long enough for "sì" or "stop", longer than a key click.
const MIN_VOICE_MS = 120;
const BRIDGED_GAP_FRAMES = 1;

const NO_SPEECH = 'NO_SPEECH';
// The chat turns this code into a sentence in the user's language.
const VOICE_BLOCKED = 'voice_blocked';

function frameLevels(pcm, sampleRate) {
  const frameBytes = Math.floor(sampleRate * FRAME_MS / 1000) * 2;
  const levels = [];
  for (let start = 0; start + frameBytes <= pcm.length; start += frameBytes) {
    let sum = 0;
    for (let i = start; i < start + frameBytes; i += 2) sum += pcm.readInt16LE(i) ** 2;
    levels.push(Math.sqrt(sum / (frameBytes / 2)));
  }
  return levels;
}

function longestLoudRun(levels, threshold) {
  let longest = 0;
  let run = 0;
  let gap = 0;
  for (const level of levels) {
    if (level > threshold) { run += 1; gap = 0; longest = Math.max(longest, run); continue; }
    gap += 1;
    if (gap > BRIDGED_GAP_FRAMES) run = 0;
  }
  return longest;
}

// `pcm` is 16-bit mono. Music, a TV or a slammed door also pass: this only drops
// clips that cannot hold a voice, and the model judges the rest.
function hasVoice(pcm, sampleRate = 16000) {
  const levels = frameLevels(pcm, sampleRate);
  if (!levels.length) return false;
  const sorted = [...levels].sort((a, b) => a - b);
  const background = sorted[Math.floor(sorted.length * BACKGROUND_PERCENTILE)];
  const threshold = Math.max(MIN_LEVEL, background * OVER_BACKGROUND);
  return longestLoudRun(levels, threshold) * FRAME_MS >= MIN_VOICE_MS;
}

// The samples of a WAV. ffmpeg can put a LIST chunk before them, so 44 is not a given.
function wavPcm(wav) {
  const at = wav.indexOf('data', 12, 'latin1');
  return at < 0 ? Buffer.alloc(0) : wav.subarray(at + 8);
}

// No sample commands in here: 3.1 Flash-Lite answered silence with the prompt's own
// "apri Spotify", every time.
function transcriptionPrompt(languageName) {
  return 'Transcribe the human speech in this audio word for word, in the language it was spoken. '
    + (languageName ? `The speaker usually talks in ${languageName}. ` : '')
    + 'Write app and brand names as separate words, the way they are spelled. '
    + 'The recording may start with a short chime: ignore it. '
    + `Most recordings are empty: if you cannot clearly hear a human voice saying words (silence, noise, breathing, chimes, music), output exactly ${NO_SPEECH} and nothing else. `
    + 'Never guess or invent words.';
}

function cleanTranscript(text) {
  const out = String(text || '').trim();
  return /\bNO[_ ]SPEECH\b/i.test(out) ? '' : out;
}

// Gemini can refuse a clip outright: no candidates, only promptFeedback.blockReason
// "OTHER". Read as empty text, a spoken command looked like silence. Measured on
// Flash (3.8), "apri Discord e chiudi Chrome": 7 clips in 8 without a language in the
// prompt, none with Italian, 1 in 8 with the wrong language.
function geminiTranscript(response) {
  const candidates = response?.candidates || [];
  if (!candidates.length && response?.promptFeedback?.blockReason) throw new Error(VOICE_BLOCKED);
  const parts = candidates[0]?.content?.parts || [];
  return cleanTranscript(parts.filter(p => p.text && !p.thought).map(p => p.text).join(''));
}

module.exports = { hasVoice, wavPcm, transcriptionPrompt, cleanTranscript, geminiTranscript, VOICE_BLOCKED };

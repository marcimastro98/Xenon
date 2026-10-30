// The turn-based voice session (js/ai.js + the server's recorder and whisper).
//
// The rules these tests hold:
//  - "listening" shows only once the mic is really recording, never before:
//    the old fixed waits told people to talk while their first words were lost;
//  - a spoken turn in a voice session stays off the text chat (bubbles and the
//    chat's status line), and its errors show on the voice screen instead;
//  - a reply with no voice behind it is still shown;
//  - whisper runs with the fast flags and its non-speech output never becomes a
//    request; the end-of-speech wait stays short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ai = require('../ai-local.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const AI = read('../js/ai.js');
const S = read('../server.js');
const fn = (src, name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  const next = src.indexOf('\nfunction ', at + 10);
  const nextAsync = src.indexOf('\nasync function ', at + 10);
  const ends = [next, nextAsync].filter((n) => n > 0);
  return src.slice(at, ends.length ? Math.min(...ends) : undefined);
};

test('the voice screen says "listening" only after the recorder answers', () => {
  const rec = fn(AI, '_aiStartServerRecorder');
  const idAt = rec.indexOf('_aiServerRecordingId = id;');
  const listenAt = rec.indexOf("_aiVoiceState('listening')");
  assert.ok(idAt > 0 && listenAt > idAt, 'listening is set after the id arrives');
  for (const name of ['startVoiceSessionTurnBased', '_aiVoiceOrbTap', '_aiStartFollowupListen', '_aiRetryActiveListen']) {
    const body = fn(AI, name);
    assert.doesNotMatch(body, /_aiVoiceState\('listening'\)/, `${name} does not claim to listen before the mic is open`);
    assert.match(body, /_aiVoiceState\('connecting'\)[\s\S]*await _aiStartServerRecorder\(\)/, `${name} shows connecting, then opens the mic`);
  }
  for (const name of ['startVoiceSessionTurnBased', '_aiVoiceOrbTap', '_aiStartFollowupListen']) {
    assert.doesNotMatch(fn(AI, name), /setTimeout\(r, \d+\)/, `${name} has no blind wait before the mic`);
  }
});

test('a voice-session turn never writes into the text chat', () => {
  const send = fn(AI, 'aiSendMessage');
  assert.match(send, /const voiceTurn = !!fromVoice && _aiVoiceSessionActive;/);
  assert.match(send, /if \(!voiceTurn\) \{\s+if \(text\) _aiAppendBubble\('user'/);
  assert.match(send, /if \(!voiceTurn\) \{\s+const ranActions = [^\n]+\n\s+_aiAppendBubble\('assistant', replyText, null, /);
  // Every other bubble in the turn is either guarded or on the non-voice path.
  const bubbles = send.match(/_aiAppendBubble\(/g) || [];
  assert.equal(bubbles.length, 8, 'a new bubble in a turn needs a voice decision');
  assert.match(send, /if \(!voiceTurn\) _aiAppendBubble\('assistant', t\('ai_partial_done'\)\);/);
  assert.match(send, /if \(voiceTurn\) \{\s+if \(_aiVoiceSessionActive\) _aiVoiceShowError\(msg\);\s+\} else \{\s+_aiAppendBubble\('assistant', msg, null, 'worry'\);/);
  assert.match(send, /if \(voiceTurn && voiceGen !== _aiVoiceGen\) return; \/\/ the session closed/);
  const rec = fn(AI, '_aiStartServerRecorder');
  assert.match(rec, /const inChat = !_aiVoiceSessionActive;/);
  assert.match(rec, /if \(inChat\) setAiStatus\('connecting'\);/);
  assert.doesNotMatch(rec, /_aiAppendBubble/);
  const stop = fn(AI, '_aiStopServerRecorder');
  assert.match(stop, /if \(!wasVoice\) setAiStatus\('thinking'\);/);
  assert.doesNotMatch(stop, /_aiAppendBubble/);
});

test('a reply whose voice never played is still shown on the voice screen', () => {
  const send = fn(AI, 'aiSendMessage');
  assert.match(send, /_aiSpeak\(spokenReply, \(\) => \{\s+\/\/[^\n]*\n[^\n]*\n\s+if \(_aiPendingVoiceReply && _aiVoiceSessionActive\) \{\s+_aiVoiceSetReply\(_aiPendingVoiceReply\);/);
});

test('voice errors stay up long enough to read, then close the session', () => {
  const show = fn(AI, '_aiVoiceShowError');
  assert.match(show, /_aiVoiceSetReply\(msg\)/);
  assert.match(show, /gen === _aiVoiceGen && _aiVoiceSessionActive\) _aiEndVoiceSession\(\)/);
  assert.match(AI, /const AI_VOICE_ERROR_HOLD_MS = \d{4};/);
  assert.match(read('../js/i18n.js'), /ai_mic_unavailable/);
  const langs = read('../js/i18n.js').match(/^ {4}ai_mic_unavailable: /gm) || [];
  assert.equal(langs.length, 11);
});

test('whisper runs fast: more threads, greedy decoding, a clip-sized window', () => {
  const four = ai.whisperSpeedArgs(44 + 32000 * 4, 16);
  assert.deepEqual(four, ['-t', '8', '-bs', '1', '-bo', '1', '-ac', '384', '-sns']);
  const long = ai.whisperSpeedArgs(44 + 32000 * 30, 4);
  assert.equal(long[long.indexOf('-t') + 1], '4');
  assert.equal(long[long.indexOf('-ac') + 1], '1500', 'a 30 s clip gets the full window');
  const mid = ai.whisperSpeedArgs(44 + 32000 * 10, 8);
  assert.equal(mid[mid.indexOf('-ac') + 1], '664');
  assert.match(read('../ai-local.js'), /'-nt', \.\.\.whisperSpeedArgs\(clip\.length\)\]/);
});

// A 16 kHz mono 16-bit WAV with `samples` non-zero samples; `sizes` false
// leaves the header sizes at 0, as ffmpeg does when it writes to a pipe.
function wav(samples, sizes = true) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.write('WAVE', 8, 'ascii'); head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  const data = Buffer.alloc(samples * 2, 7);
  head.writeUInt32LE(sizes ? data.length : 0, 40);
  head.writeUInt32LE(sizes ? 36 + data.length : 0, 4);
  return Buffer.concat([head, data]);
}

test('whisper hears silence before the first word, so a clip on the first syllable keeps it', () => {
  const out = ai.padWavStart(wav(1600), 400);
  const lead = 16000 * 0.4 * 2;
  assert.equal(out.length, 44 + lead + 3200);
  assert.equal(out.readUInt32LE(40), lead + 3200, 'data size');
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size');
  assert.ok(out.subarray(44, 44 + lead).every((b) => b === 0), 'the lead is silence');
  assert.ok(out.subarray(44 + lead).every((b) => b === 7), 'the voice follows untouched');
  // ffmpeg's pipe header (sizes 0) still pads, from the bytes that are there.
  assert.equal(ai.padWavStart(wav(1600, false), 400).readUInt32LE(40), lead + 3200);
  // Not a 16-bit PCM WAV: passed on as it came.
  const odd = Buffer.from('not a wav at all, just some bytes here to be long enough...');
  assert.equal(ai.padWavStart(odd), odd);
  assert.match(read('../ai-local.js'), /const clip = padWavStart\(wavBuffer\);\n {4}fs\.promises\.writeFile\(wavPath, clip\)/);
});

test('whisper output that is not speech never becomes a request', () => {
  for (const noise of ['[BLANK_AUDIO]', ' (musica) ', '*applausi*', 'Sottotitoli creati dalla comunità Amara.org', 'Grazie per la visione!', 'Thanks for watching.', '...']) {
    assert.equal(ai.cleanTranscript(noise), '', noise);
  }
  assert.equal(ai.cleanTranscript('Che ore sono?'), 'Che ore sono?');
  assert.equal(ai.cleanTranscript('Spegni la luce (ride)'), 'Spegni la luce');
  assert.equal(ai.cleanTranscript('  metti  la\nmusica '), 'metti la musica');
  assert.match(read('../ai-local.js'), /resolve\(cleanTranscript\(text\)\);/);
});

test('the answer starts about a second and a half after the last word', () => {
  const m = S.match(/const STT_AFTER_SPEECH_SILENCE_GRACE_MS = (\d+);/);
  assert.ok(m && Number(m[1]) <= 1200, 'end-of-speech grace stays short');
  assert.match(S, /silencedetect=noise=\$\{silenceDb\.toFixed\(1\)\}dB:d=0\.55/);
});

test('on credits, every speech route uses the free local voice and whisper', () => {
  const tts = S.slice(S.indexOf("reqPath === '/api/tts'"));
  assert.match(tts.slice(0, 2500), /ttsProvider === 'xenon'/);
  const stop = S.slice(S.indexOf("reqPath === '/api/stt/stop'"), S.indexOf("reqPath === '/api/ai/cli/mcp'"));
  assert.match(stop, /sttProvider === 'xenon'/);
  assert.match(S, /const useLocal = [^\n]*provider === 'xenon'/);
});

// Tap, cancel while the mic is still opening, tap again: the third tap must
// open the mic. The server takes one recording at a time, so a recorder left
// running after a cancel made every later tap answer 409 for five minutes.
test('a recording cancelled while the mic opens is let go, and the next tap records', async () => {
  const vm = await import('node:vm');
  const names = ['_aiDropRecorder', '_aiStartServerRecorder', '_aiEndVoiceSession', '_aiVoiceTapInterrupt', 'stopAiVoice'];
  const server = { recording: null, calls: [] };
  let release = null;
  const answer = (status, body) => ({ status, ok: status < 400, json: async () => body });
  const ctx = {
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      server.calls.push(url);
      if (url === '/api/stt/start') {
        if (server.recording) return Promise.resolve(answer(409, { error: 'already_recording' }));
        const id = 'rec-' + server.calls.length;
        server.recording = id;
        // The first start answers only when the test says so: the mic is opening.
        if (!release) return new Promise((r) => { release = () => r(answer(200, { id })); });
        return Promise.resolve(answer(200, { id }));
      }
      if (url === '/api/stt/stop' && body.id === server.recording) server.recording = null;
      return Promise.resolve(answer(200, {}));
    },
    document: { body: { classList: { add() {}, remove() {}, contains: (c) => c === 'ai-voice-mode' } } },
    $: () => null, setAiStatus() {}, t: (k) => k, _aiNotice() {}, _aiLog() {},
    _aiVoiceState() {}, _aiVoiceModeExit() {}, _aiPlayCloseChime() {}, closeAiPanel() {},
    _aiCloseMonitorPicker() {}, _aiStopSpeaking() {}, _aiStopServerRecorder() {},
    Date, JSON, Promise, Error, String,
  };
  vm.createContext(ctx);
  vm.runInContext(`
    var aiListening = false, aiRecognition = null, _aiMediaRecorder = null, _aiServerRecordingId = null;
    var _aiRecorderCancel = 0, _aiVoiceSessionActive = false, _aiVoiceGen = 0, _aiFollowupTimer = null;
    var _aiPendingPicker = null, _aiPcConfirmOpen = false, _aiVoiceOpenedAt = 0, AI_VOICE_TAP_GRACE_MS = 0;
    var aiLiveTapInterrupt;
    ${names.map((n) => (n === '_aiStartServerRecorder' ? 'async ' : '') + fn(AI, n)).join('\n')}
    this.state = () => ({ aiListening, id: _aiServerRecordingId });
  `, ctx);

  // Tap 1: a voice session opens the mic, which takes a moment.
  vm.runInContext('_aiVoiceSessionActive = true', ctx);
  const first = ctx._aiStartServerRecorder();
  // Tap 2, before the mic answered: cancel.
  ctx._aiVoiceTapInterrupt();
  release();
  await first;
  assert.equal(server.recording, null, 'the recorder that answered after the cancel was stopped');
  assert.deepEqual({ ...ctx.state() }, { aiListening: false, id: null });

  // Tap 3 records.
  vm.runInContext('_aiVoiceSessionActive = true', ctx);
  await ctx._aiStartServerRecorder();
  assert.ok(server.recording, 'the third tap opened the mic');
  assert.equal(ctx.state().id, server.recording);
});

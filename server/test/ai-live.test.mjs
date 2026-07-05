import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const live = require('../ai-live.js');

test('buildSetupMessage: model prefix, modalities, transcription', () => {
  const m = live.buildSetupMessage({ model: 'gemini-3.1-flash-live-preview', systemInstruction: 'Be Xenon.', tools: [{ name: 'toggle_mic' }] });
  assert.equal(m.setup.model, 'models/gemini-3.1-flash-live-preview');
  assert.deepEqual(m.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.deepEqual(m.setup.inputAudioTranscription, {});
  assert.deepEqual(m.setup.outputAudioTranscription, {});
  assert.equal(m.setup.systemInstruction.parts[0].text, 'Be Xenon.');
  assert.equal(m.setup.tools[0].functionDeclarations[0].name, 'toggle_mic');
});

test('buildSetupMessage: never double-prefixes models/, omits empty sys/tools', () => {
  const m = live.buildSetupMessage({ model: 'models/foo' });
  assert.equal(m.setup.model, 'models/foo');
  assert.equal(m.setup.systemInstruction, undefined);
  assert.equal(m.setup.tools, undefined);
});

test('buildSetupMessage: voiceName adds speechConfig', () => {
  const m = live.buildSetupMessage({ voiceName: 'Charon' });
  assert.equal(m.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
});

test('encodeAudioChunk: base64 PCM with 16k mime', () => {
  const buf = Buffer.from([0, 1, 2, 3]);
  const enc = live.encodeAudioChunk(buf);
  assert.equal(enc.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(enc.realtimeInput.audio.data, buf.toString('base64'));
});

test('encodeToolResponse: keeps id/name/response, drops nameless', () => {
  const enc = live.encodeToolResponse([
    { id: 'a', name: 'set_volume', response: { output: 'ok' } },
    { name: '' },
    { name: 'read_notes' },
  ]);
  const list = enc.toolResponse.functionResponses;
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'a', name: 'set_volume', response: { output: 'ok' } });
  assert.equal(list[1].name, 'read_notes');
  assert.deepEqual(list[1].response, { output: '' }); // defaulted
});

test('chunkPcm: exact frames + trailing partial preserved', () => {
  const buf = Buffer.alloc(3200 * 2 + 10);
  const chunks = live.chunkPcm(buf, 3200);
  assert.equal(chunks.length, 3); // two full + one 10-byte tail
  assert.equal(chunks[0].length, 3200);
  assert.equal(chunks[1].length, 3200);
  assert.equal(chunks[2].length, 10);
  // total bytes conserved
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), buf.length);
});

test('chunkPcm: empty in → empty out; odd chunk size forced even', () => {
  assert.deepEqual(live.chunkPcm(Buffer.alloc(0)), []);
  const chunks = live.chunkPcm(Buffer.alloc(8), 3); // forced to 2
  assert.ok(chunks.every((c) => c.length % 2 === 0 || c === chunks[chunks.length - 1]));
});

test('parseServerMessage: setupComplete', () => {
  const p = live.parseServerMessage({ setupComplete: {} });
  assert.equal(p.setupComplete, true);
});

test('parseServerMessage: audio + transcripts + turnComplete', () => {
  const p = live.parseServerMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] },
      inputTranscription: { text: 'ciao' },
      outputTranscription: { text: 'salve' },
      turnComplete: true,
    },
  });
  assert.deepEqual(p.audioChunks, ['AAA=']);
  assert.equal(p.inputText, 'ciao');
  assert.equal(p.outputText, 'salve');
  assert.equal(p.turnComplete, true);
});

test('parseServerMessage: interrupted (barge-in) flag', () => {
  const p = live.parseServerMessage({ serverContent: { interrupted: true } });
  assert.equal(p.interrupted, true);
});

test('parseServerMessage: toolCall list + cancellation', () => {
  const p = live.parseServerMessage({
    toolCall: { functionCalls: [{ id: '1', name: 'set_volume', args: { level: 20 } }, { name: '' }] },
  });
  assert.equal(p.toolCalls.length, 1);
  assert.deepEqual(p.toolCalls[0], { id: '1', name: 'set_volume', args: { level: 20 } });
  const c = live.parseServerMessage({ toolCallCancellation: { ids: ['1', '2'] } });
  assert.deepEqual(c.cancelledToolIds, ['1', '2']);
});

test('parseServerMessage: non-audio inline part is ignored', () => {
  const p = live.parseServerMessage({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'image/png', data: 'ZZ==' } }] } } });
  assert.deepEqual(p.audioChunks, []);
});

// ── createLiveSession with a fake WebSocket ──────────────────────────────────

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  // test helpers
  _open() { if (this.onopen) this.onopen(); }
  _msg(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}

test('createLiveSession: sends setup on open, routes audio + tool calls', () => {
  const events = { audio: [], input: [], output: [], tools: [], interrupted: 0, closed: 0, setup: 0 };
  const s = live.createLiveSession({
    apiKey: 'k', model: 'gemini-3.1-flash-live-preview',
    systemInstruction: 'sys', tools: [{ name: 'set_volume' }],
    WebSocketImpl: FakeWS,
    onSetupComplete: () => { events.setup++; },
    onAudio: (a) => events.audio.push(a),
    onInputText: (t) => events.input.push(t),
    onOutputText: (t) => events.output.push(t),
    onToolCall: (calls) => events.tools.push(...calls),
    onInterrupted: () => { events.interrupted++; },
    onClose: () => { events.closed++; },
  });
  const ws = FakeWS.last;
  ws._open();
  // first frame must be setup
  const first = JSON.parse(ws.sent[0]);
  assert.equal(first.setup.model, 'models/gemini-3.1-flash-live-preview');

  ws._msg({ setupComplete: {} });
  assert.equal(events.setup, 1);

  ws._msg({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QQ==' } }] }, outputTranscription: { text: 'ok' } } });
  assert.deepEqual(events.audio, ['QQ==']);
  assert.deepEqual(events.output, ['ok']);

  ws._msg({ toolCall: { functionCalls: [{ id: '9', name: 'set_volume', args: { level: 10 } }] } });
  assert.equal(events.tools.length, 1);

  ws._msg({ serverContent: { interrupted: true } });
  assert.equal(events.interrupted, 1);

  // sendAudio frames the realtimeInput; sendToolResponse frames toolResponse
  s.sendAudio(Buffer.from([1, 2]));
  s.sendToolResponse([{ id: '9', name: 'set_volume', response: { output: 'ok' } }]);
  const audioFrame = JSON.parse(ws.sent[ws.sent.length - 2]);
  const toolFrame = JSON.parse(ws.sent[ws.sent.length - 1]);
  assert.ok(audioFrame.realtimeInput.audio.data);
  assert.equal(toolFrame.toolResponse.functionResponses[0].name, 'set_volume');

  s.close();
  assert.equal(s.closed, true);
});

test('createLiveSession: goAway closes the session', () => {
  let closed = 0;
  live.createLiveSession({ apiKey: 'k', WebSocketImpl: FakeWS, onClose: () => { closed++; } });
  const ws = FakeWS.last;
  ws._open();
  ws._msg({ goAway: {} });
  assert.ok(closed >= 1);
});

test('createLiveSession: throws without WebSocketImpl', () => {
  assert.throws(() => live.createLiveSession({ apiKey: 'k' }), /WebSocketImpl/);
});

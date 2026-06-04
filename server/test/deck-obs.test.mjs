import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const obs = require('../actions/obs.js');
const crypto = require('node:crypto');

test('obsRequest maps each obs action to an OBS request', () => {
  assert.deepEqual(obs.obsRequest({ type: 'obsScene', scene: 'Game' }), { requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Game' } });
  assert.deepEqual(obs.obsRequest({ type: 'obsRecord', mode: 'toggle' }), { requestType: 'ToggleRecord', requestData: {} });
  assert.deepEqual(obs.obsRequest({ type: 'obsRecord', mode: 'start' }), { requestType: 'StartRecord', requestData: {} });
  assert.deepEqual(obs.obsRequest({ type: 'obsRecord', mode: 'stop' }), { requestType: 'StopRecord', requestData: {} });
  assert.deepEqual(obs.obsRequest({ type: 'obsStream', mode: 'start' }), { requestType: 'StartStream', requestData: {} });
  assert.deepEqual(obs.obsRequest({ type: 'obsMute', source: 'Mic', mode: 'toggle' }), { requestType: 'ToggleInputMute', requestData: { inputName: 'Mic' } });
  assert.deepEqual(obs.obsRequest({ type: 'obsMute', source: 'Mic', mode: 'mute' }), { requestType: 'SetInputMute', requestData: { inputName: 'Mic', inputMuted: true } });
  assert.deepEqual(obs.obsRequest({ type: 'obsMute', source: 'Mic', mode: 'unmute' }), { requestType: 'SetInputMute', requestData: { inputName: 'Mic', inputMuted: false } });
});

test('obsRequest rejects missing required names / unknown types', () => {
  assert.equal(obs.obsRequest({ type: 'obsScene', scene: '' }), null);
  assert.equal(obs.obsRequest({ type: 'obsMute', source: '', mode: 'toggle' }), null);
  assert.equal(obs.obsRequest({ type: 'nope' }), null);
  assert.equal(obs.obsRequest(null), null);
});

test('computeAuth follows the OBS v5 formula', () => {
  const password = 'pw', salt = 'saltval', challenge = 'chal';
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  const expected = crypto.createHash('sha256').update(secret + challenge).digest('base64');
  assert.equal(obs.computeAuth(password, salt, challenge), expected);
  assert.notEqual(obs.computeAuth('other', salt, challenge), expected);
});

test('nextSceneName advances and wraps (A<->B toggle with two scenes)', () => {
  assert.equal(obs.nextSceneName(['A', 'B', 'C'], 'A'), 'B');
  assert.equal(obs.nextSceneName(['A', 'B', 'C'], 'C'), 'A');       // wrap
  assert.equal(obs.nextSceneName(['A', 'B'], 'A'), 'B');
  assert.equal(obs.nextSceneName(['A', 'B'], 'B'), 'A');            // toggle back
  assert.equal(obs.nextSceneName(['A', 'B'], 'unknown'), 'B');      // current not in list → from 0
  assert.equal(obs.nextSceneName([], 'A'), null);
});

test('obsEventToState maps OBS events to a partial snapshot', () => {
  assert.deepEqual(obs.obsEventToState('RecordStateChanged', { outputActive: true }), { obsRecording: true });
  assert.deepEqual(obs.obsEventToState('StreamStateChanged', { outputActive: false }), { obsStreaming: false });
  assert.deepEqual(obs.obsEventToState('CurrentProgramSceneChanged', { sceneName: 'Game' }), { obsScene: 'Game' });
  assert.deepEqual(obs.obsEventToState('InputMuteStateChanged', { inputName: 'Mic', inputMuted: true }), { obsMutes: { Mic: true } });
  assert.equal(obs.obsEventToState('SomethingElse', {}), null);
  assert.equal(obs.obsEventToState(null, null), null);
});

// ── createObs lifecycle, driven by a mock global WebSocket (no real network) ──
function installFakeWS(impl) {
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = impl;
  return () => { globalThis.WebSocket = prev; };
}

test('createObs: resolves a request through the handshake and shares one socket for concurrent requests', async () => {
  let made = 0;
  class FakeWS {
    constructor() { made++; this.l = {}; setTimeout(() => this._emit('message', { data: JSON.stringify({ op: 0, d: {} }) }), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.op === 1) setTimeout(() => this._emit('message', { data: JSON.stringify({ op: 2, d: {} }) }), 0);
      else if (m.op === 6) setTimeout(() => this._emit('message', { data: JSON.stringify({ op: 7, d: { requestId: m.d.requestId, requestStatus: { result: true }, responseData: { ok: 1 } } }) }), 0);
    }
    close() { setTimeout(() => this._emit('close', {}), 0); }
  }
  const restore = installFakeWS(FakeWS);
  try {
    const o = obs.createObs(async () => ({ host: '127.0.0.1', port: 4455, password: '' }));
    const a = o.request('GetVersion', {});
    const b = o.request('GetSceneList', {});       // concurrent → one handshake
    assert.deepEqual(await a, { ok: 1 });
    assert.deepEqual(await b, { ok: 1 });
    assert.equal(made, 1);
    o.close();
  } finally { restore(); }
});

test('scenePreviewRequest builds the GetSourceScreenshot request for a scene', () => {
  assert.deepEqual(obs.scenePreviewRequest('Game'), {
    requestType: 'GetSourceScreenshot',
    requestData: { sourceName: 'Game', imageFormat: 'jpg', imageWidth: 240, imageHeight: 135, imageCompressionQuality: 50 },
  });
  // coerces a missing name to an empty string (caller guards against empty anyway)
  assert.equal(obs.scenePreviewRequest().requestData.sourceName, '');
});

test('createObs: a failed connection rejects with the real cause and resets so a retry reconnects', async () => {
  let made = 0;
  class FailWS {
    constructor() { made++; this.l = {}; setTimeout(() => this._emit('error', {}), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send() {}
    close() {}
  }
  const restore = installFakeWS(FailWS);
  try {
    const o = obs.createObs(async () => ({ host: 'x', port: 1, password: '' }));
    await assert.rejects(o.request('GetVersion', {}), /obs_connect_failed/);
    await assert.rejects(o.request('GetVersion', {}), /obs_connect_failed/);
    assert.equal(made, 2);                          // ready was reset → a new socket on retry
  } finally { restore(); }
});

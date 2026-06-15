import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sb = require('../actions/streamerbot.js');
const crypto = require('node:crypto');

test('streamerbotRequest maps sbDoAction to a DoAction request by id', () => {
  assert.deepEqual(sb.streamerbotRequest({ type: 'sbDoAction', action: 'guid-123' }), { request: 'DoAction', action: { id: 'guid-123' } });
});

test('streamerbotRequest rejects empty id / unknown types', () => {
  assert.equal(sb.streamerbotRequest({ type: 'sbDoAction', action: '' }), null);
  assert.equal(sb.streamerbotRequest({ type: 'sbDoAction', action: '   ' }), null);
  assert.equal(sb.streamerbotRequest({ type: 'nope' }), null);
  assert.equal(sb.streamerbotRequest(null), null);
});

test('computeAuth follows the sha256 challenge formula', () => {
  const password = 'pw', salt = 'saltval', challenge = 'chal';
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  const expected = crypto.createHash('sha256').update(secret + challenge).digest('base64');
  assert.equal(sb.computeAuth(password, salt, challenge), expected);
  assert.notEqual(sb.computeAuth('other', salt, challenge), expected);
});

// ── createStreamerbot lifecycle, driven by a mock WebSocket (no network) ──
// The implementation is injected via the opts.WebSocketImpl hook so tests need
// no global patching (and stay independent of the real `ws` library).

test('createStreamerbot: no-auth Hello → request resolves; one socket shared for concurrent requests', async () => {
  let made = 0;
  class FakeWS {
    constructor() { made++; this.l = {}; setTimeout(() => this._emit('message', { data: JSON.stringify({ request: 'Hello' }) }), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send(raw) {
      const m = JSON.parse(raw);
      // Echo back a successful response carrying the request id.
      setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, status: 'ok', actions: [] }) }), 0);
    }
    close() { setTimeout(() => this._emit('close', {}), 0); }
  }
  const c = sb.createStreamerbot(async () => ({ host: '127.0.0.1', port: 8080, password: '' }), { WebSocketImpl: FakeWS });
  const a = c.request('DoAction', { action: { id: 'x' } });
  const b = c.request('GetActions', {});            // concurrent → one handshake
  assert.equal((await a).status, 'ok');
  assert.equal((await b).status, 'ok');
  assert.equal(made, 1);
  c.close();
});

test('createStreamerbot: authenticated Hello → sends a correct Authenticate before the request resolves', async () => {
  const password = 'secret', salt = 's', challenge = 'c';
  let authSeen = null;
  class AuthWS {
    constructor() { this.l = {}; setTimeout(() => this._emit('message', { data: JSON.stringify({ request: 'Hello', authentication: { salt, challenge } }) }), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.request === 'Authenticate') { authSeen = m.authentication; setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, status: 'ok' }) }), 0); }
      else setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, status: 'ok' }) }), 0);
    }
    close() {}
  }
  const c = sb.createStreamerbot(async () => ({ host: '127.0.0.1', port: 8080, password }), { WebSocketImpl: AuthWS });
  const r = await c.request('DoAction', { action: { id: 'x' } });
  assert.equal(r.status, 'ok');
  assert.equal(authSeen, sb.computeAuth(password, salt, challenge));
  c.close();
});

test('createStreamerbot: completes the handshake even when the server never acks Authenticate', async () => {
  // Some Streamer.bot builds send no acknowledgement to Authenticate (or one we
  // can't match) — the handshake must NOT block on it. We send the challenge
  // response and proceed; the following request's own reply is the proof of life.
  const password = 'secret', salt = 's', challenge = 'c';
  let authHash = null;
  class SilentAuthWS {
    constructor() { this.l = {}; setTimeout(() => this._emit('message', { data: JSON.stringify({ request: 'Hello', authentication: { salt, challenge } }) }), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.request === 'Authenticate') { authHash = m.authentication; return; }   // no ack at all
      setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, status: 'ok', actions: [] }) }), 0);
    }
    close() {}
  }
  const c = sb.createStreamerbot(async () => ({ host: '127.0.0.1', port: 8080, password }), { WebSocketImpl: SilentAuthWS });
  const r = await c.request('GetActions', {});
  assert.equal(r.status, 'ok');
  assert.equal(authHash, sb.computeAuth(password, salt, challenge));
  c.close();
});

test('createStreamerbot: an error status rejects with the reported reason', async () => {
  class ErrWS {
    constructor() { this.l = {}; setTimeout(() => this._emit('message', { data: JSON.stringify({ request: 'Hello' }) }), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send(raw) { const m = JSON.parse(raw); setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, status: 'error', error: 'no_such_action' }) }), 0); }
    close() {}
  }
  const c = sb.createStreamerbot(async () => ({ host: '127.0.0.1', port: 8080, password: '' }), { WebSocketImpl: ErrWS });
  await assert.rejects(c.request('DoAction', { action: { id: 'x' } }), /no_such_action/);
  c.close();
});

test('createStreamerbot: a failed connection rejects and resets so a retry reconnects', async () => {
  let made = 0;
  class FailWS {
    constructor() { made++; this.l = {}; setTimeout(() => this._emit('error', {}), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send() {}
    close() {}
  }
  const c = sb.createStreamerbot(async () => ({ host: 'x', port: 1, password: '' }), { WebSocketImpl: FailWS });
  await assert.rejects(c.request('GetActions', {}), /sb_connect_failed/);
  await assert.rejects(c.request('GetActions', {}), /sb_connect_failed/);
  assert.equal(made, 2);                            // ready was reset → a new socket on retry
});

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

test('streamerbotRequest: DoAction carries parsed args, and omits them when empty/invalid', () => {
  assert.deepEqual(
    sb.streamerbotRequest({ type: 'sbDoAction', action: 'g1', args: '{"a":"1","n":2,"b":true}' }),
    { request: 'DoAction', action: { id: 'g1' }, args: { a: '1', n: 2, b: true } });
  // empty / non-object / malformed args → no args field at all
  assert.deepEqual(sb.streamerbotRequest({ type: 'sbDoAction', action: 'g1', args: '' }), { request: 'DoAction', action: { id: 'g1' } });
  assert.deepEqual(sb.streamerbotRequest({ type: 'sbDoAction', action: 'g1', args: 'not json' }), { request: 'DoAction', action: { id: 'g1' } });
  assert.deepEqual(sb.streamerbotRequest({ type: 'sbDoAction', action: 'g1', args: '[1,2]' }), { request: 'DoAction', action: { id: 'g1' } });
  // nested objects/arrays inside the map are dropped (SB args are flat scalars)
  assert.deepEqual(
    sb.streamerbotRequest({ type: 'sbDoAction', action: 'g1', args: '{"ok":"y","nested":{"x":1}}' }),
    { request: 'DoAction', action: { id: 'g1' }, args: { ok: 'y' } });
});

test('streamerbotRequest: SendMessage validates platform + message and defaults to the bot account', () => {
  assert.deepEqual(
    sb.streamerbotRequest({ type: 'sbSendMessage', platform: 'twitch', message: 'hi' }),
    { request: 'SendMessage', platform: 'twitch', message: 'hi', bot: true, internal: false });
  // sendAs 'broadcaster' flips the bot flag off; platform is lower-cased
  assert.deepEqual(
    sb.streamerbotRequest({ type: 'sbSendMessage', platform: 'YouTube', message: 'yo', sendAs: 'broadcaster' }),
    { request: 'SendMessage', platform: 'youtube', message: 'yo', bot: false, internal: false });
  assert.equal(sb.streamerbotRequest({ type: 'sbSendMessage', platform: 'discord', message: 'x' }), null);   // unsupported platform
  assert.equal(sb.streamerbotRequest({ type: 'sbSendMessage', platform: 'twitch', message: '  ' }), null);   // empty message
});

test('streamerbotRequest: ExecuteCodeTrigger maps the trigger name + optional args', () => {
  assert.deepEqual(
    sb.streamerbotRequest({ type: 'sbCodeTrigger', trigger: 'My Trigger' }),
    { request: 'ExecuteCodeTrigger', triggerName: 'My Trigger' });
  assert.deepEqual(
    sb.streamerbotRequest({ type: 'sbCodeTrigger', trigger: 'T', args: '{"k":"v"}' }),
    { request: 'ExecuteCodeTrigger', triggerName: 'T', args: { k: 'v' } });
  assert.equal(sb.streamerbotRequest({ type: 'sbCodeTrigger', trigger: '' }), null);
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

test('createStreamerbot: auth advertised but NO password → does NOT send Authenticate (non-enforced mode)', async () => {
  // Streamer.bot can advertise a salt/challenge yet still accept unauthenticated
  // requests ("enabled but not enforced"). Sending a wrong (empty-password) Authenticate
  // makes the real server close with 4009. So with no password we must NOT authenticate.
  let authSent = false;
  class AdvertAuthWS {
    constructor() { this.l = {}; setTimeout(() => this._emit('message', { data: JSON.stringify({ request: 'Hello', authentication: { salt: 's', challenge: 'c' } }) }), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.request === 'Authenticate') { authSent = true; return; }
      setTimeout(() => this._emit('message', { data: JSON.stringify({ id: m.id, status: 'ok', actions: [] }) }), 0);
    }
    close() {}
  }
  const c = sb.createStreamerbot(async () => ({ host: '127.0.0.1', port: 8080, password: '' }), { WebSocketImpl: AdvertAuthWS });
  const r = await c.request('GetActions', {});
  assert.equal(r.status, 'ok');
  assert.equal(authSent, false);   // never authenticated with an empty password
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

test('createStreamerbot watch: seeds globals from GetGlobals + reflects GlobalVariable events', async () => {
  let sock;
  class WatchWS {
    constructor() { sock = this; this.l = {}; setTimeout(() => this._emit('message', { data: JSON.stringify({ request: 'Hello' }) }), 0); }
    addEventListener(t, cb) { this.l[t] = cb; }
    _emit(t, ev) { if (this.l[t]) this.l[t](ev); }
    send(raw) {
      const m = JSON.parse(raw);
      let reply = { id: m.id, status: 'ok' };
      if (m.request === 'GetGlobals') {
        // persisted globals carry the toggles; volatile set is empty here. Object-keyed
        // `variables` shape (the common one) — parsing must also tolerate an array.
        reply = m.persisted
          ? { id: m.id, status: 'ok', variables: { toggle: { name: 'toggle', value: true }, mode: { name: 'mode', value: 'live' } } }
          : { id: m.id, status: 'ok', variables: {} };
      }
      setTimeout(() => this._emit('message', { data: JSON.stringify(reply) }), 0);
    }
    close() { setTimeout(() => this._emit('close', {}), 0); }
    event(source, type, data) { this._emit('message', { data: JSON.stringify({ event: { source, type }, data }) }); }
  }
  const c = sb.createStreamerbot(async () => ({ host: '127.0.0.1', port: 8080, password: '' }), { WebSocketImpl: WatchWS });
  let changes = 0;
  const activity = [];
  const stop = c.watch(() => { changes++; }, (a) => { activity.push(a); });
  await new Promise((r) => setTimeout(r, 40));          // let seed + subscribe settle
  assert.deepEqual(c.globalsSnapshot(), { toggle: true, mode: 'live' });
  assert.ok(changes >= 1);
  // A live update flips a value; a delete removes it (event.source must be 'Misc').
  sock.event('Misc', 'GlobalVariableUpdated', { name: 'toggle', value: false });
  assert.equal(c.globalsSnapshot().toggle, false);
  sock.event('Misc', 'GlobalVariableDeleted', { name: 'mode' });
  assert.equal('mode' in c.globalsSnapshot(), false);
  // A curated stream event (non-global) is routed to the activity feed, NOT globals.
  const before = JSON.stringify(c.globalsSnapshot());
  sock.event('Twitch', 'Follow', { user: { display_name: 'Bob' } });
  assert.equal(JSON.stringify(c.globalsSnapshot()), before);   // globals untouched
  assert.equal(activity.length, 1);
  assert.equal(activity[0].type, 'Follow');
  assert.equal(activity[0].user, 'Bob');
  stop(); c.close();
});

test('projectActivity extracts user/text/amount defensively across event shapes', () => {
  assert.deepEqual(sb.projectActivity('Twitch', 'Follow', { user: { name: 'bob', display_name: 'Bob' } }),
    { source: 'Twitch', type: 'Follow', user: 'Bob' });
  assert.deepEqual(sb.projectActivity('Twitch', 'Cheer', { userName: 'ann', bits: 100, message: 'gg' }),
    { source: 'Twitch', type: 'Cheer', user: 'ann', text: 'gg', amount: 100 });
  assert.deepEqual(sb.projectActivity('Twitch', 'Raid', { user: 'raider', viewers: 42 }),
    { source: 'Twitch', type: 'Raid', user: 'raider', amount: 42 });
  assert.deepEqual(sb.projectActivity('YouTube', 'SuperChat', { message: { message: 'thanks' } }),
    { source: 'YouTube', type: 'SuperChat', text: 'thanks' });
  assert.deepEqual(sb.projectActivity('X', 'Y', null), { source: 'X', type: 'Y' });
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

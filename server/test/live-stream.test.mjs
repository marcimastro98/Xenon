import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const live = require('../js/live-stream.js');
const { socketResponse, socketRequest } = require('../sse-socket.js');

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://127.0.0.1:3030';

class FakeSocket {
  static made = [];
  constructor(url) { this.url = url; this.closed = false; FakeSocket.made.push(this); }
  close() { this.closed = true; this.onclose?.(); }
}

class FakePlain {
  static made = [];
  constructor(url, init) { this.url = url; this.init = init; this.readyState = 0; this.listeners = {}; FakePlain.made.push(this); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  close() { this.readyState = 2; }
}

function stream(url = '/sse') {
  FakeSocket.made = [];
  FakePlain.made = [];
  const Live = live.create({ WebSocket: FakeSocket, EventSource: FakePlain, origin: ORIGIN });
  return { Live, es: new Live(url), socket: () => FakeSocket.made.at(-1) };
}

test('frames: named events, the default event, several per message, comments ignored', () => {
  assert.deepEqual(live.parseFrames(':ping\n\n'), []);
  assert.deepEqual(live.parseFrames('event: media\ndata: {"a":1}\n\n'), [{ event: 'media', data: '{"a":1}' }]);
  assert.deepEqual(live.parseFrames('data: x\n\nevent: b\ndata: 1\ndata: 2\n\n'), [
    { event: 'message', data: 'x' },
    { event: 'b', data: '1\n2' },
  ]);
});

test('only this origin /sse is the live feed', () => {
  assert.equal(live.isLiveFeed('/sse', ORIGIN), true);
  assert.equal(live.isLiveFeed(`${ORIGIN}/sse`, ORIGIN), true);
  assert.equal(live.isLiveFeed('/sse/other', ORIGIN), false);
  assert.equal(live.isLiveFeed('http://example.com/sse', ORIGIN), false);
});

test('any other stream stays a plain EventSource', () => {
  const { es } = stream('/other?x=1');
  assert.ok(es instanceof FakePlain);
  assert.equal(FakeSocket.made.length, 0);
});

test('the feed opens a socket and hands events to listeners and handlers', () => {
  const { es, socket } = stream();
  assert.equal(socket().url, 'ws://127.0.0.1:3030/sse/socket');
  const seen = [];
  es.onopen = () => seen.push('open');
  es.onmessage = (e) => seen.push(`message:${e.data}`);
  es.addEventListener('media', (e) => seen.push(`media:${e.data}`));
  socket().onopen();
  assert.equal(es.readyState, 1);
  socket().onmessage({ data: 'event: media\ndata: 1\n\ndata: 2\n\n' });
  assert.deepEqual(seen, ['open', 'media:1', 'message:2']);
});

test('a dropped socket reports an error, stays connecting and comes back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { es, socket } = stream();
  let errors = 0;
  es.onerror = () => { errors += 1; };
  socket().onopen();
  socket().onclose();
  assert.equal(errors, 1);
  assert.equal(es.readyState, 0);
  assert.equal(FakeSocket.made.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(FakeSocket.made.length, 2);
  socket().onopen();
  assert.equal(es.readyState, 1);
});

test('close stops it for good', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { es, socket } = stream();
  socket().onopen();
  es.close();
  assert.equal(es.readyState, 2);
  t.mock.timers.tick(60000);
  assert.equal(FakeSocket.made.length, 1);
});

test('a socket refused before it ever opened falls back to a plain stream', () => {
  const { es, socket } = stream();
  const seen = [];
  es.addEventListener('media', (e) => seen.push(e.data));
  socket().onclose();
  const plain = FakePlain.made.at(-1);
  assert.equal(plain.url, '/sse');
  plain.listeners.media({ data: 'late' });
  es.addEventListener('audio', (e) => seen.push(e.data));
  plain.listeners.audio({ data: 'later' });
  assert.deepEqual(seen, ['late', 'later']);
  es.close();
  assert.equal(plain.readyState, 2);
});

test('installed only in the app, keeping the constants callers compare with', () => {
  const browser = { EventSource: FakePlain, WebSocket: FakeSocket, location: { origin: ORIGIN } };
  live.install(browser);
  assert.equal(browser.EventSource, FakePlain);
  const app = { ...browser, __XENON_NATIVE__: true };
  live.install(app);
  assert.notEqual(app.EventSource, FakePlain);
  assert.equal(app.EventSource.CLOSED, 2);
});

test('every page that opens the feed loads the socket first', () => {
  for (const page of ['index', 'layer-lite', 'menu', 'scene', 'sdk-service', 'deck-popup', 'shell-driver', 'screen-alerts']) {
    const html = fs.readFileSync(path.join(SERVER_DIR, `${page}.html`), 'utf8');
    const at = html.indexOf('<script src="js/live-stream.js">');
    assert.ok(at > 0, `${page}.html does not load live-stream.js`);
    assert.ok(at < html.indexOf('<script src="js/utils.js">'), `${page}.html loads it too late`);
  }
});

test('the server side looks like an HTTP stream to sseClients', () => {
  const sent = [];
  const handlers = {};
  const client = {
    readyState: 1,
    bufferedAmount: 7,
    send: (text) => sent.push(text),
    close() { this.closedBy = 'close'; },
    terminate() { this.closedBy = 'terminate'; },
    on: (name, fn) => { handlers[name] = fn; },
  };
  const res = socketResponse(client);
  assert.equal(res.writableLength, 7);
  res.write('a');
  client.readyState = 3;
  res.write('b');
  assert.deepEqual(sent, ['a']);
  res.destroy();
  assert.equal(client.closedBy, 'terminate');
  res.end();
  assert.equal(client.closedBy, 'close');
  let closed = false;
  socketRequest(client).on('close', () => { closed = true; });
  handlers.close();
  assert.equal(closed, true);
});

test('the socket sits behind the same guards as the other sockets', () => {
  const src = engineSource();
  const at = src.indexOf("server.on('upgrade'");
  const route = src.indexOf("pathname === '/sse/socket'", at);
  assert.ok(at > 0 && route > at);
  const guards = src.slice(at, route);
  assert.match(guards, /'\/sse\/socket'\]/);
  assert.match(guards, /isAllowedRequest\(req\)/);
  assert.match(guards, /refusedSocketOrigin\(req, PORT\)/);
});

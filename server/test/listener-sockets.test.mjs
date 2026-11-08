import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';

const { trackSockets } = createRequire(import.meta.url)('../listener-sockets.js');

const UPGRADE = 'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n';

// A server with one client on an upgraded socket, the way the shell and the widgets hold one.
async function withUpgradedClient() {
  const server = http.createServer();
  const sockets = trackSockets(server);
  const upgraded = new Promise((done) => server.on('upgrade', (_req, socket) => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    done();
  }));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const client = net.connect(server.address().port, '127.0.0.1');
  client.on('error', () => {});
  client.write(UPGRADE);
  await upgraded;
  return { server, sockets, client };
}

const closes = (server, ms) => new Promise((done) => {
  const late = setTimeout(() => done(false), ms);
  server.close(() => { clearTimeout(late); done(true); });
});

test('closeAllConnections leaves an upgraded socket open, so the listener never finishes closing', async () => {
  const { server, sockets, client } = await withUpgradedClient();
  const closing = closes(server, 200);
  server.closeAllConnections();
  assert.equal(await closing, false);
  sockets.dropAll();
  client.destroy();
});

test('dropAll ends the upgraded sockets too, and the listener can open again', async () => {
  const { server, sockets } = await withUpgradedClient();
  const closing = closes(server, 2000);
  sockets.dropAll();
  assert.equal(await closing, true);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  await closes(server, 2000);
});

test('a socket that ended is not kept', async () => {
  const { server, sockets, client } = await withUpgradedClient();
  client.destroy();
  await new Promise((done) => setTimeout(done, 50));
  sockets.dropAll();
  assert.equal(await closes(server, 2000), true);
});

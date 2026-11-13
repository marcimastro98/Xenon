// A route that throws past its own try must still answer: before the boundary,
// the async handler's rejection only reached process 'unhandledRejection' and
// the request hung until the browser gave up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { runGuarded, describeRequest } = require('../http/request-boundary.js');

// Serve one handler behind the boundary, send one request, collect the answer
// or the network error. A hung request fails the test after 2 s instead of
// stalling it.
async function exchange(handler, path = '/api/thing') {
  const logs = [];
  const server = http.createServer((req, res) => runGuarded(handler, req, res, line => logs.push(line)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        res.on('error', (error) => resolve({ error: error.code || error.message }));
        res.on('aborted', () => resolve({ error: 'aborted' }));
      });
      req.on('error', (error) => resolve({ error: error.code || error.message }));
      req.setTimeout(2000, () => { resolve({ error: 'hung' }); req.destroy(); });
    });
    return { ...outcome, logs };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('a synchronous throw before any header gets a 500 that keeps the prelude headers', async () => {
  const out = await exchange((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');      // set by the security prelude
    res.setHeader('Content-Disposition', 'attachment; filename="x.zip"');
    throw new TypeError('boom');
  });
  assert.equal(out.status, 500);
  assert.deepEqual(JSON.parse(out.body), { error: 'internal_error' });
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(out.headers['cache-control'], 'no-store');
  assert.equal(out.headers['x-content-type-options'], 'nosniff');
  assert.equal(out.headers['content-disposition'], undefined, 'a failure is not a download');
  assert.equal(out.logs.length, 1);
});

test('a rejection after an await is caught too', async () => {
  const out = await exchange(async () => {
    await new Promise(resolve => setImmediate(resolve));
    JSON.parse('{"note": "private text"');
  });
  assert.equal(out.status, 500, `got ${JSON.stringify(out)}`);
  assert.deepEqual(JSON.parse(out.body), { error: 'internal_error' });
});

test('a throw after the headers went out cuts the answer instead of passing it off as whole', async () => {
  const out = await exchange(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"items": [');
    await new Promise(resolve => setImmediate(resolve));
    throw new Error('half way');
  });
  assert.ok(out.error && out.error !== 'hung', `expected a cut connection, got ${JSON.stringify(out)}`);
});

test('a throw after the answer was sent leaves that answer alone', async () => {
  const out = await exchange((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('fine');
    throw new Error('after the fact');
  });
  assert.equal(out.status, 200);
  assert.equal(out.body, 'fine');
  assert.equal(out.logs.length, 1, 'still logged, so the bug is visible');
});

test('a handler that does not throw is untouched', async () => {
  const out = await exchange(async (req, res) => {
    await new Promise(resolve => setImmediate(resolve));
    res.writeHead(201, { 'Content-Type': 'text/plain' });
    res.end('made');
  });
  assert.equal(out.status, 201);
  assert.equal(out.body, 'made');
  assert.deepEqual(out.logs, []);
});

test('the log names the route and the code line, never the query, a key in the path or the message', async () => {
  const out = await exchange(async () => {
    throw new Error('private text');
  }, '/sdk/wk/assetkey123/pkg/widget.css?q=secret-search');
  assert.equal(out.status, 500);
  const line = out.logs[0];
  assert.match(line, /^\[http\] GET \/sdk\/wk\/… failed: Error /);
  assert.match(line, /request-boundary\.test\.mjs:\d+:\d+/, 'where it was thrown');
  for (const secret of ['secret-search', 'assetkey123', 'private text', 'widget.css']) {
    assert.ok(!line.includes(secret), `${secret} leaked into: ${line}`);
  }
  assert.ok(!/[A-Za-z]:\\|\/test\//.test(line), `folders leaked into: ${line}`);
});

test('stack frames lose their folders even when a folder name has a space', async () => {
  const err = new TypeError('x');
  err.stack = [
    'TypeError: x',
    '    at foo (C:\\Users\\Sample Person\\AppData\\Local\\Xenon\\server\\server.js:10:5)',
    '    at file:///home/sample person/xenon/server/routes.js:3:9',
    '    at eval (eval at bar (C:\\Sample Person\\x\\deck.js:1:2), <anonymous>:1:1)',
  ].join('\n');
  const out = await exchange(async () => { throw err; });
  const line = out.logs[0];
  assert.match(line, /at foo \(server\.js:10:5\) \| at routes\.js:3:9 \| at eval \(eval at bar \(deck\.js:1:2\), <anonymous>:1:1\)$/);
  assert.ok(!/Sample|sample|Person|person|Users|home/.test(line), `folders leaked into: ${line}`);
});

test('describeRequest survives a strange method or no url', () => {
  assert.equal(describeRequest({ method: 'get<script>', url: undefined }), '? /');
  assert.equal(describeRequest({ method: 'POST', url: '/api/ai' }), 'POST /api/ai');
  assert.equal(describeRequest(null), '? /');
});

test('both listeners run the dashboard through the boundary', () => {
  // server.js cannot be loaded in a test (it binds the port), so its wiring is read.
  const src = engineSource();
  assert.match(src, /http\.createServer\(\(req, res\) => runGuarded\(handleRequest, req, res\)\)/,
    'the loopback/LAN listener must wrap handleRequest');
  assert.match(src, /handler: \(req, res\) => runGuarded\(handleRequest, req, res\)/,
    'the HTTPS (Tailscale) listener must wrap handleRequest the same way');
  assert.ok(!/createServer\(handleRequest\)|=> handleRequest\(req, res\)/.test(src),
    'a listener calls handleRequest without the boundary');
});

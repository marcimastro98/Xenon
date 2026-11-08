import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const https = require('https');
const { createPace } = require('../search-pace.js');
const ai = require('../ai-local.js');

test('the first request goes at once', () => {
  assert.equal(createPace(12000)(1000), 0);
});

test('a request inside the gap waits for what is left of it', () => {
  const pace = createPace(12000);
  pace(1000);
  assert.equal(pace(3000), 10000);
});

test('a request after the gap does not wait', () => {
  const pace = createPace(12000);
  pace(1000);
  assert.equal(pace(13000), 0);
});

test('searches one after the other each wait one gap at most', () => {
  const pace = createPace(12000);
  pace(0);
  assert.equal(pace(2000), 10000);
  assert.equal(pace(14000), 10000);
});

test('with one request already waiting the next is turned away, and books nothing', () => {
  const pace = createPace(12000);
  pace(0);
  pace(1000);
  assert.equal(pace(1100), null);
  assert.equal(pace(24000), 0);
});

// DuckDuckGo stand-in: the instant answer is empty, the results page has one hit.
function fakeDuckDuckGo() {
  const pages = [];
  const html = '<a class="result__a" href="https://example.com/a">Title</a><a class="result__snippet" href="#">Snippet</a>';
  const get = mock.method(https, 'get', (url, _opts, onRes) => {
    const isPage = String(url).includes('html.duckduckgo.com');
    if (isPage) pages.push(String(url));
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setEncoding = () => {};
    res.resume = () => {};
    onRes(res);
    queueMicrotask(() => { res.emit('data', isPage ? html : '{}'); res.emit('end'); });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    return req;
  });
  return { pages, restore: () => get.mock.restore() };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a second web search in a row reaches the results page only after the gap', async () => {
  const ddg = fakeDuckDuckGo();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000_000 });
  try {
    const first = await ai.localWebSearch('one');
    assert.equal(first.answer, 'Snippet');
    assert.equal(ddg.pages.length, 1);

    const second = ai.localWebSearch('two');
    await settle();
    mock.timers.tick(11000);
    await settle();
    assert.equal(ddg.pages.length, 1, 'still inside the gap');

    mock.timers.tick(1000);
    assert.equal((await second).answer, 'Snippet');
    assert.equal(ddg.pages.length, 2);
  } finally {
    mock.timers.reset();
    ddg.restore();
  }
});

test('a third search while one is waiting comes back with a clear error, not a hang', async () => {
  const ddg = fakeDuckDuckGo();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000 });
  try {
    await ai.localWebSearch('one');
    const waiting = ai.localWebSearch('two');
    await settle();
    assert.match((await ai.localWebSearch('three')).error, /busy/);
    mock.timers.tick(12000);
    await waiting;
  } finally {
    mock.timers.reset();
    ddg.restore();
  }
});

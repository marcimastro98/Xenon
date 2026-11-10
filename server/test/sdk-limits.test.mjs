// Host limits a widget can read in init.limits (server/sdk-limits/limits.js): the
// numbers are the ones the host enforces, they travel /sdk/widgets → bridge →
// init, and a fetch refused for size says which size fits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { SDK_LIMITS, limitFor } = require('../sdk-limits/limits.js');
const sdkProxy = require('../sdk-proxy.js');
const sdkStore = require('../sdk-store.js');
const sdkWidgets = require('../sdk-widgets.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SERVER = read('../server.js');
const BRIDGE = read('../js/custom-widget.js');

test('every number is the one the host enforces', () => {
  assert.equal(SDK_LIMITS.fetch.maxResponseBytes, sdkProxy.PROXY_MAX_FETCH_BYTES);
  assert.equal(SDK_LIMITS.fetch.timeoutMs, sdkProxy.PROXY_DEADLINE_MS);
  assert.equal(SDK_LIMITS.store.maxKeys, sdkStore.STORE_MAX_KEYS);
  assert.equal(SDK_LIMITS.store.maxValueBytes, sdkStore.STORE_MAX_VALUE_BYTES);
  assert.equal(SDK_LIMITS.store.maxTotalBytes, sdkStore.STORE_MAX_TOTAL_BYTES);
  assert.equal(SDK_LIMITS.secrets.maxCount, sdkStore.SECRET_MAX_COUNT);
  assert.equal(SDK_LIMITS.secrets.maxValueBytes, sdkStore.SECRET_MAX_VALUE_BYTES);
  // The two enforced outside the module are pinned to it.
  const interval = Number(BRIDGE.match(/const FETCH_MIN_INTERVAL_MS = (\d+);/)[1]);
  assert.equal(SDK_LIMITS.fetch.minIntervalMs, interval);
  assert.match(SERVER, /if \(g\.inflight >= sdkWidgets\.SDK_LIMITS\.fetch\.maxInFlight \|\|/);
  // A body one byte over the limit is refused by the validator that reads it.
  const pkg = { id: 'demo', hosts: ['api.example.com'] };
  const at = (n) => sdkWidgets.validateProxyRequest(pkg, { url: 'https://api.example.com/x', method: 'POST', body: 'a'.repeat(n) }, []);
  assert.equal(at(SDK_LIMITS.fetch.maxRequestBytes).ok, true);
  assert.equal(at(SDK_LIMITS.fetch.maxRequestBytes + 1).error, 'body_too_large');
});

test('the limits cannot be changed by a caller', () => {
  assert.ok(Object.isFrozen(SDK_LIMITS) && Object.isFrozen(SDK_LIMITS.fetch) && Object.isFrozen(SDK_LIMITS.store));
});

test('a fetch refused for size names the size that fits; other errors carry nothing', () => {
  assert.equal(limitFor('response_too_large'), SDK_LIMITS.fetch.maxResponseBytes);
  assert.equal(limitFor('body_too_large'), SDK_LIMITS.fetch.maxRequestBytes);
  for (const e of ['timeout', 'rate_limited', 'host_not_granted', 'toString', '__proto__']) assert.equal(limitFor(e), undefined, e);
  assert.match(SERVER, /if \(!v\.ok\) \{ json\(\{ ok: false, error: v\.error, limit: sdkWidgets\.limitFor\(v\.error\) \}\); return; \}/);
  assert.match(SERVER, /: 'fetch_failed', limit: sdkWidgets\.limitFor\(msg\) \}\);/);
  assert.match(BRIDGE, /error: d\.error, limit: Number\.isFinite\(d\.limit\) \? d\.limit : undefined \}\);/);
});

test('the limits travel with the widget list into every init', () => {
  assert.match(SERVER, /json\(\{ ok: true, api: sdkWidgets\.SDK_API_VERSION, limits: sdkWidgets\.SDK_LIMITS, packages,/);
  assert.equal((BRIDGE.match(/limits: hostLimits\(d\.limits\) \};/g) || []).length, 2);
  const init = BRIDGE.slice(BRIDGE.indexOf("        type: 'init',"));
  assert.match(init.slice(0, 400), /limits: pkgCache \? pkgCache\.limits : null,/);
});

test('the bridge keeps only the known groups and numbers', () => {
  const start = BRIDGE.indexOf('  const LIMIT_KEYS = {');
  const end = BRIDGE.indexOf('\n  }\n', BRIDGE.indexOf('  function hostLimits(raw) {')) + 4;
  const hostLimits = vm.runInNewContext(BRIDGE.slice(start, end) + '; hostLimits;', {});
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(hostLimits(SDK_LIMITS)), plain(SDK_LIMITS));
  assert.equal(hostLimits(null), null);
  assert.equal(hostLimits('4MB'), null);
  const odd = plain(hostLimits({ fetch: { maxResponseBytes: '4', maxInFlight: -1, timeoutMs: 5, extra: 9 }, other: { a: 1 } }));
  assert.deepEqual(odd, { fetch: { timeoutMs: 5 }, store: {}, secrets: {} });
});

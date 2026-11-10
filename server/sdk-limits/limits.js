'use strict';
// Every limit a Widget SDK package can run into, in one place, so a widget can
// read them from `init.limits` instead of spending a request to find out
// (WIDGET_SDK.md, "Host limits"). The numbers are read from the modules that
// enforce them; the two that live elsewhere (the bridge's per-frame fetch
// interval in js/custom-widget.js and the fetch gate in server.js) are pinned
// to these by server/test/sdk-limits.test.mjs.

const sdkProxy = require('../sdk-proxy.js');
const sdkStore = require('../sdk-store.js');

// The largest body a widget may SEND through /sdk/fetch.
const FETCH_BODY_MAX_BYTES = 256 * 1024;
// One proxied fetch a second per frame (the bridge), two in flight per package
// (the server's gate).
const FETCH_MIN_INTERVAL_MS = 1000;
const FETCH_MAX_IN_FLIGHT = 2;

const SDK_LIMITS = Object.freeze({
  fetch: Object.freeze({
    maxResponseBytes: sdkProxy.PROXY_MAX_FETCH_BYTES,
    maxRequestBytes: FETCH_BODY_MAX_BYTES,
    minIntervalMs: FETCH_MIN_INTERVAL_MS,
    maxInFlight: FETCH_MAX_IN_FLIGHT,
    timeoutMs: sdkProxy.PROXY_DEADLINE_MS,
  }),
  store: Object.freeze({
    maxKeys: sdkStore.STORE_MAX_KEYS,
    maxValueBytes: sdkStore.STORE_MAX_VALUE_BYTES,
    maxTotalBytes: sdkStore.STORE_MAX_TOTAL_BYTES,
  }),
  secrets: Object.freeze({
    maxCount: sdkStore.SECRET_MAX_COUNT,
    maxValueBytes: sdkStore.SECRET_MAX_VALUE_BYTES,
  }),
});

// The number behind a fetch "too large" error, sent with it so a widget that
// never read init.limits still learns what fits. Undefined for any other error.
// (Store errors carry none: value_too_large means a different number for a
// stored value and for a secret, and init.limits already names both.)
const ERROR_LIMITS = Object.freeze({
  response_too_large: SDK_LIMITS.fetch.maxResponseBytes,
  body_too_large: SDK_LIMITS.fetch.maxRequestBytes,
});

function limitFor(error) {
  return Object.prototype.hasOwnProperty.call(ERROR_LIMITS, error) ? ERROR_LIMITS[error] : undefined;
}

module.exports = { SDK_LIMITS, FETCH_BODY_MAX_BYTES, FETCH_MIN_INTERVAL_MS, FETCH_MAX_IN_FLIGHT, limitFor };

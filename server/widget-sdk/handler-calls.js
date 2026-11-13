// Deck keys answered by widget code: the press is sent to the dashboards and waits here until a
// widget answers or the time runs out.

const { sseClients, broadcastSSE } = require('../http/sse-clients.js');

// ── SDK handler actions (deck keys answered by widget code) ─────────────────
// A pressed sdkHandler key broadcasts `sdk_handler` and parks its /actions/run
// response here until a dashboard frame acks it (POST /sdk/handler-ack) or the
// timeout fires — so a key with no live frame flashes an honest error instead
// of pretending success. Bounded + cleaned on shutdown.
const SDK_HANDLER_TIMEOUT_MS = 3000;
const SDK_HANDLER_PENDING_MAX = 32;
const _sdkHandlerPending = new Map();   // callId → { resolve, timer }

function sdkHandlerDispatch(pkg, handler, args, gesture) {
  // Nobody listening → fail fast; a broadcast to zero clients can never be
  // acked, so parking the call would only burn the timeout. This also keeps
  // the invariant simple: every _sdkHandlerPending entry has a live listener
  // window at creation time.
  if (sseClients.size === 0) return Promise.resolve({ ok: false, error: 'no_frame' });
  if (_sdkHandlerPending.size >= SDK_HANDLER_PENDING_MAX) {
    return Promise.resolve({ ok: false, error: 'busy' });
  }
  const callId = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _sdkHandlerPending.delete(callId);
      resolve({ ok: false, error: 'no_frame' });
    }, SDK_HANDLER_TIMEOUT_MS);
    timer.unref();
    _sdkHandlerPending.set(callId, { resolve, timer });
    broadcastSSE('sdk_handler', gesture ? { pkg, handler, args, callId, gesture } : { pkg, handler, args, callId });
  });
}

function sdkHandlerAck(callId, ok, error) {
  const entry = _sdkHandlerPending.get(String(callId || ''));
  if (!entry) return false;   // late/duplicate ack — first one already won
  _sdkHandlerPending.delete(String(callId));
  clearTimeout(entry.timer);
  entry.resolve(ok ? { ok: true } : { ok: false, error: String(error || 'handler_failed').slice(0, 80) });
  return true;
}

function sdkHandlerShutdown() {
  for (const [, entry] of _sdkHandlerPending) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: 'shutdown' });
  }
  _sdkHandlerPending.clear();
}

module.exports = {
  SDK_HANDLER_TIMEOUT_MS, SDK_HANDLER_PENDING_MAX, _sdkHandlerPending, sdkHandlerDispatch,
  sdkHandlerAck, sdkHandlerShutdown,
};

'use strict';
// Talks JSON-RPC with Codex's own app server over its pipes: lines put back together, one
// request with its time limit, and an answer that means not supported.

const REQUEST_TIMEOUT_MS = 15000;

const MAX_LINE = 4 * 1024 * 1024;       // one JSON message; a thread/list page is far below this

// ── wire format ─────────────────────────────────────────────────────────────
// One JSON object per line (measured on 0.155 and 0.160; responses carry no
// "jsonrpc" field). Lines that are not JSON are ignored, and one that grows
// past MAX_LINE is dropped whole rather than buffered without limit.
function createLineDecoder(onMessage, maxLine = MAX_LINE) {
  let buf = '';
  let dropping = false;
  return function push(chunk) {
    buf += String(chunk);
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (dropping) { dropping = false; continue; }
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg && typeof msg === 'object') onMessage(msg);
    }
    if (buf.length > maxLine) { buf = ''; dropping = true; }
  };
}

// "This copy does not have that method." Codex answers an unknown method with
// -32600 "unknown variant" (measured), JSON-RPC proper says -32601; both mean
// the same thing here.
function isUnsupported(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === -32601) return true;
  return err.code === -32600 && /unknown variant/i.test(String(err.message || ''));
}

class RpcError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function createRpc({ write, onNotification, timeoutMs = REQUEST_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let nextId = 1;
  const pending = new Map();
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new RpcError('timeout', method + ' timed out'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, params: params || {} }); } catch (e) {
        pending.delete(id); clearTimer(timer);
        reject(new RpcError('write', String((e && e.message) || e)));
      }
    });
  }
  function handle(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === 'string') {
      // A request FROM the server (an approval, an auth refresh). We never do
      // those; saying so at once keeps the child from waiting on us.
      try { write({ id: msg.id, error: { code: -32601, message: 'not supported by this client' } }); } catch { /* closed */ }
      return;
    }
    if (hasId) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimer(p.timer);
      if (msg.error) p.reject(Object.assign(new RpcError(msg.error.code, String(msg.error.message || 'error')), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string' && typeof onNotification === 'function') onNotification(msg.method, msg.params || {});
  }
  function rejectAll(reason) {
    for (const [id, p] of pending) { clearTimer(p.timer); p.reject(new RpcError('closed', reason || 'closed')); pending.delete(id); }
  }
  return { call, handle, rejectAll, get pendingCount() { return pending.size; } };
}

module.exports = {
  REQUEST_TIMEOUT_MS, MAX_LINE, createLineDecoder, isUnsupported, RpcError, createRpc,
};

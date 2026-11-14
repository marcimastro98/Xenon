'use strict';
// The local pipe to the Discord app: where it is, that it belongs to this user, and the framing
// of each message sent and read.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

// IPC frame opcodes (see the RPC transport docs).
const OP_HANDSHAKE = 0, OP_FRAME = 1, OP_CLOSE = 2, OP_PING = 3, OP_PONG = 4;
const PIPE_COUNT = 10;          // discord-ipc-0 .. discord-ipc-9

// Frame a payload: [op int32 LE][len int32 LE][utf8 json].
function encodeFrame(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

// A stateful frame decoder: feed it chunks, it invokes onMessage(op, data) per
// complete frame and buffers partial ones across chunk boundaries.
function createDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0);
      const len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      const body = buf.subarray(8, 8 + len);
      buf = buf.subarray(8 + len);
      let data = null;
      try { data = JSON.parse(body.toString('utf8')); } catch { data = null; }
      onMessage(op, data);
    }
  };
}

// Discord's local RPC endpoint: a named pipe on Windows, a Unix socket
// everywhere else. net.connect({ path }) takes either, so this is the only
// place that differs. macOS/Linux put the socket in the sandbox/runtime temp
// dir, which is what TMPDIR points at.
function pipePath(i) {
  if (process.platform === 'win32') return '\\\\?\\pipe\\discord-ipc-' + i;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
  return path.join(base, 'discord-ipc-' + i);
}

// POSIX only: is this discord-ipc-N something we may talk to? Without
// XDG_RUNTIME_DIR the socket lives in a shared, world-writable temp dir
// (/tmp on most Linux setups), where ANY local user can create discord-ipc-0
// first and receive our RPC handshake, client id and — during login — the
// OAuth authorization code / access token. So it must be the socket itself
// (lstat: a symlink to somewhere else is refused) and it must be owned by the
// user we run as. Deps are injectable for tests.
function trustedIpcSocket(p, deps) {
  const o = deps || {};
  const lstat = o.lstatSync || fs.lstatSync;
  const getuid = o.getuid || (typeof process.getuid === 'function' ? process.getuid : null);
  if (!getuid) return true;   // no uid concept (Windows named pipes take another path)
  try {
    const st = lstat(p);
    return st.isSocket() && st.uid === getuid();
  } catch {
    return false;
  }
}

// Try discord-ipc-0..9 in turn; resolve the first that connects, else reject.
// A pipe that EXISTS but refuses us fails in two ways that need OPPOSITE advice,
// and libuv reports them differently (measured against a live Discord):
//   EPERM        → ERROR_ACCESS_DENIED. Discord is running ELEVATED, so its pipe
//                  carries a high integrity label and our medium-integrity server
//                  is refused. Permanent: retrying never helps, Discord must be
//                  restarted un-elevated.
//   ECONNREFUSED → ERROR_PIPE_BUSY. Discord serves a limited number of concurrent
//                  RPC clients (often just one). Transient: retrying works.
// Treating both as "busy" told users to wait for a condition that would never
// clear. ENOENT everywhere means Discord simply isn't running. Denied wins over
// busy: it is the specific, actionable one.
function connectPipe() {
  return new Promise((resolve, reject) => {
    let i = 0;
    let sawBusy = false;
    let sawDenied = false;
    const tryNext = () => {
      if (i >= PIPE_COUNT) {
        const why = sawDenied ? 'discord_pipe_denied' : (sawBusy ? 'discord_pipe_busy' : 'discord_not_running');
        reject(new Error(why));
        return;
      }
      const target = pipePath(i);
      i += 1;
      // A missing or foreign socket is treated like "nothing listening here".
      if (process.platform !== 'win32' && !trustedIpcSocket(target)) { tryNext(); return; }
      const sock = net.connect({ path: target });
      const onErr = (e) => {
        const code = e && e.code;
        if (code === 'EPERM' || code === 'EACCES') sawDenied = true;
        else if (code === 'ECONNREFUSED' || code === 'EBUSY') sawBusy = true;
        sock.removeAllListeners(); try { sock.destroy(); } catch { /* ignore */ } tryNext();
      };
      sock.once('error', onErr);
      sock.once('connect', () => { sock.removeListener('error', onErr); resolve(sock); });
    };
    tryNext();
  });
}

module.exports = {
  OP_HANDSHAKE, OP_FRAME, OP_CLOSE, OP_PING, OP_PONG, PIPE_COUNT, encodeFrame, createDecoder,
  pipePath, trustedIpcSocket, connectPipe,
};

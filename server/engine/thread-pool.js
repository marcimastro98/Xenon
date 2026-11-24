'use strict';
// libuv's shared pool of threads, sized before its first use: server.js requires this right
// after startup-log.js, before anything reads a file. Every async file call, DNS lookup,
// zlib and crypto job and the native calls to USB devices (koffi's async: the LINK hub, the
// pump screens) share it, four threads by default. On a PC busy on every core the antivirus
// holds the first open of a freshly written file for tens of seconds: four such opens filled
// the pool, every file call queued behind them for up to 54 s, and the dashboard and the
// hub's fans waited with them (measured 23 Nov 2026). A thread costs only its reserved
// stack. A size set in the environment is kept.
const POOL_SIZE = 32;

/** The pool's size: the environment's own when it is a valid one, else POOL_SIZE. */
function poolSize(env = process.env) {
  const own = Number(env.UV_THREADPOOL_SIZE);
  return Number.isInteger(own) && own >= 1 && own <= 1024 ? own : POOL_SIZE;
}

process.env.UV_THREADPOOL_SIZE = String(poolSize());

module.exports = { POOL_SIZE, poolSize };

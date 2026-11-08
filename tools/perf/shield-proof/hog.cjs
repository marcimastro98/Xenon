// Something busy in the background: N threads that never rest. Ends itself after a limit,
// or with whoever started it.
const { Worker, isMainThread } = require('worker_threads');
const THREADS = Number(process.env.HOG_THREADS || 16);
if (!isMainThread) { let x = 1; for (;;) { x = (x * 1103515245 + 12345) | 0; if (x === 42) x = 1; } }
for (let i = 0; i < THREADS; i += 1) new Worker(__filename);
process.stdin.on('close', () => process.exit(0)).resume();
setTimeout(() => process.exit(0), Number(process.env.HOG_LIMIT_MS || 30000));

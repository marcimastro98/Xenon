// A stand-in for a game's frame loop: a main thread and a job pool that must all finish each frame.
// Frame time is from the start of the frame's work to the last job done, so one late thread makes a late frame.
const { Worker, isMainThread, workerData } = require('worker_threads');
const readline = require('readline');
const WORKERS = Number(process.env.GAME_WORKERS || 6);
const BUDGET_MS = 1000 / Number(process.env.GAME_FPS || 120);
const WORK_MS = Number(process.env.GAME_WORK_MS || 4);

function spin(iterations) {
  let x = 0x9e3779b9 | 0;
  for (let i = 0; i < iterations; i += 1) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; }
  return x;
}

if (!isMainThread) {
  const ctrl = new Int32Array(workerData.shared);
  let seen = 0; let sink = 0;
  for (;;) {
    Atomics.wait(ctrl, 0, seen);
    seen = Atomics.load(ctrl, 0);
    if (Atomics.load(ctrl, 2)) break;
    sink ^= spin(workerData.iterations);
    Atomics.add(ctrl, 1, 1);
  }
  process.exit(sink === 12345 ? 1 : 0);
}

const calibrate = () => {
  let iterations = 1e6;
  for (let i = 0; i < 6; i += 1) {
    const t = performance.now(); spin(iterations);
    iterations = Math.round(iterations * (WORK_MS / (performance.now() - t)));
  }
  return iterations;
};

const iterations = calibrate();
const shared = new SharedArrayBuffer(16);
const ctrl = new Int32Array(shared);
for (let i = 0; i < WORKERS; i += 1) new Worker(__filename, { workerData: { shared, iterations } });

let frames = [];
let done = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line === 'mark') frames = [];
  if (line === 'report') {
    const s = [...frames].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))] || 0;
    process.stdout.write(JSON.stringify({ n: s.length, p50: at(0.5), p99: at(0.99), p999: at(0.999), max: s[s.length - 1] || 0, late: s.filter((v) => v > BUDGET_MS).length / Math.max(1, s.length) }) + '\n');
  }
  if (line === 'quit') done = true;
});

// The loop yields to the event loop between frames so stdin is heard; a real engine has its own pump.
function frame() {
  if (done) { Atomics.store(ctrl, 2, 1); Atomics.add(ctrl, 0, 1); Atomics.notify(ctrl, 0); setTimeout(() => process.exit(0), 50); return; }
  const start = performance.now();
  Atomics.store(ctrl, 1, 0);
  Atomics.add(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
  spin(iterations);
  while (Atomics.load(ctrl, 1) < WORKERS) { /* the main thread waits for its jobs */ }
  const end = performance.now();
  frames.push(end - start);
  while (performance.now() - start < BUDGET_MS) { /* hold the frame rate */ }
  setImmediate(frame);
}
setTimeout(() => process.exit(0), Number(process.env.GAME_LIMIT_MS || 300000)).unref();
process.stdout.write(JSON.stringify({ ready: true, iterations }) + '\n');
frame();

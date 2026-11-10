#!/usr/bin/env node
// The real server on Linux, in a throwaway container: how fast it answers, what it starts, what it
// takes with a page listening, whether a game holds the index, whether it stops clean. A container
// has a real kernel and no desktop: no X, no sensors, so the tools of a desktop read as missing.
// Needs Docker running.
//   node tools/perf/linux-live.mjs [seconds per round]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInContainer } from '../linux-suite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTLE_SECONDS = 30;
const PATHS = ['server', 'packages', 'apps', 'tools/link-shared.mjs', 'package.json', 'package-lock.json'];

const inBase64 = (text) => Buffer.from(text).toString('base64');
const toolText = (name) => readFileSync(path.join(HERE, name), 'utf8');

// Runs in the container beside the server: the process id, when it started, how long to watch.
const PROBE = `
import { readFileSync } from 'node:fs';
const [pid, startedAt, seconds] = process.argv.slice(2).map(Number);
const base = 'http://127.0.0.1:3030';
const headers = { Origin: base };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cpuMs = () => {
  const fields = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ');
  return (Number(fields[11]) + Number(fields[12])) * 10;
};
let answeredAt = 0;
for (let tries = 0; tries < 400 && !answeredAt; tries += 1) {
  try { await fetch(base + '/status', { headers }); answeredAt = Date.now(); } catch { await wait(25); }
}
console.log('answers after', answeredAt - startedAt, 'ms');
for (const label of ['first /system', 'second /system']) {
  const asked = Date.now();
  const reply = await fetch(base + '/system', { headers });
  await reply.text();
  console.log(label, Date.now() - asked, 'ms', reply.status);
}
const listener = new AbortController();
fetch(base + '/sse', { headers, signal: listener.signal })
  .then(async (reply) => { for await (const _ of reply.body) { /* a page listening */ } })
  .catch(() => {});
await wait(${SETTLE_SECONDS} * 1000);
const cpuBefore = cpuMs();
const measuredFrom = Date.now();
await wait((seconds - ${SETTLE_SECONDS}) * 1000);
const share = ((cpuMs() - cpuBefore) / (Date.now() - measuredFrom)) * 100;
console.log('node cpu with a listener:', share.toFixed(2) + '% of a core');
const index = await (await fetch(base + '/index/status', { headers })).json();
console.log('index', JSON.stringify({ ready: index.ready, building: index.building, held: index.held, files: index.files }));
console.log('rss', Math.round(Number(/VmRSS:\\s+(\\d+)/.exec(readFileSync('/proc/' + pid + '/status', 'utf8'))[1]) / 1024), 'MB');
listener.abort();
`;

// The game a Linux container cannot run.
const FAKE_GAME = `
if (process.env.XENON_FAKE_GAME) {
  module.exports.isGaming = () => true;
  module.exports.isGameRunning = () => true;
  module.exports.getGameProcess = () => 'fakegame.exe';
}
`;

const round = (label, env, seconds) => `
echo "=== ${label}"
rm -f /tmp/spawn.log; touch /tmp/spawn.log; rm -rf server/data
START=$(node -p 'Date.now()')
${env} SPAWN_LOG=/tmp/spawn.log node -r /tmp/spy.cjs server/server.js > /tmp/server.log 2>&1 &
PID=$!
node /tmp/probe.mjs $PID $START ${seconds}
node /tmp/report.cjs /tmp/spawn.log | cut -c1-120 | head -30
ASKED=$(node -p 'Date.now()')
kill -TERM $PID
for i in $(seq 1 100); do kill -0 $PID 2>/dev/null || break; sleep 0.1; done
echo "stopped after $(( $(node -p 'Date.now()') - ASKED )) ms, still alive: $(kill -0 $PID 2>/dev/null && echo yes || echo no)"
echo "left over: $(ps -eo comm --no-headers | grep -v -x -e ps -e bash -e su -e sh -e grep -e tr | tr '\\n' ' ')"
echo "errors in the log: $(grep -c -i -E 'uncaught|unhandled|TypeError|ReferenceError' /tmp/server.log)"
`;

export function containerScript(seconds) {
  const rounds = `set +e\ncd /tmp/w\n${round('normal', '', seconds)}\n${round('in a game', 'XENON_FAKE_GAME=1', seconds)}`;
  return [
    'set -e',
    'apt-get update -qq && apt-get install -y -qq --no-install-recommends procps > /dev/null',
    'mkdir -p /tmp/w && cd /tmp/w && tar xf -',
    `echo ${inBase64(toolText('spy-spawn.cjs'))} | base64 -d > /tmp/spy.cjs`,
    `echo ${inBase64(toolText('spawn-report.cjs'))} | base64 -d > /tmp/report.cjs`,
    `echo ${inBase64(PROBE)} | base64 -d > /tmp/probe.mjs`,
    `echo ${inBase64(FAKE_GAME)} | base64 -d >> server/gamedetect.js`,
    `echo ${inBase64(rounds)} | base64 -d > /tmp/run.sh`,
    'chown -R node:node /tmp/w',
    'su node -c "cd /tmp/w && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --omit=dev && node tools/link-shared.mjs && bash /tmp/run.sh"',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInContainer(containerScript(Number(process.argv[2] || 100)), PATHS);
}

// Airflow on Linux, end to end, without a Linux PC: the real engine in a throwaway
// container, its real hwmon driver and watchdog, on a pretend board (fake-hwmon.mjs)
// mounted where the kernel keeps it, /sys/class/hwmon. It runs the fan check, lets
// Xenon drive, heats the CPU past the safety level (full speed), kills the engine and
// stops it, and says after each step whether the fans went back to the board's own curve.
//
//   node tools/airflow-live/linux-rig.mjs     needs Docker; about 15 minutes; exit 0 = every step passed
//
// Not tested here: a real chip's quirks (a pwm_enable that refuses 1, a BIOS that
// takes the fan back), the udev rule, a desktop session. Those need a tester's PC.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInContainer } from '../linux-suite.mjs';
import { line, summarize } from './summary.mjs';
import { AUTO, MANUAL } from './fake-hwmon.mjs';

export const HWMON = '/sys/class/hwmon';
// The board is the container user's own (uid 1000, the image's `node`): the udev rule's job on a real PC.
export const DOCKER_ARGS = Object.freeze(['--tmpfs', `${HWMON}:uid=1000,gid=1000,mode=0755`]);
const DEV = '/tmp/fakedev';
const CTL = '/tmp/fanctl';
const PORT = 3030;
const CHECK_MAX_MS = 9 * 60000;

/** What the container runs: the tree unpacked, installed, then this file's scenario as `node`. */
export function containerScript() {
  return [
    'set -e',
    'mkdir -p /tmp/w && cd /tmp/w && tar xf -',
    'chown -R node:node /tmp/w',
    'su node -c "cd /tmp/w && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && node tools/link-shared.mjs && node tools/airflow-live/linux-rig.mjs --inside"',
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readInt = (file) => { try { return Number(readFileSync(file, 'utf8').trim()); } catch { return null; } };
const enables = () => [1, 2, 3].map((i) => readInt(`${HWMON}/hwmon0/pwm${i}_enable`));
const board = () => { try { return JSON.parse(readFileSync(path.join(CTL, 'board.json'), 'utf8')); } catch { return null; } };

async function call(route, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}
const view = () => call('/airflow').catch((e) => ({ ok: false, error: e.message }));
const act = (body) => call('/actions/run', body);

/** The first truthy answer of `fn` within `ms`, or null. */
async function until(fn, ms, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

function createReport() {
  const steps = [];
  return {
    check(name, ok, detail = '') {
      steps.push({ name, ok: !!ok });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    },
    note: (text) => console.log(`     ${text}`),
    failed: () => steps.filter((s) => !s.ok).length,
    count: () => steps.length,
  };
}

function startEngine() {
  const log = openSync('/tmp/engine.log', 'a');
  const child = spawn(process.execPath, ['server/server.js'], { cwd: process.cwd(), stdio: ['ignore', log, log] });
  return child;
}
const engineUp = () => until(async () => (await call('/version').catch(() => null))?.version, 90000);
const allBack = () => enables().every((e) => e === AUTO);

async function checkStep(r) {
  const started = await act({ type: 'airflowCheck', do: 'start' });
  r.check('the fan check starts', started.ok, JSON.stringify(started));
  const t0 = Date.now();
  let last = '';
  const done = await until(async () => {
    const v = await view();
    const s = summarize(v);
    const l = line(s);
    if (s.check?.step !== last) { r.note(l); last = s.check?.step; }
    return !v.check && v.checkEnded ? v : null;
  }, CHECK_MAX_MS, 2000);
  r.check('the fan check ends on its own', done, done ? `${Math.round((Date.now() - t0) / 1000)} s, ${JSON.stringify(done.checkEnded)}` : 'still running');
  const v = await view();
  for (const f of v.fans || []) r.note(`${f.name}: checked ${f.checked}, problem ${f.problem}`);
  const driven = (v.fans || []).filter((f) => f.checked && !f.problem);
  r.check('the two 4-pin fans are measured', driven.length >= 2);
  r.check('after the check every fan is back on the board\'s curve', await until(allBack, 10000), JSON.stringify(enables()));
}

async function driveStep(r) {
  const on = await act({ type: 'airflowSet', patch: JSON.stringify({ drive: 'on' }) });
  r.check('Airflow turns on', on.ok, JSON.stringify(on));
  const took = await until(() => enables().filter((e) => e === MANUAL).length >= 2, 30000);
  r.check('Xenon takes the fans it measured (pwm_enable 1)', took, JSON.stringify(enables()));
  writeFileSync(path.join(CTL, 'load'), '0.9');
  await sleep(60000);
  const v = await view();
  r.note(line(summarize(v)));
  r.note(`board ${JSON.stringify(board())}`);
  r.check('under load Xenon is still driving, no alarm', v.state && !(v.alerts || []).length && enables().filter((e) => e === MANUAL).length >= 2, `${v.state} ${v.why}`);
  writeFileSync(path.join(CTL, 'load'), '0.25');
}

async function hotStep(r) {
  writeFileSync(path.join(CTL, 'hot'), '');
  // Too hot is every fan at full speed, never a hand-back to a board curve that may run them slower.
  const full = await until(async () => {
    const v = await view();
    const pwm = [1, 2].map((i) => readInt(`${HWMON}/hwmon0/pwm${i}`));
    return v.why === 'hot' && pwm.every((x) => x === 255) ? v : null;
  }, 15000, 500);
  r.check('CPU at 95 °C: every fan Xenon drives at 100 % within 15 s', full, JSON.stringify(enables()));
  r.note(line(summarize(await view())));
  rmSync(path.join(CTL, 'hot'), { force: true });
  const again = await until(() => enables().filter((e) => e === MANUAL).length >= 2, 180000, 2000);
  r.check('cool again: Xenon takes them back after its wait', again, JSON.stringify(enables()));
}

async function inside() {
  const r = createReport();
  const sim = spawn(process.execPath, ['tools/airflow-live/fake-hwmon.mjs', HWMON, DEV, CTL], { stdio: 'inherit' });
  const simUp = await until(() => board(), 10000, 250);
  r.check('the pretend board is up', simUp);
  let engine = startEngine();
  r.check('the engine starts on Linux', await engineUp());
  const first = await until(async () => { const v = await view(); return v.ok && v.fans?.length ? v : null; }, 30000);
  r.check('GET /airflow lists the board\'s fans', first, first ? first.fans.map((f) => `${f.id} ${f.why}`).join(', ') : 'none');
  await checkStep(r);
  await driveStep(r);
  await hotStep(r);

  engine.kill('SIGKILL');
  r.check('engine killed: the watchdog gives every fan back within 10 s', await until(allBack, 10000, 250), JSON.stringify(enables()));

  engine = startEngine();
  r.check('the engine starts again', await engineUp());
  const retaken = await until(async () => (await view()).ok && enables().filter((e) => e === MANUAL).length >= 2, 60000, 2000);
  r.check('after a restart Xenon drives again (it was left on)', retaken, JSON.stringify(enables()));
  engine.kill('SIGTERM');
  r.check('engine stopped: every fan back within 10 s', await until(allBack, 10000, 250), JSON.stringify(enables()));

  writeFileSync(path.join(CTL, 'stop'), '');
  sim.kill();
  if (r.failed() && existsSync('/tmp/engine.log')) console.log(readFileSync('/tmp/engine.log', 'utf8').split('\n').filter((l) => /airflow|error/i.test(l)).slice(-30).join('\n'));
  console.log(`${r.count() - r.failed()}/${r.count()} steps passed`);
  process.exit(r.failed() ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--inside')) inside().catch((e) => { console.error(e); process.exit(1); });
  else runInContainer(containerScript(), [], [...DOCKER_ARGS]);
}

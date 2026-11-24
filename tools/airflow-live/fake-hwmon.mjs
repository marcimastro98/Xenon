// A pretend PC for Airflow's Linux rig (linux-rig.mjs): a board chip with three fan
// headers and a CPU sensor, kept alive under a hwmon root the way the kernel keeps
// /sys/class/hwmon. In the rig's container that root IS /sys/class/hwmon (a tmpfs over
// it), so the engine reads and writes it with its real driver and watchdog.
//
// The board: pwm1 a case fan, pwm2 the CPU fan, pwm3 a 3-pin fan that ignores its pwm.
// pwmN_enable starts at 5, the chip's own curve, which writes pwmN from the CPU's
// heat; 1 is manual and the fan follows pwmN. Fans take time to change speed and read
// a little noisy. The CPU heats with the load and cools with the air the fans move.
//
//   node tools/airflow-live/fake-hwmon.mjs <hwmon root> <device dir> <control dir>
//
// The control dir steers it: `load` (0 to 1), `hot` (present: the CPU runs at 95 °C),
// `stop` (present: it ends). It writes `<control dir>/board.json` every tick.

import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUTO = 5;
export const MANUAL = 1;
export const FANS = Object.freeze([
  { max: 1500, startDuty: 20, threePin: false },
  { max: 2000, startDuty: 15, threePin: false },
  { max: 1300, startDuty: 0, threePin: true },
]);
const UP_RPM_S = 400;
const DOWN_RPM_S = 300;
const HEAT_TAU_S = 15;
const HOT_TAU_S = 3;
const HOT_C = 95;
const TICK_MS = 250;

/** The chip's own curve: 30 % up to 40 °C, 100 % from 80 °C. */
export function chipDuty(celsius) {
  return Math.round(Math.min(100, Math.max(30, 30 + ((celsius - 40) * 70) / 40)));
}

/** The speed a fan heads for at this duty. */
export function targetRpm(fan, duty) {
  if (fan.threePin) return fan.max;
  if (duty < fan.startDuty) return 0;
  return fan.max * (0.15 + (0.85 * duty) / 100);
}

export function initialBoard() {
  return { temp: 38, rpm: FANS.map((f) => targetRpm(f, chipDuty(38))), pwm: FANS.map(() => Math.round((chipDuty(38) * 255) / 100)), enable: FANS.map(() => AUTO) };
}

/**
 * One tick. Pure: what the engine wrote comes in as `wrote`, the noise as `rand`.
 * @param {{ temp: number, rpm: number[], pwm: number[], enable: number[] }} board
 * @param {{ pwm: (number|null)[], enable: (number|null)[], load: number, hot: boolean }} wrote
 */
export function step(board, wrote, dt, rand = Math.random) {
  const enable = FANS.map((_, i) => (Number.isInteger(wrote.enable[i]) ? wrote.enable[i] : board.enable[i]));
  const autoDuty = chipDuty(board.temp);
  const pwm = FANS.map((_, i) => {
    if (enable[i] !== MANUAL) return Math.round((autoDuty * 255) / 100);
    const w = wrote.pwm[i];
    return Number.isInteger(w) && w >= 0 && w <= 255 ? w : board.pwm[i];
  });
  const rpm = FANS.map((f, i) => {
    const goal = targetRpm(f, (pwm[i] * 100) / 255);
    const now = board.rpm[i];
    const limit = (goal > now ? UP_RPM_S : DOWN_RPM_S) * dt;
    return Math.max(0, now + Math.max(-limit, Math.min(limit, goal - now)));
  });
  const air = FANS.reduce((sum, f, i) => sum + rpm[i] / f.max, 0) / FANS.length;
  const goal = wrote.hot ? HOT_C : 28 + (Math.min(1, Math.max(0, wrote.load)) * 65) / (0.5 + air);
  const tau = wrote.hot ? HOT_TAU_S : HEAT_TAU_S;
  const temp = board.temp + (goal - board.temp) * (1 - Math.exp(-dt / tau));
  const noisy = rpm.map((r) => (r > 0 ? Math.round(r * (1 + (rand() - 0.5) * 0.01)) : 0));
  return { board: { temp, rpm, pwm, enable }, shown: { temp: Math.round(temp * 1000), rpm: noisy, pwm } };
}

// Whole files only: the engine never reads half a number.
function put(file, text) {
  writeFileSync(`${file}.new`, `${text}\n`);
  renameSync(`${file}.new`, file);
}
const readInt = (file) => {
  try { const t = readFileSync(file, 'utf8').trim(); return /^\d{1,3}$/.test(t) ? Number(t) : null; } catch { return null; }
};

/** The tree: hwmon0 the board (nct6798), hwmon1 the CPU (k10temp), each with a device link. */
export function makeTree(root, devDir, board = initialBoard()) {
  const chips = [['hwmon0', 'nct6798', 'nct6775.656'], ['hwmon1', 'k10temp', '0000:00:18.3']];
  for (const [dir, name, dev] of chips) {
    mkdirSync(path.join(root, dir), { recursive: true });
    mkdirSync(path.join(devDir, dev), { recursive: true });
    put(path.join(root, dir, 'name'), name);
    if (!existsSync(path.join(root, dir, 'device'))) symlinkSync(path.join(devDir, dev), path.join(root, dir, 'device'));
  }
  const b = path.join(root, 'hwmon0');
  FANS.forEach((_, i) => {
    put(path.join(b, `pwm${i + 1}`), board.pwm[i]);
    put(path.join(b, `pwm${i + 1}_enable`), board.enable[i]);
    put(path.join(b, `fan${i + 1}_input`), Math.round(board.rpm[i]));
  });
  put(path.join(root, 'hwmon1', 'temp1_label'), 'Tctl');
  put(path.join(root, 'hwmon1', 'temp1_input'), Math.round(board.temp * 1000));
}

function run(root, devDir, ctl) {
  mkdirSync(ctl, { recursive: true });
  let board = initialBoard();
  makeTree(root, devDir, board);
  const b = path.join(root, 'hwmon0');
  const tick = () => {
    if (existsSync(path.join(ctl, 'stop'))) return;
    let load = Number(readFileSync(path.join(ctl, 'load'), { encoding: 'utf8', flag: 'a+' }).trim() || 0.25);
    if (!Number.isFinite(load)) load = 0.25;
    const wrote = {
      pwm: FANS.map((_, i) => readInt(path.join(b, `pwm${i + 1}`))),
      enable: FANS.map((_, i) => readInt(path.join(b, `pwm${i + 1}_enable`))),
      load, hot: existsSync(path.join(ctl, 'hot')),
    };
    const out = step(board, wrote, TICK_MS / 1000);
    board = out.board;
    FANS.forEach((_, i) => {
      put(path.join(b, `fan${i + 1}_input`), out.shown.rpm[i]);
      // The chip writes pwmN only while its own curve runs it, as a real one does.
      if (board.enable[i] !== MANUAL && wrote.pwm[i] !== out.shown.pwm[i]) writeFileSync(path.join(b, `pwm${i + 1}`), `${out.shown.pwm[i]}\n`);
    });
    put(path.join(root, 'hwmon1', 'temp1_input'), out.shown.temp);
    put(path.join(ctl, 'board.json'), JSON.stringify({ at: Date.now(), temp: Math.round(board.temp * 10) / 10, ...out.shown, enable: board.enable, load }));
    setTimeout(tick, TICK_MS);
  };
  tick();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, devDir, ctl] = process.argv.slice(2);
  if (!root || !devDir || !ctl) { console.error('usage: fake-hwmon.mjs <hwmon root> <device dir> <control dir>'); process.exit(1); }
  run(path.resolve(root), path.resolve(devDir), path.resolve(ctl));
}

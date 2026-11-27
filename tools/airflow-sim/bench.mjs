// A pretend motherboard for the fan check (server/airflow/calibrate.js), wired the
// way real builds are: a header whose fan reads on another header's tachometer, a
// hub carrying two fans with two readings, a 3-pin fan on a header set to PWM, an
// empty header, a pump, a graphics card with a 30 % floor and two fans on one
// control, and a fan the BIOS drives that changes speed on its own mid-check.
// Fans coast, stop below their stop duty and need a kick to start again (startDuty
// over 100: never again); a reading can be jittery or vanish (goneAt ms); the hands
// apply a duty only after a delay, as the service does. A fan can ramp slowly
// (rampRpmS, as an iCUE LINK hub does) and its control say so (settleMs). Fans start
// at 40 % of their top speed, or at startRpm (a hub already running its profile).
// A control Xenon never tried (beta) may keep Xenon's last duty once let go (keepsLast),
// as a control whose hand-back does nothing would.
import { seeded } from './scenarios.mjs';

const FAN_TAU_S = 1;
const TACH_NOISE = 10;
// Board tachometers read 0 this slow.
const TACH_FLOOR = 150;
const FIRMWARE_DUTY = 60;

const fan = (tach, extra) => ({ tach, maxRpm: 1500, floorRpm: 400, knee: 20, stopDuty: null, startDuty: 0, ...extra });

/** The default board; each control names its fans and the reading its driver guessed. */
export function defaultBench() {
  return {
    controls: [
      { id: 'lhm:board:control-1', tach: 'lhm:board:fan-1', fans: [fan('lhm:board:fan-1', { maxRpm: 1800, stopDuty: 10, startDuty: 22 })] },
      // Its fan reads on fan-3, not on the fan-2 its name suggests.
      { id: 'lhm:board:control-2', tach: 'lhm:board:fan-2', fans: [fan('lhm:board:fan-3', { floorRpm: 500, knee: 25 })] },
      { id: 'lhm:board:control-3', tach: 'lhm:board:fan-3', fans: [
        fan('lhm:board:fan-4', { maxRpm: 1200, floorRpm: 300, stopDuty: 15, startDuty: 30 }),
        fan('lhm:board:fan-5', { maxRpm: 1250, floorRpm: 320, stopDuty: 18, startDuty: 35 }),
      ] },
      { id: 'lhm:board:control-4', tach: 'lhm:board:fan-6', fans: [fan('lhm:board:fan-6', { threePin: true })] },
      // Empty; the reading its name suggests is control-2's fan.
      { id: 'lhm:board:control-5', tach: 'lhm:board:fan-3', fans: [] },
      { id: 'lhm:board:control-6', tach: 'lhm:board:fan-8', kind: 'pump', fans: [fan('lhm:board:fan-8', { maxRpm: 2800, floorRpm: 1300, knee: 0 })] },
      { id: 'lhm:gpu:control-1', tach: 'lhm:gpu:fan-1', floor: 30, fans: [
        fan('lhm:gpu:fan-1', { maxRpm: 3000, floorRpm: 1000, knee: 30 }),
        fan('lhm:gpu:fan-2', { maxRpm: 3050, floorRpm: 1020, knee: 30 }),
      ] },
    ],
    // On a header Xenon cannot drive: the BIOS slows it down at 40 s.
    bios: [fan('lhm:board:fan-9', { maxRpm: 1400, floorRpm: 500 })],
    biosDuty: (t) => (t < 40000 ? 80 : 45),
  };
}

function speedFor(f, duty) {
  if (f.dead) return 0;
  if (f.threePin) return f.maxRpm;
  if (!f.spinning && duty < f.startDuty) return 0;
  if (f.stopDuty != null && duty <= f.stopDuty) { f.spinning = false; return 0; }
  f.spinning = true;
  if (duty <= f.knee) return f.floorRpm;
  return f.floorRpm + (f.maxRpm - f.floorRpm) * ((duty - f.knee) / (100 - f.knee)) ** 1.1;
}

/**
 * @param {ReturnType<typeof defaultBench>} [spec]
 * @param {{ latencyMs?: number, seed?: number, start?: number }} [opts]
 *   start: the clock's first reading, so runs one after another on the same disk see time go on
 */
export function createBench(spec = defaultBench(), { latencyMs = 1500, seed = 3, start = 0 } = {}) {
  const rng = seeded(seed);
  let t = start;
  const controls = spec.controls.map((c) => ({
    ...c, applied: FIRMWARE_DUTY, held: false, queue: [],
    fans: c.fans.map((f) => ({ ...f, rpm: f.startRpm ?? f.maxRpm * 0.4, spinning: true })),
  }));
  const bios = (spec.bios || []).map((f) => ({ ...f, rpm: f.maxRpm * 0.6, spinning: true }));
  const clampTo = (c, d) => Math.max(c.floor || 0, Math.min(100, d));

  return {
    now: () => t,
    /** What a driver hands the check: one entry per control. */
    channels: () => controls.map((c) => ({ id: c.id, kind: c.kind || 'fan', tach: c.tach, floor: c.floor || 0, settleMs: c.settleMs, beta: c.beta === true })),
    /** Duties the safety layer let through; a control left out goes back to the firmware. */
    apply(duties) {
      for (const c of controls) {
        const want = Number.isFinite(duties[c.id]) ? clampTo(c, Math.round(duties[c.id])) : null;
        c.queue.push({ at: t + latencyMs, duty: want });
      }
    },
    advance(ms) {
      t += ms;
      for (const c of controls) {
        while (c.queue.length && c.queue[0].at <= t) {
          const { duty } = c.queue.shift();
          c.held = duty != null;
          c.applied = duty ?? (c.keepsLast ? c.applied : FIRMWARE_DUTY);
        }
      }
      const k = 1 - Math.exp(-ms / 1000 / FAN_TAU_S);
      const move = (f, duty) => {
        const target = speedFor(f, duty);
        const step = (target - f.rpm) * k;
        const most = f.rampRpmS ? f.rampRpmS * (ms / 1000) : Infinity;
        f.rpm += Math.max(-most, Math.min(most, step));
        if (target === 0 && f.rpm < TACH_FLOOR) f.rpm = 0;
      };
      for (const c of controls) for (const f of c.fans) move(f, c.applied);
      for (const f of bios) move(f, spec.biosDuty(t));
    },
    read() {
      const tachs = {};
      const all = [...controls.flatMap((c) => c.fans), ...bios];
      for (const f of all) {
        const value = f.rpm < TACH_FLOOR ? 0 : Math.round(f.rpm + (rng() - 0.5) * (f.jitter || TACH_NOISE));
        tachs[f.tach] = f.goneAt != null && t >= f.goneAt ? null : value;
      }
      // A guessed reading with no fan on it reads 0, as an empty header does.
      for (const c of controls) if (c.tach && !(c.tach in tachs)) tachs[c.tach] = 0;
      return { at: t, tachs, duty: Object.fromEntries(controls.map((c) => [c.id, c.applied])) };
    },
    fan: (tach) => [...controls.flatMap((c) => c.fans), ...bios].find((f) => f.tach === tach),
    /** The readings of the fans really on a control (what the check has to find out). */
    tachsOf: (id) => controls.find((c) => c.id === id)?.fans.map((f) => f.tach) || [],
  };
}

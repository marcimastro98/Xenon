// A pretend gaming PC for Airflow's tests and tuning: physics the brain never
// sees, only senses through the same readings the real drivers give it.
//
// Heat: CPU and GPU each have a die riding on a slow node (liquid / heatsink),
// the slow nodes shed heat to the air they breathe, and the case air is heated by
// whatever is not blown straight out (GPU heat, the board, a top-exhaust radiator
// only partly) and cooled by the case fans' airflow to the room. Fans follow
// their own duty->RPM curve with inertia; a 3-pin fan on a PWM header ignores the
// duty; a stalled fan reads 0. A fan can need more to start from a dead stop than
// it needs to keep turning (startDuty), more even than the fan check found
// (calStartDuty). Commands can reach the fans late (handDelayS) and tachometers read
// late (tachLagS), as through the Windows sensor service. Sensors have the real
// resolution and can freeze or vanish. The firmware (BIOS curve, GPU auto) takes over a channel whenever the
// brain hands it back, so a run shows what the user would really get. The CPU
// throttles at its limit like a real one (power falls, the die holds).
//
// Numbers are a typical mid-range build (8-core Ryzen under a 360 AIO, a 300 W
// card): about 25 W/K through the radiator at full speed, 10-12 K of liquid over
// case air under load, case air 8-12 K over the room while gaming.

const FAN_TAU_S = 1.5;
const TACH_NOISE = 8;
const TEMP_STEP = 0.125;
// Board tachometers read 0 below a couple of hundred RPM.
const TACH_FLOOR = 150;

/** A default PC: 360 AIO on top, 3 front intakes, 1 rear, GPU with 2 fans. */
export function defaultPc() {
  return {
    room: 24,
    fans: [
      { id: 'rad1', place: 'radiator', maxRpm: 2000, minRpm: 450, stopDuty: 15, zeroOk: false },
      { id: 'rad2', place: 'radiator', maxRpm: 2000, minRpm: 450, stopDuty: 15, zeroOk: false, rpmSkew: 1.03 },
      { id: 'rad3', place: 'radiator', maxRpm: 2000, minRpm: 450, stopDuty: 15, zeroOk: false, rpmSkew: 0.97 },
      { id: 'front1', place: 'front', maxRpm: 1500, minRpm: 350, stopDuty: 12, zeroOk: true },
      { id: 'front2', place: 'front', maxRpm: 1500, minRpm: 350, stopDuty: 12, zeroOk: true, rpmSkew: 1.04 },
      { id: 'front3', place: 'front', maxRpm: 1500, minRpm: 350, stopDuty: 12, zeroOk: true },
      { id: 'rear', place: 'rear', maxRpm: 1500, minRpm: 350, stopDuty: 12, zeroOk: true },
      { id: 'gpu1', place: 'gpu', maxRpm: 3000, minRpm: 900, stopDuty: 27, zeroOk: true, minDuty: 30, zeroByDefault: true },
      { id: 'gpu2', place: 'gpu', maxRpm: 3000, minRpm: 900, stopDuty: 27, zeroOk: true, minDuty: 30, zeroByDefault: true },
    ],
    cpu: { name: 'AMD Ryzen 7 9700X', C: 2200, G0: 1.5, radG: 25, R: 0.3, limit: 95, exhaustShare: 0.3 },
    gpu: { C: 900, G0: 1.5, fanG: 25, caseG: 2, R: 0.05, memOver: 8 },
    caseAir: { C: 1500, G0: 4, perFan: 15, board: 35 },
  };
}

export function createPlant(spec = defaultPc(), rng = Math.random) {
  const fans = spec.fans.map((f) => ({ ...f, rpm: f.minRpm, duty: null, firmware: true, stalled: false, threePin: false }));
  /** @type {{ due: number, verdicts: Record<string, any> }[]} */
  const sent = [];
  /** @type {{ t: number, rpm: number[] }[]} */
  const tachs = [];
  const s = { t: 0, liquid: spec.room + 6, gpuSink: spec.room + 8, caseAir: spec.room + 4, power: { cpu: 25, gpu: 20 } };
  const faults = { frozen: null, missing: new Set(), dust: 1 };
  let frozenValue = null;

  const frac = (f) => f.rpm / f.maxRpm;
  const flow = (place) => fans.filter((f) => f.place === place);
  const sum08 = (list) => list.reduce((a, f) => a + frac(f) ** 0.8, 0);
  const mean08 = (list) => (list.length ? sum08(list) / list.length : 0);

  function rpmFor(f, duty) {
    if (f.stalled) return 0;
    if (f.threePin) return f.maxRpm;
    if (f.startDuty != null && f.rpm < TACH_FLOOR && duty < f.startDuty) return 0;
    if (duty <= f.stopDuty) return f.zeroOk ? 0 : f.minRpm;
    const x = (duty - f.stopDuty) / (100 - f.stopDuty);
    return (f.minRpm + (f.maxRpm - f.minRpm) * x ** 1.1) * (f.rpmSkew || 1);
  }

  // What the firmware does with a channel it owns: BIOS curve on the CPU die for
  // board headers, the card's own zero-RPM curve for GPU fans.
  function firmwareDuty(f, dies) {
    if (f.place === 'gpu') return dies.gpu < 50 ? 0 : Math.min(100, 30 + (dies.gpu - 55) * (70 / 30));
    return Math.min(100, Math.max(30, 30 + (dies.cpu - 40) * (70 / 40)));
  }

  function dies() {
    const cpu = s.liquid + spec.cpu.R * s.power.cpu;
    const gpu = s.gpuSink + spec.gpu.R * s.power.gpu;
    return { cpu, gpu, gpuMem: gpu + spec.gpu.memOver + 0.02 * s.power.gpu };
  }

  /** Advance dt seconds. `power` { cpu, gpu } in watts, as asked; the CPU may throttle. */
  function step(dt, power) {
    const cpuRoom = (spec.cpu.limit - s.liquid) / spec.cpu.R;
    s.power = { cpu: Math.max(0, Math.min(power.cpu, cpuRoom)), gpu: power.gpu };
    const d = dies();
    while (sent.length && sent[0].due <= s.t) take(sent.shift().verdicts);
    for (const f of fans) {
      const duty = f.firmware ? firmwareDuty(f, d) : f.duty;
      f.rpm += (rpmFor(f, duty) - f.rpm) * (1 - Math.exp(-dt / FAN_TAU_S));
    }
    tachs.push({ t: s.t + dt, rpm: fans.map((f) => f.rpm) });
    while (tachs.length > 1 && tachs[1].t <= s.t + dt - (spec.tachLagS || 0)) tachs.shift();
    const caseFans = fans.filter((f) => ['front', 'rear', 'top', 'bottom', 'side'].includes(f.place));
    const radG = spec.cpu.G0 + spec.cpu.radG * mean08(flow('radiator')) * faults.dust;
    const gpuG = spec.gpu.G0 + spec.gpu.fanG * mean08(flow('gpu')) * faults.dust
      + spec.gpu.caseG * sum08(caseFans);
    const caseG = spec.caseAir.G0 + spec.caseAir.perFan * sum08(caseFans) * faults.dust;
    const cpuToCase = s.power.cpu * spec.cpu.exhaustShare;
    const heatIn = s.power.gpu + spec.caseAir.board + cpuToCase;
    s.liquid += (dt / spec.cpu.C) * (s.power.cpu - radG * (s.liquid - s.caseAir));
    s.gpuSink += (dt / spec.gpu.C) * (s.power.gpu - gpuG * (s.gpuSink - s.caseAir));
    s.caseAir += (dt / spec.caseAir.C) * (heatIn - caseG * (s.caseAir - spec.room));
    s.t += dt;
  }

  const q = (v) => Math.round(v / TEMP_STEP) * TEMP_STEP;

  /** Readings as a driver would give them. */
  function sense() {
    const at = Math.round(s.t * 1000);
    const d = dies();
    const reading = (name, v) => {
      if (faults.missing.has(name)) return undefined;
      if (faults.frozen === name) { frozenValue ??= q(v); return { value: frozenValue, at }; }
      return { value: q(v), at };
    };
    const temps = { cpu: reading('cpu', d.cpu), gpu: reading('gpu', d.gpu), gpuMem: reading('gpuMem', d.gpuMem), board: reading('board', s.caseAir + 3) };
    for (const k of Object.keys(temps)) if (temps[k] === undefined) delete temps[k];
    const rpm = {};
    const duty = {};
    const read = tachs[0]?.rpm || fans.map((f) => f.rpm);
    for (const [i, f] of fans.entries()) {
      const r = read[i];
      rpm[f.id] = r < TACH_FLOOR ? 0 : Math.round(r + (rng() - 0.5) * TACH_NOISE);
      if (!f.firmware && Number.isFinite(f.duty)) duty[f.id] = f.duty;
    }
    return { at, temps, power: { ...s.power }, rpm, duty };
  }

  function take(verdicts) {
    for (const f of fans) {
      const v = verdicts[f.id];
      if (!v) continue;
      if (v.action === 'firmware') { f.firmware = true; f.duty = null; } else { f.firmware = false; f.duty = v.duty; }
    }
  }

  /** Apply safety verdicts { id: { action: 'set', duty } | { action: 'firmware' } }, late if the hands are. */
  function apply(verdicts) {
    if (spec.handDelayS > 0) sent.push({ due: s.t + spec.handDelayS, verdicts });
    else take(verdicts);
  }

  return {
    step, sense, apply, dies, fans, state: s, faults, spec,
    freeze: (name) => { faults.frozen = name; frozenValue = null; },
    // What calibration would report: the curve measured on a healthy fan, the
    // slowest steady speed at its minimum duty.
    channels: () => fans.map((f) => {
      const healthy = { ...f, rpmSkew: 1, stalled: false, threePin: false };
      const minDuty = f.minDuty ?? f.stopDuty + 3;
      return {
        id: f.id, kind: 'fan', place: f.place, maxRpm: f.maxRpm, minFrac: rpmFor(healthy, minDuty) / f.maxRpm,
        zeroOk: f.zeroOk, zeroByDefault: f.zeroByDefault === true, controllable: true, hasTach: true,
        minDuty, startDuty: f.calStartDuty ?? f.startDuty ?? f.stopDuty + 3,
        curve: [minDuty, 30, 40, 50, 60, 70, 80, 90, 100].map((dd) => [dd, Math.round(rpmFor(healthy, dd))]),
      };
    }),
  };
}

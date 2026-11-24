// What happens to the pretend PC over a run: power drawn, what the user is doing,
// and the faults thrown at it. Every scenario is deterministic for a given seed.
//
// power() -> (t, rng) -> { cpu, gpu } watts asked of the chips at second t (a
// factory: the burst generator keeps state, and every run starts fresh).
// ctx(t) -> what brain-context.js sees (game exe, call, hour, options).
// events: [{ at, run(plant, rig) }] faults injected at second `at`.
// leftToPc: fans another app runs (their firmware curve here): Xenon never gets them.
// pc(spec) -> the pretend PC, when the scenario needs another one than defaultPc().

/** Small seeded generator, so every run of a scenario draws the same spikes. */
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A Ryzen at the desktop: low base, short bursts to 3x every few seconds
// (a page loading, an app waking), which is what makes BIOS curves hunt.
function desktop(base = 25, burst = 85) {
  let until = 0;
  let next = 0;
  return (t, rng) => {
    if (t >= next) { until = t + 1 + Math.floor(rng() * 4); next = until + 5 + Math.floor(rng() * 20); }
    return t < until ? burst : base + rng() * 4;
  };
}

function game({ cpu = 90, gpu = 280, from = 180 } = {}) {
  const idle = desktop();
  return (t, rng) => (t < from
    ? { cpu: idle(t, rng), gpu: 22 }
    : { cpu: cpu + (rng() - 0.5) * 20, gpu: gpu + (rng() - 0.5) * 40 });
}

const at = (pick) => (t) => pick(t);
const base = { hour: 15, mode: 'balanced', allowZero: false, options: {} };

export const SCENARIOS = {
  'idle-spikes': {
    about: 'Desktop with Ryzen bursts, 30 min',
    seconds: 1800,
    power: () => { const idle = desktop(); return (t, rng) => ({ cpu: idle(t, rng), gpu: 22 }); },
    ctx: at(() => base),
  },
  game: {
    about: 'Game for 2 h after 3 min of desktop',
    seconds: 7380,
    power: () => game(),
    ctx: at((t) => ({ ...base, game: t >= 180 ? 'game.exe' : null })),
  },
  'game-known': {
    about: 'Same game, already learned: fans start rising at launch',
    seconds: 1500,
    memory: { 'game.exe': { cpu: 90, gpu: 280, n: 3600 } },
    power: () => game(),
    ctx: at((t) => ({ ...base, game: t >= 180 ? 'game.exe' : null })),
  },
  render: {
    about: 'All-core render, CPU flat out for 30 min, then 10 min desktop',
    seconds: 2400,
    power: () => { const idle = desktop(); return (t, rng) => (t < 1800 ? { cpu: 160, gpu: 30 } : { cpu: idle(t, rng), gpu: 22 }); },
    ctx: at(() => base),
  },
  call: {
    about: 'Light work with a call from minute 5 to 15',
    seconds: 1200,
    power: () => { const idle = desktop(); return (t, rng) => ({ cpu: idle(t, rng) + 15, gpu: 45 }); },
    ctx: at((t) => ({ ...base, call: t >= 300 && t < 900 })),
  },
  night: {
    about: 'Desktop at 2 am with night hours on',
    seconds: 1800,
    power: () => { const idle = desktop(); return (t, rng) => ({ cpu: idle(t, rng), gpu: 22 }); },
    ctx: at(() => ({ ...base, hour: 2, options: { night: { on: true, from: 23, to: 7 } } })),
  },
  dust: {
    about: 'Game on a dusty PC (filters and radiator 30 % worse)',
    seconds: 3600,
    power: () => game(),
    ctx: at((t) => ({ ...base, game: t >= 180 ? 'game.exe' : null })),
    events: [{ at: 0, run: (plant) => { plant.faults.dust = 0.7; } }],
  },
  'hidden-cooler': {
    about: 'A warm-idling X3D whose AIO its own app runs: Xenon drives the case fans and the card, no board sensor',
    seconds: 1800,
    pc: (spec) => ({ ...spec, cpu: { ...spec.cpu, name: 'AMD Ryzen 7 9800X3D', R: 0.45 } }),
    power: () => { const idle = desktop(45, 80); return (t, rng) => ({ cpu: idle(t, rng), gpu: 39 }); },
    ctx: at(() => base),
    leftToPc: ['rad1', 'rad2', 'rad3'],
    events: [{ at: 0, run: (plant) => { plant.faults.missing.add('board'); } }],
  },
  'hidden-cooler-work': {
    about: 'The same X3D at work for 15 min (a scan, a build): its AIO, run by its own app, does the cooling',
    seconds: 1800,
    pc: (spec) => ({ ...spec, cpu: { ...spec.cpu, name: 'AMD Ryzen 7 9800X3D', R: 0.45 } }),
    power: () => { const idle = desktop(45, 80); return (t, rng) => ({ cpu: t >= 300 && t < 1200 ? 105 + (rng() - 0.5) * 30 : idle(t, rng), gpu: 39 }); },
    ctx: at(() => base),
    leftToPc: ['rad1', 'rad2', 'rad3'],
    events: [{ at: 0, run: (plant) => { plant.faults.missing.add('board'); } }],
  },
  'fan-restart': {
    about: 'Case fans allowed to stop at rest, needed again by bursts of work, on hands and tachometers a second or two late and fans that need more to start than the fan check found',
    seconds: 1500,
    pc: (spec) => ({
      ...spec,
      handDelayS: 2,
      tachLagS: 1,
      fans: spec.fans.map((f) => (['front', 'rear'].includes(f.place) ? { ...f, startDuty: 28, calStartDuty: 25 } : f)),
    }),
    power: () => {
      const idle = desktop(45, 80);
      const work = (t) => (t >= 300 && t < 600) || (t >= 1000 && t < 1300);
      return (t, rng) => ({ cpu: work(t) ? 120 + (rng() - 0.5) * 30 : idle(t, rng), gpu: 39 });
    },
    ctx: at(() => ({ ...base, allowZero: true })),
    leftToPc: ['rad1', 'rad2', 'rad3'],
  },
  'three-pin': {
    about: 'Rear fan is 3-pin on a PWM header: always full speed',
    seconds: 1800,
    power: () => game({ from: 600 }),
    ctx: at((t) => ({ ...base, game: t >= 600 ? 'game.exe' : null })),
    events: [{ at: 0, run: (plant) => { plant.fans.find((f) => f.id === 'rear').threePin = true; } }],
  },
  'stuck-sensor': {
    about: 'CPU sensor freezes during a game whose load swings',
    seconds: 1200,
    power: () => (t) => ({ cpu: Math.floor(t / 20) % 2 ? 130 : 60, gpu: 250 }),
    ctx: at(() => base),
    fault: { at: 600, component: 'cpu', within: 35 },
    events: [{ at: 600, run: (plant) => plant.freeze('cpu') }],
  },
  'lost-sensor': {
    about: 'CPU sensor disappears from the readings mid-game',
    seconds: 900,
    power: () => game({ from: 0 }),
    ctx: at(() => base),
    fault: { at: 600, component: 'cpu', within: 6 },
    events: [{ at: 600, run: (plant) => { plant.faults.missing.add('cpu'); } }],
  },
  'brain-crash': {
    about: 'The brain stops answering mid-game',
    seconds: 900,
    power: () => game({ from: 0 }),
    ctx: at(() => base),
    fault: { at: 600, component: 'brain', within: 6 },
    events: [{ at: 600, run: (_plant, rig) => { rig.brainDead = true; } }],
  },
  'engine-restart': {
    about: 'Xenon restarts mid-game: the board runs the fans for 12 s, then a new brain starts from the save',
    seconds: 900,
    power: () => game({ from: 0 }),
    ctx: at(() => base),
    events: [{ at: 600, run: (_plant, rig) => { rig.brainDead = true; } }, { at: 612, run: (_plant, rig) => { rig.restart = true; } }],
  },
  stall: {
    about: 'A front fan jams mid-game',
    seconds: 900,
    power: () => game({ from: 0 }),
    ctx: at(() => base),
    fault: { at: 300, channel: 'front2', within: 7 },
    events: [{ at: 300, run: (plant) => { plant.fans.find((f) => f.id === 'front2').stalled = true; } }],
  },
};

// The three ways the pretend PC's fans can be driven, so a run compares them on
// the same physics and the same load:
//   bios       - what most PCs do: every header on a CPU-die curve (30 % up to
//                40 C, 100 % at 80 C), the card on its own zero-RPM curve.
//   fancontrol - a careful enthusiast setup in the FanControl style: same curves
//                with 2 C hysteresis and 8 %/s steps, case fans on the hotter of
//                CPU and GPU, the card left on its own curve.
//   xenon      - Airflow's brain checked by its safety layer, exactly as in the app.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrain } = require('../../server/airflow/brain.js');
const { LAST_EVERY_MS } = require('../../server/airflow/loop-save.js');
const { createSafety } = require('../../server/airflow/safety.js');
// Which readings each channel depends on: the app's own rule.
export const { depsFor } = require('../../server/airflow/inventory.js');

const CASE_PLACES = new Set(['front', 'rear', 'top', 'bottom', 'side']);
const line = (t, t0, d0, t1, d1) => Math.min(d1, Math.max(d0, d0 + ((t - t0) * (d1 - d0)) / (t1 - t0)));
const cpuCurve = (t) => line(t, 40, 30, 80, 100);
const gpuCurve = (t) => line(t, 50, 30, 80, 100);

function bios() {
  // The plant's firmware is this curve: leaving every channel to it is the BIOS.
  return { tick() {} };
}

function fancontrol({ plant }) {
  const used = {};
  const duty = {};
  const hyst = (key, temp) => {
    if (used[key] == null || Math.abs(temp - used[key]) >= 2) used[key] = temp;
    return used[key];
  };
  return {
    tick(snap) {
      const cpu = snap.temps.cpu?.value;
      const gpu = snap.temps.gpu?.value;
      if (!Number.isFinite(cpu) || !Number.isFinite(gpu)) return;
      const c = cpuCurve(hyst('cpu', cpu));
      const g = gpuCurve(hyst('gpu', gpu));
      const verdicts = {};
      for (const f of plant.fans) {
        if (f.place === 'gpu') continue;
        const want = CASE_PLACES.has(f.place) ? Math.max(c, g) : c;
        const now = duty[f.id] ?? want;
        duty[f.id] = now + Math.max(-8, Math.min(8, want - now));
        verdicts[f.id] = { action: 'set', duty: Math.round(duty[f.id]) };
      }
      plant.apply(verdicts);
    },
  };
}


function xenon({ plant, scenario, rig }) {
  const left = new Set(scenario.leftToPc || []);
  const channels = plant.channels().filter((c) => !left.has(c.id)).map((c) => ({ ...c, deps: depsFor(c.place, c.kind) }));
  const cpuName = plant.spec.cpu.name;
  let brain = createBrain({ channels, cpuName, memory: scenario.memory || {} });
  // The speeds as the engine writes them, every LAST_EVERY_MS (loop-save.js).
  let last = null;
  let lastAt = -Infinity;
  const safety = createSafety({ cpuName, clock: () => rig.nowMs });
  let plan = null;
  let untrusted = [];
  return {
    get brain() { return brain; },
    safety,
    tick(snap, ctx) {
      let out = null;
      // An engine restart: what the brain learned goes to a new one, as the loop saves it.
      if (rig.restart) {
        brain = createBrain({ channels, cpuName, memory: scenario.memory || {}, saved: JSON.parse(JSON.stringify(brain.save())), last });
        rig.restart = false;
        rig.brainDead = false;
      }
      if (!rig.brainDead) {
        out = brain.tick(snap, { ...ctx, untrusted, stalled: safety.stalled(), driving: true });
        plan = { at: snap.at, targets: out.duties, allowZero: ctx.allowZero === true };
        if (snap.at - lastAt >= LAST_EVERY_MS) { lastAt = snap.at; last = JSON.parse(JSON.stringify(brain.last())); }
      }
      const live = channels.map((c) => ({ ...c, rpm: snap.rpm[c.id] }));
      const verdict = safety.check({ temps: snap.temps, power: snap.power, channels: live, plan });
      untrusted = verdict.untrusted;
      plant.apply(verdict.channels);
      return { out, verdict };
    },
  };
}

export const CONTROLLERS = { bios, fancontrol, xenon };

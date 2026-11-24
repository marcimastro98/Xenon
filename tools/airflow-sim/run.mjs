// Airflow simulator: runs scenarios on the pretend PC with each controller and
// prints how they compare. Used by the tests (server/test/airflow-sim.test.mjs)
// and by hand while tuning the brain:
//   node tools/airflow-sim/run.mjs                 every scenario, every controller
//   node tools/airflow-sim/run.mjs idle-spikes game --seed 3 --json
import { pathToFileURL } from 'node:url';
import { createPlant, defaultPc } from './plant.mjs';
import { SCENARIOS, seeded } from './scenarios.mjs';
import { CONTROLLERS, depsFor } from './controllers.mjs';
import { createMetrics } from './metrics.mjs';

/**
 * @param {string} name scenario name
 * @param {'bios'|'fancontrol'|'xenon'} controllerName
 * @param {{ seed?: number, trace?: (t: number, row: any) => void }} [opts]
 */
export function runScenario(name, controllerName, { seed = 7, trace } = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}`);
  const rng = seeded(seed);
  const plant = createPlant(scenario.pc ? scenario.pc(defaultPc()) : undefined, seeded(seed + 1000));
  const rig = { nowMs: 0, brainDead: false };
  const controller = CONTROLLERS[controllerName]({ plant, scenario, rig });
  const channels = plant.channels().map((c) => ({ ...c, deps: depsFor(c.place, c.kind) }));
  const metrics = createMetrics({ channels, cpuName: plant.spec.cpu.name, fault: controllerName === 'xenon' ? scenario.fault : null });
  const power = scenario.power();
  const events = (scenario.events || []).slice().sort((a, b) => a.at - b.at);
  for (let t = 0; t < scenario.seconds; t += 1) {
    while (events.length && events[0].at <= t) events.shift().run(plant, rig);
    plant.step(1, power(t, rng));
    rig.nowMs = (t + 1) * 1000;
    const snap = plant.sense();
    const r = controller.tick(snap, scenario.ctx(t));
    const rpm = Object.fromEntries(plant.fans.map((f) => [f.id, f.rpm]));
    metrics.add(t, plant.dies(), rpm, r?.verdict);
    if (trace) trace(t, { snap, dies: plant.dies(), rpm, channels, out: r?.out, verdict: r?.verdict, liquid: plant.state.liquid, caseAir: plant.state.caseAir, brain: controller.brain });
  }
  return { scenario: name, controller: controllerName, ...metrics.result(), brain: controller.brain };
}

function table(rows) {
  const head = ['scenario', 'ctrl', 'cpu max', 'gpu max', 'over s cpu/gpu', 'dB mean', 'dB p95', 'changes', 'reversals', 'full s', 'fault s'];
  const lines = rows.map((r) => [
    r.scenario, r.controller, r.maxDie.cpu, r.maxDie.gpu, `${r.overTarget.cpu}/${r.overTarget.gpu}`,
    r.meanDb, r.p95Db, r.changes, r.reversals, r.fullSeconds, r.reactedIn ?? '-',
  ].map(String));
  const width = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const fmt = (cols) => cols.map((c, i) => c.padEnd(width[i])).join('  ');
  return [fmt(head), fmt(width.map((w) => '-'.repeat(w))), ...lines.map(fmt)].join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const seedAt = argv.indexOf('--seed');
  const seed = seedAt >= 0 ? Number(argv[seedAt + 1]) : 7;
  const names = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--seed');
  const pick = names.length ? names : Object.keys(SCENARIOS);
  const rows = [];
  for (const name of pick) {
    for (const ctrl of Object.keys(CONTROLLERS)) {
      const { brain: _brain, ...row } = runScenario(name, /** @type {any} */ (ctrl), { seed });
      rows.push(row);
    }
  }
  process.stdout.write(json ? `${JSON.stringify(rows, null, 2)}\n` : `${table(rows)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));

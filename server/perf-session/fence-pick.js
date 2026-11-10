'use strict';
// Which cores the busy apps move to, from the same facts on every OS.

// About a quarter of the cores is what was measured: 2 of 8 left a stand-in game
// reading like an empty PC with 16 busy threads around it.
const FENCE_SHARE = 0.25;
const MIN_CORES = 4;

// units: { id, core, efficiency }, one per logical CPU, `core` a number that ranks the
// physical cores. The apps go to the lowest efficiency class (E-cores) and, within it,
// to the last cores: on chips with two cache groups those are the second group, away
// from the first, and on 3D V-Cache parts away from the cache games want.
// Null on a PC with too few cores to give any away.
function pickFence(units) {
  const cores = new Map();
  for (const u of units) {
    const core = cores.get(u.core) || { order: u.core, efficiency: u.efficiency, ids: [] };
    core.ids.push(u.id);
    cores.set(u.core, core);
  }
  if (cores.size < MIN_CORES) return null;
  const count = Math.floor(cores.size * FENCE_SHARE);
  const chosen = [...cores.values()]
    .sort((a, b) => a.efficiency - b.efficiency || b.order - a.order)
    .slice(0, count);
  return { ids: chosen.flatMap((c) => c.ids), cores: chosen.length };
}

module.exports = { pickFence };

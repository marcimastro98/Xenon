'use strict';
// What the brain knows about sound, so it can pick the quietest mix of speeds.
//
// One fan: the fan laws put sound power at about the 5th power of speed, so
// level = Lref + 50 log10(rpm / 1000): twice the speed is 15 dB louder. Lref (the
// fan's level at 1000 RPM) is guessed from its top speed until a measurement says
// otherwise (wave 3 measures it with the microphone).
// Several fans add as energy: 10 log10(sum 10^(L/10)). Two fans at a speed are
// 3 dB louder than one; one fan at twice the speed is 15 dB louder. That is why
// the quietest way to move air is many slow fans, and the planner finds it alone.
//
// Beats: two similar fans a few RPM apart throb ("wah-wah") at the difference of
// their blade-pass frequencies; listeners find a throb around 4 Hz the most
// annoying sound a PC makes. Fans of the same kind are therefore grouped and held
// at the same RPM, and two groups that would land a few percent apart are pulled
// together (always upward, so cooling never drops).

// Level at 1000 RPM by top speed: slow fans are big (140 mm), fast ones small or
// high static pressure. GPU fans: 90-100 mm axial.
const LREF_BY_MAX = Object.freeze([[1300, 21], [2200, 23], [3200, 25], [Infinity, 28]]);
const LREF_GPU = 24;
const LREF_PUMP = 20;
// Similar fans: top speeds within this share of each other.
const SAME_KIND_SHARE = 0.06;
// Two speeds this close but not equal beat audibly.
const BEAT_SHARE = Object.freeze({ min: 0.005, max: 0.06 });

/** @param {{ kind?: string, place?: string, maxRpm?: number, noiseRef?: number }} ch */
function refLevel(ch) {
  if (Number.isFinite(ch.noiseRef)) return ch.noiseRef;
  if (ch.kind === 'pump') return LREF_PUMP;
  if (ch.place === 'gpu') return LREF_GPU;
  const max = Number.isFinite(ch.maxRpm) ? ch.maxRpm : 2000;
  return LREF_BY_MAX.find(([limit]) => max <= limit)[1];
}

/** dB(A)-like level of one fan at `rpm`; -Infinity when it is not turning. */
function fanDb(ch, rpm) {
  if (!(rpm > 0)) return -Infinity;
  return refLevel(ch) + 50 * Math.log10(rpm / 1000);
}

/** Energetic sum of levels. */
function totalDb(levels) {
  const e = levels.reduce((s, l) => s + (Number.isFinite(l) ? 10 ** (l / 10) : 0), 0);
  return e > 0 ? 10 * Math.log10(e) : -Infinity;
}

/**
 * Groups of fans that must turn at one speed. Fans without a tach or a top speed
 * stand alone (nothing to lock them on), and so do pumps.
 * @param {{ id: string, kind?: string, maxRpm?: number, hasTach?: boolean }[]} channels
 * @returns {string[][]}
 */
function beatGroups(channels) {
  const lockable = channels.filter((c) => c.kind !== 'pump' && c.hasTach && Number.isFinite(c.maxRpm) && c.maxRpm > 0)
    .sort((a, b) => a.maxRpm - b.maxRpm);
  const groups = [];
  for (const ch of lockable) {
    const g = groups.at(-1);
    if (g && ch.maxRpm <= g.base * (1 + SAME_KIND_SHARE)) g.ids.push(ch.id);
    else groups.push({ base: ch.maxRpm, ids: [ch.id] });
  }
  const grouped = new Set(lockable.map((c) => c.id));
  return groups.map((g) => g.ids).concat(channels.filter((c) => !grouped.has(c.id)).map((c) => [c.id]));
}

/**
 * Pulls apart-but-close speeds together: any speed within BEAT_SHARE below
 * another is raised to it. Never lowers anything.
 * @param {Record<string, number>} rpms target RPM per group key
 */
function unbeat(rpms) {
  const keys = Object.keys(rpms).filter((k) => rpms[k] > 0).sort((a, b) => rpms[b] - rpms[a]);
  const out = { ...rpms };
  for (let i = 1; i < keys.length; i += 1) {
    const hi = out[keys[i - 1]];
    const lo = out[keys[i]];
    const gap = (hi - lo) / hi;
    if (gap > BEAT_SHARE.min && gap < BEAT_SHARE.max) out[keys[i]] = hi;
  }
  return out;
}

/**
 * Moves a speed out of a resonance zone: up when rising (or when it is needed),
 * down otherwise. `zones` are [lowRpm, highRpm] pairs.
 */
function avoidZones(rpm, zones, rising) {
  for (const z of zones || []) {
    if (!Array.isArray(z) || z.length !== 2) continue;
    const [lo, hi] = z;
    if (rpm > lo && rpm < hi) return rising ? hi : lo;
  }
  return rpm;
}

module.exports = { refLevel, fanDb, totalDb, beatGroups, unbeat, avoidZones, BEAT_SHARE, SAME_KIND_SHARE };

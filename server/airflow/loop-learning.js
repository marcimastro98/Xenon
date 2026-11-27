'use strict';
// When what Airflow learned stops being true (loop.js). A fan that turns far from its
// check, reading after reading, is another fan on that header: it loses its check and goes
// back to the PC until the person checks again. A new processor or graphics card (its name
// differs from the one the learning was made on) starts that part's learning again; a new
// card's own fans lose their check too. After a new cooler or case the person asks to learn
// again from scratch: the fan checks and every choice stay. Also what each tick tells
// health.js.
const { createHealth } = require('./health.js');
const { createShadow } = require('./shadow.js');

// Health's daily note is tried at most this often (it returns at once when done).
const DAILY_EVERY_MS = 3600000;
const PARTS = Object.freeze(['cpu', 'gpu']);
const NAME_MAX = 96;
// Runs in a row a new name must be seen before it counts. A processor's name comes from the
// system and never varies; a card's comes from whichever reader answered (nvidia-smi, WMI,
// LibreHardwareMonitor, a Linux driver's plain "AMD GPU") and on a PC with two cards may
// name the other one, so it must come back once more. A false "new card" would cost the
// person a fan check.
const CONFIRM_RUNS = Object.freeze({ cpu: 1, gpu: 2 });

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const partName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');
const squash = (name) => name.toLowerCase().replace(/\((?:r|tm)\)/g, '').replace(/[^a-z0-9]/g, '');
// Another part only when both names carry a model number and neither holds the other:
// "NVIDIA GeForce RTX 4080" and "GeForce RTX 4080" are one card, "AMD GPU" names none.
function another(kept, now) {
  const a = squash(kept);
  const b = squash(now);
  return /\d/.test(a) && /\d/.test(b) && !a.includes(b) && !b.includes(a);
}

/**
 * @param {{ store: any, parts?: () => { cpu?: string|null, gpu?: string|null }, warn?: (msg: string) => void }} opts
 *   parts: this PC's processor and graphics card names, or null while not known yet
 */
function createLearning({ store, parts = () => ({}), warn = (_msg) => {} }) {
  // A part's name is taken once a run: a processor or a card changes only with the PC off,
  // and a name known later (a card's, once something reads it) is still this run's.
  const seen = new Set();
  let dailyAt = -Infinity;

  // The parts named for the first time this run that are another part than the learning's,
  // each with the time it was first seen. A new name not yet seen enough runs waits in
  // `pending`; the learning's own name stays.
  function newParts(st, now) {
    const names = parts() || {};
    const fresh = PARTS.filter((n) => !seen.has(n) && partName(names[n]));
    if (!fresh.length) return [];
    const kept = st.learned.parts && typeof st.learned.parts === 'object' ? st.learned.parts : {};
    const next = { ...kept, pending: { ...(kept.pending || {}) } };
    const gone = [];
    for (const n of fresh) {
      seen.add(n);
      const name = partName(names[n]);
      const was = partName(kept[n]);
      const prev = next.pending[n];
      const again = partName(prev?.name) === name;
      const runs = again ? (Number(prev.runs) || 0) + 1 : 1;
      const since = again && Number.isFinite(prev.at) ? prev.at : now;
      delete next.pending[n];
      // The same part: a name with a model number is the better one to keep.
      if (!was || !another(was, name)) next[n] = !was || /\d/.test(squash(name)) ? name : was;
      else if (runs >= CONFIRM_RUNS[n]) { next[n] = name; gone.push({ node: n, since }); }
      else next.pending[n] = { name, runs, at: since };
    }
    st.learned.parts = next;
    return gone;
  }

  // The new parts' models go; the brain is made again from what is left on the next tick.
  function forgetParts(st, gone, now) {
    if (st.brain) {
      st.learned.brain = st.brain.save();
      st.last = st.brain.last() ?? st.last;
    }
    st.brain = null;
    st.brainKey = '';
    const brain = { ...(st.learned.brain || {}) };
    for (const n of gone) { delete brain[n]; st.health.newPart(n, localDay(now)); }
    // The heat each game brought was measured on the old part.
    st.learned = { ...st.learned, brain, games: {} };
    warn(`airflow: a new ${gone.join(' and ')} was found, its learning starts again`);
  }

  // These fans lose their check: the PC drives them until the person checks them again.
  // checkedSince: a fan the check measured at or after that time keeps it (a new card's fans
  // checked once the card was first seen).
  async function uncheck(st, ids, now, checkedSince = {}) {
    for (const id of ids) st.health.forgetFan(id);
    try {
      await store.update((m) => {
        const mine = ids.filter((id) => m.fans[id]?.calib && !(m.fans[id].calib.at >= (checkedSince[id] ?? Infinity)));
        if (!mine.length) return null;
        const fans = { ...m.fans };
        const problems = { ...(m.check?.problems || {}) };
        for (const id of mine) { fans[id] = { ...fans[id], calib: null }; problems[id] = 'changed'; }
        return { ...m, fans, check: { at: m.check?.at ?? now, problems } };
      });
    } catch (e) {
      warn(`airflow: a fan that changed could not be left to the PC (${e.code || e.message})`);
    }
  }

  return {
    /** Each driving tick: the driven fans' readings for health, and its daily note. */
    observe(st, driven, verdict, now) {
      for (const c of driven) {
        const v = verdict.channels[c.id];
        if (v?.action === 'set') st.health.observeFan({ id: c.id, duty: v.duty, rpm: c.rpm, curve: c.curve, now });
      }
      if (st.brain && now - dailyAt >= DAILY_EVERY_MS) { dailyAt = now; st.health.daily({ day: localDay(now), models: st.brain.models }); }
    },
    /** Each tick: a new part, a fan that is another one. */
    async settle(st, channels, now) {
      if (!st.learned || !st.health) return;
      const gone = seen.size < PARTS.length ? newParts(st, now) : [];
      if (gone.length) forgetParts(st, gone.map((g) => g.node), now);
      const card = gone.find((g) => g.node === 'gpu');
      const cardFans = card ? channels.filter((c) => c.source === 'gpu').map((c) => c.id) : [];
      const ids = [...new Set([...st.health.swapped(), ...cardFans])];
      if (ids.length) await uncheck(st, ids, now, Object.fromEntries(cardFans.map((id) => [id, card.since])));
    },
    /** Learn again from scratch: everything learned goes, the parts' names stay. */
    forgetAll(st) {
      if (st.brain) st.last = st.brain.last() ?? st.last;
      st.learned = { parts: st.learned?.parts };
      st.brain = null;
      st.brainKey = '';
      st.health = createHealth();
      st.shadow = createShadow();
    },
  };
}

module.exports = { createLearning, localDay, another, DAILY_EVERY_MS, CONFIRM_RUNS };

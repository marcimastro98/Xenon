'use strict';
// What the engine keeps on disk for its next start. What the brain learned (models, games,
// fan health, the shadow's score) is written every SAVE_EVERY_MS and when the fans go back
// to the PC. The speeds the brain asked are written every LAST_EVERY_MS to a small file of
// their own: an update stops the engine by force with no save on the way out, and a brain
// that did not know them started from what the board ran the fans at while the engine was
// down, then fell from it at 1 %/s for over a minute (23 Nov 2026). brain-resume.js says
// when the next brain uses them.
const SAVE_EVERY_MS = 5 * 60000;
const LAST_EVERY_MS = 15000;

/** @param {{ store: any, warn: (msg: string) => void }} opts */
function createSaves({ store, warn }) {
  let learnedAt = 0;
  let lastAt = -Infinity;
  let lastFailing = false;

  /** @param {any} st the loop's state: learned, brain, health, shadow @param {number} now */
  async function learned(st, now) {
    learnedAt = now;
    if (!st.learned) return;
    if (st.brain) Object.assign(st.learned, { brain: st.brain.save(), games: st.brain.memory() });
    Object.assign(st.learned, { health: st.health.save(), shadow: st.shadow.save() });
    try { await store.saveLearned(st.learned); }
    catch (e) { warn(`airflow: what the fans learned could not be saved (${e.code || e.message})`); }
  }

  // Only while the brain drives: watching, its speeds were never the fans'.
  async function last(brain, now) {
    lastAt = now;
    const speeds = brain?.last();
    if (!speeds) return;
    try {
      await store.saveLast(speeds);
      lastFailing = false;
    } catch (e) {
      // Tried every few seconds: said once until it works again.
      if (!lastFailing) warn(`airflow: the fans' last speeds could not be saved (${e.code || e.message})`);
      lastFailing = true;
    }
  }

  return {
    learned,
    /** What is due on this tick. @param {any} st @param {number} now */
    async due(st, now) {
      if (now - lastAt >= LAST_EVERY_MS) await last(st.brain, now);
      if (now - learnedAt >= SAVE_EVERY_MS) await learned(st, now);
    },
    /** Everything now: the fans go back to the PC, or the engine stops. @param {any} st @param {number} now */
    async all(st, now) {
      await last(st.brain, now);
      await learned(st, now);
    },
  };
}

module.exports = { createSaves, SAVE_EVERY_MS, LAST_EVERY_MS };

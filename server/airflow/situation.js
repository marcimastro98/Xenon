'use strict';
// What Airflow's brain hears about the person and the names they gave their fans.
// The situation comes from the situations engine (capabilities/situations.js): a
// game running and its program, a call, a recording or a stream. Airflow asks for
// those facts only while it is on, and for the call and the recording only when
// "quiet during calls" is on, since reading them has a cost (the microphone check,
// the OBS watch). The names are the Fans widget's (settings.fanLabels), read again
// at most once a minute.

const LABELS_EVERY_MS = 60000;

/**
 * @param {{ wanted: () => any }} opts the saved model (store.peek()), or null before the first read
 */
function createSituation({ wanted }) {
  let facts = {};

  function rules() {
    const m = wanted();
    if (!m || m.drive === 'off') return [];
    const any = [{ c: 'game' }, { c: 'app', app: '' }];
    if (m.options?.callQuiet !== false) any.push({ c: 'call' }, { c: 'recording' }, { c: 'live' });
    return [{ any }];
  }

  return {
    source: { rules, onFacts: (f) => { facts = f && typeof f === 'object' ? f : {}; } },
    /** @param {number} now */
    now(now) {
      const front = typeof facts.front === 'string' && facts.front ? facts.front : null;
      return {
        hour: new Date(now).getHours(),
        // The game is the program in front while a game runs: its heat is remembered by name.
        game: facts.game === true ? front : null,
        call: facts.call === true,
        recording: facts.recording === true || facts.live === true,
      };
    },
  };
}

/**
 * @param {{ read: () => Promise<any>, clock?: () => number }} opts
 */
function createLabels({ read, clock = Date.now }) {
  let names = {};
  let at = -Infinity;
  let reading = false;
  return {
    get() {
      if (!reading && clock() - at >= LABELS_EVERY_MS) {
        reading = true;
        at = clock();
        Promise.resolve()
          .then(read)
          .then((s) => { names = s?.fanLabels && typeof s.fanLabels === 'object' ? s.fanLabels : {}; })
          .catch(() => { /* the names stay as they were; tried again in a minute */ })
          .finally(() => { reading = false; });
      }
      return names;
    },
  };
}

module.exports = { createSituation, createLabels, LABELS_EVERY_MS };
